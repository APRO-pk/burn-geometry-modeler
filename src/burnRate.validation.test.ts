import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
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

/** Coefficients the app actually ships, from DEFAULT_PROPELLANTS. */
const SHIPPED = {
  'KN-Dextrose': { label: 'KNDX (Dextrose)', a: 4.77e-5, n: 0.35 },
  'KN-Sorbitol': { label: 'KNSB (Sorbitol)', a: 6.01e-5, n: 0.32 },
};

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
  it('KNDX is calibrated about as well as a single power law allows', () => {
    const pts = operatingPoints('KN-Dextrose');
    const shipped = SHIPPED['KN-Dextrose'];
    const got = errorStats(pts, shipped.a, shipped.n);
    const best = bestSinglePowerLaw(pts);
    const bestErr = errorStats(pts, best.a, best.n);

    console.log(
      `\n    shipped KNDX (a=${shipped.a}, n=${shipped.n}): mean ${(got.mean * 100).toFixed(1)}%` +
        `  worst ${(got.worst * 100).toFixed(1)}% at ${got.worstAt} MPa`
    );
    console.log(
      `    best possible single law (a=${best.a.toExponential(3)}, n=${best.n.toFixed(3)}): ` +
        `mean ${(bestErr.mean * 100).toFixed(1)}%`
    );

    expect(got.mean).toBeLessThan(0.10);
    // Within a percentage point of optimal -- there is nothing to gain by
    // re-fitting, only by abandoning the single-law form.
    expect(got.mean - bestErr.mean).toBeLessThan(0.01);
  });

  it('KNSB systematically UNDER-predicts, and a re-fit would roughly halve the error', () => {
    /*
     * The actionable finding. Every measured point above 0.75 MPa comes out low,
     * so the bias has a direction: predicted burn rate too slow means burn time
     * too long and chamber pressure too LOW. That is the unsafe direction for a
     * pressure-vessel calculation.
     *
     * Not corrected here. Nakka's data is 65/35 with a specific preparation, and
     * swapping the shipped coefficients is a formulation judgement for the
     * project owner, not a test's call to make. The numbers are reported so the
     * decision can be made on evidence.
     */
    const pts = operatingPoints('KN-Sorbitol');
    const shipped = SHIPPED['KN-Sorbitol'];
    const got = errorStats(pts, shipped.a, shipped.n);
    const best = bestSinglePowerLaw(pts);
    const bestErr = errorStats(pts, best.a, best.n);

    console.log(
      `\n    shipped KNSB (a=${shipped.a}, n=${shipped.n}): mean ${(got.mean * 100).toFixed(1)}%` +
        `  worst ${(got.worst * 100).toFixed(1)}% at ${got.worstAt} MPa`
    );
    console.log(
      `    re-fitted to this data:  a=${best.a.toExponential(3)}  n=${best.n.toFixed(4)}` +
        `  ->  mean ${(bestErr.mean * 100).toFixed(1)}%`
    );

    // The bias is one-directional, not scatter.
    const low = pts.filter(
      (m) => burnRate(shipped.a, shipped.n, m.pressureMPa) < m.burnRateCmS / 100
    );
    expect(low.length, 'expected a systematic under-prediction').toBeGreaterThan(pts.length * 0.8);

    // Pinned so a future change to the library shows up here.
    expect(got.mean).toBeGreaterThan(0.08);
    expect(got.mean).toBeLessThan(0.20);
    // And a re-fit really would help, unlike KNDX.
    expect(bestErr.mean).toBeLessThan(got.mean * 0.6);
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
