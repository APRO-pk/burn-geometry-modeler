/**
 * Browser-side Gaussian Process inference.
 *
 * Mirrors the prediction path in tools/train.mts exactly, and shares the feature
 * extraction with it via ./features, so the numbers here are the numbers the
 * held-out metrics were measured on.
 *
 * Cost per prediction is O(N) for each mean and O(N^2) for the shared variance,
 * which lands inside a millisecond at the shipped training-set size. That is
 * what makes typing-speed prediction and 10k-sample Monte Carlo possible without
 * a worker.
 *
 * THE SURROGATE IS NEVER THE ANSWER. It approximates crates/burn-core, trained
 * on it, and every number it produces is presented with an uncertainty band and
 * a path to a real solve. `checkEnvelope` exists so the UI can refuse to answer
 * outside the region the model was trained on rather than extrapolating
 * confidently into nonsense.
 */

import { EXPANDED_FEATURES, N_EXPANDED, describeGrain, expandDesign } from './features';
import type { GrainDescriptor, RawDesign } from './features';

export type SurrogateTarget = 'peak_pc' | 'total_impulse' | 'isp' | 'max_kn' | 'burn_time';

interface ModelJson {
  version: number;
  createdAt: string;
  expandedFeatures: string[];
  targets: SurrogateTarget[];
  logTargets: SurrogateTarget[];
  grainKinds: string[];
  n: number;
  d: number;
  hypers: { lengthScales: number[]; sigmaF: number; sigmaN: number };
  featMean: number[];
  featStd: number[];
  targMean: number[];
  targStd: number[];
  sdScale: number[];
  envelope: Record<string, [number, number]>;
  metrics: Record<string, { r2: number; mae: number; mape: number; coverage95: number }>;
  metricsByKind: Record<string, Record<string, { r2: number; mape: number }>>;
  dataset: Record<string, unknown>;
  X: string;
  alphas: string[];
  L: string;
}

interface LoadedModel {
  json: ModelJson;
  n: number;
  d: number;
  X: Float32Array;
  /** Packed lower triangle of the Cholesky factor, row-major. */
  L: Float32Array;
  alphas: Float32Array[];
  invSqLen: Float64Array;
  sigmaF2: number;
  noise: number;
  isLog: boolean[];
}

let model: LoadedModel | null = null;
let loading: Promise<LoadedModel> | null = null;

