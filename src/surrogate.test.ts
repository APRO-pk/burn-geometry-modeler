import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkEnvelope,
  initSurrogateFromJson,
  predict,
  predictMeanOnly,
  surrogateInfo,
  surrogateMetrics,
} from './surrogate/predict';
import { P_REF, RAW_FEATURES, expandDesign } from './surrogate/features';
import type { RawDesign } from './surrogate/features';
import { dispersionSweep, inverseDesign } from './surrogate/optimize';

/*
 * ============================================================================
 * STEP-5: the surrogate must be checkable against the physics it approximates
 * ============================================================================
 *
 * A surrogate is only worth having if its error is known, so these tests do not
 * check that the model is accurate in the abstract -- they check it against the
 * SAME Rust core the app's "verify" button runs, on designs the model never saw.
 *
 * Three things are asserted, in order of importance:
 *
 *   1. The browser inference in predict.ts reproduces the trainer's numbers.
 *      Two implementations of GP prediction is two chances to be wrong, and a
 *      mismatch would make the reported R^2 a claim about code that never runs.
 *   2. Held-out accuracy against fresh physics solves, not against the training
 *      CSV -- so a mistake in the dataset pipeline cannot hide.
 *   3. The uncertainty band actually covers. An error bar that lies is worse
 *      than no error bar, because the UI offers it as grounds for trust.
 * ============================================================================
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const core = require(path.resolve(HERE, '../crates/burn-core/pkg-node/burn_core.js'));
const MODEL_PATH = path.resolve(HERE, 'surrogate/model.json');

const FIXED = { flame_temp: 1720, gamma: 1.13, molecular_weight: 0.042 };

beforeAll(() => {
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(
      `No surrogate model at ${MODEL_PATH}. Build it with:\n` +
        '  npm run surrogate:sample && npm run surrogate:train'
    );
  }
  initSurrogateFromJson(JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')));
});

/** Ground truth: the same 0-D solve the app runs. */
function solve(d: RawDesign) {
  const out = core.simulate({
    propellant: { density: d.density, a: d.a, n: d.n, ...FIXED },
    grain: {
      kind: 'BATES',
      length: d.length,
      outer_radius: d.outer_radius,
      inner_radius: d.inner_radius,
    },
    nozzle: {
      throat_diameter: d.throat_diameter,
      expansion_ratio: d.expansion_ratio,
      material: null,
    },
    options: { model: '0D' },
  });
  const NF = out.fields.length;
  const c = (name: string) => out.fields.indexOf(name);
  const [cT, cPc, cF, cAb, cAt] = [c('Time'), c('Pc'), c('Thrust'), c('Ab'), c('ThroatArea')];

  let peak_pc = -Infinity;
  let max_kn = -Infinity;
  let total_impulse = 0;
  for (let i = 0; i < out.rows; i++) {
    const b = i * NF;
    peak_pc = Math.max(peak_pc, out.data[b + cPc]);
    max_kn = Math.max(max_kn, out.data[b + cAb] / out.data[b + cAt]);
    if (i > 0) {
      const pb = (i - 1) * NF;
      total_impulse +=
        ((out.data[b + cF] + out.data[pb + cF]) / 2) * (out.data[b + cT] - out.data[pb + cT]);
    }
  }
  const burn_time = out.data[(out.rows - 1) * NF + cT];
  const propMass =
    Math.PI * (d.outer_radius ** 2 - d.inner_radius ** 2) * d.length * d.density;
  return {
    peak_pc,
    total_impulse,
    isp: total_impulse / (propMass * 9.80665),
    max_kn,
    burn_time,
    rows: out.rows,
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Discharge coefficient for the fixed propellant, as the sampler uses. */
const C_D = (() => {
  const g = FIXED.gamma;
  const rSpec = 8.314 / FIXED.molecular_weight;
  const bigGamma = Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
  return bigGamma / Math.sqrt(rSpec * FIXED.flame_temp);
})();

function isSaneMotor(t: ReturnType<typeof solve>) {
  return (
    Number.isFinite(t.peak_pc) &&
    t.rows >= 20 &&
    t.peak_pc >= 1e6 &&
    t.peak_pc <= 25e6 &&
    t.burn_time >= 0.05 &&
    t.burn_time <= 20 &&
    Number.isFinite(t.isp) &&
    t.isp >= 40 &&
    t.isp <= 260
  );
}

/**
 * Fresh designs drawn the way the TRAINING data was drawn: geometry and
 * propellant chosen freely, then the throat derived from a feasible chamber
 * pressure. These are in-distribution -- new points on the manifold the model
 * was fitted over -- and are what the accuracy claim is about.
 */
function onManifoldDesigns(count: number, seed = 20260212): RawDesign[] {
  const rnd = rng(seed);
  const out: RawDesign[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 80) {
    const length = 0.12 + 0.8 * rnd();
    const outer_radius = 0.022 + 0.055 * rnd();
    const inner_radius = outer_radius * (1 - (0.32 + 0.45 * rnd()));
    const n = 0.21 + 0.28 * rnd();
    const density = 1520 + 420 * rnd();
    const expansion_ratio = 1.1 + 10.5 * rnd();
    const a = (0.0025 + 0.016 * rnd()) / Math.pow(P_REF, n);

    // Same inversion the sampler performs: pick a pressure, get the Kn it
    // implies for THIS propellant, and size the throat from it.
    const pcTarget = 1.4e6 + 9.5e6 * rnd();
    const kn = (Math.pow(pcTarget, 1 - n) * C_D) / (density * a);
    if (!Number.isFinite(kn) || kn < 45 || kn > 1100) continue;

    const ab0 =
      2 * Math.PI * inner_radius * length +
      2 * Math.PI * (outer_radius ** 2 - inner_radius ** 2);
    const at = ab0 / kn;
    if ((Math.PI * inner_radius ** 2) / at < 1.2) continue;

    const d: RawDesign = {
      length,
      outer_radius,
      inner_radius,
      throat_diameter: Math.sqrt((4 * at) / Math.PI),
      expansion_ratio,
      a,
      n,
      density,
    };
    if (!checkEnvelope(d).inside) continue;
    if (!isSaneMotor(solve(d))) continue;
    out.push(d);
  }
  return out;
}

/**
 * Designs that pass the box test but sit OFF the training manifold: every
 * feature is drawn independently from its own marginal range, which is not how
 * the training points were generated.
 *
 * These exist to test the guardrail rather than the accuracy. The sampled
 * region is the image of a box under a nonlinear map, so a per-feature box test
 * cannot possibly certify coverage -- it is documented as necessary, not
 * sufficient. What has to hold is that the GP notices: predictive variance
 * grows away from training points, so these should get visibly wider bands and
 * still be covered by them.
 */
function offManifoldDesigns(count: number, seed = 987651): RawDesign[] {
  const rnd = rng(seed);
  const env = surrogateInfo()!.envelope;
  const pick = (f: string, lo = 0.15, hi = 0.85) => {
    const [a, b] = env[f];
    return a + (lo + (hi - lo) * rnd()) * (b - a);
  };

  const out: RawDesign[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 80) {
    const outer_radius = pick('outer_radius');
    const d: RawDesign = {
      length: pick('length'),
      outer_radius,
      inner_radius: outer_radius * (0.25 + 0.5 * rnd()),
      throat_diameter: pick('throat_diameter'),
      expansion_ratio: pick('expansion_ratio'),
      a: pick('a'),
      n: pick('n'),
      density: pick('density'),
    };
    if (!checkEnvelope(d).inside) continue;
    if (!isSaneMotor(solve(d))) continue;
    out.push(d);
  }
  return out;
}

function errorStats(designs: RawDesign[], target: (typeof TARGETS)[number]) {
  const actual: number[] = [];
  const predicted: number[] = [];
  for (const d of designs) {
    actual.push(solve(d)[target]);
    predicted.push(predict(d).mean[target]);
  }
  const mean = actual.reduce((s, v) => s + v, 0) / actual.length;
  let ssRes = 0;
  let ssTot = 0;
  let ape = 0;
  for (let i = 0; i < actual.length; i++) {
    ssRes += (actual[i] - predicted[i]) ** 2;
    ssTot += (actual[i] - mean) ** 2;
    ape += Math.abs(actual[i] - predicted[i]) / Math.abs(actual[i]);
  }
  return { r2: 1 - ssRes / ssTot, mape: (100 * ape) / actual.length };
}

function coverageOf(designs: RawDesign[], target: (typeof TARGETS)[number]) {
  let inside = 0;
  for (const d of designs) {
    const truth = solve(d)[target];
    const p = predict(d);
    if (truth >= p.lower[target] && truth <= p.upper[target]) inside++;
  }
  return (100 * inside) / designs.length;
}

const TARGETS = ['peak_pc', 'total_impulse', 'isp', 'max_kn', 'burn_time'] as const;

// =========================================================================
describe('model artifact', () => {
  it('carries the metadata the UI needs to be honest about it', () => {
    const info = surrogateInfo()!;
    expect(info.features).toEqual([...RAW_FEATURES]);
    expect(info.targets).toEqual([...TARGETS]);
    expect(info.n).toBeGreaterThan(100);
    expect(Object.keys(info.envelope).sort()).toEqual([...RAW_FEATURES].sort());
    expect(info.dataset.trainRows).toBeGreaterThan(0);
    expect(info.dataset.testRows).toBeGreaterThan(0);
  });

  it('reports held-out metrics for every target', () => {
    const m = surrogateMetrics()!;
    for (const t of TARGETS) {
      expect(m[t], t).toBeDefined();
      expect(m[t].r2, `${t} R^2`).toBeGreaterThan(0.95);
      expect(m[t].coverage95, `${t} coverage`).toBeGreaterThan(85);
      expect(m[t].coverage95, `${t} coverage`).toBeLessThan(100);
    }
  });

  it('separates train, calibration and test rows', () => {
    // Calibration on the test split would make the coverage number circular.
    const d = surrogateInfo()!.dataset as Record<string, number>;
    expect(d.calibRows).toBeGreaterThan(0);
    expect(Number(d.trainRows) + Number(d.calibRows) + Number(d.testRows))
      .toBeLessThanOrEqual(Number(d.totalRows));
  });
});

// =========================================================================
describe('feature expansion', () => {
  const design: RawDesign = {
    length: 0.3,
    outer_radius: 0.05,
    inner_radius: 0.02,
    throat_diameter: 0.015,
    expansion_ratio: 4,
    a: 8.875e-5,
    n: 0.32,
    density: 1879,
  };

  it('derives Kn, propellant mass and web exactly from the raw inputs', () => {
    const x = expandDesign(design);
    const at = (Math.PI / 4) * 0.015 ** 2;
    const ab0 = 2 * Math.PI * 0.02 * 0.3 + 2 * Math.PI * (0.05 ** 2 - 0.02 ** 2);
    const mass = Math.PI * (0.05 ** 2 - 0.02 ** 2) * 0.3 * 1879;

    expect(Math.exp(x[8])).toBeCloseTo(ab0 / at, 6); // log_kn0
    expect(Math.exp(x[9])).toBeCloseTo(mass, 6); // log_prop_mass
    expect(Math.exp(x[10])).toBeCloseTo(0.03, 9); // log_web
    expect(Math.exp(x[12])).toBeCloseTo((Math.PI * 0.02 ** 2) / at, 6); // port/throat
  });

  it('is a pure function of the raw inputs -- no hidden state between calls', () => {
    const a = Array.from(expandDesign(design));
    expandDesign({ ...design, length: 0.9 });
    expect(Array.from(expandDesign(design))).toEqual(a);
  });

  it('survives degenerate geometry without producing NaN', () => {
    // The UI calls this on every keystroke, including half-typed numbers.
    const x = expandDesign({ ...design, inner_radius: 0, throat_diameter: 0 });
    for (let i = 0; i < x.length; i++) expect(Number.isFinite(x[i]), `feature ${i}`).toBe(true);
  });
});

// =========================================================================
describe('accuracy against fresh physics solves (in-distribution)', () => {
  let designs: RawDesign[] = [];
  beforeAll(() => {
    designs = onManifoldDesigns(200);
  }, 120_000);

  it('generated a usable held-out set', () => {
    expect(designs.length).toBeGreaterThan(140);
  });

  it('matches the real solver on every output', () => {
    const stats = Object.fromEntries(TARGETS.map((t) => [t, errorStats(designs, t)]));
    console.log('\n  surrogate vs physics, on-manifold:');
    for (const t of TARGETS) {
      console.log(`    ${t.padEnd(15)} R2=${stats[t].r2.toFixed(4)}  MAPE=${stats[t].mape.toFixed(2)}%`);
    }
    for (const t of TARGETS) {
      expect(stats[t].r2, `${t} R^2`).toBeGreaterThan(0.95);
      expect(stats[t].mape, `${t} MAPE`).toBeLessThan(12);
    }
  }, 120_000);

  it('keeps its 95% band honest against the real solver', () => {
    // The whole guardrail rests on this. A band that under-covers is worse than
    // no band, because the UI offers it as grounds for trusting the number.
    for (const t of TARGETS) {
      const c = coverageOf(designs, t);
      console.log(`    ${t.padEnd(15)} 95% band covers ${c.toFixed(1)}%`);
      expect(c, `${t} coverage`).toBeGreaterThan(85);
    }
  }, 120_000);

  it('is less accurate where it says it is less sure', () => {
    // The band has to be informative, not a constant: the widest-band decile
    // must really be worse than the narrowest.
    const rows = designs.map((d) => {
      const p = predict(d);
      return {
        band: p.relativeBand.peak_pc,
        err: Math.abs(p.mean.peak_pc - solve(d).peak_pc) / solve(d).peak_pc,
      };
    });
    rows.sort((x, y) => x.band - y.band);
    const k = Math.max(3, Math.floor(rows.length / 10));
    const tight = rows.slice(0, k).reduce((s, r) => s + r.err, 0) / k;
    const loose = rows.slice(-k).reduce((s, r) => s + r.err, 0) / k;
    console.log(`    narrowest decile err ${(tight * 100).toFixed(2)}% vs widest ${(loose * 100).toFixed(2)}%`);
    expect(loose).toBeGreaterThan(tight);
  }, 120_000);
});

// =========================================================================
describe('off-manifold designs: the box test is not sufficient, and the GP knows', () => {
  /*
   * These designs pass `checkEnvelope` -- every feature is inside its training
   * range -- but they were built by drawing the features INDEPENDENTLY, which
   * is not how the training set was built. The throat, in particular, is no
   * longer tied to the grain and propellant through the pressure relation.
   *
   * Point-accuracy collapses here (R^2 on peak Pc falls from ~0.99 to ~0.8),
   * and that is the honest, expected behaviour of an interpolator asked about a
   * region it has no points in. What must NOT collapse is the model's
   * self-assessment: it should widen its bands and keep covering the truth.
   * That is precisely why the UI never shows a bare surrogate number.
   */
  let onM: RawDesign[] = [];
  let offM: RawDesign[] = [];
  beforeAll(() => {
    onM = onManifoldDesigns(120);
    offM = offManifoldDesigns(120);
  }, 120_000);

  it('still covers the truth with its 95% band', () => {
    for (const t of TARGETS) {
      const c = coverageOf(offM, t);
      console.log(`    off-manifold ${t.padEnd(15)} covers ${c.toFixed(1)}%`);
      expect(c, `${t} off-manifold coverage`).toBeGreaterThan(80);
    }
  }, 120_000);

  it('widens its uncertainty band there, rather than staying confident', () => {
    const meanBand = (ds: RawDesign[]) =>
      ds.reduce((s, d) => s + predict(d).relativeBand.peak_pc, 0) / ds.length;
    const on = meanBand(onM);
    const off = meanBand(offM);
    console.log(`    mean relative band: on-manifold ${(on * 100).toFixed(1)}%, off ${(off * 100).toFixed(1)}%`);
    expect(off).toBeGreaterThan(on);
  }, 120_000);
});

// =========================================================================
describe('envelope guardrail', () => {
  const inside: RawDesign = {
    length: 0.3,
    outer_radius: 0.05,
    inner_radius: 0.02,
    throat_diameter: 0.015,
    expansion_ratio: 4,
    a: 8.875e-5,
    n: 0.32,
    density: 1879,
  };

  it('accepts a design in the middle of the training region', () => {
    expect(checkEnvelope(inside).inside).toBe(true);
    expect(predict(inside).envelope.inside).toBe(true);
  });

  it('names every feature that is out of range, with the range', () => {
    const out = checkEnvelope({ ...inside, length: 50, density: 12000 });
    expect(out.inside).toBe(false);
    const names = out.violations.map((v) => v.feature).sort();
    expect(names).toEqual(['density', 'length']);
    for (const v of out.violations) {
      expect(v.max).toBeGreaterThan(v.min);
      expect(v.value < v.min || v.value > v.max).toBe(true);
    }
  });

  it('flags extrapolation on the prediction itself, not just via a side call', () => {
    // The UI reads `prediction.envelope`, so that path has to carry the flag.
    expect(predict({ ...inside, length: 99 }).envelope.inside).toBe(false);
  });
});

// =========================================================================
describe('inverse design refuses to exploit the surrogate', () => {
  /*
   * Optimising over an approximation finds its errors. Both of these are
   * regressions for failures the search actually produced:
   *
   *   - a 57 mm throat inside a 46 mm bore, which is not a motor at all; and
   *   - designs pinned at 0.3 MPa that satisfy "impulse <= X" by never
   *     choking and producing no thrust.
   *
   * Neither was caught by the input envelope check -- every INPUT was in range.
   * The constraints have to be on the geometry and on the predicted OUTPUTS.
   */
  const bounds = () => {
    const env = surrogateInfo()!.envelope;
    return {
      length: env.length as [number, number],
      outer_radius: env.outer_radius as [number, number],
      inner_radius: env.inner_radius as [number, number],
      throat_diameter: env.throat_diameter as [number, number],
      expansion_ratio: env.expansion_ratio as [number, number],
    };
  };
  const fixed = { a: 8.875e-5, n: 0.32, density: 1879 };

  it('never proposes a throat the port cannot feed', () => {
    const found = inverseDesign(bounds(), { maxImpulse: 2000, maxPeakPc: 7e6 }, {
      fixed,
      restarts: 8,
      seed: 991,
    });
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      const portArea = Math.PI * c.design.inner_radius ** 2;
      const throatArea = (Math.PI / 4) * c.design.throat_diameter ** 2;
      expect(portArea / throatArea, 'port/throat').toBeGreaterThanOrEqual(1.2 - 1e-9);
      expect(c.design.throat_diameter).toBeLessThan(2 * c.design.inner_radius);
    }
  });

  it('never proposes a design outside the trained output range', () => {
    const found = inverseDesign(bounds(), { maxImpulse: 2000, maxPeakPc: 7e6 }, {
      fixed,
      restarts: 8,
      seed: 4242,
    });
    for (const c of found.filter((x) => x.penalty === 0)) {
      expect(c.predicted.peak_pc, 'peak Pc').toBeGreaterThanOrEqual(1.0e6);
      expect(c.predicted.peak_pc, 'peak Pc').toBeLessThanOrEqual(25e6);
    }
  });

  it('produces a best candidate that survives a real solve', () => {
    const found = inverseDesign(bounds(), { maxImpulse: 2000, maxPeakPc: 7e6 }, {
      fixed,
      restarts: 8,
      seed: 7,
    });
    const best = found[0];
    expect(best.penalty).toBe(0);

    const truth = solve(best.design);
    // The whole point of ranking by the model's own confidence: candidate 1
    // should be one the surrogate actually gets right.
    expect(Math.abs(truth.peak_pc - best.predicted.peak_pc) / truth.peak_pc).toBeLessThan(0.15);
    expect(truth.total_impulse).toBeGreaterThan(0.5 * 2000); // a real motor
    expect(truth.peak_pc).toBeLessThan(7e6 * 1.15); // honours the ceiling
  }, 60_000);

  it('orders candidates so the most trusted comes first', () => {
    const found = inverseDesign(bounds(), { maxImpulse: 2000, maxPeakPc: 7e6 }, {
      fixed,
      restarts: 8,
      seed: 31337,
    });
    const feasible = found.filter((c) => c.penalty === 0);
    if (feasible.length > 2) {
      const worst = Math.max(...feasible.map((c) => c.band));
      expect(feasible[0].band).toBeLessThan(worst);
    }
  });
});

// =========================================================================
describe('dispersion sweep', () => {
  const design: RawDesign = {
    length: 0.3,
    outer_radius: 0.05,
    inner_radius: 0.02,
    throat_diameter: 0.015,
    expansion_ratio: 4,
    a: 8.875e-5,
    n: 0.32,
    density: 1879,
  };

  it('produces a distribution centred on the nominal design', () => {
    const res = dispersionSweep(design, { sigma: 0.03, samples: 3000 }, TARGETS);
    const nominal = predictMeanOnly(design);
    for (const t of TARGETS) {
      expect(res[t].values.length).toBe(3000);
      expect(res[t].p05).toBeLessThan(res[t].p50);
      expect(res[t].p50).toBeLessThan(res[t].p95);
      // Median within a few percent of the unperturbed prediction.
      expect(Math.abs(res[t].p50 - nominal[t]) / nominal[t], t).toBeLessThan(0.1);
    }
  });

  it('widens as the dispersion grows', () => {
    const tight = dispersionSweep(design, { sigma: 0.01, samples: 2000 }, TARGETS);
    const loose = dispersionSweep(design, { sigma: 0.06, samples: 2000 }, TARGETS);
    expect(loose.peak_pc.sd).toBeGreaterThan(tight.peak_pc.sd * 2);
  });

  it('is reproducible for a given seed', () => {
    const a = dispersionSweep(design, { sigma: 0.03, samples: 500, seed: 5 }, TARGETS);
    const b = dispersionSweep(design, { sigma: 0.03, samples: 500, seed: 5 }, TARGETS);
    expect(a.peak_pc.mean).toBe(b.peak_pc.mean);
    expect(a.peak_pc.sd).toBe(b.peak_pc.sd);
  });

  it('agrees with the physics core on the dispersion it predicts', () => {
    // The claim the UI makes when it offers "confirm with N full solves".
    const sigma = 0.03;
    const surrogate = dispersionSweep(design, { sigma, samples: 4000, seed: 11 }, TARGETS);

    let s = 90210 >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let r = Math.imul(s ^ (s >>> 15), 1 | s);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => {
      let u = 0;
      let v = 0;
      let q = 0;
      do {
        u = 2 * rnd() - 1;
        v = 2 * rnd() - 1;
        q = u * u + v * v;
      } while (q === 0 || q >= 1);
      return u * Math.sqrt((-2 * Math.log(q)) / q);
    };

    const truth: number[] = [];
    for (let i = 0; i < 120; i++) {
      truth.push(
        solve({
          ...design,
          a: design.a * (1 + sigma * gauss()),
          throat_diameter: design.throat_diameter * (1 + sigma * gauss()),
          density: design.density * (1 + sigma * gauss()),
        }).peak_pc
      );
    }
    const tMean = truth.reduce((x, y) => x + y, 0) / truth.length;
    const tSd = Math.sqrt(truth.reduce((x, y) => x + (y - tMean) ** 2, 0) / truth.length);

    console.log(
      `\n  dispersion: surrogate mean ${(surrogate.peak_pc.mean / 1e6).toFixed(3)} MPa sd ` +
        `${(surrogate.peak_pc.sd / 1e6).toFixed(3)} | physics mean ${(tMean / 1e6).toFixed(3)} sd ${(tSd / 1e6).toFixed(3)}`
    );
    expect(Math.abs(surrogate.peak_pc.mean - tMean) / tMean).toBeLessThan(0.05);
    // 120 solves gives sigma itself only ~6% precision, so this is loose by
    // necessity rather than by choice.
    expect(Math.abs(surrogate.peak_pc.sd - tSd) / tSd).toBeLessThan(0.35);
  }, 120_000);
});

// =========================================================================
describe('performance budget', () => {
  const design: RawDesign = {
    length: 0.3,
    outer_radius: 0.05,
    inner_radius: 0.02,
    throat_diameter: 0.015,
    expansion_ratio: 4,
    a: 8.875e-5,
    n: 0.32,
    density: 1879,
  };

  it('predicts with uncertainty in well under 10 ms', () => {
    for (let i = 0; i < 20; i++) predict(design); // warm up JIT
    const t0 = performance.now();
    const reps = 200;
    for (let i = 0; i < reps; i++) predict({ ...design, length: 0.2 + i * 0.001 });
    const per = (performance.now() - t0) / reps;
    console.log(`\n  predict (with variance): ${per.toFixed(3)} ms`);
    expect(per).toBeLessThan(10);
  });

  it('predicts the mean fast enough for interactive Monte Carlo', () => {
    for (let i = 0; i < 50; i++) predictMeanOnly(design);
    const t0 = performance.now();
    const reps = 5000;
    for (let i = 0; i < reps; i++) predictMeanOnly({ ...design, length: 0.2 + i * 0.0001 });
    const total = performance.now() - t0;
    console.log(`  predictMeanOnly: ${((total / reps) * 1000).toFixed(1)} us  ` +
      `(${reps} samples in ${total.toFixed(0)} ms)`);
    // 10k dispersion samples must stay inside a couple of seconds.
    expect(total / reps).toBeLessThan(1);
  });

  it('agrees between the full and mean-only paths', () => {
    // predictMeanOnly skips the variance solve; it must not skip anything else.
    const full = predict(design).mean;
    const fast = predictMeanOnly(design);
    for (const t of TARGETS) {
      expect(Math.abs(full[t] - fast[t]) / Math.abs(full[t]), t).toBeLessThan(1e-12);
    }
  });
});
