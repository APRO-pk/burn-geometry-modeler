/**
 * Inverse design and dispersion sweeps over the surrogate.
 *
 * Both exist because the surrogate is orders of magnitude cheaper than a solve,
 * so searching or sampling over it is interactive where searching over the
 * physics is not. Neither is allowed to be the final word: the caller verifies
 * the winner (inverse design) or a subsample (Monte Carlo) against the real core.
 */

import { predict, predictMeanOnly } from './predict';
import { describeGrain } from './features';
import type { GrainDescriptor, GrainKind, RawDesign, SurrogateGrain } from './features';
import { GRAIN_SHAPE_PARAMS, dxfTablesOf, grainFromShape, shapeFromGrain } from './shape';
import type { SurrogateTarget } from './predict';

// --- shared guards ---------------------------------------------------------

/**
 * Minimum port-to-throat area ratio, matching the sampler's own rule. Below ~1
 * the bore physically cannot feed the throat.
 */
export const MIN_PORT_TO_THROAT = 1.2;

/**
 * Output ranges the model was trained over. A prediction outside these is
 * extrapolation regardless of whether the inputs passed the envelope check,
 * because the sampler discarded such motors and the GP has never seen one.
 */
const TRAINED_OUTPUT_RANGE: Partial<Record<SurrogateTarget, [number, number]>> = {
  peak_pc: [1.0e6, 25e6],
  isp: [40, 260],
  burn_time: [0.05, 20],
};

function outOfRangePenalty(p: Record<SurrogateTarget, number>): number {
  let penalty = 0;
  for (const [key, range] of Object.entries(TRAINED_OUTPUT_RANGE)) {
    const v = p[key as SurrogateTarget];
    const [lo, hi] = range as [number, number];
    if (!Number.isFinite(v)) penalty += 10;
    else if (v < lo) penalty += (lo - v) / lo;
    else if (v > hi) penalty += (v - hi) / hi;
  }
  return penalty;
}

// --- inverse design --------------------------------------------------------

export interface InverseTargets {
  minImpulse?: number;
  maxImpulse?: number;
  /** Peak chamber pressure ceiling, Pa. The usual binding constraint. */
  maxPeakPc?: number;
  maxKn?: number;
  minBurnTime?: number;
  maxBurnTime?: number;
}

export interface SearchBounds {
  length: [number, number];
  outer_radius: [number, number];
  throat_diameter: [number, number];
  expansion_ratio: [number, number];
}

export interface Candidate {
  design: RawDesign;
  predicted: Record<SurrogateTarget, number>;
  /** Lower is better; 0 means every constraint is satisfied. */
  penalty: number;
  /** Relative width of the peak-Pc band, as a confidence hint. */
  band: number;
  inEnvelope: boolean;
}

/** Aim this far below the impulse ceiling, leaving room for surrogate error. */
const IMPULSE_AIM = 0.97;
/** Keep the answer this far inside the trained pressure range. */
const VALIDITY_MARGIN = 0.15;
/** How strongly to prefer candidates the model is confident about. */
const UNCERTAINTY_WEIGHT = 4.0;

function penaltyOf(p: Record<SurrogateTarget, number>, t: InverseTargets): number {
  let penalty = 0;
  const over = (value: number, limit: number | undefined) =>
    limit === undefined || limit <= 0 ? 0 : value > limit ? (value - limit) / limit : 0;
  const under = (value: number, limit: number | undefined) =>
    limit === undefined || limit <= 0 ? 0 : value < limit ? (limit - value) / limit : 0;

  penalty += over(p.peak_pc, t.maxPeakPc) * 3; // safety-critical: weighted up
  penalty += over(p.max_kn, t.maxKn);
  penalty += over(p.total_impulse, t.maxImpulse);
  penalty += under(p.total_impulse, t.minImpulse);
  penalty += over(p.burn_time, t.maxBurnTime);
  penalty += under(p.burn_time, t.minBurnTime);
  return penalty;
}

/**
 * Ranking among designs that satisfy every constraint.
 *
 * Aims just BELOW the impulse ceiling rather than exactly at it: pinned to the
 * cap, an earlier version verified at 2009 N*s against a 2000 N*s limit -- the
 * surrogate was within 0.45%, but 0.45% on the wrong side of a hard constraint
 * is still a violation.
 *
 * And it pushes away from the EDGES of the trained pressure range, not just the
 * ceiling. Rewarding low pressure alone drove every candidate to exactly the
 * bottom of the training data, which is the one place the model is least
 * supported. Optimising against an approximation naturally walks to its
 * boundary; the fix is to make the boundary unattractive.
 */
