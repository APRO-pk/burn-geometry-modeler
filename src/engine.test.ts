import { describe, it, expect } from 'vitest';
import {
  SolidPropellant,
  BATES,
  Star,
  MotorSimulation,
  export_to_eng,
  SIM_DT,
} from './engine';
import type { SimulationResult } from './engine';

/*
 * ============================================================================
 * GOLDEN REFERENCE (TS engine, pre-Rust)
 * ============================================================================
 *
 * Captured from src/engine.ts at commit 3b474ea, dt = SIM_DT = 0.001 s.
 * These numbers define the behaviour a Rust port must reproduce.
 *
 * Case: KNDX / BATES  (Nakka KNDX values, from reference/legacy-python)
 *   propellant : density=1879 kg/m^3, a=8.875e-5 (SI, Pc in Pa), n=0.32,
 *                flame_temp=1720 K, gamma=1.13, molecular_weight=0.042 kg/mol
 *   grain      : BATES length=0.2 m, outer_radius=0.025 m, inner_radius=0.01 m
 *   nozzle     : throat sized for initial Kn=200 -> D_t=0.01004988 m,
 *                expansion_ratio=1.0, no nozzle material (non-eroding throat)
 *   no igniter, no erosive burning, efficiencies left at unity
 *
 *   derived    : C_D            = 1.087522e-3
 *                Kn initial     = 200.00
 *                Kn max         = 336.59   (grain is PROGRESSIVE)
 *                propellant mass= 0.6198205225899983 kg
 *
 *   GOLDEN     : steps          = 1202
 *                peak Pc        = 8301390.079462577 Pa   (8.301390 MPa)
 *                peak thrust    = 803.3165457222151 N
 *                total impulse  = 692.6263448509707 N-s
 *                Isp            = 113.9494882210235 s
 *                burn time      = 1.2019999999999784 s
 *
 * ---------------------------------------------------------------------------
 * Deviations from reference/legacy-python/test_apro_modeler.py, and why
 * ---------------------------------------------------------------------------
 * 1. test_pressure_equilibrium_kndx compared PEAK Pc against the equilibrium
 *    pressure computed from the INITIAL Kn. That is only valid for a neutral
 *    grain. This BATES is progressive (Kn 200 -> 336.59), so peak Pc exceeds
 *    the initial-Kn equilibrium by +109%. Ported here in corrected form:
 *    peak Pc is compared against the equilibrium at PEAK Kn (agrees to 2.6%),
 *    plus a stronger quasi-steady invariant across the whole burn.
 *
 * 2. test_star_grain_continuity is not portable as written -- see the
 *    "KNOWN DEFECT" test below. Its geometry never reaches the star->cylinder
 *    transition (y_transition=0.0280 > web=0.0200), so both sampled areas are
 *    0.0 and its |a-b|/a is 0/0. Separately, the transition in the current
 *    engine is genuinely discontinuous, so a "<1% jump" assertion cannot pass
 *    for ANY geometry (240 reachable-transition geometries scanned, 0 under 1%).
 * ============================================================================
 */

/** Relative-closeness helper: golden comparisons are tight by design. */
function expectRelClose(actual: number, expected: number, relTol = 1e-9) {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(relTol);
}

// --- Nakka KNDX reference case, shared by several tests -------------------
const KNDX = {
  density: 1879,
  a: 8.875e-5,
  n: 0.32,
  flameTemp: 1720,
  gamma: 1.13,
  molWeight: 0.042,
};
const KNDX_GRAIN = { length: 0.2, outerRadius: 0.025, innerRadius: 0.01 };
const KN_TARGET = 200.0;

function makeKndxProp() {
  return new SolidPropellant(
    KNDX.density, KNDX.a, KNDX.n, KNDX.flameTemp, KNDX.gamma, KNDX.molWeight
  );
}

