/**
 * Sample the 0-D physics core across the design space and write a CSV dataset.
 *
 *   npm run surrogate:sample -- --n 4000 --seed 1 --out tools/data/samples.csv
 *
 * The physics core is ground truth; this just runs it a lot. Every row is one
 * full RK4 burn through crates/burn-core, so the dataset inherits exactly the
 * behaviour the app ships -- there is no separate "training physics" that could
 * drift from what the verify button runs.
 *
 * CSV rather than parquet on purpose: a few thousand rows is a ~1 MB text file
 * that diffs, greps and loads without a dependency. Parquet would buy nothing
 * here and would add a native module to the toolchain.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACCEPTANCE,
  FEATURES,
  FIXED_PROPELLANT,
  P_REF,
  SAMPLING_RANGES,
  TARGETS,
  dischargeCoefficient,
  latinHypercube,
  lerp,
  mulberry32,
} from './designSpace.mts';
import type { SampleRow } from './designSpace.mts';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const core = require(path.resolve(HERE, '../crates/burn-core/pkg-node/burn_core.js'));
const C_D = dischargeCoefficient();

// --- args ------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const N = parseInt(arg('n', '4000'), 10);
const SEED = parseInt(arg('seed', '1'), 10);
const OUT = path.resolve(HERE, '..', arg('out', 'tools/data/samples.csv'));

// --- one run ---------------------------------------------------------------

interface Rejection {
  reason: string;
}

function runOne(u: number[]): SampleRow | Rejection {
  const length = lerp(u[0], SAMPLING_RANGES.length);
  const outer_radius = lerp(u[1], SAMPLING_RANGES.outer_radius);
  const web_fraction = lerp(u[2], SAMPLING_RANGES.web_fraction);
  const expansion_ratio = lerp(u[4], SAMPLING_RANGES.expansion_ratio);
  const burn_rate_at_ref = lerp(u[5], SAMPLING_RANGES.burn_rate_at_ref);
  const n = lerp(u[6], SAMPLING_RANGES.n);
  const density = lerp(u[7], SAMPLING_RANGES.density);

  // St. Robert coefficient from the reference burn rate: r_b = a * Pc^n.
  const a = burn_rate_at_ref / Math.pow(P_REF, n);

  const inner_radius = outer_radius * (1 - web_fraction);
  const r = inner_radius;
  const ab0 = 2 * Math.PI * r * length + 2 * Math.PI * (outer_radius ** 2 - r ** 2);

  /*
   * Kn is drawn CONDITIONALLY on the propellant, not from a fixed box.
   *
   * Chamber pressure and Kn are locked together by
   *   Pc_eq = ((rho a / C_D) Kn)^(1/(1-n))
   * so once (a, n, rho) are drawn, only a narrow Kn window lands at a sane
   * pressure -- and the window MOVES with the propellant. A fixed box for
   * either variable therefore wastes most of its draws, and not uniformly: it
   * throws away whole regions of (a, n), leaving the surrogate blind exactly
   * where the pressure exponent matters most.
   *
   * So: invert the relation at both ends of the target pressure band to get the
   * feasible Kn window for THIS propellant, intersect it with what a designer
   * would build, and place the draw inside that. The other seven axes keep
   * their Latin Hypercube stratification; only this one is remapped.
   */
  const knAt = (pc: number) => (Math.pow(pc, 1 - n) * C_D) / (density * a);
  const knLo = Math.max(knAt(SAMPLING_RANGES.pc_target[0]), ACCEPTANCE.kn[0]);
  const knHi = Math.min(knAt(SAMPLING_RANGES.pc_target[1]), ACCEPTANCE.kn[1]);
  if (!(knHi > knLo)) return { reason: 'no feasible Kn for this propellant' };

  // Geometric mean interpolation: Kn spans decades, so a log-uniform draw keeps
  // the low-Kn end from being swamped.
  const kn_derived = knLo * Math.pow(knHi / knLo, u[3]);
  const pc_target = Math.pow((density * a * kn_derived) / C_D, 1 / (1 - n));

  const at = ab0 / kn_derived;
  const throat_diameter = Math.sqrt((4 * at) / Math.PI);

  // The throat has to fit inside, and be fed by, the port.
  const portArea = Math.PI * r * r;
  if (portArea / at < ACCEPTANCE.min_port_to_throat) {
    return { reason: 'port cannot feed throat' };
  }

  let out: { fields: string[]; rows: number; data: Float64Array; warnings: string[] };
  try {
    out = core.simulate({
      propellant: { density, a, n, ...FIXED_PROPELLANT },
      grain: { kind: 'BATES', length, outer_radius, inner_radius },
      nozzle: { throat_diameter, expansion_ratio, material: null },
      options: { model: '0D' },
    });
  } catch (err) {
    return { reason: `solver threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (out.rows < ACCEPTANCE.min_rows) return { reason: 'too few steps' };
  if (out.warnings.some((w) => /diverged/.test(w))) return { reason: 'diverged' };

  const NF = out.fields.length;
  const col = (name: string) => out.fields.indexOf(name);
  const cTime = col('Time');
  const cPc = col('Pc');
  const cThrust = col('Thrust');
  const cAb = col('Ab');
  const cAt = col('ThroatArea');

  let peak_pc = -Infinity;
  let max_kn = -Infinity;
  let total_impulse = 0;
  for (let i = 0; i < out.rows; i++) {
    const b = i * NF;
    peak_pc = Math.max(peak_pc, out.data[b + cPc]);
    const kn = out.data[b + cAb] / out.data[b + cAt];
    if (Number.isFinite(kn)) max_kn = Math.max(max_kn, kn);
    if (i > 0) {
      const pb = (i - 1) * NF;
      total_impulse +=
        ((out.data[b + cThrust] + out.data[pb + cThrust]) / 2) *
        (out.data[b + cTime] - out.data[pb + cTime]);
    }
  }
  const burn_time = out.data[(out.rows - 1) * NF + cTime];

  const propMass = Math.PI * (outer_radius ** 2 - inner_radius ** 2) * length * density;
  const isp = total_impulse / (propMass * 9.80665);

  for (const [key, value] of [
    ['peak_pc', peak_pc],
    ['total_impulse', total_impulse],
    ['isp', isp],
    ['burn_time', burn_time],
  ] as Array<[keyof typeof ACCEPTANCE, number]>) {
    const range = ACCEPTANCE[key] as unknown as readonly [number, number];
    if (!Number.isFinite(value)) return { reason: `${key} not finite` };
    if (value < range[0] || value > range[1]) return { reason: `${key} out of range` };
  }

  return {
    length,
    outer_radius,
    inner_radius,
    throat_diameter,
    expansion_ratio,
    a,
    n,
    density,
    pc_target,
    kn_derived,
    web_fraction,
    peak_pc,
    total_impulse,
    isp,
    max_kn,
    burn_time,
  };
}

// --- sweep -----------------------------------------------------------------

console.log(`burn-core ${core.version()} | LHS n=${N} seed=${SEED}`);
const rand = mulberry32(SEED);
const cube = latinHypercube(N, 8, rand);

const rows: SampleRow[] = [];
const rejects = new Map<string, number>();
const t0 = Date.now();

for (let i = 0; i < N; i++) {
  const res = runOne(cube[i]);
  if ('reason' in res) {
    const reason = String((res as Rejection).reason);
    rejects.set(reason, (rejects.get(reason) ?? 0) + 1);
  } else {
    rows.push(res);
  }
  if ((i + 1) % 500 === 0) {
    process.stdout.write(`  ${i + 1}/${N} sampled, ${rows.length} accepted\r`);
  }
}
const elapsed = (Date.now() - t0) / 1000;

console.log(`\n${rows.length}/${N} accepted (${((100 * rows.length) / N).toFixed(1)}%) in ${elapsed.toFixed(1)}s`);
if (rejects.size) {
  console.log('rejections:');
  for (const [reason, count] of [...rejects].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }
}

if (!rows.length) {
  console.error('No accepted samples -- check the ranges in tools/designSpace.mts.');
  process.exit(1);
}

// --- report the feature envelope, which is what the guardrail uses ----------

console.log('\nfeature envelope (accepted rows):');
for (const f of FEATURES) {
  const vals = rows.map((r) => r[f]);
  console.log(
    `  ${f.padEnd(16)} [${Math.min(...vals).toPrecision(4)}, ${Math.max(...vals).toPrecision(4)}]`
  );
}
console.log('target ranges:');
for (const t of TARGETS) {
  const vals = rows.map((r) => r[t]);
  console.log(
    `  ${t.padEnd(16)} [${Math.min(...vals).toPrecision(4)}, ${Math.max(...vals).toPrecision(4)}]`
  );
}

// --- write -----------------------------------------------------------------

const header = [...FEATURES, ...TARGETS, 'pc_target', 'kn_derived', 'web_fraction'];
const lines = [header.join(',')];
for (const r of rows) {
  lines.push(header.map((h) => (r as Record<string, number>)[h].toPrecision(10)).join(','));
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`\nwrote ${rows.length} rows -> ${path.relative(process.cwd(), OUT)}`);
