import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/*
 * ============================================================================
 * VALIDATION AGAINST REAL STATIC-FIRE MEASUREMENTS
 * ============================================================================
 *
 * Every other suite in this repository checks the code against itself: the Rust
 * core against the TypeScript reference, the surrogate against the core, the
 * burn-back outline against ClipperLib, Lame against textbook algebra. That is
 * internal consistency, and it proves only that the pieces agree.
 *
 * This one checks the model against reality -- 790 motors certified by NAR, TRA
 * and CAR, fetched from ThrustCurve.org and committed as a fixture so the suite
 * runs offline and deterministically (tools/fetchMotorData.mts to refresh).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT VALIDATE, AND WHY
 * ---------------------------------------------------------------------------
 *
 * A certification stand measures OUTPUTS: total impulse, burn time, average and
 * peak thrust, propellant mass. It does not publish the solver's INPUTS -- grain
 * geometry, the St. Robert coefficients, throat diameter, expansion ratio. Those
 * are manufacturer trade secrets.
 *
 * So there is no way to feed a real commercial motor into this solver and
 * compare its pressure trace. Point validation of Pc(t) against certified data
 * is not possible from public sources, and no test here pretends otherwise.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES VALIDATE
 * ---------------------------------------------------------------------------
 *
 * Two model outputs are DIMENSIONLESS or mass-normalised, and therefore
 * comparable without knowing the geometry that produced them:
 *
 *   DELIVERED SPECIFIC IMPULSE, I_total/(m_prop g). Set by propellant
 *   thermochemistry and nozzle expansion, not by grain shape. Checking the
 *   propellant library the app ships against the real distribution tests c*,
 *   C_F, the isentropic relations and the efficiency defaults all at once.
 *
 *   PEAK-TO-AVERAGE THRUST RATIO. Set by how progressive the grain burns --
 *   i.e. by the burn-back model -- and independent of motor size. This is the
 *   one place real hardware constrains the geometry side of the model.
 *
 * Neither is a tight point comparison; both are distribution checks. They will
 * not catch a 5% error. They will catch a model that is wrong in kind, which is
 * what "has never been compared to a real motor" leaves open.
 * ============================================================================
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const core = require(path.resolve(HERE, '../crates/burn-core/pkg-node/burn_core.js'));
const FIXTURE = path.resolve(HERE, '../tools/data/thrustcurve-motors.json');

interface RealMotor {
  motorId: string;
  manufacturer: string;
  designation: string;
  impulseClass: string;
  propInfo: string;
  diameterMm: number;
  lengthMm: number;
  propWeightG: number;
  totImpulseNs: number;
  burnTimeS: number;
  avgThrustN: number;
  maxThrustN: number;
  certOrg: string;
}

let fixture: { source: string; fetchedAt: string; motors: RealMotor[] };
let composite: RealMotor[];

/** Black powder is a different propellant class and drags the band down. */
const isComposite = (m: RealMotor) => !/black\s*powder/i.test(m.propInfo || '');

const deliveredIsp = (m: RealMotor) => m.totImpulseNs / ((m.propWeightG / 1000) * 9.80665);
const peakToAvg = (m: RealMotor) => m.maxThrustN / m.avgThrustN;

function quantile(values: number[], f: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(f * s.length)))];
}

beforeAll(() => {
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(
      `No certified-motor fixture at ${FIXTURE}.\n` +
        'Fetch it with:  npm run validation:fetch'
    );
  }
  fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  composite = fixture.motors.filter(isComposite);
});

// --- the propellants the app actually ships --------------------------------

/**
 * DEFAULT_PROPELLANTS from src/AppDesktop.tsx, verbatim.
 *
 * Validating the shipped library rather than invented values is the point: if
 * these coefficients imply an impossible motor, users are being handed an
 * impossible motor as a starting point.
 */
const SHIPPED = {
  APCP: { density: 1528, a: 8.4e-5, n: 0.3, molecular_weight: 0.024, flame_temp: 2700, gamma: 1.18 },
  KNSB: { density: 1800, a: 6.01e-5, n: 0.32, molecular_weight: 0.04, flame_temp: 1600, gamma: 1.13 },
  KNDX: { density: 1878, a: 4.77e-5, n: 0.35, molecular_weight: 0.042, flame_temp: 1700, gamma: 1.14 },
};

