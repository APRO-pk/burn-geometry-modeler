/**
 * Per-output model uncertainty for the internal-ballistics side.
 *
 * The structural tab already tells the user what it assumed and where it is
 * shaky. The ballistics tab did not: it produced a peak pressure to four
 * significant figures with no indication that, say, a Finocyl grain's burning
 * area is modelled to about 8%. This module closes that gap.
 *
 * WHAT THIS IS NOT
 *
 * Not a confidence interval. It does not say "95% of real motors will land in
 * this band" -- nothing here has been validated against enough instrumented
 * firings to support that claim, and pretending otherwise would manufacture
 * exactly the false precision this module exists to remove.
 *
 * It is a MODEL-FORM uncertainty budget: the known, measured error of each
 * approximation the solver makes, propagated to the outputs through the
 * sensitivities below. Real hardware also varies in ways this cannot see --
 * propellant batch, grain defects, nozzle machining, ambient temperature -- so
 * treat these as a floor on the error, never a bound on it.
 *
 * WHERE THE NUMBERS COME FROM
 *
 *   geometry     src/modelUncertainty.data.json, measured against ClipperLib
 *                polygon offsetting by src/geometryError.test.ts
 *   burn rate    src/burnRate.validation.test.ts, against Nakka's strand-burner
 *                measurements
 *   Isp          src/validation.test.ts, against 400+ certified motors
 *   erosive      uncalibrated; see crates/burn-core/src/erosive.rs
 *   nozzle       tools/calibrateBartz.mts, simplified vs real Bartz
 *
 * Every figure is traceable to a test that measures it. Nothing here is a
 * guess dressed as data.
 */

import data from './modelUncertainty.data.json';

export type UncertaintyOutput =
  | 'peak_pressure'
  | 'total_impulse'
  | 'burn_time'
  | 'throat_erosion';

/** One contributing source of error, before propagation. */
export interface UncertaintySource {
  name: string;
  /** Relative error of the SOURCE quantity, e.g. 0.084 for Finocyl area. */
  relative: number;
  /** Where the number was measured. */
  basis: string;
}

export interface OutputUncertainty {
  output: UncertaintyOutput;
  label: string;
  /** Combined relative uncertainty on this output. */
  relative: number;
  /** The single largest contributor, which is what a user should act on. */
  dominant: string;
  /** All contributions, already propagated to this output. */
  contributions: Array<{ name: string; relative: number; basis: string }>;
  /** True when the estimate itself is weak, not just the value. */
  orderOfMagnitudeOnly: boolean;
}

export interface UncertaintyInputs {
  grainKind: string;
  /** Saint-Robert pressure exponent, which sets the pressure amplification. */
  n: number;
  /** True when the propellant carries a measured piecewise burn-rate law. */
  hasBurnRateRegimes: boolean;
  /** Propellant name, used to pick the measured burn-rate error. */
  propellantName: string;
  erosiveModel: string;
  /** True when a nozzle material is configured, enabling the erosion model. */
  hasNozzleMaterial: boolean;
  /**
   * Peak erosive augmentation as a fraction of the base burn rate, if known.
   *
   * Lets the erosive uncertainty scale with how much erosion this particular
   * motor has, rather than applying a blanket figure to a motor that barely
   * erodes. Omit it and a pessimistic default is used and labelled as such.
   */
  erosiveFraction?: number;
}

/*
 * ---------------------------------------------------------------------------
 * Measured input uncertainties
 * ---------------------------------------------------------------------------
 */

/**
 * Burn-rate coefficient uncertainty, from src/burnRate.validation.test.ts.
 *
 * The sugar propellants have been measured against Nakka's strand burner. APCP
 * has NOT been validated against anything in this repository, so it carries a
 * deliberately wide band rather than a flattering small one -- an unvalidated
 * propellant should not look more certain than a measured one.
 */
const BURN_RATE_ERROR = {
  measuredPiecewise: 0.018, // KNSB 1.8%, KNDX 1.2%; the worse of the two
  measuredSingleLaw: 0.061, // best single power law over the same data
  unvalidated: 0.15, // no measurement in this repo; a stated guess, flagged
};

/**
 * Delivered-Isp uncertainty, from src/validation.test.ts.
 *
 * The shipped APCP predicts 222.9 s at eps=6 against a real certified
 * distribution with median 189.9 and p95 226.5. The model lands near the top of
 * the real range, which is expected -- it assumes a well-made motor -- but the
 * spread of real hardware around any prediction is what this number captures.
 */
const ISP_ERROR = 0.08;

