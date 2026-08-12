/**
 * Feature expansion for the surrogate. THE SINGLE SOURCE OF TRUTH -- the
 * training script in tools/ imports this same file, so the browser cannot drift
 * from what the model was fitted on.
 *
 * The user supplies eight raw design parameters. The GP does not see them
 * directly, for two reasons.
 *
 * POWER LAWS. Internal ballistics is multiplicative almost everywhere:
 * equilibrium pressure goes as Kn^(1/(1-n)), burn time as web / (a Pc^n),
 * impulse as mass x Isp. In linear coordinates those are strongly curved
 * surfaces and the GP has to spend its length scales bending around them; in
 * log coordinates most of them are close to planes, which a squared-exponential
 * kernel fits almost exactly. Logging the positive inputs was the single
 * largest accuracy change made to this model.
 *
 * KNOWN STRUCTURE. Some quantities the outputs depend on are exactly
 * computable from the inputs -- initial Kn, propellant mass, web thickness --
 * and the response depends on those combinations far more simply than on the
 * raw parts. Handing them over means the GP interpolates a smooth residual
 * instead of rediscovering algebra from samples.
 *
 * This is ordinary feature engineering, not physics smuggled into the answer:
 * every derived column is an exact algebraic function of the eight inputs, so
 * no information enters that the caller did not supply.
 */

/** Raw design parameters, in the order the surrogate's callers supply them. */
export const RAW_FEATURES = [
  'length',
  'outer_radius',
  'inner_radius',
  'throat_diameter',
  'expansion_ratio',
  'a',
  'n',
  'density',
] as const;
export type RawFeature = (typeof RAW_FEATURES)[number];

/** Pressure at which the reference burn rate is quoted, Pa. */
export const P_REF = 7.0e6;

/** Names of the expanded features, for diagnostics such as ARD relevance. */
export const EXPANDED_FEATURES = [
  'log_length',
  'log_outer_radius',
  'log_inner_radius',
  'log_throat_diameter',
  'expansion_ratio',
  'log_a',
  'n',
  'log_density',
  // --- derived ---
  'log_kn0',
  'log_prop_mass',
  'log_web',
  'log_burn_rate_ref',
  'log_port_to_throat',
  'log_l_over_d',
] as const;

export const N_EXPANDED = EXPANDED_FEATURES.length;

const ln = Math.log;
/** Guard against log(0) for degenerate geometry the user may type mid-edit. */
const safeLn = (v: number) => ln(Math.max(v, 1e-12));

/**
 * Expand the eight raw parameters into the model's input vector.
 *
 * `out` may be supplied to avoid allocating; the instant-prediction path calls
 * this on every keystroke.
 */
export function expandFeatures(
  length: number,
  outerRadius: number,
  innerRadius: number,
  throatDiameter: number,
  expansionRatio: number,
  a: number,
  n: number,
  density: number,
  out: Float64Array = new Float64Array(N_EXPANDED)
): Float64Array {
  const throatArea = (Math.PI / 4) * throatDiameter * throatDiameter;
  // Initial BATES burning area: bore plus both end faces.
  const ab0 =
    2 * Math.PI * innerRadius * length +
    2 * Math.PI * (outerRadius * outerRadius - innerRadius * innerRadius);
  const portArea = Math.PI * innerRadius * innerRadius;
  const propMass =
    Math.PI * (outerRadius * outerRadius - innerRadius * innerRadius) * length * density;
  const web = outerRadius - innerRadius;

  out[0] = safeLn(length);
  out[1] = safeLn(outerRadius);
  out[2] = safeLn(innerRadius);
  out[3] = safeLn(throatDiameter);
  out[4] = expansionRatio;
  out[5] = safeLn(a);
  out[6] = n;
  out[7] = safeLn(density);

  out[8] = safeLn(ab0 / Math.max(throatArea, 1e-12));
  out[9] = safeLn(propMass);
  out[10] = safeLn(web);
  // Burn rate at the reference pressure: the conditioned way to describe a
  // propellant, since `a` alone is a rate extrapolated to 1 Pa.
  out[11] = safeLn(a) + n * ln(P_REF);
  out[12] = safeLn(portArea / Math.max(throatArea, 1e-12));
  out[13] = safeLn(length / Math.max(2 * innerRadius, 1e-12));

  return out;
}

/** Convenience wrapper taking the raw parameters as an object. */
export interface RawDesign {
  length: number;
  outer_radius: number;
  inner_radius: number;
  throat_diameter: number;
  expansion_ratio: number;
  a: number;
  n: number;
  density: number;
}

export function expandDesign(d: RawDesign, out?: Float64Array): Float64Array {
  return expandFeatures(
    d.length,
    d.outer_radius,
    d.inner_radius,
    d.throat_diameter,
    d.expansion_ratio,
    d.a,
    d.n,
    d.density,
    out
  );
}