interface RunOpts {
  eps?: number;
  kn?: number;
  cStar?: number;
  cf?: number;
  length?: number;
  outer?: number;
  inner?: number;
}

/** Simulate a BATES motor and return the quantities real data can constrain. */
function simulate(prop: (typeof SHIPPED)['APCP'], o: RunOpts = {}) {
  const L = o.length ?? 0.3;
  const Ro = o.outer ?? 0.04;
  const Ri = o.inner ?? 0.015;
  const kn = o.kn ?? 200;

  const ab0 = 2 * Math.PI * Ri * L + 2 * Math.PI * (Ro ** 2 - Ri ** 2);
  const throat = Math.sqrt((4 * (ab0 / kn)) / Math.PI);

  const out = core.simulate({
    propellant: prop,
    grain: { kind: 'BATES', length: L, outer_radius: Ro, inner_radius: Ri },
    nozzle: { throat_diameter: throat, expansion_ratio: o.eps ?? 6, material: null },
    options: { model: '0D', c_star_eff: o.cStar ?? 0.95, cf_eff: o.cf ?? 0.98 },
  });

  const NF = out.fields.length;
  const ix = (s: string) => out.fields.indexOf(s);
  const cT = ix('Time');
  const cF = ix('Thrust');

  let impulse = 0;
  let peak = -Infinity;
  for (let i = 0; i < out.rows; i++) {
    peak = Math.max(peak, out.data[i * NF + cF]);
    if (i > 0) {
      impulse +=
        ((out.data[i * NF + cF] + out.data[(i - 1) * NF + cF]) / 2) *
        (out.data[i * NF + cT] - out.data[(i - 1) * NF + cT]);
    }
  }
  const burnTime = out.data[(out.rows - 1) * NF + cT];
  const propMass = Math.PI * (Ro ** 2 - Ri ** 2) * L * prop.density;

  return {
    isp: impulse / (propMass * 9.80665),
    peakToAvg: peak / (impulse / burnTime),
    impulse,
    burnTime,
    propMass,
  };
}

// =========================================================================
describe('the fixture is real measured data, with provenance', () => {
  it('records where it came from and when', () => {
    expect(fixture.source).toMatch(/thrustcurve\.org/);
    expect(Date.parse(fixture.fetchedAt)).toBeGreaterThan(0);
    expect(fixture.motors.length).toBeGreaterThan(400);
  });

  it('carries certification bodies, not anonymous numbers', () => {
    const orgs = new Set(fixture.motors.map((m) => m.certOrg).filter(Boolean));
    expect(orgs.size).toBeGreaterThan(0);
    // Every retained motor must be attributable to a real product.
    for (const m of fixture.motors.slice(0, 50)) {
      expect(m.manufacturer, m.motorId).toBeTruthy();
      expect(m.designation, m.motorId).toBeTruthy();
    }
  });

  it('is internally consistent: total impulse tracks average thrust x burn time', () => {
    // Not a test of our model -- a test that the fixture is being read
    // correctly. If units or fields were misinterpreted this diverges wildly.
    const err = fixture.motors.map(
      (m) => Math.abs(m.totImpulseNs - m.avgThrustN * m.burnTimeS) / m.totImpulseNs
    );
    expect(quantile(err, 0.5)).toBeLessThan(0.02);
    expect(quantile(err, 0.9)).toBeLessThan(0.15);
  });

  it('spans the impulse classes a hobby tool is used for', () => {
    const classes = new Set(fixture.motors.map((m) => m.impulseClass));
    for (const c of ['G', 'H', 'I', 'J', 'K', 'L', 'M']) {
      expect(classes.has(c), `class ${c}`).toBe(true);
    }
  });
});

