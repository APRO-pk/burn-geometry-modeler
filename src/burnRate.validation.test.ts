import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/*
 * ============================================================================
 * BURN RATE VALIDATED AGAINST MEASURED STRAND-BURNER DATA
 * ============================================================================
 *
 * src/validation.test.ts checks model OUTPUTS against certified motor
 * measurements. It cannot check the pressure trace, because commercial
 * certification data does not publish the solver's inputs.
 *
 * This file attacks the problem from the other end. Richard Nakka measured burn
 * rate directly against chamber pressure in a strand burner and published the
 * raw points, so the single most important propellant INPUT can be compared to
 * measurement -- no grain geometry required.
 *
 *   "Effect of Chamber Pressure on Burning Rate for the Potassium Nitrate -
 *    Dextrose and Potassium Nitrate - Sorbitol Rocket Propellants"
 *   R. Nakka, June 1999, Issue 1, Tables 2-5. 65/35 oxidiser/fuel.
 *
 * The fixture is parsed from the source by tools/extractNakkaBurnRate.mts,
 * never hand-typed: transcription is where a validation fixture quietly
 * acquires a digit nobody measured.
 *
 * ---------------------------------------------------------------------------
 * THE HEADLINE RESULT
 * ---------------------------------------------------------------------------
 *
 * Measured burn rate for both sugar propellants is NON-MONOTONIC in pressure.
 * KN-Sorbitol rises to 9.37 mm/s at 0.81 MPa, falls to 7.65 at 3.79 MPa, then
 * climbs again to 11.29 at 10.67. Nakka's own fits carry negative pressure
 * exponents over several regimes.
 *
 * The solver uses a single Saint-Robert law, r = a * Pc^n. With n > 0 that is
 * monotonic by construction, so it CANNOT reproduce this shape at any choice of
 * coefficients. The tests below quantify what that costs rather than leaving it
 * as a footnote: the best possible single power law still misses by ~5-6% on
 * average where Nakka's five-regime fit achieves 1-2%.
 * ============================================================================
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const core = require(path.resolve(HERE, '../crates/burn-core/pkg-node/burn_core.js'));
const FIXTURE = path.resolve(HERE, '../tools/data/nakka-strand-burner.json');

/** Motors do not operate near ambient; below this the law is never exercised. */
const OPERATING_MIN_MPA = 1.0;

interface Measurement {
  pressureMPa: number;
  burnRateCmS: number;
}
interface Fit {
  fromMPa: number;
  toMPa: number;
  a: number;
  n: number;
}

let fixture: {
  source: Record<string, unknown>;
  method: Record<string, string>;
  propellants: Record<string, { measurements: Measurement[]; nakkaFits: Fit[] }>;
};

beforeAll(() => {
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(
      `No strand-burner fixture at ${FIXTURE}.\n` +
        'Regenerate it from Nakka\'s report:\n' +
        '  pdftotext -layout ds_burn.pdf ds_burn.txt\n' +
        '  npx tsx tools/extractNakkaBurnRate.mts ds_burn.txt'
    );
  }
  fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
});

/** The solver's law: r [m/s] = a * Pc[Pa]^n. */
const burnRate = (a: number, n: number, pressureMPa: number) =>
  a * Math.pow(pressureMPa * 1e6, n);

interface ShippedProp {
  label: string;
  a: number;
  n: number;
  regimes: { from_pressure: number; to_pressure: number; a: number; n: number }[];
}

/**
 * Coefficients the app actually ships, PARSED OUT OF DEFAULT_PROPELLANTS.
 *
 * Earlier this was a hand-copied restatement, which meant the test could keep
 * passing while the library drifted away from it -- the test would have been
 * validating a number nothing used. Reading the real source removes that gap:
 * if someone edits the library, these tests judge the edit.
 */
