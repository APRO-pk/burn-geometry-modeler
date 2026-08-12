/**
 * A small Gaussian Process, written out by hand.
 *
 * Hand-rolled rather than pulled from a library for two reasons: the browser
 * needs to run the same prediction path, and the artifact has to be small
 * enough to ship. Both fall out of writing the inference explicitly.
 *
 * Kernel: ARD squared-exponential with a nugget.
 *
 *   k(x, x') = sigma_f^2 * exp(-0.5 * sum_d ((x_d - x'_d)/l_d)^2)
 *
 * ARD (one length scale per input) is the point of using a GP here: the fitted
 * length scales say which inputs matter, and an input the data does not
 * constrain gets a long length scale and is ignored rather than fitted to noise.
 *
 * The training set is a SUBSET of the available data. That is not a compromise
 * forced by accuracy, it is what makes the model shippable: exact GP prediction
 * needs the Cholesky factor at inference time to get variance, and that factor
 * is O(N^2). At N = 700 the packed lower triangle is ~1 MB as Float32; at
 * N = 5000 it would be 50 MB. The held-out remainder then measures what the
 * subsetting cost, which is the honest way to choose N.
 */

// --- linear algebra --------------------------------------------------------

/** In-place Cholesky, lower triangular. Returns false if not PD. */
export function cholesky(a: Float64Array, n: number): boolean {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) sum -= a[i * n + k] * a[j * n + k];
      if (i === j) {
        if (sum <= 0) return false;
        a[i * n + i] = Math.sqrt(sum);
      } else {
        a[i * n + j] = sum / a[j * n + j];
      }
    }
    for (let j = i + 1; j < n; j++) a[i * n + j] = 0;
  }
  return true;
}

/** Solve L y = b in place (forward substitution). */
export function forwardSolve(l: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    const row = i * n;
    for (let k = 0; k < i; k++) sum -= l[row + k] * y[k];
    y[i] = sum / l[row + i];
  }
  return y;
}

/** Solve L^T x = y in place (back substitution). */
export function backSolve(l: Float64Array, n: number, y: Float64Array): Float64Array {
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * x[k];
    x[i] = sum / l[i * n + i];
  }
  return x;
}

// --- kernel ----------------------------------------------------------------

export interface Hypers {
  /** log length scale per input dimension. */
  logLengthScales: number[];
  /** log signal standard deviation. */
  logSigmaF: number;
  /** log noise standard deviation (the nugget). */
  logSigmaN: number;
}

export function kernelVector(
  x: Float64Array,
  xi: number,
  X: Float64Array,
  n: number,
  d: number,
  invSqLen: Float64Array,
  sigmaF2: number,
  out: Float64Array
) {
  for (let j = 0; j < n; j++) {
    let s = 0;
    const rj = j * d;
    for (let k = 0; k < d; k++) {
      const diff = x[xi + k] - X[rj + k];
      s += diff * diff * invSqLen[k];
    }
    out[j] = sigmaF2 * Math.exp(-0.5 * s);
  }
}

/** Full covariance matrix with nugget on the diagonal. */
export function covariance(
  X: Float64Array,
  n: number,
  d: number,
  h: Hypers
): { K: Float64Array; invSqLen: Float64Array; sigmaF2: number } {
  const invSqLen = new Float64Array(d);
  for (let k = 0; k < d; k++) {
    const l = Math.exp(h.logLengthScales[k]);
    invSqLen[k] = 1 / (l * l);
  }
  const sigmaF2 = Math.exp(2 * h.logSigmaF);
  const noise = Math.exp(2 * h.logSigmaN);

  const K = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    K[i * n + i] = sigmaF2 + noise;
    for (let j = 0; j < i; j++) {
      let s = 0;
      const ri = i * d;
      const rj = j * d;
      for (let k = 0; k < d; k++) {
        const diff = X[ri + k] - X[rj + k];
        s += diff * diff * invSqLen[k];
      }
      const v = sigmaF2 * Math.exp(-0.5 * s);
      K[i * n + j] = v;
      K[j * n + i] = v;
    }
  }
  return { K, invSqLen, sigmaF2 };
}

