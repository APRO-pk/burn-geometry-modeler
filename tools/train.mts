/**
 * Fit the surrogate to the sampled dataset and export it for the browser.
 *
 *   npm run surrogate:train -- --data tools/data/samples.csv --train 900
 *
 * Reports R^2 and mean absolute error per output on a held-out test split, both
 * overall and PER GEOMETRY -- an aggregate number can hide one grain type being
 * badly served by a model that averages well.
 *
 * It also reports the CALIBRATION of the uncertainty band: the fraction of
 * held-out points that fall inside their own predicted 95% interval. A surrogate
 * whose error bars are wrong is worse than no surrogate, because the UI presents
 * them as a reason to trust a number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, mulberry32 } from './designSpace.mts';
import type { GrainKind, SurrogateGrain } from './designSpace.mts';
import {
  EXPANDED_FEATURES,
  N_EXPANDED,
  describeGrain,
  expandDesign,
} from '../src/surrogate/features.ts';
import type { RawDesign } from '../src/surrogate/features.ts';
import { backSolve, cholesky, covariance, fitHypers, forwardSolve } from './gp.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DATA = path.resolve(HERE, '..', arg('data', 'tools/data/samples.csv'));
const N_TRAIN = parseInt(arg('train', '900'), 10);
const N_CALIB = parseInt(arg('calib', '700'), 10);
const SEED = parseInt(arg('seed', '7'), 10);
const OUT = path.resolve(HERE, '..', arg('out', 'src/surrogate/model.json'));

// --- load ------------------------------------------------------------------

/** Split a CSV line, honouring "" quoting (the grain spec contains commas). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const text = fs.readFileSync(DATA, 'utf8').trim().split(/\r?\n/);
const header = splitCsv(text[0]);
const idx = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`dataset has no column "${name}"`);
  return i;
};
const iKind = idx('grain_kind');
const iGrain = idx('grain_json');
const iThroat = idx('throat_diameter');
const iEps = idx('expansion_ratio');
const iA = idx('a');
const iN = idx('n');
const iRho = idx('density');
const targIdx = TARGETS.map(idx);

interface DataRow {
  kind: GrainKind;
  design: RawDesign;
  expanded: Float64Array;
  targets: number[];
}

const allRows: DataRow[] = text.slice(1).map((line) => {
  const f = splitCsv(line);
  const grain = JSON.parse(f[iGrain]) as SurrogateGrain;
  const design: RawDesign = {
    grain,
    throat_diameter: Number(f[iThroat]),
    expansion_ratio: Number(f[iEps]),
    a: Number(f[iA]),
    n: Number(f[iN]),
    density: Number(f[iRho]),
  };
  return {
    kind: f[iKind] as GrainKind,
    design,
    expanded: expandDesign(design, new Float64Array(N_EXPANDED), describeGrain(grain, design.density, design.n)),
    targets: targIdx.map((i) => Number(f[i])),
  };
});

console.log(`loaded ${allRows.length} rows from ${path.relative(process.cwd(), DATA)}`);
const kindCounts = new Map<GrainKind, number>();
for (const r of allRows) kindCounts.set(r.kind, (kindCounts.get(r.kind) ?? 0) + 1);
console.log('  by geometry: ' + [...kindCounts].map(([k, c]) => `${k} ${c}`).join(', '));

const D = N_EXPANDED;
const T = TARGETS.length;

/*
 * Targets are modelled in LOG space where they are positive and span decades.
 *
 * Total impulse runs from ~80 to ~48000 N*s. Fitting that directly makes the GP
 * spend its capacity on the large motors and treat a 100% error on a small one
 * as negligible; worse, a symmetric error bar around a small prediction happily
 * covers negative impulse. In log space the model is calibrated in RELATIVE
 * error, which is what a designer cares about, and predictions cannot go
 * non-physical.
 */
const LOG_TARGETS = new Set(['peak_pc', 'total_impulse', 'max_kn', 'burn_time']);

// --- split -----------------------------------------------------------------

/*
 * Stratified by geometry, not a plain shuffle.
 *
 * With seven geometries and a few hundred training rows, an unstratified draw
 * can leave one kind with a handful of training points purely by luck -- and
 * because the model is geometry-agnostic, that shows up as a quiet accuracy
 * hole for that kind rather than an obvious failure. Drawing proportionally
 * from each kind removes the possibility.
 */
const rand = mulberry32(SEED);
const byKind = new Map<GrainKind, number[]>();
allRows.forEach((r, i) => {
  if (!byKind.has(r.kind)) byKind.set(r.kind, []);
  byKind.get(r.kind)!.push(i);
});
for (const list of byKind.values()) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}

