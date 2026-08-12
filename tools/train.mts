/**
 * Fit the surrogate to the sampled dataset and export it for the browser.
 *
 *   npm run surrogate:train -- --data tools/data/samples.csv --train 700
 *
 * Reports R^2 and mean absolute error per output on a held-out test split, and
 * -- more importantly for the guardrail -- the CALIBRATION of the uncertainty
 * band: the fraction of held-out points that actually fall inside their own
 * predicted 95% interval. A surrogate whose error bars are wrong is worse than
 * no surrogate, because the UI presents them as a reason to trust a number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, TARGETS, mulberry32 } from './designSpace.mts';
import { EXPANDED_FEATURES, N_EXPANDED, expandFeatures } from '../src/surrogate/features.ts';
import { backSolve, cholesky, covariance, fitHypers, forwardSolve } from './gp.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DATA = path.resolve(HERE, '..', arg('data', 'tools/data/samples.csv'));
const N_TRAIN = parseInt(arg('train', '700'), 10);
const SEED = parseInt(arg('seed', '7'), 10);
const OUT = path.resolve(HERE, '..', arg('out', 'src/surrogate/model.json'));

// --- load ------------------------------------------------------------------

const text = fs.readFileSync(DATA, 'utf8').trim().split(/\r?\n/);
const header = text[0].split(',');
const idx = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`dataset has no column "${name}"`);
  return i;
};
const featIdx = FEATURES.map(idx);
const targIdx = TARGETS.map(idx);

const allRows = text.slice(1).map((line) => line.split(',').map(Number));
console.log(`loaded ${allRows.length} rows from ${path.relative(process.cwd(), DATA)}`);

/** Raw parameters for one dataset row, in RAW_FEATURES order. */
const rawOf = (row: number[]) => featIdx.map((i) => row[i]) as [
  number, number, number, number, number, number, number, number
];
/** Expanded model input for one dataset row. */
const expandRow = (row: number[]) => expandFeatures(...rawOf(row));

const D = N_EXPANDED;
const T = TARGETS.length;

/*
 * Targets are modelled in LOG space where they are positive and span decades.
 *
 * Total impulse runs from ~200 to ~46000 N*s. Fitting that directly makes the
 * GP spend all its capacity on the large motors and treat a 100% error on a
 * small one as negligible; worse, a symmetric error bar around a small
 * prediction happily covers negative impulse. In log space the model is
 * calibrated in RELATIVE error, which is what a designer actually cares about,
 * and predictions cannot go non-physical.
 *
 * Isp and burn time are bounded and well-scaled, so they are fitted directly.
 */
const LOG_TARGETS = new Set(['peak_pc', 'total_impulse', 'max_kn']);

// --- split -----------------------------------------------------------------

const rand = mulberry32(SEED);
const order = allRows.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
/*
 * Three-way split, not two.
 *
 * The kernel is shared across outputs, so every output inherits the SAME
 * predictive variance up to its own scale factor -- and that is not right for
 * all of them at once. Left alone, Isp's 95% band covered 78% of held-out
 * points while total impulse's covered 99.9%: both wrong, in opposite
 * directions, and the low one is the dangerous kind since the UI presents the
 * band as grounds for trusting a number.
 *
 * So a per-output scale factor is fitted on a CALIBRATION split and the test
 * split is then untouched by anything. Calibrating on the test set would make
 * the reported coverage a tautology.
 */
const N_CALIB = parseInt(arg('calib', '600'), 10);
const trainIdx = order.slice(0, Math.min(N_TRAIN, order.length));
const calibIdx = order.slice(trainIdx.length, trainIdx.length + N_CALIB);
const testIdx = order.slice(trainIdx.length + calibIdx.length);
console.log(`train ${trainIdx.length} / calibrate ${calibIdx.length} / test ${testIdx.length}`);

// --- standardise -----------------------------------------------------------

// Expand once; the standardisation and the design matrix both work on this.
const expandedTrain = trainIdx.map((i) => expandRow(allRows[i]));

const featMean = new Float64Array(D);
const featStd = new Float64Array(D);
for (let k = 0; k < D; k++) {
  // Standardise on the TRAINING split only; using the full dataset would leak
  // held-out information into the model's input scaling.
  const vals = expandedTrain.map((x) => x[k]);
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / vals.length;
  featMean[k] = m;
  featStd[k] = Math.sqrt(v) || 1;
}

const rawTarget = (row: number[], t: number) => {
  const v = row[targIdx[t]];
  return LOG_TARGETS.has(TARGETS[t]) ? Math.log(v) : v;
};