function decodeF32(b64: string): Float32Array {
  // atob exists in browsers and in Node >= 16, so one path covers both.
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function prepare(j: ModelJson): LoadedModel {
  if (j.expandedFeatures.length !== N_EXPANDED) {
    throw new Error(
      `surrogate model has ${j.expandedFeatures.length} features but this build extracts ` +
        `${N_EXPANDED}. Retrain with: npm run surrogate:rebuild`
    );
  }
  const invSqLen = new Float64Array(j.d);
  for (let k = 0; k < j.d; k++) {
    const l = j.hypers.lengthScales[k];
    invSqLen[k] = 1 / (l * l);
  }
  return {
    json: j,
    n: j.n,
    d: j.d,
    X: decodeF32(j.X),
    L: decodeF32(j.L),
    alphas: j.alphas.map(decodeF32),
    invSqLen,
    sigmaF2: j.hypers.sigmaF * j.hypers.sigmaF,
    noise: j.hypers.sigmaN * j.hypers.sigmaN,
    isLog: j.targets.map((t) => j.logTargets.includes(t)),
  };
}

/** Fetch and prepare the model. Safe to call repeatedly. */
export function loadSurrogate(): Promise<LoadedModel> {
  if (model) return Promise.resolve(model);
  if (loading) return loading;

  loading = (async () => {
    // Fetched rather than imported so the artifact stays out of the main bundle
    // and is only paid for if the user opens the surrogate features.
    const url = new URL('./model.json', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`surrogate model fetch failed: ${res.status}`);
    model = prepare((await res.json()) as ModelJson);
    return model;
  })();

  return loading;
}

/**
 * Install an already-parsed model. Used by Node (tests, tooling) where the
 * browser's `fetch(import.meta.url)` path does not apply -- and by the parity
 * test, which checks this exact inference code reproduces the trainer's own
 * held-out metrics rather than trusting that two implementations agree.
 */
export function initSurrogateFromJson(json: unknown): void {
  model = prepare(json as ModelJson);
  loading = Promise.resolve(model);
}

export function surrogateReady(): boolean {
  return model !== null;
}

export function surrogateInfo(): ModelJson | null {
  return model?.json ?? null;
}

/** Held-out metrics, for showing the user what the model is worth. */
export function surrogateMetrics() {
  return model?.json.metrics ?? null;
}

/** Held-out metrics broken down by grain geometry. */
export function surrogateMetricsByKind() {
  return model?.json.metricsByKind ?? null;
}

// --- envelope --------------------------------------------------------------

export interface EnvelopeCheck {
  inside: boolean;
  /** Features outside the training range, with the range they left. */
  violations: Array<{ feature: string; value: number; min: number; max: number }>;
}

/**
 * Is this design inside the region the model was trained on?
 *
 * The test is over the EXPANDED features, not the raw parameters -- which is
 * forced by the model covering seven geometries at once. There is no common raw
 * parameter list to bound: a Star has no inner_radius, a Finocyl has no
 * valley_radius. The expanded features are geometry-agnostic by construction, so
 * bounding them asks the question that actually matters: is this design's
 * burn-back description something the model has seen?
 *
 * Deliberately a NECESSARY, not sufficient, condition. The sampled region is the
 * image of a box under a nonlinear map, so passing this does not prove coverage.
 * It catches the case that matters -- a design well outside anything sampled --
 * and the GP's own variance catches interior gaps, since predictive variance
 * grows away from training points.
 */
export function checkEnvelope(d: RawDesign, descriptor?: GrainDescriptor): EnvelopeCheck {
  const env = model?.json.envelope;
  if (!env) return { inside: true, violations: [] };

  const x = expandDesign(d, new Float64Array(N_EXPANDED), descriptor);
  const violations: EnvelopeCheck['violations'] = [];
  for (let k = 0; k < EXPANDED_FEATURES.length; k++) {
    const name = EXPANDED_FEATURES[k];
    const range = env[name];
    if (!range) continue;
    const value = x[k];
    if (!Number.isFinite(value)) {
      violations.push({ feature: name, value, min: range[0], max: range[1] });
    } else if (value < range[0] || value > range[1]) {
      violations.push({ feature: name, value, min: range[0], max: range[1] });
    }
  }
  return { inside: violations.length === 0, violations };
}

// --- prediction ------------------------------------------------------------

export interface Prediction {
  /** Mean in physical units, per target. */
  mean: Record<SurrogateTarget, number>;
  /** 95% interval in physical units. Asymmetric for log-fitted targets. */
  lower: Record<SurrogateTarget, number>;
  upper: Record<SurrogateTarget, number>;
  /** Relative half-width of the band: a scalar "how sure is it" per target. */
  relativeBand: Record<SurrogateTarget, number>;
  envelope: EnvelopeCheck;
}

const scratchExpanded = new Float64Array(N_EXPANDED);
let scratchK: Float64Array | null = null;
let scratchV: Float64Array | null = null;

function kernelVector(d: RawDesign, descriptor?: GrainDescriptor): Float64Array {
  const m = model!;
  const { n, d: dim, X, invSqLen, sigmaF2, json } = m;
  if (!scratchK || scratchK.length < n) scratchK = new Float64Array(n);
  const kv = scratchK;

  const x = expandDesign(d, scratchExpanded, descriptor);
  for (let k = 0; k < dim; k++) x[k] = (x[k] - json.featMean[k]) / json.featStd[k];

  for (let j = 0; j < n; j++) {
    let s = 0;
    const rj = j * dim;
    for (let k = 0; k < dim; k++) {
      const diff = x[k] - X[rj + k];
      s += diff * diff * invSqLen[k];
    }
    kv[j] = sigmaF2 * Math.exp(-0.5 * s);
  }
  return kv;
}

/**
 * Predict all outputs for one design.
 *
 * Throws if the model has not loaded; callers should await `loadSurrogate`.
 * `descriptor` may be passed when the grain is unchanged across many calls,
 * which skips re-scanning the burn-back curve.
 */
export function predict(design: RawDesign, descriptor?: GrainDescriptor): Prediction {
  const m = model;
  if (!m) throw new Error('surrogate model not loaded; await loadSurrogate() first');

  const { n, L, json } = m;
  const kv = kernelVector(design, descriptor);
  if (!scratchV || scratchV.length < n) scratchV = new Float64Array(n);
  const v = scratchV;

  // v = L^-1 k by forward substitution over the packed lower triangle. Row i of
  // the packed factor starts at i(i+1)/2.
  let vv = 0;
  for (let i = 0; i < n; i++) {
    const base = (i * (i + 1)) / 2;
    let sum = kv[i];
    for (let k = 0; k < i; k++) sum -= L[base + k] * v[k];
    const vi = sum / L[base + i];
    v[i] = vi;
    vv += vi * vi;
  }
  const sdStd = Math.sqrt(Math.max(1e-12, m.sigmaF2 + m.noise - vv));

  const mean = {} as Record<SurrogateTarget, number>;
  const lower = {} as Record<SurrogateTarget, number>;
  const upper = {} as Record<SurrogateTarget, number>;
  const relativeBand = {} as Record<SurrogateTarget, number>;

  for (let t = 0; t < json.targets.length; t++) {
    const target = json.targets[t];
    const alpha = m.alphas[t];
    let mu = 0;
    for (let j = 0; j < n; j++) mu += kv[j] * alpha[j];

    const muFit = mu * json.targStd[t] + json.targMean[t];
    const sdFit = sdStd * json.targStd[t] * json.sdScale[t];
    const loFit = muFit - 1.96 * sdFit;
    const hiFit = muFit + 1.96 * sdFit;

    if (m.isLog[t]) {
      mean[target] = Math.exp(muFit);
      lower[target] = Math.exp(loFit);
      upper[target] = Math.exp(hiFit);
    } else {
      mean[target] = muFit;
      lower[target] = loFit;
      upper[target] = hiFit;
    }
    relativeBand[target] =
      mean[target] !== 0 ? (upper[target] - lower[target]) / (2 * Math.abs(mean[target])) : 0;
  }

  return { mean, lower, upper, relativeBand, envelope: checkEnvelope(design, descriptor) };
}

/**
 * Predict the MEAN only, skipping the O(N^2) variance solve.
 *
 * For Monte Carlo over thousands of samples the per-sample band is not what is
 * shown -- the histogram's spread comes from input dispersion, and the model's
 * own uncertainty is reported once alongside it. Dropping the triangular solve
 * makes each sample O(N) instead of O(N^2), which is the difference between a
 * 10k-sample sweep feeling instant and taking ten seconds.
 */
export function predictMeanOnly(
  design: RawDesign,
  out?: Partial<Record<SurrogateTarget, number>>,
  descriptor?: GrainDescriptor
): Record<SurrogateTarget, number> {
  const m = model;
  if (!m) throw new Error('surrogate model not loaded; await loadSurrogate() first');

  const kv = kernelVector(design, descriptor);
  const result = (out ?? {}) as Record<SurrogateTarget, number>;
  for (let t = 0; t < m.json.targets.length; t++) {
    const alpha = m.alphas[t];
    let mu = 0;
    for (let j = 0; j < m.n; j++) mu += kv[j] * alpha[j];
    const muFit = mu * m.json.targStd[t] + m.json.targMean[t];
    result[m.json.targets[t]] = m.isLog[t] ? Math.exp(muFit) : muFit;
  }
  return result;
}

export { EXPANDED_FEATURES, describeGrain };