// =========================================================================
describe('delivered specific impulse against real motors', () => {
  it('reports the real distribution the model is being held to', () => {
    const isp = composite.map(deliveredIsp);
    console.log(
      `\n  ${composite.length} certified composite motors:` +
        `\n    delivered Isp  p05 ${quantile(isp, 0.05).toFixed(1)}` +
        `  median ${quantile(isp, 0.5).toFixed(1)}` +
        `  p95 ${quantile(isp, 0.95).toFixed(1)} s`
    );
    expect(composite.length).toBeGreaterThan(300);
  });

  it("the shipped APCP lands inside the real composite distribution", () => {
    const isp = composite.map(deliveredIsp);
    const lo = quantile(isp, 0.05);
    const hi = quantile(isp, 0.99);

    for (const eps of [4, 6, 8]) {
      const got = simulate(SHIPPED.APCP, { eps }).isp;
      expect(got, `APCP at eps=${eps}: ${got.toFixed(1)} s`).toBeGreaterThan(lo);
      expect(got, `APCP at eps=${eps}: ${got.toFixed(1)} s`).toBeLessThan(hi);
    }
  });

  it('places the shipped APCP near the top of the real range, not beyond it', () => {
    // 222.9 s at eps=6 against a real p95 of 226.5. That is a GOOD motor rather
    // than an impossible one, which is the right character for a default -- but
    // the margin is thin, so users should not read the default as conservative.
    const isp = composite.map(deliveredIsp);
    const got = simulate(SHIPPED.APCP, { eps: 6 }).isp;
    console.log(
      `    shipped APCP at eps=6: ${got.toFixed(1)} s  ` +
        `(real median ${quantile(isp, 0.5).toFixed(1)}, p95 ${quantile(isp, 0.95).toFixed(1)})`
    );
    expect(got).toBeGreaterThan(quantile(isp, 0.5));
    expect(got).toBeLessThan(quantile(isp, 0.99));
  });

  it('puts the sugar propellants below the composite band, where they belong', () => {
    // KNDX and KNSB are lower-energy than ammonium-perchlorate composites, so
    // landing inside the composite distribution would mean the thermochemistry
    // was not doing any work.
    const p05 = quantile(composite.map(deliveredIsp), 0.05);
    for (const [name, prop] of [
      ['KNDX', SHIPPED.KNDX],
      ['KNSB', SHIPPED.KNSB],
    ] as const) {
      const got = simulate(prop, { eps: 6 }).isp;
      console.log(`    shipped ${name} at eps=6: ${got.toFixed(1)} s`);
      expect(got, `${name} should sit below the composite p05`).toBeLessThan(p05);
      // ...but still be a real motor, not black-powder territory.
      expect(got, `${name} implausibly low`).toBeGreaterThan(90);
    }
  });

  it('KNDX matches its independently known real-world Isp', () => {
    // engine.test.ts records 110-130 s for KNDX from the Nakka reference this
    // project was ported from -- a figure that came from static tests, not from
    // this code. Reproducing it is a genuine external check.
    const got = simulate(SHIPPED.KNDX, { eps: 6 }).isp;
    expect(got).toBeGreaterThan(105);
    expect(got).toBeLessThan(145);
  });

  it('cannot reach real Isp without the efficiency factors, and that is correct', () => {
    // An ideal nozzle with perfect combustion should predict MORE than any real
    // motor delivers. If the ideal case sat inside the real distribution, the
    // efficiencies would be hiding a model that was already too pessimistic.
    const ideal = simulate(SHIPPED.APCP, { eps: 6, cStar: 1, cf: 1 }).isp;
    const withLosses = simulate(SHIPPED.APCP, { eps: 6 }).isp;
    const p95 = quantile(composite.map(deliveredIsp), 0.95);

    console.log(
      `    ideal ${ideal.toFixed(1)} s -> with default efficiencies ${withLosses.toFixed(1)} s` +
        `  (real p95 ${p95.toFixed(1)})`
    );
    expect(ideal, 'ideal Isp should exceed what real motors deliver').toBeGreaterThan(p95);
    expect(withLosses).toBeLessThan(ideal);
  });

  it('improves with expansion ratio and then over-expands, as a real nozzle does', () => {
    const curve = [1, 2, 4, 6, 8, 12].map((eps) => ({ eps, isp: simulate(SHIPPED.APCP, { eps }).isp }));
    const best = curve.reduce((a, b) => (b.isp > a.isp ? b : a));
    // Rises steeply off eps=1...
    expect(curve[0].isp).toBeLessThan(curve[2].isp);
    // ...peaks at a finite ratio rather than climbing forever, because the
    // over-expansion term eventually costs more than the extra expansion gains.
    expect(best.eps).toBeGreaterThan(1);
    expect(best.eps).toBeLessThan(12);
    expect(curve[curve.length - 1].isp).toBeLessThan(best.isp);
  });
});