const targMean = new Float64Array(T);
const targStd = new Float64Array(T);
for (let t = 0; t < T; t++) {
  const vals = trainIdx.map((i) => rawTarget(allRows[i], t));
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / vals.length;
  targMean[t] = m;
  targStd[t] = Math.sqrt(v) || 1;
}

const Xtrain = new Float64Array(trainIdx.length * D);
expandedTrain.forEach((x, i) => {
  for (let k = 0; k < D; k++) Xtrain[i * D + k] = (x[k] - featMean[k]) / featStd[k];
});
const Ytrain: Float64Array[] = [];
for (let t = 0; t < T; t++) {
  const y = new Float64Array(trainIdx.length);
  trainIdx.forEach((row, i) => {
    y[i] = (rawTarget(allRows[row], t) - targMean[t]) / targStd[t];
  });
  Ytrain.push(y);
}

// --- fit -------------------------------------------------------------------

const N = trainIdx.length;
console.log(`\nfitting ARD kernel over ${D} inputs, ${T} shared outputs, N=${N}...`);
const t0 = Date.now();
const { hypers, nll } = fitHypers(Xtrain, Ytrain, N, D, mulberry32(SEED + 1), {
  restarts: 3,
  sweeps: 14,
  log: (s) => console.log(s),
});
console.log(`fit in ${((Date.now() - t0) / 1000).toFixed(1)}s, nll = ${nll.toFixed(2)}`);

console.log('\nARD length scales (standardised units; larger = input matters less):');
EXPANDED_FEATURES.map((f, k) => [f, Math.exp(hypers.logLengthScales[k])] as const)
  .sort((x, y) => x[1] - y[1])
  .forEach(([f, l]) => console.log(`  ${f.padEnd(18)} ${l.toFixed(3)}`));
console.log(`  sigma_f = ${Math.exp(hypers.logSigmaF).toFixed(4)}, sigma_n = ${Math.exp(hypers.logSigmaN).toFixed(4)}`);

// --- factorise and solve for alpha ----------------------------------------

const { K, invSqLen, sigmaF2 } = covariance(Xtrain, N, D, hypers);
if (!cholesky(K, N)) throw new Error('covariance not positive definite after fit');
const L = K; // cholesky() overwrote K with its lower factor

const alphas: Float64Array[] = Ytrain.map((y) => backSolve(L, N, forwardSolve(L, N, y)));

// --- predict ---------------------------------------------------------------

function predict(expanded: Float64Array): { mean: number[]; sd: number[] } {
  const xs = new Float64Array(D);
  for (let k = 0; k < D; k++) xs[k] = (expanded[k] - featMean[k]) / featStd[k];

  const kv = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    let s = 0;
    for (let k = 0; k < D; k++) {
      const diff = xs[k] - Xtrain[j * D + k];
      s += diff * diff * invSqLen[k];
    }
    kv[j] = sigmaF2 * Math.exp(-0.5 * s);
  }

  // var = k** - v^T v, with v = L^-1 k. Shared across outputs because the
  // kernel is shared; only the mean differs per output.
  const v = forwardSolve(L, N, kv);
  let vv = 0;
  for (let i = 0; i < N; i++) vv += v[i] * v[i];
  const varStd = Math.max(1e-12, sigmaF2 + Math.exp(2 * hypers.logSigmaN) - vv);

  const mean: number[] = [];
  const sd: number[] = [];
  for (let t = 0; t < T; t++) {
    let m = 0;
    for (let j = 0; j < N; j++) m += kv[j] * alphas[t][j];
    mean.push(m * targStd[t] + targMean[t]);
    sd.push(Math.sqrt(varStd) * targStd[t]);
  }
  return { mean, sd };
}

// --- calibrate the uncertainty band ---------------------------------------

/*
 * Scale each output's predictive sd by the spread of its own standardised
 * residuals z = (actual - predicted)/sd. If the residuals were already
 * Gaussian with the predicted sd, this factor is 1; anything else says the
 * shared kernel over- or under-states that output's uncertainty by a constant,
 * which a single multiplier fixes exactly.
 */
const calibPreds = calibIdx.map((row) => predict(expandRow(allRows[row])));
const sdScale = new Float64Array(T);
for (let t = 0; t < T; t++) {
  const isLog = LOG_TARGETS.has(TARGETS[t]);
  let sumSq = 0;
  for (let i = 0; i < calibIdx.length; i++) {
    const actual = allRows[calibIdx[i]][targIdx[t]];
    const a = isLog ? Math.log(actual) : actual;
    const z = (a - calibPreds[i].mean[t]) / calibPreds[i].sd[t];
    sumSq += z * z;
  }
  sdScale[t] = Math.sqrt(sumSq / calibIdx.length);
}
console.log('\nuncertainty calibration (sd multiplier from the calibration split):');
TARGETS.forEach((name, t) => console.log(`  ${name.padEnd(16)} x${sdScale[t].toFixed(3)}`));