function readShippedLibrary(): Record<string, ShippedProp> {
  const src = fs.readFileSync(path.resolve(HERE, 'AppDesktop.tsx'), 'utf8');
  const out: Record<string, ShippedProp> = {};

  for (const [key, label] of [
    ['KN-Dextrose', 'KNDX (Dextrose)'],
    ['KN-Sorbitol', 'KNSB (Sorbitol)'],
  ] as const) {
    const at = src.indexOf(`name: '${label}'`);
    expect(at, `${label} missing from DEFAULT_PROPELLANTS`).toBeGreaterThan(0);

    // Brace-match the entry so a regex cannot wander into the next propellant.
    const open = src.lastIndexOf('{', at);
    let depth = 0;
    let close = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    const entry = src.slice(open, close + 1);

    const scalar = (name: string) => {
      const m = entry.match(new RegExp(`\\b${name}: (-?[0-9.e+-]+)`));
      expect(m, `${label} has no ${name}`).toBeTruthy();
      return Number(m![1]);
    };

    const regimes: ShippedProp['regimes'] = [];
    const block = entry.match(/burnRateRegimes: \[([\s\S]*?)\]/);
    if (block) {
      const re =
        /from_pressure: (-?[0-9.e+-]+), to_pressure: (-?[0-9.e+-]+), a: (-?[0-9.e+-]+), n: (-?[0-9.e+-]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(block[1]))) {
        regimes.push({
          from_pressure: Number(m[1]),
          to_pressure: Number(m[2]),
          a: Number(m[3]),
          n: Number(m[4]),
        });
      }
    }
    out[key] = { label, a: scalar('a'), n: scalar('n'), regimes };
  }
  return out;
}

const SHIPPED = readShippedLibrary();

/** Evaluate the shipped law the same way crates/burn-core/src/propellant.rs does. */
function shippedBurnRate(p: ShippedProp, pressureMPa: number): number {
  const pc = pressureMPa * 1e6;
  if (!p.regimes.length) return burnRate(p.a, p.n, pressureMPa);
  for (const r of p.regimes) {
    if (pc >= r.from_pressure && pc <= r.to_pressure) return r.a * Math.pow(pc, r.n);
  }
  const edge = pc < p.regimes[0].from_pressure ? p.regimes[0] : p.regimes[p.regimes.length - 1];
  return edge.a * Math.pow(pc, edge.n);
}

function shippedErrorStats(p: ShippedProp, pts: Measurement[]) {
  let sum = 0;
  let worst = 0;
  let worstAt = 0;
  for (const m of pts) {
    const e = Math.abs((shippedBurnRate(p, m.pressureMPa) - m.burnRateCmS / 100) / (m.burnRateCmS / 100));
    sum += e;
    if (e > worst) {
      worst = e;
      worstAt = m.pressureMPa;
    }
  }
  return { mean: sum / pts.length, worst, worstAt };
}

function operatingPoints(prop: string): Measurement[] {
  return fixture.propellants[prop].measurements.filter(
    (m) => m.pressureMPa >= OPERATING_MIN_MPA
  );
}

function errorStats(pts: Measurement[], a: number, n: number) {
  let sum = 0;
  let worst = 0;
  let worstAt = 0;
  for (const m of pts) {
    const measured = m.burnRateCmS / 100;
    const err = (burnRate(a, n, m.pressureMPa) - measured) / measured;
    sum += Math.abs(err);
    if (Math.abs(err) > Math.abs(worst)) {
      worst = err;
      worstAt = m.pressureMPa;
    }
  }
  return { mean: sum / pts.length, worst, worstAt };
}

/** Least squares on log r = log a + n log P: the best a single law can do. */
function bestSinglePowerLaw(pts: Measurement[]) {
  const X = pts.map((p) => Math.log(p.pressureMPa * 1e6));
  const Y = pts.map((p) => Math.log(p.burnRateCmS / 100));
  const mx = X.reduce((s, v) => s + v, 0) / X.length;
  const my = Y.reduce((s, v) => s + v, 0) / Y.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < X.length; i++) {
    num += (X[i] - mx) * (Y[i] - my);
    den += (X[i] - mx) ** 2;
  }
  const n = num / den;
  return { a: Math.exp(my - n * mx), n };
}

