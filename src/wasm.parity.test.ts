import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SolidPropellant,
  BATES,
  Star,
  Tubular,
  RodAndTube,
  MoonBurner,
  Finocyl,
  CustomDXF,
  MotorSimulation,
  Igniter,
  grainFromUi,
  SIM_DT,
} from './engine';
import type {
  GrainGeometry,
  GrainUiParams,
  DxfTables,
  NozzleMaterialProps,
  SimulationResult,
} from './engine';
import { unpackResults, grainConfigFromUi } from './wasmCore';
import type { BurnConfig, BurnGrainConfig, RawRunOutput } from './wasmCore';

/*
 * ============================================================================
 * STEP-3B PARITY TABLE: Rust/WASM core vs the TypeScript reference engine
 * ============================================================================
 *
 * crates/burn-core is the port of the solver half of src/engine.ts, with the
 * integrator upgraded from semi-implicit (backward) Euler to fixed-step
 * classical RK4 on the coupled fast state (Pc, y, V_c). src/engine.ts is
 * retained as the reference this file compares against.
 *
 * Two very different kinds of agreement are asserted here, and they must not be
 * conflated:
 *
 *   GEOMETRY is a pure port with no integrator involved, so it is required to
 *   agree to floating-point noise (<1e-12 relative). Any drift here is a
 *   transcription bug in crates/burn-core/src/grain.rs, not a numerical effect.
 *
 *   TRAJECTORY quantities are integrals of a stiff ODE evaluated by two
 *   different schemes, so exact agreement is neither expected nor desirable --
 *   RK4 is the more accurate of the two. What is asserted is that the physics
 *   is the same: the tolerances below are the measured deviations with headroom,
 *   not aspirational limits. Tightening them is meaningless; a large jump in one
 *   means a real divergence in the model.
 *
 * Measured deviations at dt = SIM_DT = 0.001 s (wasm vs TS, all 13 cases):
 *
 *   case                          steps       peak Pc    impulse   burn time
 *   ---------------------------------------------------------------------
 *   BATES                      1199/1202     +0.0023%   +0.0125%   -0.2496%
 *   Star N=5                   1721/1725     +0.0254%   +0.0068%   -0.2319%
 *   Star N=8 (past transition) 1894/1897     +0.0731%   -0.0358%   -0.1581%
 *   Tubular                    2094/2098     +0.0179%   +0.0446%   -0.1907%
 *   RodAndTube                 1677/1680     +0.0331%   +0.0033%   -0.1786%
 *   MoonBurner                 3814/3815     +0.0581%   -0.0048%   -0.0262%
 *   Finocyl                    2775/2769     -0.0029%   -0.0393%   +0.2167%
 *   CustomDXF                  2909/2914     +0.0286%   +0.0244%   -0.1716%
 *   + igniter                  1197/1202     +0.0024%   -0.0839%   -0.4160%
 *   + graphite nozzle          1249/1253     -0.0565%   +0.0043%   -0.3192%
 *   + Lenoir-Robillard         1044/1048     +0.0177%   +0.0209%   -0.3817%
 *   + JPL erosive               549/554      +0.7862%   -0.0348%   -0.9025%
 *   + effs 0.95/0.98, eps=4     1195/1199    +0.0368%   +0.0421%   -0.3336%
 *
 * The JPL row is the outlier by an order of magnitude, and legitimately so: JPL
 * erosive burning multiplies the burn rate by (1 + k*(G - G_th)), so burn rate
 * feeds mass flux feeds burn rate. That positive feedback amplifies any
 * per-step integration difference, and the case also burns out in half the
 * steps, leaving less time to average out. It gets its own wider tolerance
 * rather than loosening the whole table.
 *
 * Burn time is consistently ~1-4 steps SHORTER under RK4 across every case.
 * That is the expected sign: RK4 tracks the true (higher) burn rate through
 * each step instead of holding the step-start value, so the web is consumed
 * marginally sooner.
 * ============================================================================
 */

// --- loading the compiled core --------------------------------------------

const require = createRequire(import.meta.url);
const PKG_NODE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../crates/burn-core/pkg-node/burn_core.js'
);

