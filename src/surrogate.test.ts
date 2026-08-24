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
  surrogateMetricsByKind,
} from './surrogate/predict';
import {
  P_REF,
  SURROGATE_GRAIN_KINDS,
  burnoutWeb,
  describeGrain,
  expandDesign,
  grainFromConfig,
} from './surrogate/features';
import type { GrainKind, RawDesign, SurrogateGrain } from './surrogate/features';
import { GRAIN_SHAPE_PARAMS, grainFromShape } from './surrogate/shape';
import { MIN_PORT_TO_THROAT, dispersionSweep, inverseDesign } from './surrogate/optimize';

/*
 * ============================================================================
 * The surrogate must be checkable against the physics it approximates
 * ============================================================================
 *
 * A surrogate is only worth having if its error is known, so these tests do not
 * check that the model is accurate in the abstract -- they check it against the
 * SAME Rust core the app's "verify" button runs, on designs it never saw, FOR
 * EVERY GRAIN GEOMETRY.
 *
 * The per-geometry breakdown is the part that matters most. One model covers all
 * seven kinds, because the solver only ever sees a grain through its burn-back
 * curves and the features describe those curves. That design is what makes an
 * aggregate metric misleading: a model averaging R^2 = 0.99 could still be
 * useless for Finocyl grains, and nothing but a per-kind split would say so.
 * ============================================================================
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const core = require(path.resolve(HERE, '../crates/burn-core/pkg-node/burn_core.js'));
const MODEL_PATH = path.resolve(HERE, 'surrogate/model.json');

const FIXED = { flame_temp: 1720, gamma: 1.13, molecular_weight: 0.042 };
const TARGETS = ['peak_pc', 'total_impulse', 'isp', 'max_kn', 'burn_time'] as const;

beforeAll(() => {
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(
      `No surrogate model at ${MODEL_PATH}. Build it with:\n  npm run surrogate:rebuild`
    );
  }
  initSurrogateFromJson(JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')));
});

/** Ground truth: the same 0-D solve the app runs. */
/**
 * Ground truth for one design, memoised.
 *
 * WHY THE MEMO
 *
 * The held-out set is 45 designs x 7 geometries = 315 designs, built once in
 * beforeAll and then shared. Three tests read it: one computes error stats for
 * three targets, one computes band coverage, one compares error against
 * predicted uncertainty. Between them every design was solved FIVE times, with
 * identical inputs and therefore identical results -- about 1,575 full solves
 * to do 315 designs worth of work.
 *
 * That made these three tests roughly 116 of the suite s 127 seconds, and the
 * CPU saturation starved unrelated tests until they tripped their timeouts. So
 * the flakiness elsewhere was a symptom of waste here.
 *
 * Keyed on the design OBJECT, which is stable for the lifetime of the run, so
 * this is a cache hit by identity with no serialisation cost. A WeakMap because
 * there is no reason to hold designs alive once a test file is done with them.
 *
 * Coverage is unchanged: the same designs are still solved by the same core,
 * just once each.
 */
const solveCache = new WeakMap<RawDesign, ReturnType<typeof solveUncached>>();

function solve(d: RawDesign): ReturnType<typeof solveUncached> {
  const hit = solveCache.get(d);
  if (hit) return hit;
  const fresh = solveUncached(d);
  solveCache.set(d, fresh);
  return fresh;
}

