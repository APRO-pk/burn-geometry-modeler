/**
 * Feature extraction for the surrogate. THE SINGLE SOURCE OF TRUTH -- the
 * training scripts in tools/ import this same file, so the browser cannot drift
 * from what the model was fitted on.
 *
 * # Why this is geometry-agnostic
 *
 * The 0-D solver touches the grain through exactly three things (grep
 * `self.grain` in crates/burn-core/src/sim.rs):
 *
 *     burning_area(y)      port_area(y)      length()
 *
 * Nothing else. Not the grain KIND, not its parameters -- those exist only to
 * produce those two curves. So a feature vector that describes the curves is
 * sufficient IN PRINCIPLE to predict the run, and one model covers BATES, Star,
 * Tubular, Rod & Tube, MoonBurner, Finocyl and Custom DXF alike.
 *
 * That is why there is one model here and not seven. Seven would each have
 * needed their own parameter list, envelope, sampling ranges and metrics table,
 * and a grain type nobody trained on would have been unsupported forever.
 * Describing the curves instead means a new geometry is covered the day it is
 * added -- provided its curves resemble something in the training set, and the
 * GP's own uncertainty is what says whether they do.
 *
 * # What the features are
 *
 * Scalars that set the SCALE of the problem (initial burning area, port area,
 * propellant mass, web, Kn, port-to-throat), plus dimensionless samples of the
 * burn-back curve that set its SHAPE -- `Ab(y)/Ab(0)` at fixed fractions of the
 * web. That shape is what makes a grain progressive, neutral or regressive, and
 * it is the strongest single driver of the pressure trace.
 *
 * Everything positive that spans decades is logged: internal ballistics is
 * multiplicative (pressure goes as Kn^(1/(1-n)), burn time as web/(a Pc^n)), so
 * in log coordinates most of the response is close to flat, which is what a
 * squared-exponential kernel fits best.
 *
 * All of it is exact algebra on the caller's own inputs -- no information enters
 * that the caller did not supply.
 */

import { BATES, Star, Tubular, RodAndTube, MoonBurner, Finocyl, CustomDXF } from '../engine';
import type { GrainGeometry } from '../engine';

/** Pressure at which the reference burn rate is quoted, Pa. */
export const P_REF = 7.0e6;

/**
 * Fractions of the burnt-out web at which the burning-area curve is sampled.
 *
 * Nine points, evenly spread. Five were enough for the smooth geometries but
 * not for the ones whose curve has a KINK -- Finocyl when its fin slots reach
 * the casing, Rod & Tube when the central rod burns through -- where a coarse
 * grid can step straight over the discontinuity. Those two had burn-time R^2 of
 * 0.57 and 0.77 on five samples.
 */
export const AB_SAMPLE_FRACTIONS = [
  0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.9, 0.96,
] as const;
/** Fractions of the web at which the port-area curve is sampled. */
export const PORT_SAMPLE_FRACTIONS = [0.25, 0.6, 0.9] as const;

export const EXPANDED_FEATURES: string[] = [
  // --- propellant and nozzle ---
  'log_a',
  'n',
  'log_density',
  'log_throat_diameter',
  'expansion_ratio',
  'log_burn_rate_ref',
  // --- grain scale ---
  'log_length',
  'log_outer_radius',
  'log_ab0',
  'log_aport0',
  'log_web',
  'log_prop_mass',
  'log_kn0',
  'log_port_to_throat',
  // --- grain shape (dimensionless) ---
  ...AB_SAMPLE_FRACTIONS.map((f) => 'ab_at_' + Math.round(f * 100)),
  ...PORT_SAMPLE_FRACTIONS.map((f) => 'port_at_' + Math.round(f * 100)),
  // Where the curve turns over, and how far it rises before it does. Grains
  // with a kink -- Finocyl when its slots reach the casing, Rod & Tube when the
  // rod burns through -- are not well described by samples alone, because the
  // kink can fall between two of them. These locate it directly.
  'ab_peak_fraction',
  'log_ab_peak_ratio',
  // The integral that actually sets burn time; see `burnTimeShape`.
  'log_tb_shape',
];