function tieBreak(p: Record<SurrogateTarget, number>, t: InverseTargets): number {
  let cost = 0;
  if (t.maxImpulse && t.maxImpulse > 0) {
    cost += Math.abs(p.total_impulse - IMPULSE_AIM * t.maxImpulse) / t.maxImpulse;
  } else {
    cost -= p.total_impulse / 1e6;
  }
  const [lo, hi] = TRAINED_OUTPUT_RANGE.peak_pc!;
  const softLo = lo * (1 + VALIDITY_MARGIN);
  const ceiling = t.maxPeakPc && t.maxPeakPc > 0 ? Math.min(t.maxPeakPc, hi) : hi;
  const softHi = ceiling * (1 - VALIDITY_MARGIN);
  if (p.peak_pc < softLo) cost += (softLo - p.peak_pc) / softLo;
  if (p.peak_pc > softHi) cost += (p.peak_pc - softHi) / softHi;
  return cost;
}

export interface SearchOptions {
  iterations?: number;
  restarts?: number;
  seed?: number;
  /** Fixed propellant properties; the search moves geometry only. */
  fixed: Pick<RawDesign, 'a' | 'n' | 'density'>;
  /** Grain geometry to search within. Its shape parameters are the free ones. */
  kind: GrainKind;
  /** Starting grain, used for the DXF tables and to seed one restart. */
  seedGrain?: SurrogateGrain;
}

/**
 * Search the surrogate for a design meeting the targets.
 *
 * Pattern search with shrinking steps, multi-start. Not gradient descent: the
 * GP mean is differentiable, but the objective has hard one-sided constraints
 * and the space is small, so a direct method is simpler, derivative-free and
 * cannot be trapped by a kink in the penalty. Thousands of evaluations still
 * cost milliseconds because each one is a surrogate call.
 *
 * Every candidate is built through `grainFromShape`, the same function the
 * SAMPLER uses. That is deliberate: when the two were written separately, the
 * search returned geometry the sampler would have rejected, in a region the
 * model had therefore never seen.
 *
 * Returns candidates best-first. The caller MUST verify the winner against the
 * physics core before showing it as an answer.
 */
