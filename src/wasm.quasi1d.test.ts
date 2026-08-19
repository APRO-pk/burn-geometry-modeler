import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { unpackResults } from './wasmCore';
import type { BurnConfig, RawRunOutput, StationProfiles } from './wasmCore';
import type { NozzleMaterialProps, SimulationResult } from './engine';

/*
 * ============================================================================
 * STEP-4A: quasi-1-D internal ballistics
 * ============================================================================
 *
 * The 0-D model treats the chamber as one well-stirred volume: one pressure,
 * one mass flux, one burn rate. That is a good approximation for a short, fat
 * grain and a poor one for a long, thin one, where the gas accelerates from
 * rest at the head end to a large fraction of the speed of sound at the nozzle.
 *
 * The quasi-1-D model resolves the port into axial stations, each with its own
 * pressure, mass flux, erosive burn rate and web. These tests pin the two ends
 * of that behaviour:
 *
 *   LONG THIN  the axial gradient must be real and must concentrate erosive
 *              burning at the aft end, coning the port out
 *   SHORT FAT  with no gradient to resolve, quasi-1-D must reproduce 0-D
 *
 * The second is the one that catches modelling mistakes. A quasi-1-D solver
 * that does not collapse onto the 0-D answer when the flow slows down has a bug
 * somewhere in its mass or momentum bookkeeping, and the size of the gap says
 * where. Both are also pinned as regression snapshots.
 *
 * Snapshot tolerance is 1e-6 relative rather than 1e-9: the values are
 * deterministic for a given wasm build, but the Rust release profile uses LTO,
 * and floating-point reassociation across an inlining change can legitimately
 * move the last few bits. Six significant figures is far tighter than any real
 * change to the model could hide behind.
 * ============================================================================
 */

const require = createRequire(import.meta.url);
const PKG_NODE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../crates/burn-core/pkg-node/burn_core.js'
);

interface BurnCore {
  simulate(config: unknown): RawRunOutput;
}

const core: BurnCore = (() => {
  try {
    return require(PKG_NODE) as BurnCore;
  } catch (err) {
    throw new Error(
      `Could not load the compiled burn-core wasm at ${PKG_NODE}. Rebuild it with: ` +
        `npm run wasm:build\n(underlying error: ${err instanceof Error ? err.message : String(err)})`
    );
  }
})();

// --- fixtures --------------------------------------------------------------

const GAMMA = 1.13;
const KNDX = {
  density: 1879,
  a: 8.875e-5,
  n: 0.32,
  flame_temp: 1720,
  gamma: GAMMA,
  molecular_weight: 0.042,
};

/**
 * Long, thin, high-L/D grain: 1 m of tubular bore only 40 mm across, so
 * L/D_port = 25. Throat sized for an initial Kn of 150.
 */
const LONG_THIN = {
  kind: 'Tubular' as const,
  length: 1.0,
  outer_radius: 0.045,
  inner_radius: 0.02,
};
const LONG_THIN_DT = 0.032659863237109045; // sqrt(4*Ab0/(150*pi))

/** Short, fat grain: 80 mm long with a 60 mm bore, L/D_port = 1.33. */
const SHORT_FAT = {
  kind: 'Tubular' as const,
  length: 0.08,
  outer_radius: 0.05,
  inner_radius: 0.03,
};
const SHORT_FAT_DT = 0.014;

const GRAPHITE: NozzleMaterialProps = {
  type: 'Graphite',
  density: 1800,
  heat_of_ablation: 25e6,
  oxidation_temp: 1500,
  thermal_shock_coeff: 0.1,
  thermal_conductivity: 100,
  specific_heat: 710,
  k_temp_coeff: -0.0001,
  cp_temp_coeff: 0.0004,
};

interface RunOpts {
  model?: '0D' | 'quasi1D';
  erosive?: 'None' | 'Lenoir-Robillard' | 'JPL';
  stations?: number;
  expansionRatio?: number;
  material?: NozzleMaterialProps | null;
}

interface RunSummary {
  raw: RawRunOutput;
  results: SimulationResult[];
  stations?: StationProfiles;
  warnings: string[];
  peakPc: number;
  peakThrust: number;
  impulse: number;
  burnTime: number;
  /**
   * Largest head-to-nozzle pressure drop while the motor is actually running.
   *
   * Rows below half the peak pressure are excluded on purpose. The ignition
   * fill starts the port at ambient, where a tiny absolute mass flow is still a
   * large RELATIVE drop; including it would report ~25% for every motor ever
   * simulated and say nothing about the grain.
   */
  maxDrop: number;
}