export const N_EXPANDED = EXPANDED_FEATURES.length;

const ln = Math.log;
/** Guard against log(0) for degenerate geometry the user may type mid-edit. */
const safeLn = (v: number) => ln(Math.max(v, 1e-12));

// --- grain config -> TypeScript geometry ----------------------------------

/** The grain half of a run configuration, in the core's own shape. */
export type SurrogateGrain =
  | { kind: 'BATES'; length: number; outer_radius: number; inner_radius: number }
  | {
      kind: 'Star';
      length: number;
      outer_radius: number;
      valley_radius: number;
      tip_radius: number;
      num_points: number;
    }
  | { kind: 'Tubular'; length: number; outer_radius: number; inner_radius: number }
  | {
      kind: 'RodAndTube';
      length: number;
      outer_radius: number;
      rod_radius: number;
      tube_inner_radius: number;
    }
  | {
      kind: 'MoonBurner';
      length: number;
      outer_radius: number;
      core_radius: number;
      offset: number;
    }
  | {
      kind: 'Finocyl';
      length: number;
      outer_radius: number;
      r_tube: number;
      num_fins: number;
      w_fin: number;
      h_fin: number;
    }
  | {
      kind: 'CustomDXF';
      length: number;
      outer_radius: number;
      dx: number;
      perim_table: number[];
      area_table: number[];
      /** Traced profile, for drawing. Not used by the solver or the surrogate. */
      base_polygon?: Array<Array<{ x: number; y: number }>>;
    };

export type GrainKind = SurrogateGrain['kind'];

/** Every geometry the surrogate covers -- which is every geometry the app has. */
export const SURROGATE_GRAIN_KINDS: GrainKind[] = [
  'BATES',
  'Star',
  'Tubular',
  'RodAndTube',
  'MoonBurner',
  'Finocyl',
  'CustomDXF',
];

/**
 * Build the TypeScript geometry for a grain config.
 *
 * These classes are the ones src/wasm.parity.test.ts proves bit-exact against
 * the Rust implementations (worst relative error 0 on burning area, 3e-16 on
 * port area), so deriving features from them costs nothing in fidelity and
 * avoids maintaining a second copy of seven geometry models.
 */
export function grainFromConfig(g: SurrogateGrain): GrainGeometry {
  switch (g.kind) {
    case 'BATES':
      return new BATES(g.length, g.outer_radius, g.inner_radius);
    case 'Star':
      return new Star(g.length, g.outer_radius, g.valley_radius, g.tip_radius, g.num_points);
    case 'Tubular':
      return new Tubular(g.length, g.outer_radius, g.inner_radius);
    case 'RodAndTube':
      return new RodAndTube(g.length, g.outer_radius, g.rod_radius, g.tube_inner_radius);
    case 'MoonBurner':
      return new MoonBurner(g.length, g.outer_radius, g.core_radius, g.offset);
    case 'Finocyl':
      return new Finocyl(g.length, g.outer_radius, g.r_tube, g.num_fins, g.w_fin, g.h_fin);
    case 'CustomDXF':
      return new CustomDXF(g.length, g.outer_radius, g.dx, g.perim_table, g.area_table);
  }
}

/**
 * Web at which the grain burns out, found numerically.
 *
 * There is no closed form covering all seven geometries -- BATES burns out at
 * `outer - inner`, Star at `outer - valley`, Rod & Tube at whichever of its two
 * surfaces goes first, Custom DXF wherever its table runs out. Rather than
 * maintain seven special cases that could quietly disagree with the solver,
 * this brackets the first zero of the burning area and bisects it, which is
 * correct for any geometry including ones added later.
 */