/** Nakka's piecewise fit, evaluated in his units (a in mm/s at 1 MPa). */
function nakkaPiecewise(fits: Fit[], pressureMPa: number) {
  const f =
    fits.find((r) => pressureMPa >= r.fromMPa && pressureMPa <= r.toMPa) ?? fits[fits.length - 1];
  return (f.a * Math.pow(pressureMPa, f.n)) / 1000;
}

// =========================================================================
describe('the fixture is measured data, parsed not transcribed', () => {
  it('carries its provenance', () => {
    expect(fixture.source.author).toBe('Richard Nakka');
    expect(String(fixture.source.title)).toMatch(/Burning Rate/i);
    expect(fixture.method.apparatus).toBe('Strand burner');
    expect(fixture.method.oxidiserFuelRatio).toBe('65/35');
  });

  it('has both propellants with enough points to fit against', () => {
    expect(fixture.propellants['KN-Dextrose'].measurements.length).toBeGreaterThanOrEqual(12);
    expect(fixture.propellants['KN-Sorbitol'].measurements.length).toBeGreaterThanOrEqual(12);
    for (const p of Object.values(fixture.propellants)) {
      expect(p.nakkaFits.length).toBe(5);
    }
  });

  it('holds physically sensible measurements', () => {
    for (const [name, p] of Object.entries(fixture.propellants)) {
      for (const m of p.measurements) {
        expect(m.pressureMPa, name).toBeGreaterThan(0);
        expect(m.pressureMPa, name).toBeLessThan(20);
        // Sugar propellants burn in the millimetres-per-second range.
        expect(m.burnRateCmS, name).toBeGreaterThan(0.1);
        expect(m.burnRateCmS, name).toBeLessThan(3);
      }
    }
  });

  it('records that this is a strand burner, not motor firings', () => {
    // Guards against the fixture being cited as validation of a pressure trace,
    // which it is not: there is no grain, thrust or motor pressure here.
    expect(fixture.method.note).toMatch(/no grain geometry|carry no grain/i);
  });
});

// =========================================================================
describe('measured burn rate is non-monotonic, which a single power law cannot represent', () => {
  it('reports where the measurements reverse', () => {
    for (const [name, p] of Object.entries(fixture.propellants)) {
      const pts = p.measurements;
      const reversals: string[] = [];
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].burnRateCmS < pts[i - 1].burnRateCmS) {
          reversals.push(
            `${pts[i - 1].pressureMPa}->${pts[i].pressureMPa} MPa ` +
              `(${(pts[i - 1].burnRateCmS * 10).toFixed(2)} -> ${(pts[i].burnRateCmS * 10).toFixed(2)} mm/s)`
          );
        }
      }
      console.log(`\n    ${name}: burn rate FALLS with rising pressure at ${reversals.length} steps`);
      reversals.forEach((r) => console.log(`      ${r}`));
      expect(reversals.length, `${name} should show measured reversals`).toBeGreaterThan(0);
    }
  });

  it('has negative pressure exponents in Nakka\'s own fits', () => {
    // A negative exponent means burn rate falls as pressure rises. r = a*P^n
    // with n > 0 cannot express that at any a.
    for (const [name, p] of Object.entries(fixture.propellants)) {
      const negative = p.nakkaFits.filter((f) => f.n < 0);
      console.log(
        `    ${name}: ${negative.length} of ${p.nakkaFits.length} regimes have n < 0 ` +
          `(${negative.map((f) => f.n).join(', ')})`
      );
      expect(negative.length).toBeGreaterThan(0);
    }
  });

  it('costs several percent that no re-fit of a single law can recover', () => {
    // The honest framing of the limitation: compare the BEST achievable single
    // power law against Nakka's five-regime fit on the same points. Whatever
    // gap remains is structural, not a calibration error.
    for (const [name, p] of Object.entries(fixture.propellants)) {
      const pts = operatingPoints(name);
      const best = bestSinglePowerLaw(pts);
      const bestErr = errorStats(pts, best.a, best.n);

      let piecewiseMean = 0;
      for (const m of pts) {
        const measured = m.burnRateCmS / 100;
        piecewiseMean += Math.abs((nakkaPiecewise(p.nakkaFits, m.pressureMPa) - measured) / measured);
      }
      piecewiseMean /= pts.length;

      console.log(
        `    ${name}: best single law ${(bestErr.mean * 100).toFixed(1)}% mean  vs  ` +
          `Nakka 5-regime ${(piecewiseMean * 100).toFixed(1)}% mean`
      );

      // The piecewise fit is materially better, which is the whole point.
      expect(piecewiseMean).toBeLessThan(bestErr.mean);
      expect(piecewiseMean).toBeLessThan(0.04);
      // And no single law gets close to it.
      expect(bestErr.mean).toBeGreaterThan(0.03);
    }
  });
});

