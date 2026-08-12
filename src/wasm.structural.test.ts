import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StructuralConfig, StructuralResult } from './wasmCore';

/*
 * ============================================================================
 * STEP-4B: closed-form pressure-vessel mechanics
 * ============================================================================
 *
 * These replace a function that computed "max bending stress" as
 *
 *     const max_bending_stress = 1.3 * hoop_stress; // approximation for visual proxy
 *
 * The Lame solution is exact elasticity, so the textbook cases below are
 * asserted to floating-point precision rather than the 1e-3 the brief asks for
 * -- there is no approximation left to absorb a looser tolerance, and anything
 * that moves these numbers at all is a genuine regression.
 *
 * Hand-worked case A (a = 0.1 m, b = 0.2 m, p = 100 MPa, closed end):
 *   k          = p a^2/(b^2-a^2) = 100 * 0.01/0.03      =  33.333333 MPa
 *   hoop(a)    = p (b^2+a^2)/(b^2-a^2) = 100*0.05/0.03  = 166.666667 MPa
 *   radial(a)  = -p                                     = -100       MPa
 *   hoop(b)    = 2 p a^2/(b^2-a^2) = 200*0.01/0.03      =  66.666667 MPa
 *   radial(b)  = 0
 *   axial      = k                                      =  33.333333 MPa
 *   vonMises(a): principals (166.667, -100, 33.333)
 *     = sqrt(0.5 * (266.667^2 + 133.333^2 + 133.333^2)) = 230.940108 MPa
 *
 * Hand-worked case B (a = 0.02 m, b = 0.03 m, p = 50 MPa):
 *   k = 50*0.0004/0.0005 = 40 MPa
 *   hoop(a) = 50*0.0013/0.0005 = 130 MPa ; radial(a) = -50 ; hoop(b) = 80
 *   axial = 40 ; vonMises(a) = sqrt(0.5*(180^2+90^2+90^2)) = 155.884573 MPa
 * ============================================================================
 */

const require = createRequire(import.meta.url);
const PKG_NODE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../crates/burn-core/pkg-node/burn_core.js'
);

interface BurnCore {
  analyze_structure(config: StructuralConfig): StructuralResult;
  required_wall_thickness(
    maxPressure: number,
    innerRadius: number,
    safetyFactor: number,
    yieldStress: number
  ): number;
}

const core: BurnCore = (() => {
  try {
    return require(PKG_NODE) as BurnCore;
  } catch (err) {
    throw new Error(
      `Could not load the compiled burn-core wasm at ${PKG_NODE}. Rebuild with: npm run wasm:build\n` +
        `(underlying error: ${err instanceof Error ? err.message : String(err)})`
    );
  }
})();

const MPa = 1e6;

function analyze(over: Partial<StructuralConfig> = {}): StructuralResult {
  return core.analyze_structure({
    max_pressure: 6 * MPa,
    inner_radius: 0.05,
    wall_thickness: 0.003,
    yield_stress: 276 * MPa,
    youngs_modulus: 69e9,
    poissons_ratio: 0.33,
    material: 'Al 6061-T6',
    ...over,
  });
}

/** Independent von Mises, so the test does not lean on the core's own helper. */
function vonMises(h: number, r: number, a: number) {
  return Math.sqrt(0.5 * ((h - r) ** 2 + (r - a) ** 2 + (a - h) ** 2));
}

function expectClose(actual: number, expected: number, relTol: number, what: string) {
  const rel = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-30);
  expect(rel, `${what}: ${actual} vs ${expected} (rel ${rel.toExponential(3)})`)
    .toBeLessThan(relTol);
}