/**
 * Erosive burning, from crates/burn-core/src/erosive.rs.
 *
 * LR_ALPHA has no calibration in this repository -- Lenoir-Robillard fit alpha
 * per propellant from firing data and there is no universal value -- so the
 * augmentation it produces could plausibly be absent or twice as large.
 *
 * This is a fraction OF THE EROSIVE AUGMENTATION, not of the whole burn rate.
 * The distinction matters: applying it to the total rate reported +-75% on peak
 * pressure for a motor whose erosive contribution was a couple of percent,
 * which would train users to ignore the number entirely. What reaches the
 * output is this figure scaled by how much erosion the motor actually has.
 */
const EROSIVE_COEFFICIENT_ERROR = 1.0;

/**
 * Erosive augmentation as a fraction of base burn rate, when the caller has not
 * told us the motor's actual figure.
 *
 * Deliberately pessimistic: an unknown erosive contribution should not look
 * small. Callers that pass `erosiveFraction` get a motor-specific number.
 */
const EROSIVE_FRACTION_UNKNOWN = 0.25;

/**
 * Nozzle throat erosion, from tools/calibrateBartz.mts.
 *
 * The simplified correlation reproduces real Bartz EXACTLY in its pressure and
 * diameter dependence -- the ratio is constant to three figures across every
 * motor size and chamber pressure sampled -- but its magnitude is about 7x
 * high, and its sqrt(T_flame) factor introduces a further 1.4x spread across
 * the flame temperatures of interest. So the erosion RATE is not trustworthy in
 * absolute terms, while the way it scales with the motor is.
 */
const NOZZLE_HEAT_FLUX_ERROR = 6.0;

/*
 * ---------------------------------------------------------------------------
 * Propagation
 * ---------------------------------------------------------------------------
 *
 * Equilibrium chamber pressure follows Pc = (Kn * a * rho * c*)^(1/(1-n)), so a
 * fractional error in burning area or burn-rate coefficient is AMPLIFIED by
 * 1/(1-n) when it reaches pressure. At n = 0.32 that is 1.47x; at n = 0.5 it is
 * 2x. This is the single most important propagation factor in the model and the
 * reason a high-n propellant is harder to predict as well as harder to fly.
 */
export function pressureAmplification(n: number): number {
  const safeN = Math.min(Math.max(n, 0), 0.95);
  return 1 / (1 - safeN);
}

/** Root-sum-square, for sources treated as independent. */
function rss(values: number[]): number {
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0));
}

function burnRateSource(inp: UncertaintyInputs): UncertaintySource {
  const isSugar = /KNSB|KNDX|sorbitol|dextrose/i.test(inp.propellantName);
  if (!isSugar) {
    return {
      name: 'Burn-rate law (unvalidated propellant)',
      relative: BURN_RATE_ERROR.unvalidated,
      basis: 'No strand-burner measurement for this propellant in this repository',
    };
  }
  if (inp.hasBurnRateRegimes) {
    return {
      name: 'Burn-rate law (measured, piecewise)',
      relative: BURN_RATE_ERROR.measuredPiecewise,
      basis: 'Nakka 1999 strand burner, src/burnRate.validation.test.ts',
    };
  }
  return {
    name: 'Burn-rate law (single power law)',
    relative: BURN_RATE_ERROR.measuredSingleLaw,
    basis: 'Best single power law over Nakka 1999; piecewise would reach 1.8%',
  };
}

function geometrySource(kind: string): UncertaintySource {
  const g = (data.geometries as Record<string, { impulseWeightedError: number }>)[kind];
  if (!g) {
    return {
      name: `Grain geometry (${kind}, unmeasured)`,
      relative: 0.05,
      basis: 'No polygon comparison for this geometry; stated estimate',
    };
  }
  return {
    name: `Grain geometry (${kind})`,
    relative: g.impulseWeightedError,
    basis: 'Burning area vs ClipperLib polygon offsetting, src/geometryError.test.ts',
  };
}

function volumeSource(kind: string): UncertaintySource {
  const g = (data.geometries as Record<string, { volumeError: number }>)[kind];
  return {
    name: `Burned volume (${kind})`,
    relative: g ? Math.abs(g.volumeError) : 0.03,
    basis: 'Integrated burning area vs polygon ground truth',
  };
}