function runKndxMotor() {
  const prop = makeKndxProp();
  const grain = new BATES(KNDX_GRAIN.length, KNDX_GRAIN.outerRadius, KNDX_GRAIN.innerRadius);
  const At = grain.get_burning_area(0) / KN_TARGET;
  const D_t = Math.sqrt((4 * At) / Math.PI);
  const sim = new MotorSimulation(prop, grain, SIM_DT);
  sim.set_nozzle(D_t, 1.0, null);
  const { results, warnings } = sim.run();

  let totalImpulse = 0;
  for (let i = 1; i < results.length; i++) {
    totalImpulse +=
      ((results[i].Thrust + results[i - 1].Thrust) / 2) * (results[i].Time - results[i - 1].Time);
  }
  const propVol =
    Math.PI * (KNDX_GRAIN.outerRadius ** 2 - KNDX_GRAIN.innerRadius ** 2) * KNDX_GRAIN.length;
  const propMass = propVol * KNDX.density;

  return {
    prop, results, warnings, D_t, totalImpulse, propMass,
    peakPc: results.reduce((m, r) => Math.max(m, r.Pc), -Infinity),
    peakThrust: results.reduce((m, r) => Math.max(m, r.Thrust), -Infinity),
    isp: totalImpulse / (propMass * 9.80665),
    burnTime: results[results.length - 1].Time,
  };
}

/** Equilibrium chamber pressure for a given Kn (efficiencies at unity). */
function pcEquilibrium(prop: SolidPropellant, Kn: number) {
  return Math.pow(((prop.density * prop.a) / prop.C_D) * Kn, 1 / (1 - prop.n));
}

// =========================================================================
describe('BATES grain geometry (ported: test_bates_grain_area)', () => {
  const length = 0.4;
  const outerRadius = 0.05;
  const innerRadius = 0.015;
  const web = outerRadius - innerRadius;
  const grain = new BATES(length, outerRadius, innerRadius);

  it('matches the closed form at y = 0', () => {
    const expected =
      2 * Math.PI * innerRadius * length + 2 * Math.PI * (outerRadius ** 2 - innerRadius ** 2);
    expectRelClose(grain.get_burning_area(0), expected, 1e-5);
  });

  it('matches the closed form at y = web / 2', () => {
    const y = web / 2;
    const r = innerRadius + y;
    const l = length - 2 * y;
    const expected = 2 * Math.PI * r * l + 2 * Math.PI * (outerRadius ** 2 - r ** 2);
    expectRelClose(grain.get_burning_area(y), expected, 1e-5);
  });

  it('is exactly zero at y = web (burnout)', () => {
    expect(grain.get_burning_area(web)).toBe(0.0);
  });

  it('port area grows as the bore regresses and never exceeds the casing circle', () => {
    const outerArea = Math.PI * outerRadius ** 2;
    let prev = -Infinity;
    for (let y = 0; y <= web; y += web / 20) {
      const a = grain.get_port_area(y);
      expect(a).toBeGreaterThan(prev);
      expect(a).toBeLessThanOrEqual(outerArea + 1e-12);
      prev = a;
    }
  });
});