// =========================================================================
describe('Lame thick-wall cylinder vs hand-worked textbook cases', () => {
  const A = analyze({
    max_pressure: 100 * MPa,
    inner_radius: 0.1,
    wall_thickness: 0.1, // b = 0.2
    yield_stress: 300 * MPa,
    youngs_modulus: 200e9,
    poissons_ratio: 0.3,
    material: 'Steel 4130',
  });

  it('case A: inner-wall hoop, radial and axial stresses', () => {
    expectClose(A.lame.inner.hoop, 166.666666666667 * MPa, 1e-12, 'hoop(a)');
    expectClose(A.lame.inner.radial, -100 * MPa, 1e-12, 'radial(a)');
    expectClose(A.lame.axial, 33.333333333333 * MPa, 1e-12, 'axial');
  });

  it('case A: outer-wall stresses', () => {
    expectClose(A.lame.outer.hoop, 66.666666666667 * MPa, 1e-12, 'hoop(b)');
    expect(Math.abs(A.lame.outer.radial)).toBeLessThan(1e-6); // exactly zero
  });

  it('case A: von Mises at the bore', () => {
    expectClose(A.lame.inner.vonMises, 230.940107675850 * MPa, 1e-12, 'vonMises(a)');
    // And it agrees with an independent evaluation of the same principals.
    expectClose(
      A.lame.inner.vonMises,
      vonMises(A.lame.inner.hoop, A.lame.inner.radial, A.lame.axial),
      1e-12,
      'vonMises consistency'
    );
  });

  const B = analyze({
    max_pressure: 50 * MPa,
    inner_radius: 0.02,
    wall_thickness: 0.01, // b = 0.03
    yield_stress: 300 * MPa,
    youngs_modulus: 200e9,
    poissons_ratio: 0.3,
    material: 'Steel 4130',
  });

  it('case B: a second radius ratio, worked independently', () => {
    expectClose(B.lame.inner.hoop, 130 * MPa, 1e-12, 'hoop(a)');
    expectClose(B.lame.inner.radial, -50 * MPa, 1e-12, 'radial(a)');
    expectClose(B.lame.outer.hoop, 80 * MPa, 1e-12, 'hoop(b)');
    expectClose(B.lame.axial, 40 * MPa, 1e-12, 'axial');
    expectClose(B.lame.inner.vonMises, 155.884572681199 * MPa, 1e-12, 'vonMises(a)');
  });
});

// =========================================================================
describe('Lame: analytic invariants that must hold at any radius ratio', () => {
  const cases = [
    { p: 6 * MPa, a: 0.05, t: 0.003 },
    { p: 100 * MPa, a: 0.1, t: 0.1 },
    { p: 20 * MPa, a: 0.03, t: 0.0005 },
    { p: 1 * MPa, a: 0.2, t: 0.05 },
  ];

  for (const { p, a, t } of cases) {
    const r = analyze({ max_pressure: p, inner_radius: a, wall_thickness: t });
    const b = a + t;
    const label = `p=${p / MPa}MPa a=${a} t=${t}`;

    it(`${label}: radial stress equals -p at the bore and 0 at the outside`, () => {
      // Boundary conditions of the elasticity problem -- these are not fitted,
      // they must fall out of the solution.
      expectClose(r.lame.inner.radial, -p, 1e-12, 'radial(a)');
      expect(Math.abs(r.lame.outer.radial)).toBeLessThan(p * 1e-12);
    });

    it(`${label}: axial stress satisfies closed-end force balance`, () => {
      // sigma_z * pi(b^2 - a^2) = p * pi a^2
      expectClose(r.lame.axial * (b * b - a * a), p * a * a, 1e-12, 'axial force balance');
    });

    it(`${label}: hoop + radial is constant through the wall (Lame invariant)`, () => {
      const sum0 = r.lame.profile.hoop[0] + r.lame.profile.radial[0];
      for (let i = 1; i < r.lame.profile.hoop.length; i++) {
        expectClose(
          r.lame.profile.hoop[i] + r.lame.profile.radial[i],
          sum0,
          1e-10,
          `hoop+radial at station ${i}`
        );
      }
    });

    it(`${label}: hoop stress is highest at the bore and falls monotonically`, () => {
      const { hoop } = r.lame.profile;
      for (let i = 1; i < hoop.length; i++) {
        expect(hoop[i], `hoop at station ${i}`).toBeLessThan(hoop[i - 1]);
      }
      expect(r.lame.inner.hoop).toBe(hoop[0]);
      expect(r.lame.outer.hoop).toBe(hoop[hoop.length - 1]);
    });
  }
});