export function burnoutWeb(grain: GrainGeometry): number {
  /*
   * The scan has to reach past the casing radius.
   *
   * A MoonBurner burns out at `outer + offset - core`, because its bore is
   * offset from the casing axis and the far wall is further away than the
   * radius. Bounding the scan at `outer_radius` silently returned that bound
   * as the web for every offset bore -- understating the web, and with it the
   * burn time, for a whole geometry. Twice the radius covers any offset the
   * app can produce.
   */
  const hi = Math.max(2 * grain.outer_radius, 1e-6);
  if (!(grain.get_burning_area(0) > 0)) return 1e-9;

  const STEPS = 256;
  let lo = 0;
  let bracket = hi;
  for (let i = 1; i <= STEPS; i++) {
    const y = (hi * i) / STEPS;
    if (!(grain.get_burning_area(y) > 0)) {
      bracket = y;
      lo = (hi * (i - 1)) / STEPS;
      break;
    }
    lo = y;
  }
  let a = lo;
  let b = bracket;
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2;
    if (grain.get_burning_area(mid) > 0) a = mid;
    else b = mid;
  }
  return Math.max(b, 1e-9);
}

// --- the design a caller supplies -----------------------------------------

export interface RawDesign {
  grain: SurrogateGrain;
  throat_diameter: number;
  expansion_ratio: number;
  a: number;
  n: number;
  density: number;
}

/**
 * Scalars describing the grain. Shared by the feature vector and the envelope
 * check, so the two cannot disagree about what a design "is".
 */
export interface GrainDescriptor {
  ab0: number;
  aport0: number;
  web: number;
  propMass: number;
  length: number;
  outerRadius: number;
  /** Ab(f*web)/Ab(0) at AB_SAMPLE_FRACTIONS. */
  abShape: number[];
  /** Aport(f*web)/Aport(0) at PORT_SAMPLE_FRACTIONS. */
  portShape: number[];
  /** Web fraction at which burning area peaks (0 = peaks at ignition). */
  abPeakFraction: number;
  /** max(Ab)/Ab(0): how progressive the grain gets at its most. */
  abPeakRatio: number;
  /** Dimensionless burn-time integral; see `burnTimeShape`. */
  tbShape: number;
}

/**
 * The dimensionless integral that sets burn time.
 *
 * Quasi-steadily, chamber pressure follows the burning area,
 *
 *     Pc(y) ~ Kn(y)^(1/(1-n))    =>    r_b(y) = a Pc^n ~ Ab(y)^(n/(1-n))
 *
 * so the time to consume the web is
 *
 *     t_b = INTEGRAL dy / r_b(y)  ~  INTEGRAL (Ab(y)/Ab0)^(-n/(1-n)) dy
 *
 * This returns that integral normalised by the web, which makes it a pure
 * shape factor: 1 for a neutral grain, larger for one that spends part of its
 * burn at low area and therefore low pressure.
 *
 * It is worth computing exactly rather than leaving the GP to infer it from
 * curve samples, because it is the ONE combination of the curve and the
 * pressure exponent that burn time actually depends on. Sampling the curve at
 * nine points gets peak pressure right but leaves burn time weakest exactly
 * where the curve has a step -- Rod & Tube when its rod burns through, where
 * the area collapses and the remaining web then burns slowly at low pressure.
 *
 * The integrand diverges as Ab goes to zero at burnout, so the area ratio is
 * floored and the last sliver of web is excluded. Both are cutoffs on a
 * region that contributes little real burn time and much numerical noise --
 * the solver itself stops once the area reaches zero.
 */