// =========================================================================
describe('Star grain port area (Step-2 regression: two-phase model)', () => {
  const length = 0.4;
  const outerRadius = 0.05;
  const valleyRadius = 0.03;
  const tipRadius = 0.01;
  const N = 5;
  const star = new Star(length, outerRadius, valleyRadius, tipRadius, N);

  it('is strictly less than the circumscribing circle during the star phase', () => {
    // Before the Step-2 fix this returned PI*(Rv+y)^2 exactly, which
    // overestimated port area and under-triggered erosive burning.
    for (const y of [0, 0.002, 0.005, 0.008, 0.0095]) {
      const portArea = star.get_port_area(y);
      const circle = Math.PI * (valleyRadius + y) ** 2;
      expect(portArea).toBeLessThan(circle);
    }
  });

  it('equals the star-polygon closed form N*r^2*sin(2*theta)/2', () => {
    const theta = Math.PI / N;
    for (const y of [0, 0.002, 0.005, 0.008]) {
      const rMean = valleyRadius + y;
      const expected = (N * rMean ** 2 * Math.sin(2 * theta)) / 2;
      expectRelClose(star.get_port_area(y), expected, 1e-12);
    }
  });

  it('holds a constant ratio to the circumscribing circle of N*sin(2*theta)/(2*pi)', () => {
    const theta = Math.PI / N;
    const expectedRatio = (N * Math.sin(2 * theta)) / (2 * Math.PI); // 0.7568 for N=5
    for (const y of [0, 0.003, 0.007]) {
      const ratio = star.get_port_area(y) / (Math.PI * (valleyRadius + y) ** 2);
      expectRelClose(ratio, expectedRatio, 1e-12);
    }
    expect(expectedRatio).toBeCloseTo(0.756827, 6);
  });

  it('never exceeds the casing circle area', () => {
    const outerArea = Math.PI * outerRadius ** 2;
    for (let y = 0; y <= outerRadius - valleyRadius; y += 0.001) {
      expect(star.get_port_area(y)).toBeLessThanOrEqual(outerArea + 1e-12);
    }
  });
});

// =========================================================================
describe('Star grain burning-area transition', () => {
  it('legacy test geometry never reaches the star->cylinder transition', () => {
    // Documents why test_star_grain_continuity could not be ported verbatim:
    // its own geometry burns out before the transition, so both samples are 0.
    const s = new Star(0.4, 0.05, 0.03, 0.01, 5);
    const yTransition = s.initial_straight_length * Math.tan(s.epsilon);
    const web = 0.05 - 0.03;
    expect(yTransition).toBeGreaterThan(web);
    expect(s.get_burning_area(yTransition - 1e-7)).toBe(0);
    expect(s.get_burning_area(yTransition + 1e-7)).toBe(0);
  });

  it.fails('KNOWN DEFECT: transition is discontinuous, so jump is NOT < 1%', () => {
    // The requested regression case. It cannot pass against the current
    // engine: the star branch gives perimeter 2*N*l_straight + 2*pi*y, which
    // tends to 2*pi*y as l_straight -> 0, while the cylinder branch gives
    // 2*pi*(Rv + y). The perimeter therefore jumps by exactly 2*pi*Rv.
    // Marked it.fails so the suite stays green while tracking the defect:
    // when get_burning_area is made continuous, THIS TEST WILL START FAILING
    // and should be converted to a normal passing test.
    const s = new Star(0.4, 0.05, 0.03, 0.01, 8); // N=8 so the transition is reachable
    const yT = s.initial_straight_length * Math.tan(s.epsilon);
    const before = s.get_burning_area(yT - 1e-7);
    const after = s.get_burning_area(yT + 1e-7);
    expect(Math.abs(before - after) / before).toBeLessThan(0.01);
  });

  it('quantifies the current discontinuity as exactly 2*pi*valley_radius of perimeter', () => {
    // Locks in present behaviour so a Rust port reproduces it verbatim, and
    // so the magnitude is visible if anyone changes the model.
    const length = 0.4;
    const valleyRadius = 0.03;
    const s = new Star(length, 0.05, valleyRadius, 0.01, 8);
    const yT = s.initial_straight_length * Math.tan(s.epsilon);
    const before = s.get_burning_area(yT - 1e-7);
    const after = s.get_burning_area(yT + 1e-7);

    expect(yT).toBeLessThan(0.05 - valleyRadius); // transition IS reachable here
    const perimeterJump = (after - before) / length;
    expectRelClose(perimeterJump, 2 * Math.PI * valleyRadius, 1e-4);
    expect(Math.abs(before - after) / before).toBeGreaterThan(2.0); // ~219%
  });
});

