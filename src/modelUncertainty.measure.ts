/**
 * Measure how far each analytic grain model departs from polygon ground truth,
 * so model uncertainty can be QUANTIFIED per geometry instead of described.
 *
 * Lives in src/ rather than tools/ because it imports grainOutline, and
 * ClipperLib only resolves cleanly under the Vite/Vitest module graph. It is
 * driven by src/geometryError.test.ts, which both regenerates the data file and
 * asserts the errors have not grown -- so the numbers cannot go stale silently.
 *
 * WHY
 *
 * The solver evaluates burning area from closed-form expressions, one per
 * grain type. Several are approximations with known defects -- the Finocyl
 * rectangular-slot treatment, the Star post-transition cylinder -- and until
 * now the size of each defect lived in prose inside test comments, in different
 * units, measured at whatever single point the test happened to pick. That is
 * exactly the "documented but unquantified" problem.
 *
 * GROUND TRUTH
 *
 * outlineAt() computes the port cross-section by offsetting the initial polygon
 * outward with ClipperLib, which is what burning a surface back geometrically
 * IS. It shares no code with the analytic models, so agreement is real evidence
 * and disagreement localises the error.
 *
 * The polygon is itself discretised, so this measures analytic-vs-polygon, not
 * analytic-vs-truth. BATES and Tubular are exact analytically, so their residual
 * IS the discretisation floor, and every other number is read against it.
 */

import { outlineAt } from './grainOutline';
import type { SurrogateGrain } from './surrogate/features';
import { grainFromUi } from './engine';
import type { GrainUiParams } from './engine';

/** How many web fractions to sample between ignition and burnout. */
const SAMPLES = 200;

/**
 * Ignore samples where the burning surface has fallen below this fraction of
 * its initial area. See the note in measure() -- relative error between two
 * vanishing quantities is meaningless, and this tail carries almost no impulse.
 */
const COLLAPSE_FRACTION = 0.05;

interface Case {
  kind: string;
  ui: GrainUiParams;
  grain: SurrogateGrain;
}

const L = 0.3;
const RO = 0.05;

/*
 * One representative motor per geometry, sized so the interesting behaviour is
 * actually reachable: the Star transition and the Finocyl fin burnout both
 * happen partway through the web rather than after the grain is gone.
 */
const CASES: Case[] = [
  {
    kind: 'BATES',
    ui: { grainType: 'BATES', length: L, outerRadius: RO, innerRadius: 0.02 } as GrainUiParams,
    grain: { kind: 'BATES', length: L, outer_radius: RO, inner_radius: 0.02 } as SurrogateGrain,
  },
  {
    kind: 'Tubular',
    ui: { grainType: 'Tubular', length: L, outerRadius: RO, innerRadius: 0.02 } as GrainUiParams,
    grain: { kind: 'Tubular', length: L, outer_radius: RO, inner_radius: 0.02 } as SurrogateGrain,
  },
  {
    kind: 'Star',
    ui: {
      grainType: 'Star',
      length: L,
      outerRadius: RO,
      valleyRadius: 0.028,
      tipRadius: 0.010,
      numPoints: 6,
    } as GrainUiParams,
    grain: {
      kind: 'Star',
      length: L,
      outer_radius: RO,
      valley_radius: 0.028,
      tip_radius: 0.010,
      num_points: 6,
    } as SurrogateGrain,
  },
  {
    kind: 'MoonBurner',
    ui: {
      grainType: 'MoonBurner',
      length: L,
      outerRadius: RO,
      innerRadius: 0.018,
      offset: 0.012,
    },
    grain: {
      kind: 'MoonBurner',
      length: L,
      outer_radius: RO,
      core_radius: 0.018,
      offset: 0.012,
    } as SurrogateGrain,
  },
  {
    kind: 'RodAndTube',
    ui: {
      grainType: 'RodAndTube',
      length: L,
      outerRadius: RO,
      innerRadius: 0.030,
      rodRadius: 0.010,
    },
    grain: {
      kind: 'RodAndTube',
      length: L,
      outer_radius: RO,
      rod_radius: 0.010,
      tube_inner_radius: 0.030,
    } as SurrogateGrain,
  },
  {
    kind: 'Finocyl',
    ui: {
      grainType: 'Finocyl',
      length: L,
      outerRadius: RO,
      innerRadius: 0.015,
      finDepth: 0.020,
      finWidth: 0.006,
      numPoints: 6,
    } as GrainUiParams,
    grain: {
      kind: 'Finocyl',
      length: L,
      outer_radius: RO,
      r_tube: 0.015,
      h_fin: 0.020,
      w_fin: 0.006,
      num_fins: 6,
    },
  },
];

interface Row {
  webFraction: number;
  analytic: number;
  truth: number;
  relError: number;
}