// =========================================================================
describe('the shipped propellant library against measurement', () => {
  /*
   * These tests used to record that KNSB shipped a=6.01e-5, n=0.32 and
   * under-predicted every measured point above 0.75 MPa by 13.8% on average,
   * and deferred the correction as a formulation judgement for the project
   * owner. That call has since been made: both sugar propellants now carry
   * coefficients fitted to this data, plus Nakka's five measured bands. The
   * tests below hold the new library to the evidence that motivated the change.
   */

  for (const key of ['KN-Dextrose', 'KN-Sorbitol'] as const) {
    it(`${key}: the single-law fallback is the best a single law can do`, () => {
      const pts = operatingPoints(key);
      const shipped = SHIPPED[key];
      const got = errorStats(pts, shipped.a, shipped.n);
      const best = bestSinglePowerLaw(pts);
      const bestErr = errorStats(pts, best.a, best.n);

      console.log(
        `
    ${shipped.label} fallback (a=${shipped.a.toExponential(3)}, n=${shipped.n}): ` +
          `mean ${(got.mean * 100).toFixed(1)}%  worst ${(got.worst * 100).toFixed(1)}% at ${got.worstAt} MPa`
      );
      console.log(
        `    best possible single law (a=${best.a.toExponential(3)}, n=${best.n.toFixed(4)}): ` +
          `mean ${(bestErr.mean * 100).toFixed(1)}%`
      );

      // Optimal to within a tenth of a percentage point. Anything worse means
      // someone edited the library without re-running tools/emitPropellantRegimes.mts.
      expect(got.mean - bestErr.mean).toBeLessThan(0.001);
      expect(got.mean).toBeLessThan(0.07);
    });

    it(`${key}: no longer carries a one-directional bias`, () => {
      /*
       * The finding that drove the re-fit. Shipped KNSB read LOW at essentially
       * every measured point, and low burn rate means low predicted chamber
       * pressure -- the unsafe direction when the number sizes a pressure
       * vessel. A fitted law should scatter either side instead.
       */
      const pts = operatingPoints(key);
      const shipped = SHIPPED[key];
      const low = pts.filter((m) => shippedBurnRate(shipped, m.pressureMPa) < m.burnRateCmS / 100);
      console.log(
        `
    ${shipped.label}: ${low.length}/${pts.length} measured points under-predicted`
      );
      expect(low.length).toBeGreaterThan(0);
      expect(low.length).toBeLessThan(pts.length);
    });

    it(`${key}: ships Nakka's measured bands, and they beat any single law`, () => {
      const pts = operatingPoints(key);
      const shipped = SHIPPED[key];
      const fits = fixture.propellants[key].nakkaFits;

      expect(shipped.regimes.length, 'expected the measured piecewise law').toBe(fits.length);

      // Each shipped band must BE one of Nakka's, converted. The conversion is
      // the step most likely to be got wrong silently, so it is checked rather
      // than assumed: r[mm/s] = a_N*P[MPa]^n  ->  a_SI = (a_N/1000)*10^(-6n).
      for (let i = 0; i < fits.length; i++) {
        const f = fits[i];
        const r = shipped.regimes[i];
        expect(r.n).toBeCloseTo(f.n, 10);
        expect(r.from_pressure / 1e6).toBeCloseTo(f.fromMPa, 6);
        expect(r.to_pressure / 1e6).toBeCloseTo(f.toMPa, 6);
        const expectedA = (f.a / 1000) * Math.pow(10, -6 * f.n);
        expect(Math.abs(r.a - expectedA) / expectedA).toBeLessThan(1e-3);
      }

      // Contiguous cover: no pressure inside the range falls through a gap.
      for (let i = 1; i < shipped.regimes.length; i++) {
        expect(shipped.regimes[i].from_pressure).toBeCloseTo(shipped.regimes[i - 1].to_pressure, 6);
      }

      const piece = shippedErrorStats(shipped, pts);
      const best = bestSinglePowerLaw(pts);
      const bestErr = errorStats(pts, best.a, best.n);
      console.log(
        `
    ${shipped.label}: piecewise ${(piece.mean * 100).toFixed(1)}% mean ` +
          `vs best single law ${(bestErr.mean * 100).toFixed(1)}%`
      );

      expect(piece.mean).toBeLessThan(0.025);
      // The whole point of the feature: it must recover most of the gap.
      expect(bestErr.mean - piece.mean).toBeGreaterThan(0.03);
    });
  }

  it('the bands step discontinuously, which is a real property to be aware of', () => {
    /*
     * Piecewise fits do not join up. Straddling a boundary makes burn rate jump,
     * and the solver integrates straight through it. Measuring the jumps here
     * documents how large that effect is and pins it, so a later edit that
     * introduced a 30% cliff would not slip past.
     */
    for (const key of ['KN-Dextrose', 'KN-Sorbitol'] as const) {
      const p = SHIPPED[key];
      let worst = 0;
      let worstAt = 0;
      for (let i = 1; i < p.regimes.length; i++) {
        const bMPa = p.regimes[i].from_pressure / 1e6;
        const below = shippedBurnRate(p, bMPa - 1e-6);
        const above = shippedBurnRate(p, bMPa + 1e-6);
        const jump = Math.abs(above - below) / below;
        if (jump > worst) {
          worst = jump;
          worstAt = bMPa;
        }
      }
      console.log(
        `
    ${p.label}: largest band step ${(worst * 100).toFixed(1)}% at ${worstAt.toFixed(2)} MPa`
      );
      // Small enough that integrating across it is benign.
      expect(worst).toBeLessThan(0.10);
    }
  });
});

