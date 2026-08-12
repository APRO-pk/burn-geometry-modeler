/**
 * Inverse design and dispersion sweeps over the surrogate.
 *
 * Both exist because the surrogate is ~10,000x cheaper than a solve, so
 * searching or sampling over it is interactive where searching over the physics
 * is not. Neither is allowed to be the final word: the caller verifies the
 * winner (inverse design) or a subsample (Monte Carlo) against the real core.
 */

import { predict, predictMeanOnly } from './predict';
import type { RawDesign } from './features';
import type { SurrogateTarget } from './predict';

// --- inverse design --------------------------------------------------------

export interface InverseTargets {
  /** Total impulse must be at least this, N*s. */
  minImpulse?: number;
  /** Total impulse must not exceed this, N*s. */
  maxImpulse?: number;
  /** Peak chamber pressure ceiling, Pa. The usual binding constraint. */
  maxPeakPc?: number;
  /** Peak Kn ceiling. */
  maxKn?: number;
  /** Burn time window, s. */
  minBurnTime?: number;
  maxBurnTime?: number;
}

/** Which parameters the search may move, and between what bounds. */
export interface SearchBounds {
  length: [number, number];
  outer_radius: [number, number];
  inner_radius: [number, number];
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

/**
 * Minimum port-to-throat area ratio, matching the sampler's ACCEPTANCE rule.
 * Below ~1 the bore physically cannot feed the throat.
 */
const MIN_PORT_TO_THROAT = 1.2;

/**
 * Output ranges the model was trained over. A prediction outside these is
 * extrapolation regardless of whether the INPUTS passed the envelope check,
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
    if (!Number.isFinite(v)) {
      penalty += 10;
    } else if (v < lo) {
      penalty += (lo - v) / lo;
    } else if (v > hi) {
      penalty += (v - hi) / hi;
    }
  }
  return penalty;
}

/**
 * Penalty for missing the targets.
 *
 * Constraints are scored RELATIVE to their own target, so a 1 MPa pressure
 * overshoot and a 100 N*s impulse shortfall are comparable quantities rather
 * than whichever happens to have larger units. Ceilings are one-sided: being
 * comfortably under a pressure limit is not better than being just under it, so
 * only violations are charged.
 */
function penaltyOf(p: Record<SurrogateTarget, number>, t: InverseTargets): number {
  let penalty = 0;
  const over = (value: number, limit: number | undefined) => {
    if (limit === undefined || limit <= 0) return 0;
    return value > limit ? (value - limit) / limit : 0;
  };
  const under = (value: number, limit: number | undefined) => {
    if (limit === undefined || limit <= 0) return 0;
    return value < limit ? (limit - value) / limit : 0;
  };

  penalty += over(p.peak_pc, t.maxPeakPc) * 3; // safety-critical: weighted up
  penalty += over(p.max_kn, t.maxKn);
  penalty += over(p.total_impulse, t.maxImpulse);
  penalty += under(p.total_impulse, t.minImpulse);
  penalty += over(p.burn_time, t.maxBurnTime);
  penalty += under(p.burn_time, t.minBurnTime);
  return penalty;
}

/** Aim this far below the impulse ceiling, leaving room for surrogate error. */
const IMPULSE_AIM = 0.97;
/** Keep the answer this far inside the trained pressure range. */
const VALIDITY_MARGIN = 0.15;
/** How strongly to prefer candidates the model is confident about. */
const UNCERTAINTY_WEIGHT = 4.0;

/**
 * Ranking among designs that satisfy every constraint.
 *
 * Two refinements over "most impulse, least pressure", both learned from what
 * the search actually returned:
 *
 * It aims just BELOW the impulse ceiling rather than exactly at it. Pinned to
 * the cap, the winner verified at 2009 N*s against a 2000 N*s limit -- the
 * surrogate was within 0.45%, but 0.45% on the wrong side of a hard constraint
 * is still a violation. Aiming 3% under costs nothing and absorbs the model's
 * own error.
 *
 * It also pushes away from the EDGES of the trained pressure range, not just
 * the ceiling. Rewarding low pressure alone drove every candidate to exactly
 * 1.00 MPa, the bottom of the training data, which is the one place the model
 * is least supported. Optimising against an approximation naturally walks to
 * its boundary; the fix is to make the boundary unattractive.
 */
function tieBreak(p: Record<SurrogateTarget, number>, t: InverseTargets): number {
  let cost = 0;

  if (t.maxImpulse && t.maxImpulse > 0) {
    const aim = IMPULSE_AIM * t.maxImpulse;
    cost += Math.abs(p.total_impulse - aim) / t.maxImpulse;
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
}

/**
 * Search the surrogate for a design meeting the targets.
 *
 * Pattern search with shrinking steps, multi-start. Not gradient descent: the
 * GP mean is differentiable, but the objective has hard one-sided constraints
 * and the search space is only five-dimensional, so a direct method is simpler,
 * derivative-free, and cannot be trapped by a kink in the penalty. Thousands of
 * evaluations still cost milliseconds because each one is a surrogate call.
 *
 * Returns candidates best-first. The caller MUST verify the winner against the
 * physics core before showing it as an answer.
 */
export function inverseDesign(
  bounds: SearchBounds,
  targets: InverseTargets,
  opts: SearchOptions
): Candidate[] {
  const iterations = opts.iterations ?? 260;
  const restarts = opts.restarts ?? 6;
  let s = (opts.seed ?? 12345) >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };

  const keys = ['length', 'outer_radius', 'inner_radius', 'throat_diameter', 'expansion_ratio'] as const;

  /*
   * Feasibility is enforced by CONSTRUCTION, not by penalty.
   *
   * An optimiser handed an approximate model will find its extrapolation
   * errors: an early version of this search happily returned a 57 mm throat
   * inside a 46 mm bore, because no training point looked like that and the GP
   * was free to invent whatever the objective wanted there. Those designs are
   * not merely inaccurate, they are geometrically impossible, and the sampler
   * rejected them for exactly that reason -- so the search must respect the
   * same rules the training data does.
   */
  const clampDesign = (d: RawDesign): RawDesign => {
    const out = { ...d };
    for (const k of keys) {
      const [lo, hi] = bounds[k];
      out[k] = Math.min(hi, Math.max(lo, out[k]));
    }
    // The bore must stay inside the grain, with a web left to burn.
    out.inner_radius = Math.min(out.inner_radius, out.outer_radius * 0.9);
    out.inner_radius = Math.max(out.inner_radius, out.outer_radius * 0.05);
    // The port has to be able to feed the throat: A_port/A_t >= MIN_PORT_TO_THROAT,
    // the same floor the sampler used.
    const maxThroat = (2 * out.inner_radius) / Math.sqrt(MIN_PORT_TO_THROAT);
    out.throat_diameter = Math.min(out.throat_diameter, maxThroat);
    return out;
  };

  const score = (d: RawDesign) => {
    const p = predictMeanOnly(d);
    // Outputs outside the range the model was TRAINED on are extrapolation
    // whatever the box test says, so they are charged as constraint violations.
    // Without this the search converges happily on 0.3 MPa motors that never
    // choke and produce no thrust at all -- which technically satisfy an
    // "impulse <= X" target.
    const pen = penaltyOf(p, targets) + outOfRangePenalty(p);
    return { p, cost: pen > 0 ? 1e3 + pen : tieBreak(p, targets) };
  };

  const results: Candidate[] = [];

  for (let r = 0; r < restarts; r++) {
    let current = clampDesign({
      length: bounds.length[0] + rnd() * (bounds.length[1] - bounds.length[0]),
      outer_radius: bounds.outer_radius[0] + rnd() * (bounds.outer_radius[1] - bounds.outer_radius[0]),
      inner_radius: bounds.inner_radius[0] + rnd() * (bounds.inner_radius[1] - bounds.inner_radius[0]),
      throat_diameter:
        bounds.throat_diameter[0] + rnd() * (bounds.throat_diameter[1] - bounds.throat_diameter[0]),
      expansion_ratio:
        bounds.expansion_ratio[0] + rnd() * (bounds.expansion_ratio[1] - bounds.expansion_ratio[0]),
      ...opts.fixed,
    });
    let best = score(current);
    // Step as a fraction of each parameter's own range, so all five move at
    // comparable rates despite spanning very different magnitudes.
    let step = 0.35;

    for (let i = 0; i < iterations && step > 1e-4; i++) {
      let improved = false;
      for (const k of keys) {
        const [lo, hi] = bounds[k];
        const delta = step * (hi - lo);
        for (const dir of [1, -1]) {
          const trial = clampDesign({ ...current, [k]: current[k] + dir * delta });
          const cand = score(trial);
          if (cand.cost < best.cost - 1e-12) {
            current = trial;
            best = cand;
            improved = true;
            break;
          }
        }
      }
      if (!improved) step *= 0.5;
    }

    const full = predict(current);
    results.push({
      design: current,
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
   * A search over an approximation gravitates towards wherever the
   * approximation is most optimistic, which tends to be where it has least
   * data. Ranking purely on the objective put a 981 mm grain with a 4 mm web
   * first; it verified 17% off on peak pressure, against a 1.6% held-out MAPE.
   * The GP already knew -- its band was wide there -- so folding the band into
   * the ordering surfaces the candidate most likely to survive verification.
   *
   * The band is only available from the full O(N^2) prediction, which is why it
   * is applied here to a handful of finalists rather than inside the search
   * loop over thousands of evaluations.
   */
  results.sort((a, b) => {
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
    const ca = tieBreak(a.predicted, targets) + UNCERTAINTY_WEIGHT * a.band;
    const cb = tieBreak(b.predicted, targets) + UNCERTAINTY_WEIGHT * b.band;
    return ca - cb;
  });

  // Drop near-duplicates so the user sees genuinely different options.
  const distinct: Candidate[] = [];
  for (const c of results) {
    const dup = distinct.some((d) => {
      let diff = 0;
      for (const k of keys) {
        const [lo, hi] = bounds[k];
        diff += Math.abs(d.design[k] - c.design[k]) / (hi - lo);
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
  /** 5th, 50th, 95th percentiles. */
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
 * The per-sample uncertainty band is deliberately NOT propagated here. What the
 * histogram shows is the spread caused by manufacturing dispersion, which is
 * the question being asked; the model's own error is a separate quantity,
 * reported alongside rather than blended in, because mixing the two would make
 * it impossible to tell a wide distribution from an unsure model.
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
  // Box-Muller, cached second value.
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

  const cols: Record<string, Float64Array> = {};
  for (const t of targets) cols[t] = new Float64Array(spec.samples);

  const scratch: Partial<Record<SurrogateTarget, number>> = {};
  const design: RawDesign = { ...base };

  for (let i = 0; i < spec.samples; i++) {
    design.a = base.a * (1 + spec.sigma * gauss());
    design.throat_diameter = base.throat_diameter * (1 + spec.sigma * gauss());
    design.density = base.density * (1 + spec.sigma * gauss());
    // A negative coefficient is not a motor; clamp rather than emit nonsense.
    if (design.a <= 0) design.a = base.a * 1e-3;
    if (design.throat_diameter <= 0) design.throat_diameter = base.throat_diameter * 1e-3;

    const p = predictMeanOnly(design, scratch);
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
  return counts.map((count, i) => ({
    x: lo + ((i + 0.5) * (hi - lo)) / bins,
    count,
  }));
}