function run(grain: unknown, throatDiameter: number, o: RunOpts = {}): RunSummary {
  const config: BurnConfig = {
    propellant: KNDX,
    grain: grain as BurnConfig['grain'],
    nozzle: {
      throat_diameter: throatDiameter,
      expansion_ratio: o.expansionRatio ?? 1.0,
      material: o.material ?? null,
    },
    options: {
      model: o.model ?? '0D',
      erosive_model: o.erosive ?? 'None',
      ...(o.stations !== undefined ? { stations: o.stations } : {}),
    },
  };

  const raw = core.simulate(config);
  const results = unpackResults(raw);

  let peakPc = -Infinity;
  let peakThrust = -Infinity;
  let impulse = 0;
  for (let i = 0; i < results.length; i++) {
    peakPc = Math.max(peakPc, results[i].Pc);
    peakThrust = Math.max(peakThrust, results[i].Thrust);
    if (i > 0) {
      impulse +=
        ((results[i].Thrust + results[i - 1].Thrust) / 2) *
        (results[i].Time - results[i - 1].Time);
    }
  }

  let maxDrop = 0;
  for (const r of results) {
    if (r.Ab > 0 && r.Pc > 0.5 * peakPc) {
      maxDrop = Math.max(maxDrop, (r.Pc - (r.PcNozzle ?? r.Pc)) / r.Pc);
    }
  }

  return {
    raw,
    results,
    stations: raw.stations,
    warnings: raw.warnings,
    peakPc,
    peakThrust,
    impulse,
    burnTime: results[results.length - 1].Time,
    maxDrop,
  };
}

function expectRelClose(actual: number, expected: number, relTol: number, what: string) {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  expect(rel, `${what}: ${actual} vs ${expected} (rel ${rel.toExponential(3)} > ${relTol})`)
    .toBeLessThan(relTol);
}

const SNAP = 1e-6;