export function burnTimeShape(grain: GrainGeometry, web: number, ab0: number, n: number): number {
  if (!(ab0 > 0) || !(web > 0)) return 1;
  const exponent = -n / Math.max(1 - n, 0.05);
  const STEPS = 96;
  const upper = 0.98 * web;
  const h = upper / STEPS;
  let sum = 0;
  for (let i = 0; i <= STEPS; i++) {
    const ratio = Math.max(grain.get_burning_area(i * h) / ab0, 1e-3);
    const w = i === 0 || i === STEPS ? 0.5 : 1;
    sum += w * Math.pow(ratio, exponent);
  }
  return (sum * h) / web;
}
export function describeGrain(
  g: SurrogateGrain,
  density: number,
  n = 0.35
): GrainDescriptor {
  const grain = grainFromConfig(g);
  const ab0 = grain.get_burning_area(0);
  const aport0 = Math.max(grain.get_port_area(0), 1e-12);
  const web = burnoutWeb(grain);
  const casingArea = Math.PI * grain.outer_radius * grain.outer_radius;
  // Propellant is whatever of the casing circle is not port, extruded. Works
  // for every geometry without a per-kind volume formula.
  const propMass = Math.max(casingArea - aport0, 0) * grain.length * density;

  const abShape = AB_SAMPLE_FRACTIONS.map((f) =>
    ab0 > 0 ? grain.get_burning_area(f * web) / ab0 : 0
  );
  const portShape = PORT_SAMPLE_FRACTIONS.map((f) => grain.get_port_area(f * web) / aport0);
  const tbShape = burnTimeShape(grain, web, ab0, n);

  // Locate the turn-over on a finer grid than the feature samples use: the
  // whole point of these two is to pin a kink the samples may have stepped
  // over, so resolving them coarsely would defeat the purpose.
  let abPeak = ab0;
  let abPeakFraction = 0;
  const PEAK_SCAN = 120;
  for (let i = 1; i <= PEAK_SCAN; i++) {
    const f = i / PEAK_SCAN;
    const v = grain.get_burning_area(f * web);
    if (v > abPeak) {
      abPeak = v;
      abPeakFraction = f;
    }
  }

  return {
    ab0,
    aport0,
    web,
    propMass,
    length: grain.length,
    outerRadius: grain.outer_radius,
    abShape,
    portShape,
    abPeakFraction,
    abPeakRatio: ab0 > 0 ? abPeak / ab0 : 1,
    tbShape,
  };
}

/**
 * Expand a design into the model's input vector.
 *
 * `out` may be supplied to avoid allocating; the instant-prediction path calls
 * this on every keystroke and the Monte Carlo path thousands of times a sweep.
 * `descriptor` may be supplied when the grain is unchanged across a sweep,
 * which skips the burn-back scan.
 */
export function expandDesign(
  d: RawDesign,
  out: Float64Array = new Float64Array(N_EXPANDED),
  descriptor?: GrainDescriptor
): Float64Array {
  const g = descriptor ?? describeGrain(d.grain, d.density, d.n);
  const throatArea = Math.max((Math.PI / 4) * d.throat_diameter * d.throat_diameter, 1e-14);

  let i = 0;
  out[i++] = safeLn(d.a);
  out[i++] = d.n;
  out[i++] = safeLn(d.density);
  out[i++] = safeLn(d.throat_diameter);
  out[i++] = d.expansion_ratio;
  // Burn rate at the reference pressure: the conditioned way to describe a
  // propellant, since `a` alone is a rate extrapolated to 1 Pa.
  out[i++] = safeLn(d.a) + d.n * ln(P_REF);

  out[i++] = safeLn(g.length);
  out[i++] = safeLn(g.outerRadius);
  out[i++] = safeLn(g.ab0);
  out[i++] = safeLn(g.aport0);
  out[i++] = safeLn(g.web);
  out[i++] = safeLn(g.propMass);
  out[i++] = safeLn(g.ab0 / throatArea);
  out[i++] = safeLn(g.aport0 / throatArea);

  for (const v of g.abShape) out[i++] = Number.isFinite(v) ? v : 0;
  for (const v of g.portShape) out[i++] = Number.isFinite(v) ? v : 1;
  out[i++] = g.abPeakFraction;
  out[i++] = safeLn(g.abPeakRatio);
  out[i++] = safeLn(g.tbShape);

  return out;
}