interface BurnCore {
  simulate(config: unknown): RawRunOutput;
  sim_dt(): number;
  version(): string;
  Solver: new () => { configure(config: unknown): void; run(): RawRunOutput };
}

function loadCore(): BurnCore {
  try {
    return require(PKG_NODE) as BurnCore;
  } catch (err) {
    throw new Error(
      `Could not load the compiled burn-core wasm at ${PKG_NODE}.\n` +
        'The wasm-pack output is committed, so this normally means it was deleted ' +
        'or the checkout is incomplete. Rebuild it with:  npm run wasm:build\n' +
        `(underlying error: ${err instanceof Error ? err.message : String(err)})`
    );
  }
}

const core = loadCore();

// --- shared fixtures -------------------------------------------------------

/** Nakka KNDX, the same propellant the Step-3A golden reference uses. */
const KNDX = {
  density: 1879,
  a: 8.875e-5,
  n: 0.32,
  flameTemp: 1720,
  gamma: 1.13,
  molWeight: 0.042,
};
const KNDX_PROP = {
  density: KNDX.density,
  a: KNDX.a,
  n: KNDX.n,
  flame_temp: KNDX.flameTemp,
  gamma: KNDX.gamma,
  molecular_weight: KNDX.molWeight,
};
const KNDX_GRAIN = { length: 0.2, outerRadius: 0.025, innerRadius: 0.01 };
/** Throat sized for an initial Kn of 200 (see engine.test.ts). */
const KNDX_D_T = 0.010049880048721369;

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

/** A synthetic DXF regression table, to exercise the interpolated-table path. */
const DXF_DX = 0.001;
const DXF_PERIM: number[] = [];
const DXF_AREA: number[] = [];
for (let i = 0; i < 40; i++) {
  DXF_PERIM.push(0.06 + 0.004 * i);
  DXF_AREA.push(3e-4 + 6e-5 * i);
}

// --- helpers ---------------------------------------------------------------

function runWasm(config: BurnConfig): { results: SimulationResult[]; warnings: string[] } {
  const raw = core.simulate(config);
  return { results: unpackResults(raw), warnings: raw.warnings };
}

function totalImpulse(rows: SimulationResult[]): number {
  let sum = 0;
  for (let i = 1; i < rows.length; i++) {
    sum += ((rows[i].Thrust + rows[i - 1].Thrust) / 2) * (rows[i].Time - rows[i - 1].Time);
  }
  return sum;
}

const peak = (rows: SimulationResult[], key: keyof SimulationResult) =>
  rows.reduce((m, r) => Math.max(m, r[key] as number), -Infinity);

function expectWithin(actual: number, expected: number, relTol: number, what: string) {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  expect(rel, `${what}: ${actual} vs ${expected} (rel ${rel.toExponential(3)} > ${relTol})`)
    .toBeLessThan(relTol);
}

/**
 * Every case in the parity table: a TS grain object, the equivalent wasm grain
 * config, and the run settings both engines are given.
 */
interface ParityCase {
  name: string;
  grain: () => GrainGeometry;
  grainConfig: BurnGrainConfig;
  throatDiameter: number;
  expansionRatio?: number;
  cStarEff?: number;
  cfEff?: number;
  tInit?: number;
  erosive?: 'None' | 'Lenoir-Robillard' | 'JPL';
  igniter?: { mass: number; surface_area: number; density: number; a: number; n: number };
  material?: NozzleMaterialProps;
  /** Trajectory tolerances (relative). Defaults cover every case but JPL. */
  tol?: { peakPc?: number; impulse?: number; burnTime?: number; steps?: number };
}

const DEFAULT_TOL = { peakPc: 2e-3, impulse: 2e-3, burnTime: 1e-2, steps: 1e-2 };