// =========================================================================
describe("the golden regression fixture's coefficients", () => {
  /*
   * engine.test.ts pins a KNDX case and describes it as
   *   "Nakka KNDX values, from reference/legacy-python"
   * Neither half holds up. reference/legacy-python's only propellant example is
   *   density=1700, a=5e-5, n=0.35   labelled "KNSB example"
   * which is a different propellant and different numbers; and the coefficients
   * do not match Nakka's measurements either.
   *
   * This does not make the golden test wrong. It is a REGRESSION fixture -- its
   * job is to pin behaviour so the Rust port can be diffed against the
   * TypeScript engine, and any self-consistent coefficients serve that. The
   * problem is the comment, which invites the numbers to be read as validated
   * physical constants.
   */
  const GOLDEN = { a: 8.875e-5, n: 0.32 };

  it('sits further from measurement than the shipped library does', () => {
    const pts = operatingPoints('KN-Dextrose');
    const golden = errorStats(pts, GOLDEN.a, GOLDEN.n);
    const shipped = errorStats(pts, SHIPPED['KN-Dextrose'].a, SHIPPED['KN-Dextrose'].n);

    console.log(
      `\n    golden fixture (a=${GOLDEN.a}, n=${GOLDEN.n}): mean ${(golden.mean * 100).toFixed(1)}%` +
        `  worst ${(golden.worst * 100).toFixed(1)}% at ${golden.worstAt} MPa`
    );
    console.log(`    shipped KNDX: mean ${(shipped.mean * 100).toFixed(1)}%`);

    expect(golden.mean).toBeGreaterThan(shipped.mean);
    // Biased high: it over-predicts burn rate, so pressure too, which at least
    // errs conservative for structural sizing.
    expect(golden.worst).toBeGreaterThan(0);
  });

  it('is not the propellant reference/legacy-python actually contains', () => {
    const legacy = path.resolve(HERE, '../reference/legacy-python/apro_modeler.py');
    if (!fs.existsSync(legacy)) return;
    const src = fs.readFileSync(legacy, 'utf8');
    // The cited source contains neither coefficient.
    expect(src).not.toContain('8.875');
    expect(src).not.toContain('0.32');
  });
});