// =========================================================================
describe('model switch', () => {
  it('defaults to 0-D, which produces no axial output', () => {
    const raw = core.simulate({
      propellant: KNDX,
      grain: SHORT_FAT,
      nozzle: { throat_diameter: SHORT_FAT_DT, expansion_ratio: 1.0 },
    });
    expect(raw.stations).toBeUndefined();
  });

  it('gives 0-D the identical answer whatever `stations` is set to', () => {
    // Guards against the station count leaking into the fast path, which would
    // make Monte Carlo results depend on a setting that should not touch them.
    const few = run(LONG_THIN, LONG_THIN_DT, { erosive: 'Lenoir-Robillard', stations: 3 });
    const many = run(LONG_THIN, LONG_THIN_DT, { erosive: 'Lenoir-Robillard', stations: 99 });
    expect(few.results.length).toBe(many.results.length);
    expect(few.peakPc).toBe(many.peakPc);
    expect(few.impulse).toBe(many.impulse);
  });

  it('returns a full station profile under quasi-1-D, defaulting to 20 stations', () => {
    const r = run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D' });
    const st = r.stations!;
    expect(st).toBeDefined();
    expect(st.count).toBe(20);
    for (const key of [
      'x', 'web', 'peakWeb', 'pressure', 'massFlux', 'burnRate', 'erosiveRate', 'massFlow', 'portArea',
    ] as const) {
      expect(st[key].length, `stations.${key}`).toBe(20);
    }
    // Station centres span the grain.
    expect(st.x[0]).toBeCloseTo(0.025, 12);
    expect(st.x[19]).toBeCloseTo(0.975, 12);
  });

  it('honours a custom station count', () => {
    expect(run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D', stations: 7 }).stations!.count).toBe(7);
    expect(run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D', stations: 50 }).stations!.count).toBe(50);
  });

  it('rejects nothing and still runs with a single station', () => {
    // Degenerate but must not divide by zero: one cell is the whole grain.
    const r = run(SHORT_FAT, SHORT_FAT_DT, { model: 'quasi1D', stations: 1 });
    expect(r.results.length).toBeGreaterThan(100);
    expect(Number.isFinite(r.peakPc)).toBe(true);
  });
});

// =========================================================================
describe('long thin grain (L/D = 25): the axial gradient is real', () => {
  const q1d = run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D', erosive: 'Lenoir-Robillard' });
  const zeroD = run(LONG_THIN, LONG_THIN_DT, { erosive: 'Lenoir-Robillard' });

  it('shows a meaningful head-to-nozzle pressure drop, where 0-D shows exactly none', () => {
    expect(q1d.maxDrop).toBeGreaterThan(0.05); // 20.4% for this motor
    expect(zeroD.maxDrop).toBe(0);

    // And it is a drop, never a rise: stagnation pressure cannot be created
    // along the port.
    for (const r of q1d.results) {
      expect(r.PcNozzle!).toBeLessThanOrEqual(r.Pc * (1 + 1e-12));
    }
  });

  it('accelerates the flow monotonically from head to aft', () => {
    const { massFlux, pressure } = q1d.stations!;
    for (let i = 1; i < massFlux.length; i++) {
      expect(massFlux[i], `mass flux at station ${i}`).toBeGreaterThan(massFlux[i - 1]);
      expect(pressure[i], `pressure at station ${i}`).toBeLessThan(pressure[i - 1]);
    }
    // The head end barely flows; the aft end carries everything.
    expect(massFlux[19] / massFlux[0]).toBeGreaterThan(5);
  });

  it('concentrates erosive burning at the aft end', () => {
    const { erosiveRate, burnRate } = q1d.stations!;
    // Effectively nothing at the head, several mm/s by the aft end.
    expect(erosiveRate[0]).toBeLessThan(1e-6);
    expect(erosiveRate[19]).toBeGreaterThan(1e-3);
    for (let i = 1; i < erosiveRate.length; i++) {
      expect(erosiveRate[i], `erosive rate at station ${i}`)
        .toBeGreaterThanOrEqual(erosiveRate[i - 1]);
    }
    // Total burn rate follows it up, despite the LOWER local pressure aft --
    // erosion more than overcomes the pressure drop.
    expect(burnRate[19]).toBeGreaterThan(burnRate[0]);
  });

  it('cones the port out towards the aft end', () => {
    const { peakWeb, portArea } = q1d.stations!;
    expect(peakWeb[19] / peakWeb[0]).toBeGreaterThan(1.3); // 1.77 for this motor
    expect(portArea[19]).toBeGreaterThan(portArea[0]);
  });

  it('does NOT cone the port without erosive burning -- erosion is the cause', () => {
    // The control. With erosion off the head burns marginally FASTER, because
    // it sits at the higher local pressure; the aft end has no compensating
    // flux term. So the sign of the effect flips, which is the sharpest
    // available evidence that the coning above comes from erosive burning and
    // not from some artefact of the discretisation.
    const noErosion = run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D' });
    const { peakWeb, erosiveRate } = noErosion.stations!;
    expect(peakWeb[19]).toBeLessThan(peakWeb[0]);
    for (const e of erosiveRate) expect(e).toBe(0);
    // The pressure gradient itself is still there.
    expect(noErosion.maxDrop).toBeGreaterThan(0.01);
  });

  it('differs substantially from 0-D, which is the point of the model', () => {
    // 0-D drives erosive burning with ONE lumped mass flux for the whole grain,
    // so it applies the aft end's flux to the head as well and burns the motor
    // far too fast.
    expect(zeroD.peakPc / q1d.peakPc).toBeGreaterThan(1.2);
    expect(q1d.burnTime / zeroD.burnTime).toBeGreaterThan(1.3);
  });

  it('REGRESSION SNAPSHOT: quasi-1-D, Lenoir-Robillard', () => {
    expect(q1d.results.length).toBe(2094);
    expectRelClose(q1d.peakPc, 7878048.287765, SNAP, 'peak Pc');
    expectRelClose(q1d.peakThrust, 8015.58825, SNAP, 'peak thrust');
    expectRelClose(q1d.impulse, 10688.963232, SNAP, 'total impulse');
    expectRelClose(q1d.burnTime, 2.094, SNAP, 'burn time');
    expectRelClose(q1d.maxDrop, 0.204259, 1e-4, 'max head-to-nozzle drop');
    expectRelClose(q1d.stations!.peakWeb[19] / q1d.stations!.peakWeb[0], 1.7721, 1e-3, 'coning ratio');
  });

  it('REGRESSION SNAPSHOT: quasi-1-D, no erosive burning', () => {
    const r = run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D' });
    expect(r.results.length).toBe(2120);
    expectRelClose(r.peakPc, 8287063.042978, SNAP, 'peak Pc');
    expectRelClose(r.impulse, 10687.70326, SNAP, 'total impulse');
    expectRelClose(r.burnTime, 2.12, SNAP, 'burn time');
    expectRelClose(r.maxDrop, 0.030510, 1e-4, 'max head-to-nozzle drop');
  });

  it('runs clean: a valid design must not trip the port-choking warning', () => {
    // The warning is deliberately hard to trip -- the ignition transient alone
    // used to set it off on every motor. See PORT_CHOKE_MIN_FRACTION in sim.rs.
    expect(q1d.warnings).toEqual([]);
  });
});

// =========================================================================
describe('short fat grain (L/D = 1.33): quasi-1-D collapses onto 0-D', () => {
  const zeroD = run(SHORT_FAT, SHORT_FAT_DT);
  const q1d = run(SHORT_FAT, SHORT_FAT_DT, { model: 'quasi1D' });

  it('agrees with 0-D on peak pressure, impulse and burn time to well under a percent', () => {
    expectRelClose(q1d.peakPc, zeroD.peakPc, 5e-3, 'peak Pc vs 0-D');
    expectRelClose(q1d.impulse, zeroD.impulse, 5e-3, 'impulse vs 0-D');
    expectRelClose(q1d.peakThrust, zeroD.peakThrust, 5e-3, 'peak thrust vs 0-D');
    expect(q1d.results.length).toBe(zeroD.results.length);
    expect(q1d.burnTime).toBeCloseTo(zeroD.burnTime, 9);
  });

  it('has almost no axial gradient left to resolve', () => {
    expect(q1d.maxDrop).toBeLessThan(0.01);
    const { pressure } = q1d.stations!;
    expectRelClose(pressure[19], pressure[0], 1e-3, 'aft vs head pressure');
  });

  it('is insensitive to the station count, having nothing to resolve', () => {
    const coarse = run(SHORT_FAT, SHORT_FAT_DT, { model: 'quasi1D', stations: 5 });
    const fine = run(SHORT_FAT, SHORT_FAT_DT, { model: 'quasi1D', stations: 80 });
    expectRelClose(fine.peakPc, coarse.peakPc, 1e-3, 'peak Pc across station counts');
    expectRelClose(fine.impulse, coarse.impulse, 1e-3, 'impulse across station counts');
  });

  it('REGRESSION SNAPSHOT: both models', () => {
    expect(zeroD.results.length).toBe(2193);
    expectRelClose(zeroD.peakPc, 2906835.284201, SNAP, '0-D peak Pc');
    expectRelClose(zeroD.impulse, 821.884691, SNAP, '0-D impulse');

    expect(q1d.results.length).toBe(2193);
    expectRelClose(q1d.peakPc, 2906312.121847, SNAP, 'quasi-1-D peak Pc');
    expectRelClose(q1d.impulse, 821.872491, SNAP, 'quasi-1-D impulse');
  });
});

// =========================================================================
describe('station-count convergence', () => {
  it('converges as the grid refines rather than wandering', () => {
    const runs = [10, 20, 40, 80].map((n) =>
      run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D', erosive: 'Lenoir-Robillard', stations: n })
    );

    // Integrated quantities are essentially grid-independent...
    for (const r of runs) expectRelClose(r.impulse, runs[3].impulse, 1e-3, 'impulse');

    // ...while peak pressure and the pressure drop tighten monotonically, with
    // each halving of the cell size moving them less than the last.
    const gaps = runs.slice(0, 3).map((r) => Math.abs(r.peakPc - runs[3].peakPc));
    expect(gaps[0]).toBeGreaterThan(gaps[1]);
    expect(gaps[1]).toBeGreaterThan(gaps[2]);
    expect(gaps[2] / runs[3].peakPc).toBeLessThan(0.01);
  });
});

// =========================================================================
describe('throat erosion and the exit-pressure ratio (old-engine inconsistency)', () => {
  /*
   * The old engine solved the exit/chamber pressure ratio once at t = 0 and then
   * grew the throat by ablation for the rest of the burn. Those are mutually
   * inconsistent: the exit area is fixed hardware, so a throat that grows makes
   * the expansion ratio FALL. Holding it fixed modelled a nozzle whose exit
   * conveniently grew along with its throat, overstating C_F late in the burn.
   *
   * These tests reimplement the isentropic relations independently and check the
   * core follows epsilon(t), not epsilon(0).
   */
  const bigGamma =
    Math.sqrt(GAMMA) * Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * (GAMMA - 1)));

  function exitPressureRatio(epsilon: number) {
    const f = (pr: number) => {
      if (pr <= 0 || pr >= 1) return 1e9;
      const d =
        ((2 * GAMMA) / (GAMMA - 1)) *
        Math.pow(pr, 2 / GAMMA) *
        (1 - Math.pow(pr, (GAMMA - 1) / GAMMA));
      return bigGamma / Math.sqrt(d) - epsilon;
    };
    let lo = 0.00001;
    let hi = Math.pow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1));
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function thrustCoefficient(pc: number, epsilon: number, pa = 101325) {
    const crit = Math.pow((GAMMA + 1) / 2, GAMMA / (GAMMA - 1));
    if (pc < pa * crit) return 0;
    const pe = pc * exitPressureRatio(epsilon);
    const t1 = (2 * GAMMA * GAMMA) / (GAMMA - 1);
    const t2 = Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (GAMMA - 1));
    const t3 = Math.max(0, 1 - Math.pow(pe / pc, (GAMMA - 1) / GAMMA));
    return Math.max(0, Math.sqrt(t1 * t2 * t3) + ((pe - pa) / pc) * epsilon);
  }

  const BATES = {
    kind: 'BATES' as const,
    length: 0.2,
    outer_radius: 0.025,
    inner_radius: 0.01,
  };
  const BATES_DT = 0.010049880048721369;

  const eroding = run(BATES, BATES_DT, { expansionRatio: 4, material: GRAPHITE });

  it('erodes the throat, so the expansion ratio falls during the burn', () => {
    const at0 = eroding.results[0].ThroatArea;
    const atEnd = eroding.results[eroding.results.length - 1].ThroatArea;
    expect(atEnd / at0).toBeGreaterThan(1.2); // ~1.31x for graphite here

    // Exit area is fixed, so epsilon = A_e / A_t falls from 4 to about 3.05.
    const exitArea = 4 * at0;
    expect(exitArea / atEnd).toBeLessThan(3.2);
  });

  it('computes C_F from the CURRENT expansion ratio, not the initial one', () => {
    const at0 = eroding.results[0].ThroatArea;
    const exitArea = 4 * at0;

    let maxErrCurrent = 0;
    let maxErrFrozen = 0;
    for (const r of eroding.results) {
      if (r.Thrust <= 0) continue;
      const cfActual = r.Thrust / (r.Pc * r.ThroatArea);
      const epsilon = Math.max(1, exitArea / r.ThroatArea);
      maxErrCurrent = Math.max(maxErrCurrent, Math.abs(cfActual - thrustCoefficient(r.Pc, epsilon)));
      maxErrFrozen = Math.max(maxErrFrozen, Math.abs(cfActual - thrustCoefficient(r.Pc, 4)));
    }

    // Matches epsilon(t) to floating-point noise...
    expect(maxErrCurrent, `worst |C_F - C_F(eps(t))| = ${maxErrCurrent}`).toBeLessThan(1e-9);
    // ...and is measurably NOT the frozen-epsilon answer, so this test would
    // fail if the fix were reverted.
    expect(maxErrFrozen, `worst |C_F - C_F(eps_0)| = ${maxErrFrozen}`).toBeGreaterThan(1e-2);
  });

  it('leaves a non-eroding nozzle exactly where it was', () => {
    // The other half of the fix: recomputing every step must be a no-op when
    // the throat does not move, so no existing result shifts.
    const inert = run(BATES, BATES_DT, { expansionRatio: 4 });
    const at0 = inert.results[0].ThroatArea;
    for (const r of inert.results) expect(r.ThroatArea).toBe(at0);

    let maxErr = 0;
    for (const r of inert.results) {
      if (r.Thrust <= 0) continue;
      maxErr = Math.max(maxErr, Math.abs(r.Thrust / (r.Pc * r.ThroatArea) - thrustCoefficient(r.Pc, 4)));
    }
    expect(maxErr).toBeLessThan(1e-9);
  });

  it('applies the same treatment under quasi-1-D', () => {
    const q = run(BATES, BATES_DT, { model: 'quasi1D', expansionRatio: 4, material: GRAPHITE });
    const at0 = q.results[0].ThroatArea;
    const exitArea = 4 * at0;
    let maxErr = 0;
    for (const r of q.results) {
      if (r.Thrust <= 0) continue;
      // Quasi-1-D expands from the NOZZLE stagnation pressure, not the head end.
      const cfActual = r.Thrust / (r.PcNozzle! * r.ThroatArea);
      const epsilon = Math.max(1, exitArea / r.ThroatArea);
      maxErr = Math.max(maxErr, Math.abs(cfActual - thrustCoefficient(r.PcNozzle!, epsilon)));
    }
    expect(maxErr).toBeLessThan(1e-9);
  });
});