// =========================================================================
describe('KNDX pressure equilibrium (ported+corrected: test_pressure_equilibrium_kndx)', () => {
  it('sizes the throat for an initial Kn of 200', () => {
    const m = runKndxMotor();
    expectRelClose(m.D_t, 0.01004988, 1e-6);
    const kn0 = m.results[0].Ab / m.results[0].ThroatArea;
    expect(kn0).toBeCloseTo(KN_TARGET, 1);
  });

  it('confirms the grain is progressive, which invalidates the legacy assertion', () => {
    const m = runKndxMotor();
    const kn0 = m.results[0].Ab / m.results[0].ThroatArea;
    const maxKn = m.results.reduce((mx, r) => Math.max(mx, r.Ab / r.ThroatArea), -Infinity);
    expect(maxKn).toBeGreaterThan(kn0 * 1.5);
    expect(maxKn).toBeCloseTo(336.59, 1);

    // The legacy assertion (peak Pc vs initial-Kn equilibrium, rel=0.1) misses badly.
    const legacyTheoretical = pcEquilibrium(m.prop, KN_TARGET);
    expect(Math.abs(m.peakPc - legacyTheoretical) / legacyTheoretical).toBeGreaterThan(1.0);
  });

  it('peak Pc matches the equilibrium pressure at PEAK Kn within 10%', () => {
    const m = runKndxMotor();
    const maxKn = m.results.reduce((mx, r) => Math.max(mx, r.Ab / r.ThroatArea), -Infinity);
    const theoretical = pcEquilibrium(m.prop, maxKn);
    expect(Math.abs(m.peakPc - theoretical) / theoretical).toBeLessThan(0.1);
  });

  it('tracks the quasi-steady equilibrium within 3% across the whole burn', () => {
    const m = runKndxMotor();
    let worst = 0;
    for (const r of m.results) {
      if (r.Time < 0.05 || r.Ab <= 0) continue; // skip fill transient and burnout tail
      const eq = pcEquilibrium(m.prop, r.Ab / r.ThroatArea);
      worst = Math.max(worst, Math.abs(r.Pc - eq) / eq);
    }
    expect(worst).toBeLessThan(0.03);
  });
});

// =========================================================================
describe('KNDX full motor run', () => {
  it('produces physically sane results', () => {
    const m = runKndxMotor();
    expect(m.results.length).toBeGreaterThan(100);
    expect(m.warnings).toEqual([]);

    expect(m.peakPc).toBeGreaterThan(1e6); // > 1 MPa
    expect(m.peakPc).toBeLessThan(20e6); // < 20 MPa
    expect(m.totalImpulse).toBeGreaterThan(100);
    expect(m.totalImpulse).toBeLessThan(2000);
    expect(m.isp).toBeGreaterThan(80); // KNDX real-world Isp is ~110-130 s
    expect(m.isp).toBeLessThan(160);
    expect(m.burnTime).toBeGreaterThan(0.1);
    expect(m.burnTime).toBeLessThan(10);

    // Physical invariants that must hold for every sample.
    for (const r of m.results) {
      expect(Number.isFinite(r.Pc)).toBe(true);
      expect(Number.isFinite(r.Thrust)).toBe(true);
      expect(r.Pc).toBeGreaterThan(0);
      expect(r.Thrust).toBeGreaterThanOrEqual(0);
    }
  });

  it('GOLDEN SNAPSHOT: peak Pc, total impulse, Isp, burn time', () => {
    const m = runKndxMotor();
    expect(m.results.length).toBe(1202);
    expectRelClose(m.peakPc, 8301390.079462577);
    expectRelClose(m.peakThrust, 803.3165457222151);
    expectRelClose(m.totalImpulse, 692.6263448509707);
    expectRelClose(m.propMass, 0.6198205225899983);
    expectRelClose(m.isp, 113.9494882210235);
    expectRelClose(m.burnTime, 1.2019999999999784);
  });
});