// =========================================================================
describe('thin-wall regime reporting', () => {
  it('converges on pR/t as the wall gets thin, and says the approximation holds', () => {
    const r = analyze({ max_pressure: 10 * MPa, inner_radius: 0.05, wall_thickness: 0.0005 });
    expect(r.lame.rMeanOverT).toBeGreaterThan(10);
    expect(r.lame.thinWallApplicable).toBe(true);
    expect(Math.abs(r.lame.thinWallError)).toBeLessThan(1e-3); // <0.1%
    expect(r.assumptions.some((a) => /Thin-wall regime/.test(a))).toBe(true);
  });

  it('flags a thick wall, where pR/t is materially wrong', () => {
    const r = analyze({ max_pressure: 100 * MPa, inner_radius: 0.1, wall_thickness: 0.1 });
    expect(r.lame.rMeanOverT).toBeLessThan(10);
    expect(r.lame.thinWallApplicable).toBe(false);
    expect(Math.abs(r.lame.thinWallError)).toBeGreaterThan(0.05); // 10% here
    expect(r.assumptions.some((a) => /THICK-wall regime/.test(a))).toBe(true);
    // ...and says the shell-theory junction result is out of its range too.
    expect(r.warnings.some((w) => /outside their validity/.test(w))).toBe(true);
  });

  it('pR/t at the MEAN radius is the right thin-wall comparator', () => {
    // Using the inner radius instead would leave a ~1% bias that looks like a
    // modelling error rather than a definition choice.
    const p = 10 * MPa;
    const a = 0.05;
    const t = 0.001;
    const r = analyze({ max_pressure: p, inner_radius: a, wall_thickness: t });
    expectClose(r.lame.thinWallHoop, (p * (a + t / 2)) / t, 1e-12, 'thin-wall hoop');
  });
});

// =========================================================================
describe('cylindrical-shell edge bending at the closure junction', () => {
  const p = 6 * MPa;
  const a = 0.05;
  const t = 0.003;
  const nu = 0.33;
  const r = analyze({ max_pressure: p, inner_radius: a, wall_thickness: t, poissons_ratio: nu });

  const R = a + t / 2;
  const beta = Math.pow((3 * (1 - nu * nu)) / (R * R * t * t), 0.25);

  it('uses beta = [3(1-nu^2)/(R^2 t^2)]^(1/4) about the mid-surface radius', () => {
    expectClose(r.edge.beta, beta, 1e-12, 'beta');
    expectClose(r.edge.characteristicLength, 1 / beta, 1e-12, '1/beta');
  });

  it('gives the clamped-edge moment and shear, M0 = p/(2 beta^2), Q0 = -p/beta', () => {
    expectClose(r.edge.m0, p / (2 * beta * beta), 1e-12, 'M0');
    expectClose(r.edge.q0, -p / beta, 1e-12, 'Q0');
    expectClose(r.edge.bendingStress, (6 * r.edge.m0) / (t * t), 1e-12, '6M0/t^2');
  });

  it('produces the analytic bending-to-hoop ratio sqrt(3)/sqrt(1-nu^2), NOT the old 1.3', () => {
    // The ratio is independent of R, t and p -- which is exactly why a
    // hard-coded 1.3 was wrong everywhere rather than wrong in some cases.
    const expected = Math.sqrt(3) / Math.sqrt(1 - nu * nu);
    expectClose(r.edge.bendingToHoop, expected, 1e-12, 'bending/hoop');
    expect(expected).toBeGreaterThan(1.8);
    // The replaced placeholder understated this by ~30%.
    expect(expected / 1.3).toBeGreaterThan(1.4);
  });

  it('holds the same ratio across geometries, confirming it is geometry-independent', () => {
    const expected = Math.sqrt(3) / Math.sqrt(1 - nu * nu);
    for (const [ia, it] of [[0.02, 0.001], [0.1, 0.004], [0.3, 0.01]] as Array<[number, number]>) {
      const g = analyze({ inner_radius: ia, wall_thickness: it, poissons_ratio: nu });
      expectClose(g.edge.bendingToHoop, expected, 1e-12, `ratio at a=${ia} t=${it}`);
    }
  });

  it('suppresses membrane hoop stress AT the junction and recovers it downstream', () => {
    // w(0) = 0 at a clamped edge, so there is no displacement-driven hoop stress
    // there; all that remains is the Poisson share of the axial bending.
    const { hoop, position } = r.edge.profile;
    expectClose(hoop[0], nu * r.edge.bendingStress, 1e-9, 'hoop at junction');

    // By ~3/beta the disturbance has largely died. "Largely" is the honest word:
    // the envelope is e^(-beta x), so 3/beta still leaves ~5% of it, and the
    // moment has reversed sign by then, so the residual overshoots the membrane
    // value rather than undershooting.
    const far = position.findIndex((x) => x >= r.edge.decayLength);
    expect(far).toBeGreaterThan(0);
    expect(hoop[far]).toBeGreaterThan(r.edge.membraneHoop);
    expectClose(hoop[far], r.edge.membraneHoop, 0.1, 'hoop at 3/beta');

    const last = hoop.length - 1;
    expectClose(hoop[last], r.edge.membraneHoop, 0.02, 'hoop at end of scan');
    expectClose(r.edge.membraneHoop, (p * R) / t, 1e-12, 'membrane hoop = pR/t');
  });

  it('reports where the peak is, not just how big', () => {
    expect(r.edge.peak.vonMises).toBeGreaterThan(0);
    expect(r.edge.peakLocation).toBeGreaterThanOrEqual(0);
    expect(r.edge.peakLocation).toBeLessThan(r.edge.decayLength);
    expect(['bore', 'outer']).toContain(r.edge.peakSurface);
    // The junction really is worse than the far field -- that is the point of
    // computing it at all.
    expect(r.edge.peak.vonMises).toBeGreaterThan(r.lame.inner.vonMises * 1.5);
  });

  it('is the governing location for a typical thin case', () => {
    expect(r.whereMax).toMatch(/junction/);
    expectClose(r.maxVonMises, r.edge.peak.vonMises, 1e-12, 'max vM');
    expectClose(r.safetyFactor, 276e6 / r.maxVonMises, 1e-12, 'safety factor');
    expectClose(r.marginOfSafety, r.safetyFactor - 1, 1e-12, 'margin of safety');
  });

  it('scales the junction stress linearly with pressure', () => {
    const lo = analyze({ max_pressure: 3 * MPa });
    const hi = analyze({ max_pressure: 6 * MPa });
    expectClose(hi.edge.peak.vonMises, 2 * lo.edge.peak.vonMises, 1e-9, 'linearity');
  });
});

