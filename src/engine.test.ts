import { describe, it, expect } from 'vitest';
import {
  SolidPropellant,
  BATES,
  Star,
  Finocyl,
  MotorSimulation,
  grainFromUi,
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
 * 2. test_star_grain_continuity is not portable as written. Its geometry never
 *    reaches the star->cylinder transition (y_transition=0.0280 > web=0.0200),
 *    so both sampled areas are 0.0 and its |a-b|/a is 0/0. The transition is
 *    also still slightly discontinuous -- see the residual-defect test below.
 *
 * ---------------------------------------------------------------------------
 * Star geometry accuracy (validated against ClipperLib polygon offsetting,
 * the same library dxfProcessor uses for CustomDXF grains)
 * ---------------------------------------------------------------------------
 *   star-phase perimeter : exact to <0.001%  (was 3-42% low, and TRENDING THE
 *                          WRONG WAY: burn area fell as the web burned back)
 *   star-phase port area : exact to <0.01%   (was 88-280% high)
 *   post-transition      : perimeter up to ~15% low at the transition,
 *                          converging to <1% within a few mm of web
 *   transition jump      : 0.6-15.3% depending on geometry (was 107-296%)
 *
 * For the app's default star (Ro=0.05, Rv=0.03, Rt=0.01, N=5) the transition
 * is never reached, so the model is exact over the entire burn.
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

  it('starts at the exact star-polygon area N*Rv*Rt*sin(theta)', () => {
    const theta = Math.PI / N;
    const expected = N * valleyRadius * tipRadius * Math.sin(theta);
    expectRelClose(star.get_port_area(0), expected, 1e-12);
    expect(expected).toBeCloseTo(8.816778784e-4, 12);
  });

  it('matches the closed form obtained by integrating dA/dy = perimeter(y)', () => {
    const A0 = N * valleyRadius * tipRadius * Math.sin(Math.PI / N);
    for (const y of [0, 0.002, 0.005, 0.008, 0.012]) {
      const expected =
        A0 +
        2 * N * star.initial_straight_length * y +
        N * y * y * (star.point_exterior_angle / 2 - 1 / Math.tan(star.epsilon));
      expectRelClose(star.get_port_area(y), expected, 1e-12);
    }
  });

  it('satisfies dA/dy = perimeter (internal consistency of area and burn area)', () => {
    const h = 1e-7;
    for (const y of [0.002, 0.008, 0.014]) {
      const dAdy = (star.get_port_area(y + h) - star.get_port_area(y - h)) / (2 * h);
      const perimeter = star.get_burning_area(y) / length;
      expectRelClose(dAdy, perimeter, 1e-8);
    }
  });

  it('never exceeds the casing circle area', () => {
    const outerArea = Math.PI * outerRadius ** 2;
    for (let y = 0; y <= outerRadius - valleyRadius; y += 0.001) {
      expect(star.get_port_area(y)).toBeLessThanOrEqual(outerArea + 1e-12);
    }
  });

  it('port area increases monotonically with web', () => {
    let prev = -Infinity;
    for (let y = 0; y < outerRadius - valleyRadius; y += 0.0005) {
      const a = star.get_port_area(y);
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });

  // Independent ground truth: exact polygon offsetting of the star cross-section,
  // computed with ClipperLib (the same library dxfProcessor uses). Values are
  // hard-coded so the test needs no geometry dependency of its own.
  it('matches ClipperLib polygon-offset ground truth for perimeter and area', () => {
    const GROUND_TRUTH: Array<[number, number, number]> = [
      // [ y, perimeter (m), port area (m^2) ]
      [0.0, 0.226845552, 8.816814306e-4],
      [0.005, 0.251816320, 2.078330385e-3],
      [0.01, 0.276786753, 3.399841496e-3],
      [0.015, 0.301757354, 4.846200857e-3],
      [0.0199, 0.326228992, 6.384763385e-3],
    ];
    for (const [y, perim, area] of GROUND_TRUTH) {
      expectRelClose(star.get_burning_area(y) / length, perim, 1e-5);
      expectRelClose(star.get_port_area(y), area, 1e-5);
    }
  });

  it('burning area increases with web (it previously decreased, which was wrong)', () => {
    let prev = -Infinity;
    for (let y = 0; y < outerRadius - valleyRadius; y += 0.0005) {
      const a = star.get_burning_area(y);
      expect(a).toBeGreaterThan(prev);
      prev = a;
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

  it.fails('RESIDUAL DEFECT: transition jump is reduced but still not < 1%', () => {
    // Originally the star branch used 2*pi*y for the tip arcs, giving a jump of
    // 2*pi*valley_radius (107-296% depending on geometry). The star branch is
    // now exact, so the whole remaining jump is the post-transition cylinder
    // approximation undershooting the true offset perimeter: 9.70% here.
    // Closing it fully needs a model of the merging star-point arcs.
    // Kept as it.fails so the suite stays green while tracking the residual:
    // when the post-transition branch is modelled properly, THIS TEST WILL
    // START FAILING and should become a normal passing test.
    const s = new Star(0.4, 0.05, 0.03, 0.01, 8); // N=8 so the transition is reachable
    const yT = s.initial_straight_length * Math.tan(s.epsilon);
    const before = s.get_burning_area(yT - 1e-7);
    const after = s.get_burning_area(yT + 1e-7);
    expect(Math.abs(before - after) / before).toBeLessThan(0.01);
  });

  it('pins the residual transition jump, much smaller than before the fix', () => {
    // Locks in present behaviour so a Rust port reproduces it, and makes the
    // magnitude visible if anyone changes the model.
    const s = new Star(0.4, 0.05, 0.03, 0.01, 8);
    const yT = s.initial_straight_length * Math.tan(s.epsilon);
    expect(yT).toBeLessThan(0.05 - 0.03); // transition IS reachable here
    const before = s.get_burning_area(yT - 1e-7);
    const after = s.get_burning_area(yT + 1e-7);
    const jump = Math.abs(before - after) / before;

    expect(jump).toBeCloseTo(0.0970, 3); // was 2.193 (219%) before the fix
    expect(jump).toBeLessThan(0.16);
  });

  it('exposes the star-point exterior angle used for the tip arcs', () => {
    // The core of the fix: the arc term is N*tau_c*y, not the convex-polygon
    // Steiner term 2*pi*y. For N=5 the star points are sharp (interior 30 deg).
    const s = new Star(0.4, 0.05, 0.03, 0.01, 5);
    expect((s.point_exterior_angle * 180) / Math.PI).toBeCloseTo(149.965, 3);
    expect(5 * s.point_exterior_angle).toBeGreaterThan(2 * Math.PI); // 13.09 vs 6.28
  });
});

// =========================================================================
describe('Finocyl at the app defaults (guards the UI argument mapping)', () => {
  /*
   * The grain editor used to build Finocyl grains as
   *   new Finocyl(length, outerRadius, innerRadius, finDepth, finWidth, numPoints)
   * against a constructor of
   *   (length, outer_radius, r_tube, num_fins, w_fin, h_fin)
   * so the fin DEPTH arrived as the fin COUNT and the star-point count as the
   * fin HEIGHT. With these defaults that is 0.035 fins, each 5 m tall, which
   * made the previewed cross-section and its area curves meaningless while the
   * solver -- which mapped the fields correctly -- stayed right.
   *
   * Both mappings now go through grainFromUi, so these values are built the way
   * the app builds them. src/wasm.parity.test.ts additionally cross-checks
   * grainFromUi against the wasm core's grainConfigFromUi field by field.
   */
  const DEFAULTS = {
    grainType: 'Finocyl',
    length: 0.5,
    outerRadius: 0.05,
    innerRadius: 0.02, // r_tube
    numPoints: 5, // num_fins
    finWidth: 0.01, // w_fin
    finDepth: 0.035, // h_fin
  };
  const grain = grainFromUi(DEFAULTS) as Finocyl;

  it('assigns each editor field to the constructor argument it names', () => {
    expect(grain.r_tube).toBe(0.02);
    expect(grain.num_fins).toBe(5);
    expect(grain.w_fin).toBe(0.01);
    expect(grain.h_fin).toBe(0.035);
  });

  it('starts past the fins-reach-the-casing transition, as these defaults imply', () => {
    // r_tube + h_fin = 0.055 > outer_radius = 0.05, so the slots are already
    // against the casing at y = 0 and the whole burn runs in the second phase.
    expect(grain.r_tube + grain.h_fin).toBeGreaterThan(grain.outer_radius);
  });

  it('matches the closed-form burning area at y = 0', () => {
    // Phase 2: perimeter = 2*pi*r_bore - N*w_current + 2*N*effective_h
    const perimeter = 2 * Math.PI * 0.02 - 5 * 0.01 + 2 * 5 * (0.05 - 0.02);
    expectRelClose(grain.get_burning_area(0), perimeter * 0.5, 1e-12);
    expect(grain.get_burning_area(0)).toBeCloseTo(0.18783185, 8);
  });

  it('matches the closed-form burning area part-way through the web', () => {
    const y = 0.005;
    const r_bore = 0.02 + y;
    const w_current = 0.01 + 2 * y;
    const perimeter = 2 * Math.PI * r_bore - 5 * w_current + 2 * 5 * (0.05 - r_bore);
    expectRelClose(grain.get_burning_area(y), perimeter * 0.5, 1e-12);
    expect(grain.get_burning_area(y)).toBeCloseTo(0.15353982, 8);
  });

  it('matches the closed-form port area at y = 0', () => {
    // Bore circle plus N rectangular slots, the slots clipped at the casing.
    const expected = Math.PI * 0.02 ** 2 + 5 * (0.05 - 0.02) * 0.01;
    expectRelClose(grain.get_port_area(0), expected, 1e-12);
    expect(grain.get_port_area(0)).toBeCloseTo(0.00275664, 8);
  });

  it('never reports a negative burning area as the widening slots consume the bore', () => {
    // w_current grows as w_fin + 2y, so late in the web N*w_current exceeds the
    // bore circumference and the raw perimeter goes negative. The model clamps
    // at zero rather than reporting negative area; pinned so the clamp stays.
    expect(grain.get_burning_area(0.0299)).toBe(0);
    for (let y = 0; y <= 0.03; y += 0.001) {
      expect(grain.get_burning_area(y)).toBeGreaterThanOrEqual(0);
    }
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
