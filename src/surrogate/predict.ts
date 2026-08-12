/**
 * Browser-side Gaussian Process inference.
 *
 * Mirrors the prediction path in tools/train.mts exactly, and shares the feature
 * expansion with it via ./features, so the numbers here are the numbers the
 * held-out metrics were measured on.
 *
 * Cost per prediction is O(N) for each mean and O(N^2) for the shared variance,
 * with N = 800: about 320k multiply-adds through a packed triangular solve,
 * which lands well inside a millisecond. That is what makes typing-speed
 * prediction and 10k-sample Monte Carlo possible without a worker.
 *
 * THE SURROGATE IS NEVER THE ANSWER. It is an approximation of
 * crates/burn-core, trained on it, and every number it produces is presented
 * with an uncertainty band and a path to a real solve. `checkEnvelope` exists
 * so the UI can refuse to answer at all outside the region the model was
 * trained on, rather than extrapolating confidently into nonsense.
 */

import { EXPANDED_FEATURES, N_EXPANDED, expandDesign } from './features';
import type { RawDesign } from './features';

export type SurrogateTarget = 'peak_pc' | 'total_impulse' | 'isp' | 'max_kn' | 'burn_time';

interface ModelJson {
  version: number;
  createdAt: string;
  features: string[];
  expandedFeatures: string[];
  targets: SurrogateTarget[];
  logTargets: SurrogateTarget[];
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
  dataset: Record<string, number | string>;
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

/** Fetch and prepare the model. Safe to call repeatedly. */
export function loadSurrogate(): Promise<LoadedModel> {
  if (model) return Promise.resolve(model);
  if (loading) return loading;

  loading = (async () => {
    // Fetched rather than imported so the 1.8 MB artifact stays out of the main
    // bundle and is only paid for if the user opens the surrogate features.
    const url = new URL('./model.json', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`surrogate model fetch failed: ${res.status}`);
    const json = (await res.json()) as ModelJson;

    if (json.expandedFeatures.length !== N_EXPANDED) {
      throw new Error(
        `surrogate model expects ${json.expandedFeatures.length} features but this build ` +
          `expands to ${N_EXPANDED}. Retrain with: npm run surrogate:train`
      );
    }

    const invSqLen = new Float64Array(json.d);
    for (let k = 0; k < json.d; k++) {
      const l = json.hypers.lengthScales[k];
      invSqLen[k] = 1 / (l * l);
    }

    model = {
      json,
      n: json.n,
      d: json.d,
      X: decodeF32(json.X),
      L: decodeF32(json.L),
      alphas: json.alphas.map(decodeF32),
      invSqLen,
      sigmaF2: json.hypers.sigmaF * json.hypers.sigmaF,
      noise: json.hypers.sigmaN * json.hypers.sigmaN,
      isLog: json.targets.map((t) => json.logTargets.includes(t)),
    };
    return model;
  })();

  return loading;
}

/**
 * Install an already-parsed model. Used by Node (tests, tooling) where the
 * browser's `fetch(import.meta.url)` path does not apply -- and by the parity
 * test, which checks this exact inference code reproduces the trainer's own
 * held-out metrics rather than trusting that the two implementations agree.
 */
export function initSurrogateFromJson(json: unknown): void {
  const j = json as ModelJson;
  const invSqLen = new Float64Array(j.d);
  for (let k = 0; k < j.d; k++) {
    const l = j.hypers.lengthScales[k];
    invSqLen[k] = 1 / (l * l);
  }
  model = {
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
  loading = Promise.resolve(model);
}

export function surrogateReady(): boolean {
  return model !== null;
}

export function surrogateInfo(): ModelJson | null {
  return model?.json ?? null;
}

// --- envelope --------------------------------------------------------------

export interface EnvelopeCheck {
  inside: boolean;
  /** Features outside the training range, with how far outside (fraction). */
  violations: Array<{ feature: string; value: number; min: number; max: number }>;
}

/**
 * Is this design inside the region the model was trained on?
 *
 * A per-feature box test on the training range. Deliberately a NECESSARY, not
 * sufficient, condition: the sampled region is the image of a box under a
 * nonlinear map, so passing this does not prove coverage. It catches the case
 * that actually matters -- a user typing a number well outside anything sampled
 * -- and the GP's own variance catches interior gaps, since predictive variance
 * grows away from training points.
 */
export function checkEnvelope(d: RawDesign): EnvelopeCheck {
  const env = model?.json.envelope;
  if (!env) return { inside: true, violations: [] };

  const violations: EnvelopeCheck['violations'] = [];
  for (const [feature, [min, max]] of Object.entries(env)) {
    const value = (d as unknown as Record<string, number>)[feature];
    if (!Number.isFinite(value)) continue;
    if (value < min || value > max) violations.push({ feature, value, min, max });
  }
  return { inside: violations.length === 0, violations };
}

// --- prediction ------------------------------------------------------------

export interface Prediction {
  /** Mean in physical units, per target. */
  mean: Record<SurrogateTarget, number>;
  /** 95% interval in physical units, per target. Asymmetric for log targets. */
  lower: Record<SurrogateTarget, number>;
  upper: Record<SurrogateTarget, number>;
  /** Relative half-width of the band, a scalar "how sure is it" per target. */
  relativeBand: Record<SurrogateTarget, number>;
  envelope: EnvelopeCheck;
}

const scratchExpanded = new Float64Array(N_EXPANDED);
let scratchK: Float64Array | null = null;
let scratchV: Float64Array | null = null;

/**
 * Predict all five outputs for one design.
 *
 * Throws if the model has not loaded; callers should await `loadSurrogate`.
 */
export function predict(design: RawDesign): Prediction {
  const m = model;
  if (!m) throw new Error('surrogate model not loaded; await loadSurrogate() first');

  const { n, d, X, L, invSqLen, sigmaF2, json } = m;
  if (!scratchK || scratchK.length < n) scratchK = new Float64Array(n);
  if (!scratchV || scratchV.length < n) scratchV = new Float64Array(n);
  const kv = scratchK;
  const v = scratchV;

  // Expand, then standardise with the training statistics.
  const x = expandDesign(design, scratchExpanded);
  for (let k = 0; k < d; k++) x[k] = (x[k] - json.featMean[k]) / json.featStd[k];

  // k(x, X)
  for (let j = 0; j < n; j++) {
    let s = 0;
    const rj = j * d;
    for (let k = 0; k < d; k++) {
      const diff = x[k] - X[rj + k];
      s += diff * diff * invSqLen[k];
    }
    kv[j] = sigmaF2 * Math.exp(-0.5 * s);
  }

  // v = L^-1 k, forward substitution over the packed lower triangle. Row i of
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
  const varStd = Math.max(1e-12, sigmaF2 + m.noise - vv);
  const sdStd = Math.sqrt(varStd);

  const mean = {} as Record<SurrogateTarget, number>;
  const lower = {} as Record<SurrogateTarget, number>;
  const upper = {} as Record<SurrogateTarget, number>;
  const relativeBand = {} as Record<SurrogateTarget, number>;

  for (let t = 0; t < json.targets.length; t++) {
    const target = json.targets[t];
    const alpha = m.alphas[t];
    let mu = 0;
    for (let j = 0; j < n; j++) mu += kv[j] * alpha[j];

    // Back to the fitted space, then to physical units.
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

  return { mean, lower, upper, relativeBand, envelope: checkEnvelope(design) };
}

/**
 * Predict the MEAN only, skipping the O(N^2) variance solve.
 *
 * For Monte Carlo over thousands of samples the per-sample band is not what is
 * being shown -- the histogram's spread comes from the input dispersion, and
 * the model's own uncertainty is reported once alongside it. Dropping the
 * triangular solve makes each sample O(N) instead of O(N^2), which is the
 * difference between a 10k-sample sweep feeling instant and taking ten seconds.
 */
export function predictMeanOnly(
  design: RawDesign,
  out?: Partial<Record<SurrogateTarget, number>>
): Record<SurrogateTarget, number> {
  const m = model;
  if (!m) throw new Error('surrogate model not loaded; await loadSurrogate() first');

  const { n, d, X, invSqLen, sigmaF2, json } = m;
  if (!scratchK || scratchK.length < n) scratchK = new Float64Array(n);
  const kv = scratchK;

  const x = expandDesign(design, scratchExpanded);
  for (let k = 0; k < d; k++) x[k] = (x[k] - json.featMean[k]) / json.featStd[k];

  for (let j = 0; j < n; j++) {
    let s = 0;
    const rj = j * d;
    for (let k = 0; k < d; k++) {
      const diff = x[k] - X[rj + k];
      s += diff * diff * invSqLen[k];
    }
    kv[j] = sigmaF2 * Math.exp(-0.5 * s);
  }

  const result = (out ?? {}) as Record<SurrogateTarget, number>;
  for (let t = 0; t < json.targets.length; t++) {
    const alpha = m.alphas[t];
    let mu = 0;
    for (let j = 0; j < n; j++) mu += kv[j] * alpha[j];
    const muFit = mu * json.targStd[t] + json.targMean[t];
    result[json.targets[t]] = m.isLog[t] ? Math.exp(muFit) : muFit;
  }
  return result;
}

/** Held-out metrics, for showing the user what the model is worth. */
export function surrogateMetrics() {
  return model?.json.metrics ?? null;
}

export { EXPANDED_FEATURES };
