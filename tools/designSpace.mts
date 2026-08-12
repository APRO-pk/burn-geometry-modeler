/**
 * The design space the surrogate is trained over, shared by the sampler, the
 * trainer and the browser-side envelope check.
 *
 * Two things matter here and are easy to get wrong.
 *
 * SAMPLING PARAMETERS ARE NOT MODEL FEATURES. Sampling throat diameter
 * independently of grain size produces mostly garbage: pair a big grain with a
 * small throat and the motor sits at 200 MPa, pair a small grain with a big
 * throat and it never chokes. The MODEL still takes throat diameter as a
 * feature, because that is what a user types.
 *
 * The sampler instead draws a target CHAMBER PRESSURE and inverts the
 * equilibrium relation for the throat:
 *
 *     Pc_eq = ((rho * a / C_D) * Kn)^(1/(1-n))
 *   =>  Kn  = Pc_eq^(1-n) * C_D / (rho * a),      At = Ab0 / Kn
 *
 * Sampling Kn directly is not enough, because 1/(1-n) reaches 2.5 at n = 0.6 --
 * so an innocuous corner of the (a, n, Kn) cube lands at 200 MPa and gets
 * thrown away. Pinning the pressure instead took the accept rate from 36% to
 * essentially all of it, which matters less for cost than for COVERAGE: the
 * rejected 64% were not scattered, they were the entire high-n region, and a
 * surrogate trained on what survived would have had a hole exactly where the
 * pressure exponent gets interesting.
 *
 * THE ENVELOPE IS DEFINED IN FEATURE SPACE. Because of the above, the region
 * actually covered is not a box in feature space -- it is the image of a box
 * under a nonlinear map. The envelope check therefore uses the observed feature
 * ranges from the accepted dataset, not these bounds, and is deliberately a
 * necessary-not-sufficient test: inside the box is not proof of coverage, but
 * outside it is proof of extrapolation.
 */

// The raw feature list lives with the browser-side expansion so there is one
// definition, not two that can drift.
import type { RawFeature as Feature } from '../src/surrogate/features.ts';
export { RAW_FEATURES as FEATURES, P_REF } from '../src/surrogate/features.ts';
export type { RawFeature as Feature } from '../src/surrogate/features.ts';

/** Model outputs, in the order the surrogate produces them. */
export const TARGETS = ['peak_pc', 'total_impulse', 'isp', 'max_kn', 'burn_time'] as const;
export type Target = (typeof TARGETS)[number];

/** Sampling ranges. See the note above on why Kn is sampled, not throat. */
export const SAMPLING_RANGES = {
  /** Grain length, m. */
  length: [0.1, 1.0],
  /** Grain outer radius, m. */
  outer_radius: [0.02, 0.08],
  /** Web fraction (Ro - Ri)/Ro. Sampled rather than Ri so the bore is always
   *  inside the grain and the web is always a sane fraction of the radius. */
  web_fraction: [0.3, 0.8],
  /** Target equilibrium chamber pressure, Pa. Sets the throat; see above. */
  pc_target: [1.0e6, 12.0e6],
  expansion_ratio: [1.0, 12.0],
  /**
   * Burn rate at the reference pressure, m/s. Sampled INSTEAD of the St. Robert
   * coefficient `a`, which is then derived as `a = r_ref / P_ref^n`.
   *
   * `a` and `n` cannot be drawn independently: `a` is the burn rate
   * extrapolated to 1 Pa, so its magnitude is meaningless without `n`, and a
   * box over the pair contains mostly propellants that do not exist. Sweeping
   * (r_ref, n) is both how propellants are actually characterised and far
   * better conditioned -- the two axes are close to independent, so the LHS
   * strata mean what they claim to. `a` remains a model FEATURE; it is just not
   * a sampling axis. 2-20 mm/s at 7 MPa brackets the amateur range (KNDX sits
   * near 13.8).
   */
  burn_rate_at_ref: [0.002, 0.020],
  n: [0.2, 0.5],
  /** Propellant density, kg/m^3. */
  density: [1500, 1950],
} as const;

/** Fixed propellant thermochemistry. Not swept: it is not in the brief's list,
 *  and letting it float would blur the effects that are. */
export const FIXED_PROPELLANT = {
  flame_temp: 1720,
  gamma: 1.13,
  molecular_weight: 0.042,
} as const;

/**
 * A sample is rejected unless it is a motor someone might actually build. These
 * bounds are part of the model's contract: the surrogate is only claimed to be
 * valid for runs that pass them, and the browser warns outside the resulting
 * feature envelope.
 */
export const ACCEPTANCE = {
  /**
   * Derived Kn must be a number a motor designer would recognise. Pinning the
   * chamber pressure leaves Kn free to wander: a dense, fast propellant at low
   * target pressure implies Kn ~ 2, which back-solves to a throat WIDER than
   * the grain it is attached to.
   */
  kn: [40, 1200],
  /**
   * Port-to-throat area ratio. Below ~1 the bore cannot feed the throat at all;
   * real designs stay above 2 to limit erosive burning. 1.2 is a permissive
   * floor that still excludes the geometrically impossible.
   */
  min_port_to_throat: 1.2,
  /** Reject sub-atmospheric or absurd chamber pressures. */
  peak_pc: [0.5e6, 25e6],
  /** A motor that produces no meaningful impulse teaches the model nothing. */
  total_impulse: [10, 5e5],
  /** Outside this Isp band the run is almost certainly numerically sick. */
  isp: [40, 260],
  /** Sub-millisecond or minute-long burns are not the target regime. */
  burn_time: [0.05, 20.0],
  min_rows: 20,
} as const;

export type SampleRow = Record<Feature, number> & Record<Target, number> & {
  pc_target: number;
  kn_derived: number;
  web_fraction: number;
};

/** Discharge coefficient for the fixed propellant: C_D = Gamma/sqrt(R_s * T). */
export function dischargeCoefficient(): number {
  const g = FIXED_PROPELLANT.gamma;
  const rSpec = 8.314 / FIXED_PROPELLANT.molecular_weight;
  const bigGamma = Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
  return bigGamma / Math.sqrt(rSpec * FIXED_PROPELLANT.flame_temp);
}

/** Deterministic 32-bit PRNG, so a dataset can be regenerated exactly. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Latin Hypercube sample on the unit cube.
 *
 * Each of the `dims` axes is cut into `n` equal strata and visited exactly once,
 * so one-dimensional coverage is guaranteed rather than merely likely. With
 * plain uniform sampling in 8 dimensions, a few thousand points leave visible
 * gaps along individual axes, which is exactly where a GP's extrapolation gets
 * embarrassing.
 */
export function latinHypercube(n: number, dims: number, rand: () => number): number[][] {
  const out: number[][] = Array.from({ length: n }, () => new Array(dims).fill(0));
  for (let d = 0; d < dims; d++) {
    // One stratified draw per row, then shuffle which row gets which stratum.
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < n; i++) {
      out[i][d] = (perm[i] + rand()) / n;
    }
  }
  return out;
}

export function lerp(u: number, [lo, hi]: readonly [number, number]) {
  return lo + u * (hi - lo);
}