// =========================================================================
describe('quasi-1-D physical invariants', () => {
  const cases: Array<[string, RunSummary]> = [
    ['long thin, L-R', run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D', erosive: 'Lenoir-Robillard' })],
    ['long thin, none', run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D' })],
    ['short fat', run(SHORT_FAT, SHORT_FAT_DT, { model: 'quasi1D' })],
    ['short fat, JPL', run(SHORT_FAT, SHORT_FAT_DT, { model: 'quasi1D', erosive: 'JPL' })],
    ['BATES (has burning end faces)', run(
      { kind: 'BATES', length: 0.2, outer_radius: 0.025, inner_radius: 0.01 },
      0.010049880048721369,
      { model: 'quasi1D' }
    )],
  ];

  for (const [name, r] of cases) {
    it(`${name}: every reported value is finite and physically signed`, () => {
      expect(r.results.length).toBeGreaterThan(50);
      // Scanned rather than asserted per field per row: an expect() call per
      // check over thousands of rows costs seconds and turns a correctness test
      // into a timeout risk. One assertion, same coverage, names the bad row.
      const bad: string[] = [];
      for (let i = 0; i < r.results.length && bad.length < 5; i++) {
        const row = r.results[i];
        const fail = (what: string) => bad.push(`row ${i}: ${what}`);
        if (!Number.isFinite(row.Pc)) fail(`Pc = ${row.Pc}`);
        if (!Number.isFinite(row.PcNozzle!)) fail(`PcNozzle = ${row.PcNozzle}`);
        if (!Number.isFinite(row.Thrust)) fail(`Thrust = ${row.Thrust}`);
        if (!(row.Pc > 0)) fail(`Pc not positive (${row.Pc})`);
        if (!(row.PcNozzle! > 0)) fail(`PcNozzle not positive (${row.PcNozzle})`);
        if (!(row.PcNozzle! <= row.Pc * (1 + 1e-12))) {
          fail(`PcNozzle ${row.PcNozzle} exceeds head Pc ${row.Pc}`);
        }
        if (!(row.Thrust >= 0)) fail(`Thrust negative (${row.Thrust})`);
        if (!(row.Ab >= 0)) fail(`Ab negative (${row.Ab})`);
        if (!(row.PortArea > 0)) fail(`PortArea not positive (${row.PortArea})`);
      }
      expect(bad, bad.join('; ')).toEqual([]);
    });

    it(`${name}: station profiles are finite and non-negative`, () => {
      const st = r.stations!;
      for (let i = 0; i < st.count; i++) {
        expect(Number.isFinite(st.pressure[i]), `pressure[${i}]`).toBe(true);
        expect(st.pressure[i]).toBeGreaterThan(0);
        expect(st.massFlux[i]).toBeGreaterThanOrEqual(0);
        expect(st.burnRate[i]).toBeGreaterThanOrEqual(0);
        expect(st.erosiveRate[i]).toBeGreaterThanOrEqual(0);
        expect(st.portArea[i]).toBeGreaterThan(0);
        expect(st.web[i]).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it('conserves mass: propellant generated never exceeds what the grain holds', () => {
    const r = run(LONG_THIN, LONG_THIN_DT, { model: 'quasi1D', erosive: 'Lenoir-Robillard' });
    const volume =
      Math.PI * (LONG_THIN.outer_radius ** 2 - LONG_THIN.inner_radius ** 2) * LONG_THIN.length;
    const mass = volume * KNDX.density;
    const generated = r.results[r.results.length - 1].PropellantMassGen;
    expect(generated).toBeGreaterThan(0.9 * mass);
    expect(generated).toBeLessThanOrEqual(mass * 1.001);
  });
});