/**
 * What we learned about one geometry.
 *
 * Several different numbers, because "how wrong is this model" has several
 * different answers depending on what you are about to do with it, and
 * collapsing them into one figure hides the distinction that matters.
 *
 * The Finocyl measurement is the case that forced this apart: its raw peak
 * error is 280%, which sounds catastrophic, but it occurs in the burnout tail
 * where the surviving surface is a few percent of the original and contributes
 * almost no impulse. Its impulse-weighted error is a far more modest figure.
 * Both are true; quoting only one of them misleads in opposite directions.
 */
interface Result {
  kind: string;

  /** Mean |relative error| across the sampled web. */
  meanAbsError: number;

  /**
   * Largest |relative error| anywhere, and the web fraction where it occurs.
   *
   * Read `maxAt` before reacting to `maxAbsError`: late in the web this ratio
   * divides two small numbers and is dominated by burnout behaviour rather than
   * by how well the shape is modelled.
   */
  maxAbsError: number;
  maxAt: number;

  /**
   * Error weighted by burning area, so a given percentage counts for as much as
   * the surface producing it.
   *
   * THIS IS THE DECISION-RELEVANT NUMBER for thrust and impulse: it answers
   * "how wrong is the burning area, where there is enough burning area to
   * matter", and it is what the app quotes to the user.
   */
  impulseWeightedError: number;

  /** Mean |error| over the main burn, before any burnout cliff. */
  mainBurnError: number;

  /** Mean SIGNED error: whether the model runs high or low overall. */
  meanSignedError: number;

  /** True if the signed error changes sign, so no single factor can correct it. */
  signFlips: boolean;
  signFlipAt: number | null;

  /**
   * Largest single-step drop in the ANALYTIC curve, as a fraction.
   *
   * Geometries whose topology changes mid-burn -- Finocyl when its fins reach
   * the casing, Rod & Tube when the rod is consumed -- step discontinuously.
   * The solver integrates straight through, so the size is worth knowing.
   */
  maxAnalyticStep: number;
  maxAnalyticStepAt: number;

  /**
   * How much longer the analytic model keeps burning after the polygon says the
   * grain is consumed, as a fraction of total web. Positive means the model
   * invents propellant that geometry says is not there.
   */
  burnoutOverrun: number;

  /** Error in TOTAL burned volume, which is what sets total impulse. */
  volumeError: number;

  samples: number;
}