// =========================================================================
describe('margin of safety and material handling', () => {
  it('reports a negative margin when the case yields', () => {
    const r = analyze({ max_pressure: 30 * MPa, yield_stress: 100 * MPa });
    expect(r.safetyFactor).toBeLessThan(1);
    expect(r.marginOfSafety).toBeLessThan(0);
    expect(r.warnings.some((w) => /yields at peak pressure/.test(w))).toBe(true);
  });

  it('warns between 1.0 and 1.5 rather than calling it safe', () => {
    const r = analyze({ max_pressure: 6 * MPa, yield_stress: 276 * MPa });
    expect(r.safetyFactor).toBeGreaterThan(1);
    expect(r.safetyFactor).toBeLessThan(1.5);
    expect(r.warnings.some((w) => /below the customary 1.5/.test(w))).toBe(true);
  });

  it('flags the isotropic assumption for a composite case', () => {
    const r = analyze({ material: 'Carbon Composite' });
    const w = r.warnings.find((x) => /Composite case/.test(x));
    expect(w).toBeDefined();
    expect(w).toMatch(/orthotropic/);
    expect(w).toMatch(/Tsai-Wu|max strain|max stress/i);
  });

  it('does not raise the composite caveat for metals', () => {
    for (const material of ['Al 6061-T6', 'Steel 4130', 'Custom']) {
      const r = analyze({ material });
      expect(r.warnings.some((x) => /Composite case/.test(x)), material).toBe(false);
    }
  });

  it('always states its assumptions', () => {
    const r = analyze();
    expect(r.assumptions.length).toBeGreaterThanOrEqual(4);
    expect(r.assumptions.some((a) => /Lame closed-end thick-wall/.test(a))).toBe(true);
    expect(r.assumptions.some((a) => /isotropic/i.test(a))).toBe(true);
    expect(r.assumptions.some((a) => /no thermal stress|fatigue/.test(a))).toBe(true);
    expect(r.assumptions.some((a) => /CLAMPED/.test(a))).toBe(true);
  });

  it('computes bore strain from the full triaxial state, not the uniaxial shortcut', () => {
    const r = analyze();
    const i = r.lame.inner;
    const expected = (i.hoop - 0.33 * (i.radial + r.lame.axial)) / 69e9;
    expectClose(r.boreHoopStrain, expected, 1e-12, 'bore hoop strain');
    expectClose(r.boreRadialGrowth, expected * 0.05, 1e-12, 'bore growth');
    // The old uniaxial form (pR/tE) ignores the radial and axial terms and so
    // differs materially.
    const uniaxial = (6e6 * 0.05) / (0.003 * 69e9);
    expect(Math.abs(r.boreHoopStrain - uniaxial) / uniaxial).toBeGreaterThan(0.1);
  });
});