export function inverseDesign(
  bounds: SearchBounds,
  targets: InverseTargets,
  opts: SearchOptions
): Candidate[] {
  const iterations = opts.iterations ?? 240;
  const restarts = opts.restarts ?? 8;
  let s = (opts.seed ?? 12345) >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };

  const shapeSpec = GRAIN_SHAPE_PARAMS[opts.kind];
  const dxf = opts.seedGrain ? dxfTablesOf(opts.seedGrain) : undefined;
  if (opts.kind === 'CustomDXF' && !dxf) return [];

  // Free variables: the four common ones, then the geometry's shape fractions.
  const COMMON: Array<keyof SearchBounds> = [
    'length',
    'outer_radius',
    'throat_diameter',
    'expansion_ratio',
  ];
  const nVars = COMMON.length + shapeSpec.length;
  const varBounds: Array<[number, number]> = [
    ...COMMON.map((k) => bounds[k]),
    ...shapeSpec.map((p) => p.bounds),
  ];

  /** Turn a free-variable vector into a design, or null if it is not a grain. */
  const toDesign = (v: number[]): RawDesign | null => {
    const clamped = v.map((x, i) =>
      Math.min(varBounds[i][1], Math.max(varBounds[i][0], x))
    );
    const shape = shapeSpec.map((p, i) => {
      const raw = clamped[COMMON.length + i];
      return p.integer ? Math.round(raw) : raw;
    });
    const grain = grainFromShape(opts.kind, clamped[0], clamped[1], shape, dxf);
    if (!grain) return null;

    const design: RawDesign = {
      grain,
      throat_diameter: clamped[2],
      expansion_ratio: clamped[3],
      ...opts.fixed,
    };

    // Same feasibility rules the sampler applies, so the search cannot wander
    // into geometry the model was never trained on.
    const desc = describeGrain(grain, design.density, design.n);
    if (!(desc.ab0 > 0) || !(desc.web > 1e-6)) return null;
    const throatArea = (Math.PI / 4) * design.throat_diameter ** 2;
    if (desc.aport0 / throatArea < MIN_PORT_TO_THROAT) return null;
    return design;
  };

  const score = (v: number[]) => {
    const design = toDesign(v);
    if (!design) return { design: null, cost: 1e9 };
    const p = predictMeanOnly(design);
    const pen = penaltyOf(p, targets) + outOfRangePenalty(p);
    return { design, cost: pen > 0 ? 1e3 + pen : tieBreak(p, targets) };
  };

  const results: Candidate[] = [];

  for (let r = 0; r < restarts; r++) {
    let current: number[];
    if (r === 0 && opts.seedGrain && opts.kind === opts.seedGrain.kind) {
      // One restart begins at the design the user is already looking at.
      const sh = shapeFromGrain(opts.seedGrain);
      current = [
        opts.seedGrain.length,
        opts.seedGrain.outer_radius,
        (bounds.throat_diameter[0] + bounds.throat_diameter[1]) / 2,
        (bounds.expansion_ratio[0] + bounds.expansion_ratio[1]) / 2,
        ...sh,
      ];
    } else {
      current = varBounds.map(([lo, hi]) => lo + rnd() * (hi - lo));
    }

    let best = score(current);
    if (!best.design) {
      // Reject the start and try a fresh one rather than hill-climbing from an
      // invalid point, which has no gradient information at all.
      let tries = 0;
      while (!best.design && tries++ < 40) {
        current = varBounds.map(([lo, hi]) => lo + rnd() * (hi - lo));
        best = score(current);
      }
      if (!best.design) continue;
    }

    let step = 0.35;
    for (let i = 0; i < iterations && step > 1e-4; i++) {
      let improved = false;
      for (let k = 0; k < nVars; k++) {
        const [lo, hi] = varBounds[k];
        const delta = step * (hi - lo);
        for (const dir of [1, -1]) {
          const trial = current.slice();
          trial[k] = trial[k] + dir * delta;
          const cand = score(trial);
          if (cand.design && cand.cost < best.cost - 1e-12) {
            current = trial;
            best = cand;
            improved = true;
            break;
          }
        }
      }
      if (!improved) step *= 0.5;
    }

    if (!best.design) continue;
    const full = predict(best.design);
    results.push({
      design: best.design,
      predicted: full.mean,
      penalty: penaltyOf(full.mean, targets) + outOfRangePenalty(full.mean),
      band: full.relativeBand.peak_pc,
      inEnvelope: full.envelope.inside,
    });
  }

  /*
   * Rank feasible candidates by how much the model TRUSTS them, not just by
   * objective value.
   *
   * A search over an approximation gravitates to wherever the approximation is
   * most optimistic, which tends to be where it has least data. Ranking purely
   * on the objective once put a 981 mm grain with a 4 mm web first; it verified
   * 17% off on peak pressure against a 1.6% held-out MAPE. The GP already knew
   * -- its band was wide there -- so folding the band into the ordering surfaces
   * the candidate most likely to survive verification.
   */
  results.sort((a, b) => {
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
    return (
      tieBreak(a.predicted, targets) +
      UNCERTAINTY_WEIGHT * a.band -
      (tieBreak(b.predicted, targets) + UNCERTAINTY_WEIGHT * b.band)
    );
  });

  // Drop near-duplicates so the user sees genuinely different options.
  const distinct: Candidate[] = [];
  for (const c of results) {
    const dup = distinct.some((d) => {
      const rel = (x: number, y: number, [lo, hi]: [number, number]) =>
        Math.abs(x - y) / Math.max(hi - lo, 1e-12);
      let diff =
        rel(d.design.grain.length, c.design.grain.length, bounds.length) +
        rel(d.design.grain.outer_radius, c.design.grain.outer_radius, bounds.outer_radius) +
        rel(d.design.throat_diameter, c.design.throat_diameter, bounds.throat_diameter) +
        rel(d.design.expansion_ratio, c.design.expansion_ratio, bounds.expansion_ratio);
      const ds = shapeFromGrain(d.design.grain);
      const cs = shapeFromGrain(c.design.grain);
      for (let i = 0; i < ds.length; i++) {
        diff += rel(ds[i], cs[i], shapeSpec[i].bounds);
      }
      return diff < 0.05;
    });
    if (!dup) distinct.push(c);
  }
  return distinct;
}