const CASES: ParityCase[] = [
  {
    name: 'BATES',
    grain: () => new BATES(0.2, 0.025, 0.01),
    grainConfig: { kind: 'BATES', length: 0.2, outer_radius: 0.025, inner_radius: 0.01 },
    throatDiameter: KNDX_D_T,
  },
  {
    name: 'Star N=5 (transition never reached)',
    grain: () => new Star(0.4, 0.05, 0.03, 0.01, 5),
    grainConfig: {
      kind: 'Star', length: 0.4, outer_radius: 0.05,
      valley_radius: 0.03, tip_radius: 0.01, num_points: 5,
    },
    throatDiameter: 0.025,
  },
  {
    name: 'Star N=8 (burns through the star->cylinder transition)',
    grain: () => new Star(0.4, 0.05, 0.03, 0.01, 8),
    grainConfig: {
      kind: 'Star', length: 0.4, outer_radius: 0.05,
      valley_radius: 0.03, tip_radius: 0.01, num_points: 8,
    },
    throatDiameter: 0.03,
  },
  {
    name: 'Tubular',
    grain: () => new Tubular(0.3, 0.04, 0.015),
    grainConfig: { kind: 'Tubular', length: 0.3, outer_radius: 0.04, inner_radius: 0.015 },
    throatDiameter: 0.016,
  },
  {
    name: 'RodAndTube',
    grain: () => new RodAndTube(0.3, 0.05, 0.008, 0.03),
    grainConfig: {
      kind: 'RodAndTube', length: 0.3, outer_radius: 0.05,
      rod_radius: 0.008, tube_inner_radius: 0.03,
    },
    throatDiameter: 0.02,
  },
  {
    name: 'MoonBurner',
    grain: () => new MoonBurner(0.3, 0.05, 0.015, 0.01),
    grainConfig: {
      kind: 'MoonBurner', length: 0.3, outer_radius: 0.05, core_radius: 0.015, offset: 0.01,
    },
    throatDiameter: 0.016,
  },
  {
    name: 'Finocyl',
    grain: () => new Finocyl(0.3, 0.05, 0.02, 6, 0.004, 0.015),
    grainConfig: {
      kind: 'Finocyl', length: 0.3, outer_radius: 0.05,
      r_tube: 0.02, num_fins: 6, w_fin: 0.004, h_fin: 0.015,
    },
    throatDiameter: 0.02,
  },
  {
    name: 'CustomDXF (interpolated regression tables)',
    grain: () => new CustomDXF(0.3, 0.05, DXF_DX, DXF_PERIM, DXF_AREA),
    grainConfig: {
      kind: 'CustomDXF', length: 0.3, outer_radius: 0.05,
      dx: DXF_DX, perim_table: DXF_PERIM, area_table: DXF_AREA,
    },
    throatDiameter: 0.012,
  },
  {
    name: 'BATES + igniter',
    grain: () => new BATES(0.2, 0.025, 0.01),
    grainConfig: { kind: 'BATES', length: 0.2, outer_radius: 0.025, inner_radius: 0.01 },
    throatDiameter: KNDX_D_T,
    igniter: { mass: 0.002, surface_area: 0.001, density: 1900, a: 1e-5, n: 0.3 },
  },
  {
    name: 'BATES + ablating graphite throat',
    grain: () => new BATES(0.2, 0.025, 0.01),
    grainConfig: { kind: 'BATES', length: 0.2, outer_radius: 0.025, inner_radius: 0.01 },
    throatDiameter: KNDX_D_T,
    material: GRAPHITE,
  },
  {
    name: 'BATES + Lenoir-Robillard erosive burning',
    grain: () => new BATES(0.2, 0.025, 0.01),
    grainConfig: { kind: 'BATES', length: 0.2, outer_radius: 0.025, inner_radius: 0.01 },
    throatDiameter: KNDX_D_T,
    erosive: 'Lenoir-Robillard',
  },
  {
    name: 'BATES + JPL erosive burning',
    grain: () => new BATES(0.2, 0.025, 0.01),
    grainConfig: { kind: 'BATES', length: 0.2, outer_radius: 0.025, inner_radius: 0.01 },
    throatDiameter: KNDX_D_T,
    erosive: 'JPL',
    // Positive burn-rate feedback amplifies per-step differences; see the header.
    tol: { peakPc: 1.5e-2, impulse: 2e-3, burnTime: 2e-2, steps: 2e-2 },
  },
  {
    name: 'BATES + efficiencies 0.95/0.98, expansion 4:1, T_init 310 K',
    grain: () => new BATES(0.2, 0.025, 0.01),
    grainConfig: { kind: 'BATES', length: 0.2, outer_radius: 0.025, inner_radius: 0.01 },
    throatDiameter: KNDX_D_T,
    expansionRatio: 4,
    cStarEff: 0.95,
    cfEff: 0.98,
    tInit: 310,
  },
];

