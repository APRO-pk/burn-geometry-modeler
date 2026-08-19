/**
 * The design space the surrogate is trained over, shared by the sampler, the
 * trainer and the browser-side envelope check.
 *
 * Three things matter here and each took a couple of attempts to get right.
 *
 * SAMPLING PARAMETERS ARE NOT MODEL FEATURES. The model's features describe the
 * grain's burn-back CURVES (see src/surrogate/features.ts); the sampler works in
 * the parameters a designer types. Drawing the throat independently of the grain
 * gives mostly 200 MPa motors and motors that never choke, so the sampler draws
 * a Kn feasible for the propellant it already drew and sizes the throat from it.
 *
 * `a` AND `n` CANNOT BE DRAWN INDEPENDENTLY. `a` is the burn rate extrapolated
 * to 1 Pa, so its magnitude is meaningless without `n`, and a box over the pair
 * is mostly propellants that do not exist. The sampler draws burn rate at 7 MPa
 * and derives `a = r_ref / P_ref^n`.
 *
 * EVERY GEOMETRY IS SAMPLED, NOT JUST BATES. The model is geometry-agnostic by
 * construction, but that only helps if the training set actually contains the
 * variety of burn-back curves the geometries produce -- a progressive BATES
 * teaches it nothing about a regressive Rod & Tube. Each kind gets its own
 * parameter ranges and its own feasibility rules below.
 */

import type { GrainKind, SurrogateGrain } from '../src/surrogate/features.ts';
import { GRAIN_SHAPE_PARAMS, grainFromShape } from '../src/surrogate/shape.ts';

export { P_REF } from '../src/surrogate/features.ts';
export type { GrainKind, SurrogateGrain } from '../src/surrogate/features.ts';

/** Model outputs, in the order the surrogate produces them. */
export const TARGETS = ['peak_pc', 'total_impulse', 'isp', 'max_kn', 'burn_time'] as const;
export type Target = (typeof TARGETS)[number];

/** Columns describing the design, written to the CSV alongside the targets. */
export const DESIGN_COLUMNS = [
  'grain_kind',
  'length',
  'outer_radius',
  'throat_diameter',
  'expansion_ratio',
  'a',
  'n',
  'density',
] as const;

/** Ranges shared by every geometry. */
export const COMMON_RANGES = {
  length: [0.1, 1.0],
  outer_radius: [0.02, 0.08],
  expansion_ratio: [1.0, 12.0],
  /**
   * Burn rate at P_REF, m/s. Sampled instead of `a`; see the header. 2-20 mm/s
   * brackets the amateur range (KNDX sits near 13.8).
   */
  burn_rate_at_ref: [0.002, 0.020],
  n: [0.2, 0.5],
  density: [1500, 1950],
  /** Chamber pressure band the derived Kn must land in, Pa. */
  pc_target: [1.0e6, 12.0e6],
} as const;

/** Fixed propellant thermochemistry. Not swept: it is not a design variable
 *  here, and letting it float would blur the effects that are. */
export const FIXED_PROPELLANT = {
  flame_temp: 1720,
  gamma: 1.13,
  molecular_weight: 0.042,
} as const;

/**
 * A sample is rejected unless it is a motor someone might actually build. These
 * bounds are part of the model's contract: the surrogate is only claimed to be
 * valid for runs that would have passed them.
 */
export const ACCEPTANCE = {
  kn: [40, 1200],
  min_port_to_throat: 1.2,
  peak_pc: [0.5e6, 25e6],
  total_impulse: [10, 5e5],
  isp: [40, 260],
  burn_time: [0.05, 20.0],
  min_rows: 20,
} as const;

/** Geometries the sampler sweeps, and how many extra unit draws each needs. */
export const SAMPLED_KINDS: GrainKind[] = [
  'BATES',
  'Star',
  'Tubular',
  'RodAndTube',
  'MoonBurner',
  'Finocyl',
  'CustomDXF',
];

/** Unit-cube coordinates consumed beyond the 6 common ones, per geometry. */
export const SHAPE_DIMS: Record<GrainKind, number> = {
  BATES: 1,
  Star: 3,
  Tubular: 1,
  RodAndTube: 2,
  MoonBurner: 2,
  Finocyl: 3,
  CustomDXF: 3,
};

/** Largest shape-dimension count, so one LHS cube serves every geometry. */
export const MAX_SHAPE_DIMS = Math.max(...Object.values(SHAPE_DIMS));

export function lerp(u: number, [lo, hi]: readonly [number, number]) {
  return lo + u * (hi - lo);
}

/**
 * Build the grain for one geometry from unit-cube coordinates.
 *
 * Delegates to grainFromShape in src/surrogate/shape.ts -- the SAME function
 * the inverse-design search uses. When the sampler and the optimiser had
 * separate notions of a legal grain, the search returned shapes the sampler
 * would have rejected, in a region the model had therefore never seen.
 *
 * Returns null when the draw is geometrically impossible for that kind.
 */
export function buildGrain(
  kind: GrainKind,
  length: number,
  outerRadius: number,
  u: number[]
): SurrogateGrain | null {
  const spec = GRAIN_SHAPE_PARAMS[kind];
  const shape = spec.map((p, i) => {
    const v = lerp(u[i] ?? 0.5, p.bounds);
    return p.integer ? Math.round(v) : v;
  });

  /*
   * Synthetic regression tables for Custom DXF, rather than real files.
   *
   * A DXF grain reaches the solver as a perimeter/area table, and any table is
   * legal -- so the useful thing to teach the model is the SHAPE SPACE those
   * tables span, not any particular traced cross-section. These are generated
   * with a controllable progressive/regressive trend and a curvature term,
   * which covers the behaviour a real profile produces while staying
   * reproducible from a seed.
   */
  let dxf;
  if (kind === 'CustomDXF') {
    const bore = outerRadius * lerp(u[0] ?? 0.5, [0.2, 0.6]);
    const web = outerRadius - bore;
    const dx = web / 40;
    const trend = lerp(u[1] ?? 0.5, [-0.6, 1.2]);
    const curve = lerp(u[2] ?? 0.5, [-0.5, 0.5]);
    const perim0 = 2 * Math.PI * bore;
    const perim_table: number[] = [];
    const area_table: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const p = perim0 * Math.max(0.05, 1 + trend * t + curve * t * t);
      perim_table.push(p);
      // Area is the integral of perimeter, so the two stay consistent: a table
      // where dA/dy disagrees with the perimeter is not a real grain.
      const prevArea = i === 0 ? Math.PI * bore * bore : area_table[i - 1];
      const prevPerim = i === 0 ? perim0 : perim_table[i - 1];
      area_table.push(i === 0 ? prevArea : prevArea + ((prevPerim + p) / 2) * dx);
    }
    dxf = { dx, perim_table, area_table };
  }

  return grainFromShape(kind, length, outerRadius, shape, dxf);
}

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
 * Each axis is cut into `n` equal strata and visited exactly once, so
 * one-dimensional coverage is guaranteed rather than merely likely. With plain
 * uniform sampling in this many dimensions, a few thousand points leave visible
 * gaps along individual axes -- which is exactly where a GP's extrapolation
 * gets embarrassing.
 */
export function latinHypercube(n: number, dims: number, rand: () => number): number[][] {
  const out: number[][] = Array.from({ length: n }, () => new Array(dims).fill(0));
  for (let d = 0; d < dims; d++) {
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < n; i++) out[i][d] = (perm[i] + rand()) / n;
  }
  return out;
}