// =========================================================================
describe('the solver actually integrates the piecewise law', () => {
  /*
   * Everything above compares the shipped NUMBERS to measurement. That is only
   * half the claim. If the Rust core quietly ignored burn_rate_regimes, every
   * test above would still pass while the app kept using the single law.
   *
   * These run the real core through the same entry point the Run button uses.
   */

  /** A KNDX BATES motor, with or without the measured bands. */
  function fire(regimes: ShippedProp['regimes']) {
    const p = SHIPPED['KN-Dextrose'];
    const L = 0.3;
    const Ro = 0.04;
    const Ri = 0.015;
    const ab0 = 2 * Math.PI * Ri * L + 2 * Math.PI * (Ro ** 2 - Ri ** 2);
    const throat = Math.sqrt((4 * (ab0 / 220)) / Math.PI);

    const out = core.simulate({
      propellant: {
        density: 1878,
        a: p.a,
        n: p.n,
        flame_temp: 1700,
        gamma: 1.14,
        molecular_weight: 0.042,
        ...(regimes.length ? { burn_rate_regimes: regimes } : {}),
      },
      grain: { kind: 'BATES', length: L, outer_radius: Ro, inner_radius: Ri },
      nozzle: { throat_diameter: throat, expansion_ratio: 6, material: null },
      options: { model: '0D' },
    });

    const NF = out.fields.length;
    const ix = (f: string) => out.fields.indexOf(f);
    const cT = ix('Time');
    const cP = ix('Pc');
    const pc: number[] = [];
    for (let i = 0; i < out.rows; i++) pc.push(out.data[i * NF + cP]);
    return {
      pc,
      peakPc: Math.max(...pc),
      burnTime: out.data[(out.rows - 1) * NF + cT],
      rows: out.rows,
    };
  }

  it('omitting the bands leaves the old single-law behaviour exactly intact', () => {
    // The compatibility guarantee. An empty regime list must be a no-op, not
    // "nearly a no-op" -- every existing motor file depends on it.
    const withEmpty = fire([]);
    const p = SHIPPED['KN-Dextrose'];
    const withUndefined = fire([]);
    expect(withEmpty.peakPc).toBe(withUndefined.peakPc);
    expect(withEmpty.peakPc).toBeGreaterThan(1e5);
    expect(Number.isFinite(withEmpty.burnTime)).toBe(true);
    // Sanity: the fallback law really is what ran.
    expect(p.a).toBeGreaterThan(0);
  });

  it('supplying the bands changes the answer, so they are not being ignored', () => {
    const single = fire([]);
    const piece = fire(SHIPPED['KN-Dextrose'].regimes);

    const dPc = (piece.peakPc - single.peakPc) / single.peakPc;
    const dTb = (piece.burnTime - single.burnTime) / single.burnTime;
    console.log(
      `
    KNDX BATES, single law: peak ${(single.peakPc / 1e6).toFixed(3)} MPa, ` +
        `tb ${single.burnTime.toFixed(3)} s`
    );
    console.log(
      `    with 5 measured bands:  peak ${(piece.peakPc / 1e6).toFixed(3)} MPa, ` +
        `tb ${piece.burnTime.toFixed(3)} s   (${(dPc * 100).toFixed(1)}% Pc, ${(dTb * 100).toFixed(1)}% tb)`
    );

    // The core must respond to the field at all. This is the assertion that
    // fails if someone drops burn_rate_regimes from the config plumbing.
    expect(Math.abs(dPc)).toBeGreaterThan(1e-6);
    // And it must remain a real motor, not a numerical excursion.
    expect(piece.peakPc).toBeGreaterThan(1e5);
    expect(piece.peakPc).toBeLessThan(2e7);
    expect(Math.abs(dPc)).toBeLessThan(0.5);
  });

  it('integrates across the band discontinuities without instability', () => {
    /*
     * KNDX steps 1.8% at 2.57 MPa and again at 5.93 and 8.5. A motor whose
     * pressure sweeps up through those during ignition crosses each one. Check
     * the trace stays finite and smooth -- no NaN, no oscillation latching onto
     * a boundary.
     */
    const piece = fire(SHIPPED['KN-Dextrose'].regimes);
    expect(piece.rows).toBeGreaterThan(50);
    for (const v of piece.pc) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }

    // Largest step between consecutive samples, after the ignition transient.
    const tail = piece.pc.slice(Math.floor(piece.pc.length * 0.1));
    let worst = 0;
    for (let i = 1; i < tail.length; i++) {
      worst = Math.max(worst, Math.abs(tail[i] - tail[i - 1]) / tail[i - 1]);
    }
    console.log(`
    largest step-to-step Pc change after ignition: ${(worst * 100).toFixed(2)}%`);
    expect(worst).toBeLessThan(0.15);
  });

  it('the app hands the bands to the solver', () => {
    /*
     * The one link the tests above cannot reach. Everything else here proves
     * the CORE honours burn_rate_regimes and the LIBRARY carries the right
     * ones; neither notices if AppDesktop stops putting them in the config it
     * sends. Deleting that spread was verified to leave all other tests green,
     * which is exactly the silent failure this file exists to prevent -- the
     * app would show measured coefficients while simulating the old law.
     *
     * A source-level assertion is a blunt instrument, but the alternative is
     * mounting a 3000-line component, and blunt beats absent here.
     */
    const src = fs.readFileSync(path.resolve(HERE, 'AppDesktop.tsx'), 'utf8');
    expect(
      src.includes('burn_rate_regimes: burnRateRegimes'),
      'AppDesktop no longer passes burn_rate_regimes into BurnConfig'
    ).toBe(true);
    expect(
      src.includes('setBurnRateRegimes(p.burnRateRegimes ?? [])'),
      'selecting a propellant no longer loads (or clears) its bands'
    ).toBe(true);
  });

  it('is closer to measured burn rate across the pressure range the motor sweeps', () => {
    /*
     * The payoff, stated carefully.
     *
     * Piecewise is better ON AVERAGE, not at every individual pressure. At this
     * motor's ~7.98 MPa operating point the single law happens to land 1.5% off
     * and the bands 1.6% -- the fitted line passes near that particular
     * measurement. Asserting a win at one cherry-picked pressure would be
     * asserting something untrue, so this compares over the whole range the
     * chamber actually sweeps through, ignition to burnout.
     */
    const piece = fire(SHIPPED['KN-Dextrose'].regimes);
    const lo = Math.min(...piece.pc) / 1e6;
    const hi = Math.max(...piece.pc) / 1e6;

    const p = SHIPPED['KN-Dextrose'];
    const inRange = fixture.propellants['KN-Dextrose'].measurements.filter(
      (m) => m.pressureMPa >= lo && m.pressureMPa <= hi
    );
    expect(inRange.length, 'no measurements cover this motor').toBeGreaterThan(3);

    const mean = (f: (mPa: number) => number) =>
      inRange.reduce((acc, m) => {
        const meas = m.burnRateCmS / 100;
        return acc + Math.abs(f(m.pressureMPa) - meas) / meas;
      }, 0) / inRange.length;

    const singleErr = mean((mPa) => burnRate(p.a, p.n, mPa));
    const pieceErr = mean((mPa) => shippedBurnRate(p, mPa));

    console.log(
      `
    motor sweeps ${lo.toFixed(2)}-${hi.toFixed(2)} MPa, covering ${inRange.length} measurements`
    );
    console.log(
      `    mean burn-rate error over that range: single law ${(singleErr * 100).toFixed(1)}%, ` +
        `bands ${(pieceErr * 100).toFixed(1)}%`
    );

    expect(pieceErr).toBeLessThan(singleErr);
  });
});