// =========================================================================
describe('bolted closure', () => {
  const r = analyze({
    bolts: { count: 6, diameter: 0.005, yield_stress: 400 * MPa },
  });
  const b = r.bolts!;

  it('takes the pressure load over the BORE area, not the outside diameter', () => {
    // The replaced code used the case outer radius, overstating the load.
    expectClose(b.totalForce, 6e6 * Math.PI * 0.05 ** 2, 1e-12, 'total force');
    expectClose(b.forcePerBolt, b.totalForce / 6, 1e-12, 'force per bolt');
  });

  it('separates nominal shank area from thread tensile-stress area', () => {
    const nominal = Math.PI * 0.0025 ** 2;
    expectClose(b.nominalArea, nominal, 1e-12, 'nominal area');
    expectClose(b.stressArea, nominal * 0.7386, 1e-12, 'stress area');
    // The threaded section is the one that fails, so its stress is higher and
    // its safety factor lower -- reporting only the shank number flatters the
    // design by about a third.
    expect(b.stressAreaStress).toBeGreaterThan(b.nominalStress);
    expect(b.safetyFactorStressArea).toBeLessThan(b.safetyFactorNominal);
    expectClose(
      b.safetyFactorNominal / b.safetyFactorStressArea,
      1 / 0.7386,
      1e-9,
      'SF ratio'
    );
  });

  it('computes both safety factors against the bolt yield', () => {
    expectClose(b.nominalStress, b.forcePerBolt / b.nominalArea, 1e-12, 'nominal stress');
    expectClose(b.safetyFactorNominal, (400 * MPa) / b.nominalStress, 1e-12, 'SF nominal');
    expectClose(
      b.safetyFactorStressArea,
      (400 * MPa) / b.stressAreaStress,
      1e-12,
      'SF stress area'
    );
  });

  it('gives thread engagement guidance keyed to the mating material', () => {
    expectClose(b.minEngagementSteel, 0.005, 1e-12, '1x d into steel');
    expectClose(b.minEngagementAluminium, 0.010, 1e-12, '2x d into aluminium');
  });

  it('checks flange shear-out on two tear planes per bolt', () => {
    expectClose(b.minEdgeDistance, 1.5 * 0.005, 1e-12, 'min edge distance');
    expectClose(b.edgeDistance, b.minEdgeDistance, 1e-12, 'default edge distance');
    expectClose(b.shearOutArea, 2 * b.edgeDistance * 0.003, 1e-12, 'shear-out area');
    expectClose(b.shearOutStress, b.forcePerBolt / b.shearOutArea, 1e-12, 'shear-out stress');
    // Allowable is the von Mises shear yield, 0.577 * sigma_y of the CASE.
    expectClose(
      b.safetyFactorShearOut,
      (0.577 * 276 * MPa) / b.shearOutStress,
      1e-9,
      'shear-out SF'
    );
  });

  it('honours a supplied edge distance', () => {
    const wide = analyze({
      bolts: { count: 6, diameter: 0.005, yield_stress: 400 * MPa, edge_distance: 0.015 },
    });
    expectClose(wide.bolts!.edgeDistance, 0.015, 1e-12, 'edge distance');
    expect(wide.bolts!.safetyFactorShearOut).toBeGreaterThan(b.safetyFactorShearOut);
  });

  it('halves the per-bolt load when the bolt count doubles', () => {
    const many = analyze({ bolts: { count: 12, diameter: 0.005, yield_stress: 400 * MPa } });
    expectClose(many.bolts!.forcePerBolt, b.forcePerBolt / 2, 1e-12, 'force per bolt');
    expectClose(many.bolts!.safetyFactorStressArea, b.safetyFactorStressArea * 2, 1e-9, 'SF');
  });

  it('is omitted entirely when no bolt pattern is given', () => {
    expect(analyze().bolts).toBeUndefined();
  });
});

// =========================================================================
describe('thin-wall sizing helper', () => {
  it('returns the pR/t wall for a target safety factor', () => {
    expectClose(
      core.required_wall_thickness(6 * MPa, 0.05, 1.5, 276 * MPa),
      (6e6 * 0.05 * 1.5) / 276e6,
      1e-12,
      'required thickness'
    );
  });

  it('is a sizing rule, not an analysis: the wall it returns is NOT at SF 1.5', () => {
    // Feeding its own answer back through the real analysis is the honest check,
    // and it fails -- because pR/t ignores the junction entirely. This is the
    // gap the old tab hid by reporting the sizing rule as though it were a
    // result.
    const t = core.required_wall_thickness(6 * MPa, 0.05, 1.5, 276 * MPa);
    const r = analyze({ wall_thickness: t });
    expect(r.safetyFactor).toBeLessThan(1.5);
  });
});