/** Build the full per-output uncertainty budget. */
export function modelUncertainty(inp: UncertaintyInputs): OutputUncertainty[] {
  const amp = pressureAmplification(inp.n);
  const burn = burnRateSource(inp);
  const geom = geometrySource(inp.grainKind);
  const vol = volumeSource(inp.grainKind);
  const erosiveOn = inp.erosiveModel !== 'None' && inp.erosiveModel !== '';

  const out: OutputUncertainty[] = [];

  // --- peak chamber pressure ---
  {
    const contributions = [
      { name: geom.name, relative: geom.relative * amp, basis: geom.basis },
      { name: burn.name, relative: burn.relative * amp, basis: burn.basis },
    ];
    if (erosiveOn) {
      const known = typeof inp.erosiveFraction === 'number' && inp.erosiveFraction >= 0;
      const fraction = known ? inp.erosiveFraction! : EROSIVE_FRACTION_UNKNOWN;
      contributions.push({
        name: `Erosive burning (${inp.erosiveModel}, uncalibrated)`,
        relative: EROSIVE_COEFFICIENT_ERROR * fraction * amp,
        basis: known
          ? `Erosion contributes ${(fraction * 100).toFixed(1)}% of burn rate at peak flux; ` +
            'the coefficient behind it is uncalibrated, so treat that whole contribution as uncertain'
          : 'LR_ALPHA has no calibration in this repository; erosive contribution not measured for this motor',
      });
    }
    // Order-of-magnitude only when erosion is actually a large part of the burn.
    const erosiveDominates =
      erosiveOn && (inp.erosiveFraction ?? EROSIVE_FRACTION_UNKNOWN) > 0.15;
    out.push(finish('peak_pressure', 'Peak chamber pressure', contributions, erosiveDominates));
  }

  // --- total impulse ---
  {
    /*
     * Impulse is far less sensitive than pressure. It is set by how much
     * propellant there is and how efficiently it is expelled, not by the
     * instantaneous burning area, so the amplification factor does NOT apply
     * and the burned-volume error matters more than the area error.
     */
    const contributions = [
      { name: vol.name, relative: vol.relative, basis: vol.basis },
      {
        name: 'Delivered Isp (c*, Cf efficiencies)',
        relative: ISP_ERROR,
        basis: '400+ certified motors, src/validation.test.ts',
      },
    ];
    out.push(finish('total_impulse', 'Total impulse', contributions, false));
  }

  // --- burn time ---
  {
    /*
     * Burn time is web over burn rate. Burning-area error enters only through
     * its effect on pressure and hence rate, so it is damped rather than
     * amplified -- the n/(1-n) factor rather than 1/(1-n).
     */
    const damp = Math.min(Math.max(inp.n, 0), 0.95) * amp;
    const contributions = [
      { name: burn.name, relative: burn.relative, basis: burn.basis },
      { name: geom.name, relative: geom.relative * damp, basis: geom.basis },
    ];
    const g = (data.geometries as Record<string, { burnoutOverrun: number }>)[inp.grainKind];
    if (g && g.burnoutOverrun > 0.02) {
      contributions.push({
        name: `Late burnout (${inp.grainKind} model burns past geometric burnout)`,
        relative: g.burnoutOverrun,
        basis: 'Analytic burnout vs polygon burnout, src/geometryError.test.ts',
      });
    }
    out.push(finish('burn_time', 'Burn time', contributions, false));
  }

  // --- throat erosion ---
  if (inp.hasNozzleMaterial) {
    out.push(
      finish(
        'throat_erosion',
        'Throat erosion',
        [
          {
            name: 'Simplified Bartz heat-transfer coefficient',
            relative: NOZZLE_HEAT_FLUX_ERROR,
            basis: 'About 7x the real Bartz correlation, tools/calibrateBartz.mts',
          },
        ],
        true
      )
    );
  }

  return out;
}

function finish(
  output: UncertaintyOutput,
  label: string,
  contributions: Array<{ name: string; relative: number; basis: string }>,
  orderOfMagnitudeOnly: boolean
): OutputUncertainty {
  const sorted = [...contributions].sort((a, b) => b.relative - a.relative);
  return {
    output,
    label,
    relative: rss(contributions.map((c) => c.relative)),
    dominant: sorted[0]?.name ?? 'unknown',
    contributions: sorted,
    orderOfMagnitudeOnly,
  };
}

/** Format a band for display, e.g. "±12%" or ">2x" when it is very wide. */
export function formatBand(u: OutputUncertainty): string {
  if (u.relative >= 1) return `>${(1 + u.relative).toFixed(0)}x`;
  return `±${(u.relative * 100).toFixed(u.relative < 0.1 ? 1 : 0)}%`;
}

/** The measured geometry table, for display and for the docs. */
export const geometryErrors = data.geometries as Record<
  string,
  {
    kind: string;
    impulseWeightedError: number;
    mainBurnError: number;
    maxAbsError: number;
    maxAt: number;
    volumeError: number;
    maxAnalyticStep: number;
    maxAnalyticStepAt: number;
    burnoutOverrun: number;
    signFlips: boolean;
  }
>;