/**
 * Negative log marginal likelihood, summed over outputs that share a kernel.
 *
 * Sharing one kernel across all five outputs is a deliberate simplification: it
 * means ONE Cholesky factor ships instead of five, cutting the artifact by 5x.
 * The cost is that the length scales compromise between outputs. Since all five
 * are smooth functions of the same motor geometry and vary on similar scales
 * once standardised, the compromise is mild -- and the held-out metrics are
 * reported per output, so it is visible rather than assumed.
 */
export function negLogMarginalLikelihood(
  X: Float64Array,
  Y: Float64Array[],
  n: number,
  d: number,
  h: Hypers
): number {
  const { K } = covariance(X, n, d, h);
  if (!cholesky(K, n)) return Infinity;

  let logDet = 0;
  for (let i = 0; i < n; i++) logDet += Math.log(K[i * n + i]);

  let total = 0;
  for (const y of Y) {
    const alpha = backSolve(K, n, forwardSolve(K, n, y));
    let quad = 0;
    for (let i = 0; i < n; i++) quad += y[i] * alpha[i];
    total += 0.5 * quad + logDet + 0.5 * n * Math.log(2 * Math.PI);
  }
  return total;
}

/**
 * Fit hyperparameters by coordinate descent on the negative log marginal
 * likelihood.
 *
 * Gradient-free on purpose. The analytic gradient needs the full K^-1, which
 * costs more per evaluation than a few extra line-search steps at this problem
 * size, and coordinate descent on 10 parameters converges in a couple of
 * hundred likelihood evaluations. Multi-start guards the obvious local optima.
 */
export function fitHypers(
  X: Float64Array,
  Y: Float64Array[],
  n: number,
  d: number,
  rand: () => number,
  opts: { restarts?: number; sweeps?: number; log?: (s: string) => void } = {}
): { hypers: Hypers; nll: number } {
  const restarts = opts.restarts ?? 3;
  const sweeps = opts.sweeps ?? 12;
  const log = opts.log ?? (() => {});

  let best: Hypers | null = null;
  let bestNll = Infinity;

  for (let r = 0; r < restarts; r++) {
    // Inputs are standardised, so a length scale near 1 sees the whole range.
    const h: Hypers = {
      logLengthScales: Array.from({ length: d }, () => Math.log(0.6 + 1.4 * rand())),
      logSigmaF: Math.log(0.7 + 0.6 * rand()),
      logSigmaN: Math.log(0.02 + 0.08 * rand()),
    };
    let nll = negLogMarginalLikelihood(X, Y, n, d, h);

    for (let sweep = 0; sweep < sweeps; sweep++) {
      const step = 0.6 * Math.pow(0.75, sweep);
      let improved = false;

      const tryParam = (get: () => number, set: (v: number) => void) => {
        const base = get();
        for (const delta of [step, -step]) {
          set(base + delta);
          const cand = negLogMarginalLikelihood(X, Y, n, d, h);
          if (cand < nll - 1e-9) {
            nll = cand;
            improved = true;
            return;
          }
        }
        set(base);
      };

      for (let k = 0; k < d; k++) {
        tryParam(
          () => h.logLengthScales[k],
          (v) => {
            h.logLengthScales[k] = Math.min(4, Math.max(-3, v));
          }
        );
      }
      tryParam(
        () => h.logSigmaF,
        (v) => {
          h.logSigmaF = Math.min(3, Math.max(-3, v));
        }
      );
      tryParam(
        () => h.logSigmaN,
        (v) => {
          // Floor the nugget: without it the fit chases interpolation of a
          // deterministic simulator and K goes numerically singular.
          h.logSigmaN = Math.min(1, Math.max(Math.log(1e-3), v));
        }
      );

      if (!improved) break;
    }

    log(`  restart ${r + 1}/${restarts}: nll = ${nll.toFixed(2)}`);
    if (nll < bestNll) {
      bestNll = nll;
      best = { ...h, logLengthScales: [...h.logLengthScales] };
    }
  }

  return { hypers: best!, nll: bestNll };
}