const trainIdx: number[] = [];
const calibIdx: number[] = [];
const testIdx: number[] = [];
for (const [, list] of byKind) {
  const share = (count: number) => Math.round((count * list.length) / allRows.length);
  const nTr = Math.min(share(N_TRAIN), list.length);
  const nCa = Math.min(share(N_CALIB), list.length - nTr);
  trainIdx.push(...list.slice(0, nTr));
  calibIdx.push(...list.slice(nTr, nTr + nCa));
  testIdx.push(...list.slice(nTr + nCa));
}
console.log(`train ${trainIdx.length} / calibrate ${calibIdx.length} / test ${testIdx.length}`);

// --- standardise -----------------------------------------------------------

const featMean = new Float64Array(D);
const featStd = new Float64Array(D);
for (let k = 0; k < D; k++) {
  // Standardise on the TRAINING split only; using the full dataset would leak
  // held-out information into the model's input scaling.
  const vals = trainIdx.map((i) => allRows[i].expanded[k]);
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / vals.length;
  featMean[k] = m;
  featStd[k] = Math.sqrt(v) || 1;
}

const rawTarget = (row: DataRow, t: number) =>
  LOG_TARGETS.has(TARGETS[t]) ? Math.log(row.targets[t]) : row.targets[t];

const targMean = new Float64Array(T);
const targStd = new Float64Array(T);
for (let t = 0; t < T; t++) {
  const vals = trainIdx.map((i) => rawTarget(allRows[i], t));
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / vals.length;
  targMean[t] = m;
  targStd[t] = Math.sqrt(v) || 1;
}

const N = trainIdx.length;
const Xtrain = new Float64Array(N * D);
trainIdx.forEach((row, i) => {
  for (let k = 0; k < D; k++) {
    Xtrain[i * D + k] = (allRows[row].expanded[k] - featMean[k]) / featStd[k];
  }
});
const Ytrain: Float64Array[] = [];
for (let t = 0; t < T; t++) {
  const y = new Float64Array(N);
  trainIdx.forEach((row, i) => {
    y[i] = (rawTarget(allRows[row], t) - targMean[t]) / targStd[t];
  });
  Ytrain.push(y);
}

// --- fit -------------------------------------------------------------------

console.log(`\nfitting ARD kernel over ${D} inputs, ${T} shared outputs, N=${N}...`);
const t0 = Date.now();
const { hypers, nll } = fitHypers(Xtrain, Ytrain, N, D, mulberry32(SEED + 1), {
  restarts: 3,
  sweeps: 14,
  log: (s) => console.log(s),
});
console.log(`fit in ${((Date.now() - t0) / 1000).toFixed(1)}s, nll = ${nll.toFixed(2)}`);

console.log('\nARD length scales (standardised; smaller = input matters more):');
EXPANDED_FEATURES.map((f, k) => [f, Math.exp(hypers.logLengthScales[k])] as const)
  .sort((x, y) => x[1] - y[1])
  .forEach(([f, l]) => console.log(`  ${f.padEnd(22)} ${l.toFixed(3)}`));
console.log(
  `  sigma_f = ${Math.exp(hypers.logSigmaF).toFixed(4)}, sigma_n = ${Math.exp(hypers.logSigmaN).toFixed(4)}`
);

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
 * residuals z = (actual - predicted)/sd. If those were already Gaussian with
 * the predicted sd this factor is 1; anything else says the shared kernel over-
 * or under-states that output's uncertainty by a constant, which one multiplier
 * fixes exactly. Fitted on a split the test set never sees, or the reported
 * coverage would be circular.
 */
const calibPreds = calibIdx.map((i) => predict(allRows[i].expanded));
const sdScale = new Float64Array(T);
for (let t = 0; t < T; t++) {
  const isLog = LOG_TARGETS.has(TARGETS[t]);
  let sumSq = 0;
  for (let i = 0; i < calibIdx.length; i++) {
    const actual = allRows[calibIdx[i]].targets[t];
    const a = isLog ? Math.log(actual) : actual;
    const z = (a - calibPreds[i].mean[t]) / calibPreds[i].sd[t];
    sumSq += z * z;
  }
  sdScale[t] = Math.sqrt(sumSq / calibIdx.length);
}
console.log('\nuncertainty calibration (sd multiplier, from the calibration split):');
TARGETS.forEach((name, t) => console.log(`  ${name.padEnd(16)} x${sdScale[t].toFixed(3)}`));

// --- evaluate --------------------------------------------------------------

