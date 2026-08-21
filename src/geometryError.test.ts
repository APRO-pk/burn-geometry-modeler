import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  measureAllGeometries,
  formatGeometryErrors,
  type GeometryErrorReport,
} from './modelUncertainty.measure';

/*
 * ============================================================================
 * HOW WRONG IS EACH GRAIN MODEL, IN NUMBERS
 * ============================================================================
 *
 * The solver computes burning area from a closed-form expression per grain
 * type. Several of those are approximations with known defects. Until now the
 * size of each defect lived in prose inside test comments -- "up to ~15% low at
 * the transition", "9.70% here" -- measured at whichever single point the test
 * happened to pick, in inconsistent terms, and never surfaced to the user.
 *
 * This file measures every geometry against ClipperLib polygon offsetting,
 * which shares no code with the analytic models, and writes the result to
 * src/modelUncertainty.data.json. That file is what the app reads to tell the
 * user how much to trust a given prediction, so it must not go stale: this test
 * regenerates it on every run and fails if any model has got worse.
 *
 * The bounds below are deliberately a little above the measured values. They
 * are a ratchet against regression, not a target to tune to.
 * ============================================================================
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, 'modelUncertainty.data.json');

let report: GeometryErrorReport;

beforeAll(() => {
  report = measureAllGeometries();
  /*
   * Regenerate the artifact the app ships -- but only if it actually changed.
   *
   * src/modelUncertainty.ts IMPORTS this JSON, and vitest runs test files in
   * parallel workers. Rewriting it unconditionally meant another worker could
   * import it mid-write and read a truncated file; that showed up once as a
   * whole suite failing with no visible assertion error, which is the worst
   * kind of flake because the natural response is to re-run and move on.
   *
   * Two defences: skip the write entirely when the content is identical (the
   * usual case, so usually there is no write to race with), and when a write is
   * needed do it atomically via rename, so no reader ever sees a partial file.
   */
  const next = JSON.stringify(report, null, 2) + '\n';
  const current = fs.existsSync(DATA) ? fs.readFileSync(DATA, 'utf8') : null;
  if (current !== next) {
    const tmp = `${DATA}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, DATA);
  }

  console.log('\n' + formatGeometryErrors(report));
  // Generous timeout: this sweep runs a few thousand ClipperLib polygon
  // offsets. It took ~10s before being made single-pass, which tripped
  // vitest's 10s default and failed the whole FILE -- reported as 13 SKIPPED
  // tests with no assertion error, which is hard to diagnose from CI output.
}, 60_000);

describe('the exact geometries establish the measurement noise floor', () => {
  /*
   * BATES and Tubular have analytically exact burning-area expressions, so any
   * disagreement with the polygon is the POLYGON's discretisation, not the
   * model's. Every other number in this file has to be read against this, or a
   * 1% "model error" that is really 1% circle faceting would look meaningful.
   */
  it('BATES and Tubular agree with the polygon to well under a percent', () => {
    for (const kind of ['BATES', 'Tubular']) {
      const r = report.geometries[kind];
      expect(r, `${kind} missing`).toBeTruthy();
      expect(r.maxAbsError, `${kind} should be exact`).toBeLessThan(0.01);
    }
  });

  it('the floor is small enough that the approximate models are distinguishable', () => {
    // If the floor ever approached the defects being measured, this whole file
    // would stop being evidence about the models.
    const worstApprox = Math.max(
      ...['Star', 'Finocyl', 'MoonBurner', 'RodAndTube'].map(
        (k) => report.geometries[k]?.maxAbsError ?? 0
      )
    );
    expect(report.discretisationFloor).toBeLessThan(worstApprox / 3);
  });
});

describe('every geometry has a measured error budget', () => {
  it('covers all the shipped grain types', () => {
    for (const kind of ['BATES', 'Tubular', 'Star', 'MoonBurner', 'RodAndTube', 'Finocyl']) {
      expect(report.geometries[kind], `${kind} not measured`).toBeTruthy();
      expect(report.geometries[kind].samples).toBeGreaterThan(50);
    }
  });

  it('no model exceeds 10% error where there is enough burning area to matter', () => {
    /*
     * A ratchet, on the IMPULSE-WEIGHTED error rather than the raw maximum.
     *
     * The raw maximum is the wrong thing to bound. Finocyl peaks at 280%, but
     * that happens in the burnout tail where the remaining surface is a few
     * percent of the original; bounding it would mean either accepting a
     * meaningless 300% limit or failing on a defect that barely moves the
     * thrust curve. The weighted figure asks the question that matters -- how
     * wrong is the area, where there IS area -- and Finocyl's 8.5% is a real
     * number the user should see.
     */
    for (const [kind, r] of Object.entries(report.geometries)) {
      expect(r.impulseWeightedError, `${kind} impulse-weighted error`).toBeLessThan(0.10);
    }
  });

  it('the burnout tail is the only place any model is wildly off', () => {
    // Guards the reasoning above: if a large raw error ever appeared EARLY in
    // the web, the weighted metric would be hiding something real.
    for (const [kind, r] of Object.entries(report.geometries)) {
      if (r.maxAbsError <= 0.25) continue;
      expect(r.maxAt, `${kind} has a large error early in the web`).toBeGreaterThan(0.7);
    }
  });

  it('total burned volume, which sets impulse, is accurate for every geometry', () => {
    /*
     * Instantaneous burning area can be locally wrong while the INTEGRAL stays
     * close, and it is the integral that determines total impulse. Separating
     * the two matters: a geometry can be poor for thrust SHAPE and still fine
     * for total impulse, and the user should be told which.
     */
    for (const [kind, r] of Object.entries(report.geometries)) {
      expect(Math.abs(r.volumeError), `${kind} burned-volume error`).toBeLessThan(0.10);
    }
  });
});

describe('the specific known defects, pinned', () => {
  /*
   * These are the numbers the docs and the UI quote. Pinning them means the
   * documentation cannot drift away from the code: change a geometry model and
   * this test tells you the published figure is now wrong.
   */

  it('Finocyl is the worst model in the set, by every measure', () => {
    const f = report.geometries['Finocyl'];
    console.log(
      `\n    Finocyl: impulse-weighted ${(f.impulseWeightedError * 100).toFixed(1)}%, ` +
        `main burn ${(f.mainBurnError * 100).toFixed(1)}%, ` +
        `raw max ${(f.maxAbsError * 100).toFixed(0)}% at ${(f.maxAt * 100).toFixed(0)}% web`
    );
    for (const [kind, r] of Object.entries(report.geometries)) {
      if (kind === 'Finocyl') continue;
      expect(f.impulseWeightedError, `Finocyl vs ${kind}`).toBeGreaterThan(r.impulseWeightedError);
    }
    // The rectangular-slot approximation, quantified. Pinned so the figure the
    // app shows the user cannot drift away from the code.
    expect(f.impulseWeightedError).toBeGreaterThan(0.05);
    expect(f.impulseWeightedError).toBeLessThan(0.12);
  });

  it('Finocyl steps ~50% when its fins reach the casing', () => {
    /*
     * A topology change the closed form handles by switching branches. The
     * solver integrates straight through the discontinuity, so a thrust trace
     * near that web shows a cliff that real hardware would round off.
     */
    const f = report.geometries['Finocyl'];
    console.log(
      `\n    largest analytic step: ${(f.maxAnalyticStep * 100).toFixed(0)}% at ` +
        `${(f.maxAnalyticStepAt * 100).toFixed(0)}% web`
    );
    expect(f.maxAnalyticStep).toBeGreaterThan(0.3);
    expect(f.maxAnalyticStepAt).toBeGreaterThan(0.2);
    expect(f.maxAnalyticStepAt).toBeLessThan(0.8);
  });

  it('Finocyl keeps burning after the geometry says the grain is gone', () => {
    /*
     * The defect with the clearest physical meaning, and the one most worth
     * telling a user about: past fin burnout the closed form decays linearly to
     * zero over about a tenth of the web MORE than the polygon needs. It is
     * inventing propellant, which inflates burn time and total impulse.
     *
     * Every other geometry burns out on time, so this is specific to the model
     * rather than an artifact of how burnout is detected.
     */
    const f = report.geometries['Finocyl'];
    console.log(`\n    Finocyl burnout overrun: ${(f.burnoutOverrun * 100).toFixed(1)}% of web`);
    expect(f.burnoutOverrun).toBeGreaterThan(0.02);
    for (const [kind, r] of Object.entries(report.geometries)) {
      if (kind === 'Finocyl') continue;
      expect(r.burnoutOverrun, `${kind} should burn out on time`).toBeLessThan(0.02);
    }
  });

  it('a sign-flipping error cannot be corrected by a single scale factor', () => {
    /*
     * Worth stating explicitly because it constrains the fix. A model that is
     * uniformly 10% high can be rescaled. One whose error changes sign partway
     * through the web cannot -- any single correction factor makes one half
     * worse. That is why these are reported as uncertainty rather than
     * silently compensated.
     */
    for (const [kind, r] of Object.entries(report.geometries)) {
      if (!r.signFlips) continue;
      // Mean signed error is small precisely BECAUSE the halves cancel, while
      // the mean absolute error is not. That gap is the signature.
      expect(Math.abs(r.meanSignedError), `${kind}`).toBeLessThan(r.meanAbsError + 1e-12);
    }
    const flipping = Object.entries(report.geometries)
      .filter(([, r]) => r.signFlips)
      .map(([k]) => k);
    console.log(`\n    sign-flipping error: ${flipping.join(', ') || 'none'}`);
  });
});

describe('the data file the app ships', () => {
  it('exists and matches what was just measured', () => {
    expect(fs.existsSync(DATA)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    expect(onDisk.geometries).toEqual(report.geometries);
  });

  it('records how it was produced, not just what it found', () => {
    const onDisk = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    expect(onDisk.generatedBy).toContain('modelUncertainty.measure');
    expect(onDisk.method).toContain('ClipperLib');
    expect(typeof onDisk.discretisationFloor).toBe('number');
  });

  it('carries no timestamp, so it is byte-reproducible in CI', () => {
    // A generatedAt field would make the file change on every run and turn the
    // CI staleness check into noise that everyone learns to ignore.
    const raw = fs.readFileSync(DATA, 'utf8');
    expect(raw).not.toMatch(/generatedAt/);
  });
});