function tsRun(c: ParityCase) {
  const prop = new SolidPropellant(
    KNDX.density, KNDX.a, KNDX.n, KNDX.flameTemp, KNDX.gamma, KNDX.molWeight
  );
  const sim = new MotorSimulation(prop, c.grain(), SIM_DT, c.tInit ?? 294);
  sim.set_efficiencies(c.cStarEff ?? 1, c.cfEff ?? 1);
  sim.set_erosive_burning(c.erosive ?? 'None');
  if (c.igniter) {
    const i = c.igniter;
    sim.set_igniter(new Igniter(i.mass, i.surface_area, i.density, i.a, i.n));
  }
  sim.set_nozzle(c.throatDiameter, c.expansionRatio ?? 1, c.material ?? null);
  return sim.run();
}

function wasmConfig(c: ParityCase): BurnConfig {
  return {
    propellant: KNDX_PROP,
    grain: c.grainConfig,
    nozzle: {
      throat_diameter: c.throatDiameter,
      expansion_ratio: c.expansionRatio ?? 1,
      material: c.material ?? null,
    },
    igniter: c.igniter ?? null,
    options: {
      c_star_eff: c.cStarEff ?? 1,
      cf_eff: c.cfEff ?? 1,
      erosive_model: c.erosive ?? 'None',
      t_init: c.tInit ?? 294,
    },
  };
}