function evaluate(rows: number[]) {
  const preds = rows.map((i) => predict(allRows[i].expanded));
  const stats: Record<string, { r2: number; mae: number; mape: number; coverage95: number }> = {};
  for (let t = 0; t < T; t++) {
    const name = TARGETS[t];
    const isLog = LOG_TARGETS.has(name);
    const actual = rows.map((i) => allRows[i].targets[t]);
    const predicted = preds.map((p) => (isLog ? Math.exp(p.mean[t]) : p.mean[t]));

    const mean = actual.reduce((s, v) => s + v, 0) / actual.length;
    let ssRes = 0;
    let ssTot = 0;
    let ae = 0;
    let ape = 0;
    let inside = 0;
    for (let i = 0; i < actual.length; i++) {
      ssRes += (actual[i] - predicted[i]) ** 2;
      ssTot += (actual[i] - mean) ** 2;
      ae += Math.abs(actual[i] - predicted[i]);
      ape += Math.abs(actual[i] - predicted[i]) / Math.abs(actual[i]);
      // Coverage is checked in the space the model was FITTED in: the interval
      // is symmetric there and asymmetric after back-transform, so testing it in
      // physical units would test the wrong interval.
      const a = isLog ? Math.log(actual[i]) : actual[i];
      const sd = preds[i].sd[t] * sdScale[t];
      if (a >= preds[i].mean[t] - 1.96 * sd && a <= preds[i].mean[t] + 1.96 * sd) inside++;
    }
    stats[name] = {
      r2: 1 - ssRes / ssTot,
      mae: ae / actual.length,
      mape: (100 * ape) / actual.length,
      coverage95: (100 * inside) / actual.length,
    };
  }
  return stats;
}

console.log('\nheld-out performance (test split, after calibration):');
console.log('  target            R^2      MAE          MAPE     95% coverage');
const metrics = evaluate(testIdx);
for (const t of TARGETS) {
  const m = metrics[t];
  console.log(
    `  ${t.padEnd(16)} ${m.r2.toFixed(4).padStart(7)} ${m.mae.toPrecision(4).padStart(11)} ` +
      `${m.mape.toFixed(2).padStart(7)}% ${m.coverage95.toFixed(1).padStart(11)}%`
  );
}

/*
 * Per-geometry breakdown. An aggregate R^2 can look excellent while one grain
 * type is served badly -- and since the model is geometry-agnostic, nothing else
 * would reveal that.
 */
console.log('\nper-geometry (test split): R^2 / MAPE on peak Pc and impulse');
const perKind: Record<string, Record<string, { r2: number; mae: number; mape: number; coverage95: number }>> = {};
for (const kind of new Set(allRows.map((r) => r.kind))) {
  const rows = testIdx.filter((i) => allRows[i].kind === kind);
  if (rows.length < 5) {
    console.log(`  ${kind.padEnd(11)} (only ${rows.length} test rows -- skipped)`);
    continue;
  }
  const s = evaluate(rows);
  perKind[kind] = s;
  console.log(
    `  ${kind.padEnd(11)} n=${String(rows.length).padStart(4)}  ` +
      `Pc ${s.peak_pc.r2.toFixed(4)}/${s.peak_pc.mape.toFixed(2)}%  ` +
      `It ${s.total_impulse.r2.toFixed(4)}/${s.total_impulse.mape.toFixed(2)}%  ` +
      `tb ${s.burn_time.r2.toFixed(4)}/${s.burn_time.mape.toFixed(2)}%`
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
const b64 = (arr: Float32Array) =>
  Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');

/*
 * The envelope is defined over the EXPANDED features, not the raw parameters.
 *
 * With seven geometries there is no common raw parameter list to bound -- a
 * Star has no inner_radius and a Finocyl has no valley_radius. The expanded
 * features are geometry-agnostic by construction, so bounding them asks the
 * question that actually matters: is this design's burn-back description
 * something the model has seen?
 */
const envelope: Record<string, [number, number]> = {};
EXPANDED_FEATURES.forEach((f, k) => {
  const vals = trainIdx.map((i) => allRows[i].expanded[k]);
  envelope[f] = [Math.min(...vals), Math.max(...vals)];
});

const model = {
  version: 2,
  createdAt: new Date().toISOString(),
  expandedFeatures: EXPANDED_FEATURES,
  targets: TARGETS,
  logTargets: TARGETS.filter((t) => LOG_TARGETS.has(t)),
  grainKinds: [...kindCounts.keys()],
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
  /** Per-output multiplier making the 95% band mean 95%; see above. */
  sdScale: Array.from(sdScale),
  envelope,
  metrics,
  metricsByKind: perKind,
  dataset: {
    file: path.basename(DATA),
    totalRows: allRows.length,
    trainRows: N,
    calibRows: calibIdx.length,
    testRows: testIdx.length,
    byKind: Object.fromEntries(kindCounts),
    seed: SEED,
  },
  // Base64 Float32: halves the payload against Float64 for ~1e-7 relative
  // precision, far below the model's own error.
  X: b64(Float32Array.from(Xtrain)),
  alphas: alphas.map((a) => b64(Float32Array.from(a))),
  L: b64(packLowerTriangle(L, N)),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(model));
console.log(
  `\nwrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`
);