// --- Monte Carlo -----------------------------------------------------------

export interface DispersionSpec {
  /** Relative 1-sigma on each swept parameter, e.g. 0.02 for 2%. */
  sigma: number;
  samples: number;
  seed?: number;
}

export interface DispersionResult {
  target: SurrogateTarget;
  values: Float64Array;
  mean: number;
  sd: number;
  p05: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

/**
 * Dispersion sweep over the surrogate.
 *
 * Perturbs burn-rate coefficient, throat diameter and density -- the three the
 * app's own Monte Carlo perturbs -- with independent Gaussian noise, and runs
 * every sample through the surrogate mean.
 *
 * The per-sample uncertainty band is deliberately NOT propagated. What the
 * histogram shows is the spread caused by manufacturing dispersion, which is the
 * question being asked; the model's own error is a separate quantity, reported
 * alongside rather than blended in, because mixing the two would make it
 * impossible to tell a wide distribution from an unsure model.
 */
export function dispersionSweep(
  base: RawDesign,
  spec: DispersionSpec,
  targets: readonly SurrogateTarget[]
): Record<SurrogateTarget, DispersionResult> {
  let s = (spec.seed ?? 4242) >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let q = 0;
    do {
      u = 2 * rnd() - 1;
      v = 2 * rnd() - 1;
      q = u * u + v * v;
    } while (q === 0 || q >= 1);
    const f = Math.sqrt((-2 * Math.log(q)) / q);
    spare = v * f;
    return u * f;
  };

  /*
   * The grain does not change across the sweep, so its burn-back description is
   * computed once and reused.
   *
   * Describing a grain means scanning for the burnout web, the area peak and the
   * burn-time integral -- a few hundred geometry evaluations. Redoing that for
   * every one of ten thousand samples would dominate the sweep and cost the
   * "real-time" in real-time Monte Carlo. Only propellant mass depends on the
   * perturbed density, and it does so linearly, so it is rescaled per sample.
   */
  const baseDesc = describeGrain(base.grain, base.density, base.n);

  const cols: Record<string, Float64Array> = {};
  for (const t of targets) cols[t] = new Float64Array(spec.samples);

  const scratch: Partial<Record<SurrogateTarget, number>> = {};
  const design: RawDesign = { ...base };
  const desc: GrainDescriptor = { ...baseDesc };

  for (let i = 0; i < spec.samples; i++) {
    design.a = base.a * (1 + spec.sigma * gauss());
    design.throat_diameter = base.throat_diameter * (1 + spec.sigma * gauss());
    design.density = base.density * (1 + spec.sigma * gauss());
    // A negative coefficient is not a motor; clamp rather than emit nonsense.
    if (design.a <= 0) design.a = base.a * 1e-3;
    if (design.throat_diameter <= 0) design.throat_diameter = base.throat_diameter * 1e-3;
    if (design.density <= 0) design.density = base.density * 1e-3;

    desc.propMass = (baseDesc.propMass * design.density) / base.density;
    const p = predictMeanOnly(design, scratch, desc);
    for (const t of targets) cols[t][i] = p[t];
  }

  const out = {} as Record<SurrogateTarget, DispersionResult>;
  for (const t of targets) {
    const values = cols[t];
    const sorted = Float64Array.from(values).sort();
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    let varSum = 0;
    for (let i = 0; i < values.length; i++) varSum += (values[i] - mean) ** 2;
    const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    out[t] = {
      target: t,
      values,
      mean,
      sd: Math.sqrt(varSum / values.length),
      p05: q(0.05),
      p50: q(0.5),
      p95: q(0.95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }
  return out;
}

/** Bin a dispersion result for display. */
export function histogram(values: Float64Array, bins = 40) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  if (!(hi > lo)) hi = lo + 1;
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < values.length; i++) {
    const b = Math.min(bins - 1, Math.floor(((values[i] - lo) / (hi - lo)) * bins));
    counts[b]++;
  }
  return counts.map((count, i) => ({ x: lo + ((i + 0.5) * (hi - lo)) / bins, count }));
}