// =========================================================================
describe('Choked-flow guard (Step-2 regression)', () => {
  // Slow-building motor chosen so the ignition transient spans many steps and
  // both the unchoked and choked regimes are exercised.
  const gamma = 1.13;
  const crit = Math.pow((gamma + 1) / 2, gamma / (gamma - 1));

  function runSlowMotor() {
    const prop = new SolidPropellant(1879, 4e-6, 0.32, 1720, gamma, 0.042);
    const sim = new MotorSimulation(prop, new BATES(0.2, 0.025, 0.01), SIM_DT);
    sim.set_nozzle(0.006, 1.0, null);
    return { sim, ...sim.run() };
  }

  it('uses the correct critical pressure ratio', () => {
    expect(crit).toBeCloseTo(1.728746, 6);
  });

  it('reports exactly zero thrust while Pc < Pa * crit', () => {
    const { results, sim } = runSlowMotor();
    const threshold = sim.Pa * crit;
    const unchoked = results.filter((r) => r.Pc < threshold);
    expect(unchoked.length).toBeGreaterThan(0); // regime is actually exercised
    for (const r of unchoked) expect(r.Thrust).toBe(0);
  });

  it('reports nonzero thrust once choked, and transitions exactly at the threshold', () => {
    const { results, sim } = runSlowMotor();
    const threshold = sim.Pa * crit;
    const firstNonzero = results.findIndex((r) => r.Thrust > 0);

    expect(firstNonzero).toBe(18);
    expect(results[firstNonzero - 1].Pc).toBeLessThan(threshold);
    expect(results[firstNonzero].Pc).toBeGreaterThanOrEqual(threshold);

    // Monotone: all zero before, all nonzero from that index on.
    for (let i = 0; i < firstNonzero; i++) expect(results[i].Thrust).toBe(0);
    for (let i = firstNonzero; i < results.length; i++) expect(results[i].Thrust).toBeGreaterThan(0);
  });

  it('never reports nonzero thrust below the threshold (global invariant)', () => {
    const { results, sim } = runSlowMotor();
    const threshold = sim.Pa * crit;
    expect(results.some((r) => r.Pc < threshold && r.Thrust !== 0)).toBe(false);
  });
});

// =========================================================================
describe('.eng export (ported: test_eng_export_compliance)', () => {
  function row(Time: number, Thrust: number): SimulationResult {
    return {
      Time, Thrust, Ab: 0, Pc: 0, PortMassFlux: 0, ThroatArea: 0,
      PortArea: 0, y: 0, MassFlow: 0, PropellantMassGen: 0,
    };
  }

  it('writes a RASP-style header with propellant mass then initial mass', () => {
    const content = export_to_eng([row(0, 0), row(0.1, 100), row(0.2, 0)], 1.5, 0.5, 'TEST-MOTOR');
    const lines = content.split('\n');
    expect(lines[1]).toContain('TEST-MOTOR');
    expect(lines[1]).toContain('0.5000 1.5000');
  });

  it('writes the sampled thrust curve and a terminating zero-thrust point', () => {
    const content = export_to_eng([row(0, 0), row(0.1, 100), row(0.2, 0)], 1.5, 0.5, 'TEST-MOTOR');
    const lines = content.split('\n');
    expect(lines[2]).toBe('0.0000 0.0000');
    expect(lines[3]).toBe('0.1000 100.0000');
    expect(lines[4]).toBe('0.2000 0.0000');
    expect(lines[5]).toBe('0.2100 0.0000'); // last_time + 0.01
  });

  it('downsamples long result sets to at most ~501 points', () => {
    const many = Array.from({ length: 5000 }, (_, i) => row(i * 0.001, 100));
    const dataLines = export_to_eng(many, 1.5, 0.5, 'BIG')
      .split('\n')
      .filter((l) => l && !l.startsWith(';') && !l.startsWith('BIG'));
    expect(dataLines.length).toBeLessThanOrEqual(501);
  });
});