function solveUncached(d: RawDesign) {
  const out = core.simulate({
    propellant: { density: d.density, a: d.a, n: d.n, ...FIXED },
    grain: d.grain,
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
  const propMass = describeGrain(d.grain, d.density, d.n).propMass;
  return {
    peak_pc,
    total_impulse,
    isp: total_impulse / (Math.max(propMass, 1e-9) * 9.80665),
    max_kn,
    burn_time: out.data[(out.rows - 1) * NF + cT],
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

/** A synthetic traced profile, so Custom DXF can be exercised like the rest. */
function dxfTables(bore: number, outerRadius: number, trend: number) {
  const web = outerRadius - bore;
  const dx = web / 40;
  const perim0 = 2 * Math.PI * bore;
  const perim_table: number[] = [];
  const area_table: number[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const p = perim0 * Math.max(0.05, 1 + trend * t);
    perim_table.push(p);
    const prevArea = i === 0 ? Math.PI * bore * bore : area_table[i - 1];
    const prevPerim = i === 0 ? perim0 : perim_table[i - 1];
    area_table.push(i === 0 ? prevArea : prevArea + ((prevPerim + p) / 2) * dx);
  }
  return { dx, perim_table, area_table };
}

/**
 * Fresh designs of one geometry, drawn the way the TRAINING data was drawn:
 * shape fractions through `grainFromShape`, then the throat derived from a
 * feasible chamber pressure. These are in-distribution -- new points on the
 * manifold the model was fitted over -- and are what the accuracy claim is about.
 */
function designsOfKind(kind: GrainKind, count: number, seed: number): RawDesign[] {
  const rnd = rng(seed);
  const spec = GRAIN_SHAPE_PARAMS[kind];
  const out: RawDesign[] = [];
  let guard = 0;

  while (out.length < count && guard++ < count * 200) {
    const length = 0.12 + 0.8 * rnd();
    const outerRadius = 0.022 + 0.055 * rnd();
    const n = 0.21 + 0.28 * rnd();
    const density = 1520 + 420 * rnd();
    const expansion_ratio = 1.1 + 10.5 * rnd();
    const a = (0.0025 + 0.016 * rnd()) / Math.pow(P_REF, n);

    const shape = spec.map((p) => {
      const v = p.bounds[0] + rnd() * (p.bounds[1] - p.bounds[0]);
      return p.integer ? Math.round(v) : v;
    });
    const dxf = kind === 'CustomDXF'
      ? dxfTables(outerRadius * (0.2 + 0.4 * rnd()), outerRadius, -0.6 + 1.8 * rnd())
      : undefined;

    const grain = grainFromShape(kind, length, outerRadius, shape, dxf);
    if (!grain) continue;

    const desc = describeGrain(grain, density, n);
    if (!(desc.ab0 > 0) || !(desc.web > 1e-6)) continue;

    // Same inversion the sampler performs: pick a pressure, get the Kn it
    // implies for THIS propellant, and size the throat from it.
    const pcTarget = 1.4e6 + 9.5e6 * rnd();
    const kn = (Math.pow(pcTarget, 1 - n) * C_D) / (density * a);
    if (!Number.isFinite(kn) || kn < 45 || kn > 1100) continue;
    const at = desc.ab0 / kn;
    if (desc.aport0 / at < MIN_PORT_TO_THROAT) continue;

    const d: RawDesign = {
      grain,
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

/** A representative, valid design of each geometry, for the cheap tests. */
const EXEMPLARS: Record<GrainKind, SurrogateGrain> = {
  BATES: { kind: 'BATES', length: 0.3, outer_radius: 0.05, inner_radius: 0.02 },
  Tubular: { kind: 'Tubular', length: 0.3, outer_radius: 0.05, inner_radius: 0.022 },
  Star: {
    kind: 'Star',
    length: 0.3,
    outer_radius: 0.05,
    valley_radius: 0.03,
    tip_radius: 0.012,
    num_points: 6,
  },
  RodAndTube: {
    kind: 'RodAndTube',
    length: 0.3,
    outer_radius: 0.05,
    rod_radius: 0.008,
    tube_inner_radius: 0.032,
  },
  MoonBurner: {
    kind: 'MoonBurner',
    length: 0.3,
    outer_radius: 0.05,
    core_radius: 0.016,
    offset: 0.012,
  },
  Finocyl: {
    kind: 'Finocyl',
    length: 0.3,
    outer_radius: 0.05,
    r_tube: 0.016,
    num_fins: 6,
    w_fin: 0.004,
    h_fin: 0.018,
  },
  CustomDXF: {
    kind: 'CustomDXF',
    length: 0.3,
    outer_radius: 0.05,
    ...dxfTables(0.018, 0.05, 0.5),
  },
};

const baseDesign = (grain: SurrogateGrain): RawDesign => ({
  grain,
  throat_diameter: 0.015,
  expansion_ratio: 4,
  a: 8.875e-5,
  n: 0.32,
  density: 1879,
});

// =========================================================================
describe('model artifact', () => {
  it('covers every grain geometry the app offers', () => {
    const info = surrogateInfo()!;
    // If a geometry is missing the tab would silently extrapolate for it.
    for (const kind of SURROGATE_GRAIN_KINDS) {
      expect(info.grainKinds, kind).toContain(kind);
    }
  });

  it('reports held-out metrics overall and per geometry', () => {
    const m = surrogateMetrics()!;
    for (const t of TARGETS) {
      expect(m[t], t).toBeDefined();
      expect(m[t].r2, `${t} R^2`).toBeGreaterThan(0.9);
      expect(m[t].coverage95, `${t} coverage`).toBeGreaterThan(85);
      expect(m[t].coverage95, `${t} coverage`).toBeLessThan(100);
    }

    const byKind = surrogateMetricsByKind()!;
    for (const kind of SURROGATE_GRAIN_KINDS) {
      expect(byKind[kind], `${kind} metrics`).toBeDefined();
      expect(byKind[kind].peak_pc.r2, `${kind} peak Pc R^2`).toBeGreaterThan(0.9);
    }
  });

  it('separates train, calibration and test rows', () => {
    const d = surrogateInfo()!.dataset as Record<string, number>;
    expect(Number(d.calibRows)).toBeGreaterThan(0);
    expect(Number(d.trainRows) + Number(d.calibRows) + Number(d.testRows))
      .toBeLessThanOrEqual(Number(d.totalRows));
  });

  it('trained on every geometry, not just the easy ones', () => {
    const byKind = surrogateInfo()!.dataset.byKind as Record<string, number>;
    for (const kind of SURROGATE_GRAIN_KINDS) {
      expect(byKind[kind] ?? 0, `${kind} sample count`).toBeGreaterThan(100);
    }
  });
});

// =========================================================================
describe('feature extraction', () => {
  it('finds the burnout web correctly for every geometry', () => {
    for (const kind of SURROGATE_GRAIN_KINDS) {
      const grain = grainFromConfig(EXEMPLARS[kind]);
      const web = burnoutWeb(grain);
      expect(web, `${kind} web`).toBeGreaterThan(0);
      // Burning just inside the web, none just past it: that is the definition.
      expect(grain.get_burning_area(web * 0.999), `${kind} burning before web`).toBeGreaterThan(0);
      expect(grain.get_burning_area(web * 1.001), `${kind} burnt out after web`).toBe(0);
    }
  });

  it('does not truncate an offset bore at the casing radius', () => {
    /*
     * Regression. A MoonBurner burns out at `outer + offset - core`, which
     * exceeds the casing radius whenever the bore is offset. Scanning only to
     * `outer_radius` returned that bound as the web -- understating it, and with
     * it the burn time, for the entire geometry. It cost MoonBurner burn-time
     * R^2 about 0.17 before it was found.
     */
    const g: SurrogateGrain = {
      kind: 'MoonBurner',
      length: 0.3,
      outer_radius: 0.05,
      core_radius: 0.012,
      offset: 0.03,
    };
    const web = burnoutWeb(grainFromConfig(g));
    expect(web).toBeGreaterThan(g.outer_radius);
    expect(web).toBeCloseTo(g.outer_radius + g.offset - g.core_radius, 3);
  });

  it('derives Kn, propellant mass and port area exactly from the grain', () => {
    const d = baseDesign(EXEMPLARS.BATES);
    const g = describeGrain(d.grain, d.density, d.n);
    const ab0 = 2 * Math.PI * 0.02 * 0.3 + 2 * Math.PI * (0.05 ** 2 - 0.02 ** 2);
    expect(g.ab0).toBeCloseTo(ab0, 9);
    expect(g.aport0).toBeCloseTo(Math.PI * 0.02 ** 2, 9);
    expect(g.web).toBeCloseTo(0.03, 6);
    // Propellant is the casing circle less the port, extruded -- a formula that
    // works for every geometry rather than one per kind.
    expect(g.propMass).toBeCloseTo((Math.PI * 0.05 ** 2 - Math.PI * 0.02 ** 2) * 0.3 * 1879, 6);
  });

  it('produces finite features for every geometry, including degenerate input', () => {
    for (const kind of SURROGATE_GRAIN_KINDS) {
      const x = expandDesign(baseDesign(EXEMPLARS[kind]));
      for (let i = 0; i < x.length; i++) {
        expect(Number.isFinite(x[i]), `${kind} feature ${i}`).toBe(true);
      }
    }
    // The UI calls this on every keystroke, including half-typed numbers.
    const broken = expandDesign({
      ...baseDesign(EXEMPLARS.BATES),
      throat_diameter: 0,
    });
    for (let i = 0; i < broken.length; i++) expect(Number.isFinite(broken[i])).toBe(true);
  });

  it('is a pure function -- no state carried between calls', () => {
    const d = baseDesign(EXEMPLARS.Star);
    const first = Array.from(expandDesign(d));
    expandDesign(baseDesign(EXEMPLARS.Finocyl));
    expect(Array.from(expandDesign(d))).toEqual(first);
  });

  it('tells progressive and regressive grains apart', () => {
    // The shape features exist to capture this. A grain whose area grows and one
    // whose area shrinks must not look alike to the model.
    const progressive = describeGrain(EXEMPLARS.BATES, 1879, 0.32);
    const regressive = describeGrain(
      { kind: 'CustomDXF', length: 0.3, outer_radius: 0.05, ...dxfTables(0.018, 0.05, -0.5) },
      1879,
      0.32
    );
    expect(progressive.abShape[progressive.abShape.length - 1]).toBeGreaterThan(
      regressive.abShape[regressive.abShape.length - 1]
    );
  });
});

// =========================================================================
describe('accuracy against fresh physics solves, per geometry', () => {
  const designs: Partial<Record<GrainKind, RawDesign[]>> = {};

  beforeAll(() => {
    let seed = 60321;
    for (const kind of SURROGATE_GRAIN_KINDS) {
      designs[kind] = designsOfKind(kind, 45, seed);
      seed += 7717;
    }
  }, 300_000);

  it('generated a usable held-out set for every geometry', () => {
    for (const kind of SURROGATE_GRAIN_KINDS) {
      expect(designs[kind]!.length, `${kind} sample count`).toBeGreaterThan(25);
    }
  });

  it('matches the real solver for every geometry', () => {
    console.log('\n  surrogate vs physics, fresh in-distribution designs:');
    const failures: string[] = [];
    for (const kind of SURROGATE_GRAIN_KINDS) {
      const ds = designs[kind]!;
      const pc = errorStats(ds, 'peak_pc');
      const it = errorStats(ds, 'total_impulse');
      const tb = errorStats(ds, 'burn_time');
      console.log(
        `    ${kind.padEnd(11)} n=${String(ds.length).padStart(3)}  ` +
          `Pc ${pc.r2.toFixed(4)}/${pc.mape.toFixed(2)}%  ` +
          `It ${it.r2.toFixed(4)}/${it.mape.toFixed(2)}%  ` +
          `tb ${tb.r2.toFixed(4)}/${tb.mape.toFixed(2)}%`
      );
      // Thresholds are deliberately per-geometry rather than on the average:
      // an aggregate would let one badly-served kind hide behind six good ones.
      if (pc.r2 < 0.9) failures.push(`${kind} peak Pc R2 ${pc.r2.toFixed(3)}`);
      if (pc.mape > 12) failures.push(`${kind} peak Pc MAPE ${pc.mape.toFixed(1)}%`);
      if (it.r2 < 0.9) failures.push(`${kind} impulse R2 ${it.r2.toFixed(3)}`);
      if (tb.mape > 20) failures.push(`${kind} burn time MAPE ${tb.mape.toFixed(1)}%`);
    }
    expect(failures, failures.join('; ')).toEqual([]);
  }, 300_000);

  it('keeps its 95% band honest for every geometry', () => {
    // The guardrail rests entirely on this. A band that under-covers is worse
    // than no band, because the UI offers it as grounds for trusting the number.
    const failures: string[] = [];
    for (const kind of SURROGATE_GRAIN_KINDS) {
      const c = coverageOf(designs[kind]!, 'peak_pc');
      console.log(`    ${kind.padEnd(11)} peak-Pc band covers ${c.toFixed(1)}%`);
      if (c < 80) failures.push(`${kind} coverage ${c.toFixed(1)}%`);
    }
    expect(failures, failures.join('; ')).toEqual([]);
  }, 300_000);

  it('is less accurate where it says it is less sure', () => {
    // The band has to be informative, not a constant.
    const all = SURROGATE_GRAIN_KINDS.flatMap((k) => designs[k]!);
    const rows = all.map((d) => {
      const truth = solve(d).peak_pc;
      const p = predict(d);
      return { band: p.relativeBand.peak_pc, err: Math.abs(p.mean.peak_pc - truth) / truth };
    });
    rows.sort((x, y) => x.band - y.band);
    const k = Math.max(5, Math.floor(rows.length / 10));
    const tight = rows.slice(0, k).reduce((s, r) => s + r.err, 0) / k;
    const loose = rows.slice(-k).reduce((s, r) => s + r.err, 0) / k;
    console.log(`    narrowest decile ${(tight * 100).toFixed(2)}% vs widest ${(loose * 100).toFixed(2)}%`);
    expect(loose).toBeGreaterThan(tight);
  }, 300_000);
});

// =========================================================================
describe('envelope guardrail', () => {
  it('accepts a representative design of each geometry', () => {
    for (const kind of SURROGATE_GRAIN_KINDS) {
      const d: RawDesign = {
        ...baseDesign(EXEMPLARS[kind]),
        throat_diameter: Math.sqrt(
          (4 * (describeGrain(EXEMPLARS[kind], 1879, 0.32).ab0 / 200)) / Math.PI
        ),
      };
      expect(checkEnvelope(d).inside, kind).toBe(true);
    }
  });

  it('rejects a design well outside anything sampled, and says which feature', () => {
    const out = checkEnvelope({
      ...baseDesign({ kind: 'BATES', length: 40, outer_radius: 0.05, inner_radius: 0.02 }),
    });
    expect(out.inside).toBe(false);
    expect(out.violations.length).toBeGreaterThan(0);
    for (const v of out.violations) {
      expect(v.max).toBeGreaterThan(v.min);
      expect(v.value < v.min || v.value > v.max || !Number.isFinite(v.value)).toBe(true);
    }
  });

  it('flags extrapolation on the prediction itself, not just via a side call', () => {
    // The UI reads `prediction.envelope`, so that path has to carry the flag.
    const d = baseDesign({ kind: 'BATES', length: 40, outer_radius: 0.05, inner_radius: 0.02 });
    expect(predict(d).envelope.inside).toBe(false);
  });
});

// =========================================================================
describe('inverse design refuses to exploit the surrogate', () => {
  /*
   * Optimising over an approximation finds its errors. Both guards here are
   * regressions for failures the search actually produced: a throat wider than
   * the bore it sat in, and designs that satisfied "impulse <= X" by never
   * choking and producing no thrust. Neither was caught by the input envelope
   * check, because every INPUT was in range.
   */
  const bounds = {
    length: [0.08, 1.1] as [number, number],
    outer_radius: [0.018, 0.09] as [number, number],
    throat_diameter: [0.003, 0.09] as [number, number],
    expansion_ratio: [1.0, 12.0] as [number, number],
  };
  const fixed = { a: 8.875e-5, n: 0.32, density: 1879 };

  for (const kind of SURROGATE_GRAIN_KINDS) {
    it(`${kind}: proposes only geometry a motor could have`, () => {
      const found = inverseDesign(bounds, { maxImpulse: 2500, maxPeakPc: 8e6 }, {
        fixed,
        kind,
        seedGrain: EXEMPLARS[kind],
        restarts: 6,
        seed: 991,
      });
      expect(found.length, `${kind} produced no candidates`).toBeGreaterThan(0);

      for (const c of found) {
        expect(c.design.grain.kind, 'kind preserved').toBe(kind);
        const desc = describeGrain(c.design.grain, c.design.density, c.design.n);
        const throatArea = (Math.PI / 4) * c.design.throat_diameter ** 2;
        // The port has to be able to feed the throat -- the sampler's own rule.
        expect(desc.aport0 / throatArea, `${kind} port/throat`).toBeGreaterThanOrEqual(
          MIN_PORT_TO_THROAT - 1e-9
        );
        expect(desc.ab0, `${kind} burning area`).toBeGreaterThan(0);
        expect(desc.web, `${kind} web`).toBeGreaterThan(0);
      }
    }, 120_000);
  }

  it('never proposes a design outside the trained output range', () => {
    for (const kind of SURROGATE_GRAIN_KINDS) {
      const found = inverseDesign(bounds, { maxImpulse: 2500, maxPeakPc: 8e6 }, {
        fixed,
        kind,
        seedGrain: EXEMPLARS[kind],
        restarts: 6,
        seed: 4242,
      });
      for (const c of found.filter((x) => x.penalty === 0)) {
        expect(c.predicted.peak_pc, `${kind} peak Pc`).toBeGreaterThanOrEqual(1.0e6);
        expect(c.predicted.peak_pc, `${kind} peak Pc`).toBeLessThanOrEqual(25e6);
      }
    }
  }, 300_000);

  it('produces a best candidate that survives a real solve', () => {
    const failures: string[] = [];
    for (const kind of SURROGATE_GRAIN_KINDS) {
      const found = inverseDesign(bounds, { maxImpulse: 2500, maxPeakPc: 8e6 }, {
        fixed,
        kind,
        seedGrain: EXEMPLARS[kind],
        restarts: 8,
        seed: 7,
      });
      const feasible = found.filter((c) => c.penalty === 0);
      if (!feasible.length) continue; // not every geometry can hit every target

      const best = feasible[0];
      const truth = solve(best.design);
      const err = Math.abs(truth.peak_pc - best.predicted.peak_pc) / truth.peak_pc;
      console.log(`    ${kind.padEnd(11)} best candidate verified ${(err * 100).toFixed(2)}% off on peak Pc`);
      // Ranking by the model's own confidence is supposed to make candidate 1
      // one the surrogate actually gets right.
      if (err > 0.2) failures.push(`${kind} ${(err * 100).toFixed(1)}% off`);
      if (!(truth.total_impulse > 0.4 * 2500)) failures.push(`${kind} produced no real impulse`);
    }
    expect(failures, failures.join('; ')).toEqual([]);
  }, 300_000);

  it('leaves a Custom DXF profile untouched -- there is no shape to optimise', () => {
    const seed = EXEMPLARS.CustomDXF as Extract<SurrogateGrain, { kind: 'CustomDXF' }>;
    const found = inverseDesign(bounds, { maxImpulse: 2500, maxPeakPc: 8e6 }, {
      fixed,
      kind: 'CustomDXF',
      seedGrain: seed,
      restarts: 4,
      seed: 5,
    });
    expect(GRAIN_SHAPE_PARAMS.CustomDXF).toEqual([]);
    for (const c of found) {
      const g = c.design.grain as Extract<SurrogateGrain, { kind: 'CustomDXF' }>;
      expect(g.perim_table).toEqual(seed.perim_table);
      expect(g.area_table).toEqual(seed.area_table);
    }
  }, 120_000);
});

// =========================================================================
describe('dispersion sweep', () => {
  it('centres on the nominal design and widens with sigma, for every geometry', () => {
    for (const kind of SURROGATE_GRAIN_KINDS) {
      const design = baseDesign(EXEMPLARS[kind]);
      const nominal = predictMeanOnly(design);
      const res = dispersionSweep(design, { sigma: 0.03, samples: 1500 }, TARGETS);
      for (const t of TARGETS) {
        expect(res[t].p05, `${kind} ${t}`).toBeLessThanOrEqual(res[t].p50);
        expect(res[t].p50, `${kind} ${t}`).toBeLessThanOrEqual(res[t].p95);
      }
      expect(Math.abs(res.peak_pc.p50 - nominal.peak_pc) / nominal.peak_pc, kind).toBeLessThan(0.15);

      const loose = dispersionSweep(design, { sigma: 0.08, samples: 1500 }, TARGETS);
      expect(loose.peak_pc.sd, kind).toBeGreaterThan(res.peak_pc.sd);
    }
  }, 120_000);

  it('is reproducible for a given seed', () => {
    const d = baseDesign(EXEMPLARS.Star);
    const a = dispersionSweep(d, { sigma: 0.03, samples: 400, seed: 5 }, TARGETS);
    const b = dispersionSweep(d, { sigma: 0.03, samples: 400, seed: 5 }, TARGETS);
    expect(a.peak_pc.mean).toBe(b.peak_pc.mean);
    expect(a.peak_pc.sd).toBe(b.peak_pc.sd);
  });

  it('agrees with the physics core on the dispersion it predicts', () => {
    // The claim the UI makes when it offers "confirm with N full solves".
    const design = baseDesign(EXEMPLARS.BATES);
    const sigma = 0.03;
    const surrogate = dispersionSweep(design, { sigma, samples: 3000, seed: 11 }, TARGETS);

    const rnd = rng(90210);
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
      `\n  dispersion: surrogate ${(surrogate.peak_pc.mean / 1e6).toFixed(3)} +- ` +
        `${(surrogate.peak_pc.sd / 1e6).toFixed(3)} MPa | physics ${(tMean / 1e6).toFixed(3)} +- ${(tSd / 1e6).toFixed(3)}`
    );
    expect(Math.abs(surrogate.peak_pc.mean - tMean) / tMean).toBeLessThan(0.08);
    // 120 solves gives sigma itself only ~6% precision, so this is loose by
    // necessity rather than by choice.
    expect(Math.abs(surrogate.peak_pc.sd - tSd) / tSd).toBeLessThan(0.4);
  }, 120_000);
});

// =========================================================================
describe('performance budget', () => {
  const design = baseDesign(EXEMPLARS.Star);

  it('predicts with uncertainty in well under 10 ms', () => {
    for (let i = 0; i < 20; i++) predict(design);
    const t0 = performance.now();
    const reps = 100;
    for (let i = 0; i < reps; i++) {
      predict({ ...design, throat_diameter: 0.012 + i * 0.00002 });
    }
    const per = (performance.now() - t0) / reps;
    console.log(`\n  predict (with variance): ${per.toFixed(3)} ms`);
    expect(per).toBeLessThan(10);
  });

  it('runs an interactive Monte Carlo inside a couple of seconds', () => {
    const t0 = performance.now();
    dispersionSweep(design, { sigma: 0.03, samples: 5000 }, TARGETS);
    const total = performance.now() - t0;
    console.log(`  5000-sample sweep: ${total.toFixed(0)} ms`);
    expect(total).toBeLessThan(4000);
  }, 60_000);

  it('agrees between the full and mean-only paths', () => {
    const full = predict(design).mean;
    const fast = predictMeanOnly(design);
    for (const t of TARGETS) {
      expect(Math.abs(full[t] - fast[t]) / Math.abs(full[t]), t).toBeLessThan(1e-12);
    }
  });
});