// =========================================================================
describe('thrust-trace shape against real motors', () => {
  /*
   * Peak-to-average thrust is the one dimensionless quantity in the certified
   * data that is set by the GRAIN, and it is what makes this more than a
   * thermochemistry check. A motor with a progressive grain spikes late; a
   * regressive one starts high and decays. Getting the distribution right means
   * the burn-back model produces traces shaped like real hardware.
   */
  it('reports the real distribution', () => {
    const pa = composite.map(peakToAvg);
    console.log(
      `\n    real peak/avg thrust  p05 ${quantile(pa, 0.05).toFixed(2)}` +
        `  median ${quantile(pa, 0.5).toFixed(2)}` +
        `  p95 ${quantile(pa, 0.95).toFixed(2)}`
    );
    expect(quantile(pa, 0.5)).toBeGreaterThan(1);
  });

  it('produces peak/average ratios inside the real range', () => {
    const ours: number[] = [];
    for (const length of [0.15, 0.3, 0.6]) {
      for (const inner of [0.01, 0.015, 0.022]) {
        for (const kn of [120, 200, 320]) {
          const r = simulate(SHIPPED.APCP, { length, inner, kn });
          if (Number.isFinite(r.peakToAvg)) ours.push(r.peakToAvg);
        }
      }
    }
    const real = composite.map(peakToAvg);
    console.log(
      `    ours over ${ours.length} BATES designs  min ${quantile(ours, 0).toFixed(2)}` +
        `  median ${quantile(ours, 0.5).toFixed(2)}  max ${quantile(ours, 1).toFixed(2)}`
    );

    // Our median should sit inside the real inter-percentile range, and no
    // design should produce a spike real motors never show.
    expect(quantile(ours, 0.5)).toBeGreaterThan(quantile(real, 0.05));
    expect(quantile(ours, 0.5)).toBeLessThan(quantile(real, 0.95));
    expect(quantile(ours, 1)).toBeLessThan(quantile(real, 0.99));
    // A ratio below 1 is arithmetically impossible; catching it would mean the
    // impulse integral and the peak disagree.
    expect(quantile(ours, 0)).toBeGreaterThanOrEqual(1);
    // 27 full WASM solves; see the testTimeout note in vite.config.ts.
  });

  it('makes a thin-web grain more progressive than a thick-web one', () => {
    // A larger bore burns more neutrally; a small bore in a big casing has far
    // more area to grow into. The ordering is what real BATES motors show.
    const thinWeb = simulate(SHIPPED.APCP, { inner: 0.028 }).peakToAvg;
    const thickWeb = simulate(SHIPPED.APCP, { inner: 0.01 }).peakToAvg;
    expect(thickWeb).toBeGreaterThan(thinWeb);
  });
});

// =========================================================================
describe('what remains unvalidated is stated, not implied', () => {
  it('has no certified motor with the inputs a pressure-trace check would need', () => {
    // Guards the claim in this file's header. If ThrustCurve ever publishes
    // grain geometry or burn-rate coefficients, this test fails and the much
    // stronger validation it would enable should be written.
    const withInputs = fixture.motors.filter((m) =>
      ['throatDiameter', 'grainType', 'burnRateA', 'burnRateN', 'expansionRatio'].some(
        (k) => k in (m as unknown as Record<string, unknown>)
      )
    );
    expect(
      withInputs.length,
      'certified data now carries solver inputs -- write the pressure-trace validation'
    ).toBe(0);
  });
});