// =========================================================================
describe('burn-core wasm module contract', () => {
  it('reports a version', () => {
    expect(core.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('agrees with the TypeScript engine on the nominal timestep', () => {
    // If these ever diverge, every comparison in this file is between motors
    // integrated at different resolutions and the parity table is meaningless.
    expect(core.sim_dt()).toBe(SIM_DT);
  });

  it('returns the SimulationResult columns, in the documented order', () => {
    const raw = core.simulate(wasmConfig(CASES[0]));
    expect(raw.fields).toEqual([
      'Time', 'Ab', 'Pc', 'Thrust', 'PortMassFlux',
      'ThroatArea', 'PortArea', 'y', 'MassFlow', 'PropellantMassGen', 'PcNozzle',
    ]);
    expect(raw.data.length).toBe(raw.rows * raw.fields.length);
  });

  it('defaults to the 0-D model, where the nozzle sees the chamber pressure', () => {
    const raw = core.simulate(wasmConfig(CASES[0]));
    expect(raw.stations).toBeUndefined(); // 0-D has no axial dimension
    const rows = unpackResults(raw);
    for (const r of rows) expect(r.PcNozzle).toBe(r.Pc);
  });

  it('gives the same answer through Solver.configure/run as through simulate()', () => {
    const cfg = wasmConfig(CASES[0]);
    const oneShot = core.simulate(cfg);
    const solver = new core.Solver();
    solver.configure(cfg);
    const stateful = solver.run();

    expect(stateful.rows).toBe(oneShot.rows);
    expect(Array.from(stateful.data)).toEqual(Array.from(oneShot.data));
  });

  it('rejects a malformed configuration instead of returning garbage', () => {
    // Missing the entire grain section.
    expect(() => core.simulate({ propellant: KNDX_PROP })).toThrow(/invalid config/i);
  });

  it('rejects an unknown grain kind', () => {
    const bad = { ...wasmConfig(CASES[0]), grain: { kind: 'Trapezoid', length: 0.2 } };
    expect(() => core.simulate(bad)).toThrow(/invalid config/i);
  });

  it('surfaces the same stability warnings as the TypeScript engine', () => {
    // Kn ~ 1900: over the 400 threshold, so check_stability must fire.
    const cfg = wasmConfig(CASES[0]);
    cfg.nozzle = { ...cfg.nozzle, throat_diameter: 0.00325 };
    const { warnings } = runWasm(cfg);

    const ts = tsRun({ ...CASES[0], throatDiameter: 0.00325 });
    expect(warnings).toEqual(ts.warnings);
    expect(warnings.some((w) => /Initial Kn/.test(w))).toBe(true);
  });
});

// =========================================================================
describe('geometry parity (pure port -- must agree to floating-point noise)', () => {
  /*
   * Both engines report, for step i, the burning area evaluated at the web of
   * step i-1 (the step START), alongside the web reached at the step END. That
   * off-by-one is a property of the shared output contract, not a discrepancy;
   * it is reproduced here so the geometry can be checked at every web the run
   * actually visited, using the wasm run's own y values as the sample points.
   */
  for (const c of CASES) {
    it(`${c.name}: Ab(y) and A_port(y) match src/engine.ts`, () => {
      const { results } = runWasm(wasmConfig(c));
      expect(results.length).toBeGreaterThan(100);

      const grain = c.grain();
      let worstAb = 0;
      let worstPort = 0;
      for (let i = 0; i < results.length; i++) {
        const yStart = i === 0 ? 0 : results[i - 1].y;
        const abTs = grain.get_burning_area(yStart);
        const portTs = grain.get_port_area(yStart);

        if (abTs > 0) worstAb = Math.max(worstAb, Math.abs(results[i].Ab - abTs) / abTs);
        else expect(results[i].Ab).toBe(0);

        if (portTs > 0) worstPort = Math.max(worstPort, Math.abs(results[i].PortArea - portTs) / portTs);
      }

      expect(worstAb, `worst relative Ab error ${worstAb.toExponential(3)}`).toBeLessThan(1e-12);
      expect(worstPort, `worst relative A_port error ${worstPort.toExponential(3)}`)
        .toBeLessThan(1e-12);
    });
  }

  it('covers a web range wide enough for the comparison to mean something', () => {
    // Guards against a future change that makes a case burn out in two steps and
    // silently turns the geometry checks above into no-ops.
    for (const c of CASES) {
      const { results } = runWasm(wasmConfig(c));
      const yMax = results[results.length - 1].y;
      expect(yMax, `${c.name} regressed only ${yMax} m of web`).toBeGreaterThan(0.005);
    }
  });
});

// =========================================================================
describe('trajectory parity (RK4 vs backward Euler -- same physics, better integrator)', () => {
  for (const c of CASES) {
    it(`${c.name}: peak Pc, impulse, burn time and step count track the TS engine`, () => {
      const tol = { ...DEFAULT_TOL, ...(c.tol ?? {}) };
      const ts = tsRun(c);
      const { results } = runWasm(wasmConfig(c));

      expectWithin(results.length, ts.results.length, tol.steps, `${c.name} steps`);
      expectWithin(peak(results, 'Pc'), peak(ts.results, 'Pc'), tol.peakPc, `${c.name} peak Pc`);
      expectWithin(
        peak(results, 'Thrust'), peak(ts.results, 'Thrust'), tol.peakPc, `${c.name} peak thrust`
      );
      expectWithin(
        totalImpulse(results), totalImpulse(ts.results), tol.impulse, `${c.name} total impulse`
      );
      expectWithin(
        results[results.length - 1].Time,
        ts.results[ts.results.length - 1].Time,
        tol.burnTime,
        `${c.name} burn time`
      );
    });
  }

  it('reproduces the TS engine warnings on every case', () => {
    for (const c of CASES) {
      expect(runWasm(wasmConfig(c)).warnings, c.name).toEqual(tsRun(c).warnings);
    }
  });
});

// =========================================================================
describe('KNDX golden reference (Step-3A constants, captured from engine.ts @ 3b474ea)', () => {
  // The TS engine reproduces these to 1e-9 (see engine.test.ts). The wasm core
  // integrates the same motor with RK4, so it is held to the trajectory
  // tolerances instead -- these are the numbers the port had to reproduce.
  const GOLDEN = {
    steps: 1202,
    peakPc: 8301390.079462577,
    peakThrust: 803.3165457222151,
    totalImpulse: 692.6263448509707,
    propMass: 0.6198205225899983,
    isp: 113.9494882210235,
    burnTime: 1.2019999999999784,
  };

  const kndx = (): BurnConfig => ({
    propellant: KNDX_PROP,
    grain: {
      kind: 'BATES',
      length: KNDX_GRAIN.length,
      outer_radius: KNDX_GRAIN.outerRadius,
      inner_radius: KNDX_GRAIN.innerRadius,
    },
    nozzle: { throat_diameter: KNDX_D_T, expansion_ratio: 1.0, material: null },
  });

  const propMass =
    Math.PI *
    (KNDX_GRAIN.outerRadius ** 2 - KNDX_GRAIN.innerRadius ** 2) *
    KNDX_GRAIN.length *
    KNDX.density;

  it('sizes the throat for an initial Kn of 200, as the golden case does', () => {
    const { results } = runWasm(kndx());
    expect(results[0].Ab / results[0].ThroatArea).toBeCloseTo(200.0, 1);
  });

  it('reproduces peak Pc and peak thrust', () => {
    const { results } = runWasm(kndx());
    expectWithin(peak(results, 'Pc'), GOLDEN.peakPc, 5e-4, 'golden peak Pc');
    expectWithin(peak(results, 'Thrust'), GOLDEN.peakThrust, 5e-4, 'golden peak thrust');
  });

  it('reproduces total impulse and Isp', () => {
    const { results } = runWasm(kndx());
    const impulse = totalImpulse(results);
    expectWithin(impulse, GOLDEN.totalImpulse, 5e-4, 'golden total impulse');
    expectWithin(impulse / (propMass * 9.80665), GOLDEN.isp, 5e-4, 'golden Isp');
    expectWithin(propMass, GOLDEN.propMass, 1e-12, 'propellant mass');
  });

  it('reproduces burn time and step count', () => {
    const { results } = runWasm(kndx());
    expectWithin(results[results.length - 1].Time, GOLDEN.burnTime, 5e-3, 'golden burn time');
    expectWithin(results.length, GOLDEN.steps, 5e-3, 'golden step count');
  });

  it('confirms the grain is progressive, matching the golden Kn sweep', () => {
    const { results } = runWasm(kndx());
    const maxKn = results.reduce((m, r) => Math.max(m, r.Ab / r.ThroatArea), -Infinity);
    expect(maxKn).toBeCloseTo(336.59, 1);
  });

  it('runs clean: no warnings, and the cumulative propellant generated is sane', () => {
    const { results, warnings } = runWasm(kndx());
    expect(warnings).toEqual([]);
    // Everything the grain can give, within the burnout tail's worth of web.
    const generated = results[results.length - 1].PropellantMassGen;
    expect(generated).toBeGreaterThan(0.95 * propMass);
    expect(generated).toBeLessThanOrEqual(propMass * 1.001);
  });
});

// =========================================================================
describe('physical invariants of the wasm output', () => {
  it('produces only finite, physically signed values on every case', () => {
    for (const c of CASES) {
      const { results } = runWasm(wasmConfig(c));
      for (const r of results) {
        expect(Number.isFinite(r.Pc), `${c.name} Pc`).toBe(true);
        expect(Number.isFinite(r.Thrust), `${c.name} Thrust`).toBe(true);
        expect(r.Pc, `${c.name} Pc`).toBeGreaterThan(0);
        expect(r.Thrust, `${c.name} Thrust`).toBeGreaterThanOrEqual(0);
        expect(r.Ab, `${c.name} Ab`).toBeGreaterThanOrEqual(0);
        expect(r.PortArea, `${c.name} PortArea`).toBeGreaterThanOrEqual(0);
        expect(r.y, `${c.name} y`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('advances time monotonically by exactly dt', () => {
    const { results } = runWasm(wasmConfig(CASES[0]));
    for (let i = 1; i < results.length; i++) {
      expect(results[i].Time - results[i - 1].Time).toBeCloseTo(SIM_DT, 12);
    }
  });

  it('honours the choked-flow guard: zero thrust below Pa * crit', () => {
    // Slow-building motor, so the subsonic ignition transient spans many steps.
    const gamma = 1.13;
    const crit = Math.pow((gamma + 1) / 2, gamma / (gamma - 1));
    const threshold = 101325.0 * crit;

    const { results } = runWasm({
      propellant: { ...KNDX_PROP, a: 4e-6 },
      grain: { kind: 'BATES', length: 0.2, outer_radius: 0.025, inner_radius: 0.01 },
      nozzle: { throat_diameter: 0.006, expansion_ratio: 1.0, material: null },
    });

    const unchoked = results.filter((r) => r.Pc < threshold);
    expect(unchoked.length).toBeGreaterThan(0); // the regime is actually exercised
    for (const r of unchoked) expect(r.Thrust).toBe(0);
    expect(results.some((r) => r.Pc < threshold && r.Thrust !== 0)).toBe(false);
  });

  it('erodes the graphite throat monotonically, and leaves it alone without a material', () => {
    const withMaterial = runWasm(wasmConfig(CASES.find((c) => c.material)!)).results;
    let prev = 0;
    for (const r of withMaterial) {
      expect(r.ThroatArea).toBeGreaterThanOrEqual(prev);
      prev = r.ThroatArea;
    }
    expect(withMaterial[withMaterial.length - 1].ThroatArea).toBeGreaterThan(
      withMaterial[0].ThroatArea
    );

    const inert = runWasm(wasmConfig(CASES[0])).results;
    for (const r of inert) expect(r.ThroatArea).toBe(inert[0].ThroatArea);
  });
});

// =========================================================================
describe('UI grain mapping: grainFromUi (TS) and grainConfigFromUi (wasm) agree', () => {
  /*
   * Both mappings turn the same editor fields into a grain, and the geometry
   * constructors take positional arguments whose meaning shifts between
   * geometries. When these two drift apart the app previews one grain and
   * simulates another, silently -- which is exactly what happened: the grain
   * editor passed Finocyl's fin DEPTH as its fin COUNT and the star-point count
   * as its fin HEIGHT, so with the app's defaults it previewed a grain with
   * 0.035 fins each 5 m tall while the solver ran the correct geometry.
   *
   * These compare the constructed values field by field, so a transposition in
   * either mapping fails here regardless of whether it changes a simulation.
   */

  /** The app's default grain inputs (src/AppDesktop.tsx useState initialisers). */
  const APP_DEFAULTS: Omit<GrainUiParams, 'grainType'> = {
    length: 0.5,
    outerRadius: 0.05,
    innerRadius: 0.02,
    valleyRadius: 0.03,
    tipRadius: 0.01,
    numPoints: 5,
    rodRadius: 0.01,
    offset: 0.01,
    finWidth: 0.01,
    finDepth: 0.035,
  };

  const DXF: DxfTables = { dx: DXF_DX, perimTable: DXF_PERIM, areaTable: DXF_AREA };

  /** Pull the shape-defining values off a TS grain, keyed to config field names. */
  const tsFields: Record<string, (g: any) => Record<string, unknown>> = {
    BATES: (g) => ({ inner_radius: g.inner_radius }),
    Tubular: (g) => ({ inner_radius: g.inner_radius }),
    Star: (g) => ({ valley_radius: g.valley_radius, tip_radius: g.tip_radius, num_points: g.N }),
    RodAndTube: (g) => ({ rod_radius: g.rod_radius, tube_inner_radius: g.tube_inner_radius }),
    MoonBurner: (g) => ({ core_radius: g.core_radius, offset: g.offset }),
    Finocyl: (g) => ({ r_tube: g.r_tube, num_fins: g.num_fins, w_fin: g.w_fin, h_fin: g.h_fin }),
    CustomDXF: (g) => ({ dx: g.dx, perim_table: g.perimTable, area_table: g.areaTable }),
  };

  for (const grainType of Object.keys(tsFields)) {
    it(`${grainType}: every constructor argument matches the core config`, () => {
      const params: GrainUiParams = { ...APP_DEFAULTS, grainType };
      const cfg = grainConfigFromUi(params, DXF) as Record<string, unknown>;
      const grain = grainFromUi(params, DXF) as any;

      expect(cfg.kind).toBe(grainType);
      expect(grain.length).toBe(cfg.length);
      expect(grain.outer_radius).toBe(cfg.outer_radius);

      const actual = tsFields[grainType](grain);
      for (const [field, value] of Object.entries(actual)) {
        expect(value, `${grainType}.${field}`).toEqual(cfg[field]);
      }
      // Guard against a config field with no counterpart checked above.
      const covered = new Set([...Object.keys(actual), 'kind', 'length', 'outer_radius']);
      expect(Object.keys(cfg).filter((k) => !covered.has(k))).toEqual([]);
    });
  }

  it('Finocyl reads fin count, width and depth from the right fields', () => {
    // The specific transposition, pinned in the plainest possible form: a fin
    // count is a small integer and a fin height is a length in metres, so these
    // two being swapped is both the easy mistake and an obvious one once named.
    const grain = grainFromUi({ ...APP_DEFAULTS, grainType: 'Finocyl' }) as any;
    expect(grain.num_fins).toBe(5); // not 0.035
    expect(grain.h_fin).toBe(0.035); // not 5
    expect(grain.w_fin).toBe(0.01);
    expect(grain.r_tube).toBe(0.02);
  });

  it('produces the same burning area as the wasm core for every geometry', () => {
    // The end-to-end version of the same claim: if a mapping is transposed, the
    // grain the UI previews and the grain the solver runs disagree on area.
    for (const grainType of Object.keys(tsFields)) {
      const params: GrainUiParams = { ...APP_DEFAULTS, grainType };
      const grain = grainFromUi(params, DXF);
      const { results } = runWasm({
        propellant: KNDX_PROP,
        grain: grainConfigFromUi(params, DXF),
        nozzle: { throat_diameter: 0.02, expansion_ratio: 1.0, material: null },
      });

      for (let i = 0; i < results.length; i++) {
        const yStart = i === 0 ? 0 : results[i - 1].y;
        const abTs = grain.get_burning_area(yStart);
        if (abTs > 0) {
          expect(Math.abs(results[i].Ab - abTs) / abTs, `${grainType} @ y=${yStart}`)
            .toBeLessThan(1e-12);
        }
      }
    }
  });
});

// =========================================================================
describe('unpackResults (the flat-buffer contract used by the worker)', () => {
  it('maps columns by name, not by position', () => {
    const raw: RawRunOutput = {
      // Deliberately shuffled relative to the documented order.
      fields: ['Pc', 'Time', 'Ab', 'Thrust', 'PortMassFlux', 'ThroatArea', 'PortArea', 'y', 'MassFlow', 'PropellantMassGen', 'PcNozzle'],
      rows: 1,
      data: new Float64Array([7, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11]),
      warnings: [],
    };
    const [r] = unpackResults(raw);
    expect(r.Pc).toBe(7);
    expect(r.Time).toBe(1);
    expect(r.Ab).toBe(2);
    expect(r.PcNozzle).toBe(11);
  });

  it('throws a rebuild hint if the core drops a column', () => {
    const raw: RawRunOutput = {
      fields: ['Time', 'Ab', 'Pc'],
      rows: 1,
      data: new Float64Array([0, 1, 2]),
      warnings: [],
    };
    expect(() => unpackResults(raw)).toThrow(/npm run wasm:build/);
  });

  it('round-trips a real run without changing a single value', () => {
    const raw = core.simulate(wasmConfig(CASES[0]));
    const rows = unpackResults(raw);
    const stride = raw.fields.length;
    for (let i = 0; i < raw.rows; i++) {
      expect(rows[i].Time).toBe(raw.data[i * stride]);
      expect(rows[i].PropellantMassGen).toBe(raw.data[i * stride + 9]);
    }
  });
});