// --- evaluate --------------------------------------------------------------

console.log('\nheld-out performance (test split, after calibration):');
console.log('  target            R^2      MAE          MAPE     95% coverage');

const metrics: Record<string, Record<string, number>> = {};
const preds = testIdx.map((row) => predict(expandRow(allRows[row])));

for (let t = 0; t < T; t++) {
  const name = TARGETS[t];
  const isLog = LOG_TARGETS.has(name);

  const actual = testIdx.map((row) => allRows[row][targIdx[t]]);
  // Back-transform to physical units so the metrics mean something to a user.
  const predicted = preds.map((p) => (isLog ? Math.exp(p.mean[t]) : p.mean[t]));

  const mean = actual.reduce((s, v) => s + v, 0) / actual.length;
  let ssRes = 0;
  let ssTot = 0;
  let absErr = 0;
  let pctErr = 0;
  let inside = 0;
  for (let i = 0; i < actual.length; i++) {
    ssRes += (actual[i] - predicted[i]) ** 2;
    ssTot += (actual[i] - mean) ** 2;
    absErr += Math.abs(actual[i] - predicted[i]);
    pctErr += Math.abs(actual[i] - predicted[i]) / Math.abs(actual[i]);

    // Coverage is checked in the space the model was FITTED in -- the interval
    // is symmetric there and becomes asymmetric (log-normal) after back
    // transform, so testing it in physical units would be testing the wrong
    // interval.
    const a = isLog ? Math.log(actual[i]) : actual[i];
    const sd = preds[i].sd[t] * sdScale[t];
    if (a >= preds[i].mean[t] - 1.96 * sd && a <= preds[i].mean[t] + 1.96 * sd) inside++;
  }
  const r2 = 1 - ssRes / ssTot;
  const mae = absErr / actual.length;
  const mape = (100 * pctErr) / actual.length;
  const coverage = (100 * inside) / actual.length;

  metrics[name] = { r2, mae, mape, coverage95: coverage };
  console.log(
    `  ${name.padEnd(16)} ${r2.toFixed(4).padStart(7)} ${mae.toPrecision(4).padStart(11)} ` +
      `${mape.toFixed(2).padStart(7)}% ${coverage.toFixed(1).padStart(11)}%`
  );
}

// --- export ----------------------------------------------------------------

/** Pack the lower triangle of L; the upper half is zeros and need not ship. */
function packLowerTriangle(l: Float64Array, n: number): Float32Array {
  const out = new Float32Array((n * (n + 1)) / 2);
  let p = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) out[p++] = l[i * n + j];
  return out;
}

const b64 = (arr: Float32Array) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');

// Envelope from the TRAINING rows: the region the model has actually seen.
const envelope: Record<string, [number, number]> = {};
FEATURES.forEach((f, k) => {
  const vals = trainIdx.map((i) => allRows[i][featIdx[k]]);
  envelope[f] = [Math.min(...vals), Math.max(...vals)];
});

const model = {
  version: 1,
  createdAt: new Date().toISOString(),
  features: FEATURES,
  expandedFeatures: EXPANDED_FEATURES,
  targets: TARGETS,
  logTargets: TARGETS.filter((t) => LOG_TARGETS.has(t)),
  n: N,
  d: D,
  hypers: {
    lengthScales: hypers.logLengthScales.map((v) => Math.exp(v)),
    sigmaF: Math.exp(hypers.logSigmaF),
    sigmaN: Math.exp(hypers.logSigmaN),
  },
  featMean: Array.from(featMean),
  featStd: Array.from(featStd),
  targMean: Array.from(targMean),
  targStd: Array.from(targStd),
  /** Per-output multiplier making the 95% band mean 95%; see the trainer. */
  sdScale: Array.from(sdScale),
  envelope,
  metrics,
  dataset: {
    file: path.basename(DATA),
    totalRows: allRows.length,
    trainRows: N,
    calibRows: calibIdx.length,
    testRows: testIdx.length,
    seed: SEED,
  },
  // Base64 Float32: halves the payload against Float64 and costs ~1e-7 relative
  // precision, far below the model's own error.
  X: b64(Float32Array.from(Xtrain)),
  alphas: alphas.map((a) => b64(Float32Array.from(a))),
  L: b64(packLowerTriangle(L, N)),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(model));
const sizeMB = fs.statSync(OUT).size / 1e6;
console.log(`\nwrote ${path.relative(process.cwd(), OUT)} (${sizeMB.toFixed(2)} MB)`);