function measure(c: Case): Result {
  const grain = grainFromUi(c.ui);

  // Burn until the analytic model says there is nothing left.
  let yMax = 0;
  for (let i = 1; i <= 4000; i++) {
    const y = (i / 4000) * RO;
    if (grain.get_burning_area(y) > 0) yMax = y;
    else break;
  }

  /*
   * Ground-truth burning area from the polygon.
   *
   * The lateral term is perimeter * length, which is the convention the
   * analytic models use (get_burning_area / length == perimeter). BATES is the
   * one geometry whose END FACES also burn, contributing 2 * (casing area -
   * port area); omitting that term made BATES -- which is analytically EXACT --
   * look 35% wrong, i.e. it was measuring the harness rather than the model.
   */
  const truthArea = (y: number) => {
    const o = outlineAt(c.grain, y);
    const lateral = o.perimeter * o.length;
    if (c.grain.kind !== 'BATES') return lateral;
    const casing = Math.PI * o.outerRadius * o.outerRadius;
    return lateral + 2 * Math.max(0, casing - o.area);
  };

  const initialTruth = truthArea(0);

  /*
   * ONE pass over the web, not two.
   *
   * Burnout detection used to be a separate scan, which doubled the number of
   * ClipperLib offset operations -- the expensive part -- and pushed this past
   * vitest's 10 s beforeAll hook timeout, failing the whole file. Everything
   * below is derived from a single sampled sweep instead.
   */
  const rows: Row[] = [];
  const analyticCurve: Array<{ y: number; a: number }> = [];
  let yBurnoutTruth = yMax;
  let foundBurnout = false;

  for (let i = 1; i < SAMPLES; i++) {
    const y = (i / SAMPLES) * yMax;
    const analytic = grain.get_burning_area(y);
    const truth = truthArea(y);
    analyticCurve.push({ y, a: analytic });

    if (!foundBurnout && truth <= initialTruth * COLLAPSE_FRACTION) {
      yBurnoutTruth = y;
      foundBurnout = true;
    }

    /*
     * Skip the final collapse to burnout.
     *
     * As both curves fall towards zero a relative error divides two vanishing
     * numbers and diverges. Below a twentieth of the initial area the surface
     * contributes almost nothing to thrust, so the ratio there is numerically
     * loud and physically unimportant. The overrun is captured separately by
     * `burnoutOverrun`, which is the honest way to report it.
     */
    if (truth <= initialTruth * COLLAPSE_FRACTION || analytic <= 1e-9) continue;
    rows.push({ webFraction: y / yMax, analytic, truth, relError: (analytic - truth) / truth });
  }

  if (!rows.length) throw new Error(`no usable samples for ${c.kind}`);

  let maxAbs = 0;
  let maxAt = 0;
  let sumAbs = 0;
  let sumSigned = 0;
  let weighted = 0;
  let weight = 0;
  for (const r of rows) {
    const e = Math.abs(r.relError);
    if (e > maxAbs) {
      maxAbs = e;
      maxAt = r.webFraction;
    }
    sumAbs += e;
    sumSigned += r.relError;
    weighted += e * r.truth;
    weight += r.truth;
  }

  // Where, if anywhere, the bias reverses.
  let flipAt: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    if (Math.sign(rows[i].relError) !== Math.sign(rows[i - 1].relError)) {
      flipAt = rows[i].webFraction;
      break;
    }
  }

  // Largest step in the analytic curve, i.e. a topology change.
  let maxStep = 0;
  let maxStepAt = 0;
  for (let i = 1; i < analyticCurve.length; i++) {
    const prev = analyticCurve[i - 1].a;
    if (prev <= 1e-9) continue;
    const step = Math.abs(analyticCurve[i].a - prev) / prev;
    if (step > maxStep) {
      maxStep = step;
      maxStepAt = analyticCurve[i].y / yMax;
    }
  }

  // "Main burn" = up to the largest step, or the whole thing if there isn't one.
  const cliff = maxStep > 0.2 ? maxStepAt : 1;
  const main = rows.filter((r) => r.webFraction < cliff);
  const mainBurnError = main.length
    ? main.reduce((s, r) => s + Math.abs(r.relError), 0) / main.length
    : sumAbs / rows.length;

  // How long the analytic model burns past the polygon's burnout.
  let yBurnoutAnalytic = yMax;
  for (const pt of analyticCurve) {
    if (pt.a <= initialTruth * COLLAPSE_FRACTION) {
      yBurnoutAnalytic = pt.y;
      break;
    }
  }

  // Burned volume: integrate both area curves over the web.
  let vA = 0;
  let vT = 0;
  for (let i = 1; i < rows.length; i++) {
    const dy = (rows[i].webFraction - rows[i - 1].webFraction) * yMax;
    vA += ((rows[i].analytic + rows[i - 1].analytic) / 2) * dy;
    vT += ((rows[i].truth + rows[i - 1].truth) / 2) * dy;
  }

  return {
    kind: c.kind,
    meanAbsError: sumAbs / rows.length,
    maxAbsError: maxAbs,
    maxAt,
    impulseWeightedError: weight > 0 ? weighted / weight : 0,
    mainBurnError,
    meanSignedError: sumSigned / rows.length,
    signFlips: flipAt !== null,
    signFlipAt: flipAt,
    maxAnalyticStep: maxStep,
    maxAnalyticStepAt: maxStepAt,
    burnoutOverrun: (yBurnoutAnalytic - yBurnoutTruth) / yMax,
    volumeError: (vA - vT) / vT,
    samples: rows.length,
  };
}

export interface GeometryErrorReport {
  generatedBy: string;
  method: string;
  discretisationFloor: number;
  geometries: Record<string, Result>;
}

/** Run the full sweep. Pure: no file IO, no logging. */
export function measureAllGeometries(): GeometryErrorReport {
  const results = CASES.map(measure);

  // BATES and Tubular are exact analytically, so whatever error they show is
  // the polygon discretisation, not the model. That is the noise floor every
  // other number here must be read against.
  const floor = Math.max(
    ...results.filter((r) => r.kind === "BATES" || r.kind === "Tubular").map((r) => r.maxAbsError)
  );

  return {
    generatedBy: "src/modelUncertainty.measure.ts, driven by src/geometryError.test.ts",
    method:
      "Analytic get_burning_area compared to ClipperLib polygon offsetting at " +
      SAMPLES +
      " web fractions per geometry. Shares no code with the analytic models.",
    discretisationFloor: floor,
    geometries: Object.fromEntries(results.map((r) => [r.kind, r])),
  };
}

/** Human-readable table, used by the test log and the docs generator. */
export function formatGeometryErrors(rep: GeometryErrorReport): string {
  const pct = (v: number, w = 6) => (v * 100).toFixed(2).padStart(w) + "%";
  const lines = [
    "geometry      impulse-wtd  mainburn   max|e| (at web)   volume   step      overrun",
  ];
  for (const r of Object.values(rep.geometries)) {
    lines.push(
      r.kind.padEnd(12) +
        " " + pct(r.impulseWeightedError, 10) +
        "  " + pct(r.mainBurnError, 7) +
        "  " + pct(r.maxAbsError, 7) + " (" + (r.maxAt * 100).toFixed(0).padStart(3) + "%)" +
        "  " + pct(r.volumeError, 6) +
        "  " + pct(r.maxAnalyticStep, 6) +
        "  " + pct(r.burnoutOverrun, 6)
    );
  }
  lines.push("");
  lines.push("polygon discretisation floor: " + (rep.discretisationFloor * 100).toFixed(3) + "%");
  return lines.join(String.fromCharCode(10));
}

export type { Result as GeometryErrorResult };
