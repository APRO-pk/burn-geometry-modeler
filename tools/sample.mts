/**
 * Sample the 0-D physics core across every grain geometry and write a CSV.
 *
 *   npm run surrogate:sample -- --n 12000 --seed 1
 *
 * The physics core is ground truth; this just runs it a lot. Every row is one
 * full RK4 burn through crates/burn-core, so the dataset inherits exactly the
 * behaviour the app ships -- there is no separate "training physics" that could
 * drift from what the verify button runs.
 *
 * Draws are spread evenly across the seven geometries. That is the point of the
 * exercise: the model's features describe burn-back CURVES rather than grain
 * parameters, so what it needs to see is the variety of curves the geometries
 * actually produce -- a progressive BATES teaches it nothing about a regressive
 * Rod & Tube or a Finocyl's slotted transition.
 *
 * The grain itself is not written to the CSV. The trainer re-derives features
 * from the geometry, so the file stores the design parameters plus a compact
 * grain spec (JSON) that reconstructs it exactly.
 *
 * CSV rather than parquet on purpose: a few thousand rows is a text file that
 * diffs, greps and loads without a dependency.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACCEPTANCE,
  COMMON_RANGES,
  FIXED_PROPELLANT,
  MAX_SHAPE_DIMS,
  P_REF,
  SAMPLED_KINDS,
  TARGETS,
  buildGrain,
  dischargeCoefficient,
  latinHypercube,
  lerp,
  mulberry32,
} from './designSpace.mts';
import type { GrainKind, SurrogateGrain } from './designSpace.mts';
import { describeGrain } from '../src/surrogate/features.ts';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const core = require(path.resolve(HERE, '../crates/burn-core/pkg-node/burn_core.js'));
const C_D = dischargeCoefficient();

// --- args ------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const N = parseInt(arg('n', '12000'), 10);
const SEED = parseInt(arg('seed', '1'), 10);
const OUT = path.resolve(HERE, '..', arg('out', 'tools/data/samples.csv'));

interface Row {
  grain_kind: GrainKind;
  grain: SurrogateGrain;
  length: number;
  outer_radius: number;
  throat_diameter: number;
  expansion_ratio: number;
  a: number;
  n: number;
  density: number;
  peak_pc: number;
  total_impulse: number;
  isp: number;
  max_kn: number;
  burn_time: number;
}

interface Rejection {
  reason: string;
}

function runOne(kind: GrainKind, u: number[]): Row | Rejection {
  const length = lerp(u[0], COMMON_RANGES.length);
  const outer_radius = lerp(u[1], COMMON_RANGES.outer_radius);
  const expansion_ratio = lerp(u[2], COMMON_RANGES.expansion_ratio);
  const burnRateRef = lerp(u[3], COMMON_RANGES.burn_rate_at_ref);
  const n = lerp(u[4], COMMON_RANGES.n);
  const density = lerp(u[5], COMMON_RANGES.density);
  const a = burnRateRef / Math.pow(P_REF, n);

  const grain = buildGrain(kind, length, outer_radius, u.slice(7));
  if (!grain) return { reason: `${kind}: impossible shape draw` };

  // Ab(0) and A_port(0) come from the same geometry classes the features use,
  // which the parity tests prove bit-exact against the Rust solver.
  const desc = describeGrain(grain, density, n);
  if (!(desc.ab0 > 0)) return { reason: `${kind}: no burning area at ignition` };
  if (!(desc.web > 1e-6)) return { reason: `${kind}: no web to burn` };

  /*
   * Kn is drawn CONDITIONALLY on the propellant, not from a fixed box.
   *
   * Chamber pressure and Kn are locked together by
   *   Pc_eq = ((rho a / C_D) Kn)^(1/(1-n))
   * so once the propellant is drawn, only a narrow Kn window lands at a sane
   * pressure -- and the window MOVES with the propellant. A fixed box for
   * either wastes most of its draws, and not uniformly: it discards whole
   * regions of (a, n), leaving the surrogate blind exactly where the pressure
   * exponent matters most.
   */
  const knAt = (pc: number) => (Math.pow(pc, 1 - n) * C_D) / (density * a);
  const knLo = Math.max(knAt(COMMON_RANGES.pc_target[0]), ACCEPTANCE.kn[0]);
  const knHi = Math.min(knAt(COMMON_RANGES.pc_target[1]), ACCEPTANCE.kn[1]);
  if (!(knHi > knLo)) return { reason: 'no feasible Kn for this propellant' };

  // Log-uniform: Kn spans decades, so this keeps the low end from being swamped.
  const kn = knLo * Math.pow(knHi / knLo, u[6]);
  const at = desc.ab0 / kn;
  const throat_diameter = Math.sqrt((4 * at) / Math.PI);
  if (desc.aport0 / at < ACCEPTANCE.min_port_to_throat) {
    return { reason: 'port cannot feed throat' };
  }

  let out: { fields: string[]; rows: number; data: Float64Array; warnings: string[] };
  try {
    out = core.simulate({
      propellant: { density, a, n, ...FIXED_PROPELLANT },
      grain,
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
    const knNow = out.data[b + cAb] / out.data[b + cAt];
    if (Number.isFinite(knNow)) max_kn = Math.max(max_kn, knNow);
    if (i > 0) {
      const pb = (i - 1) * NF;
      total_impulse +=
        ((out.data[b + cThrust] + out.data[pb + cThrust]) / 2) *
        (out.data[b + cTime] - out.data[pb + cTime]);
    }
  }
  const burn_time = out.data[(out.rows - 1) * NF + cTime];
  const isp = total_impulse / (Math.max(desc.propMass, 1e-9) * 9.80665);

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
    grain_kind: kind,
    grain,
    length,
    outer_radius,
    throat_diameter,
    expansion_ratio,
    a,
    n,
    density,
    peak_pc,
    total_impulse,
    isp,
    max_kn,
    burn_time,
  };
}

// --- sweep -----------------------------------------------------------------

console.log(`burn-core ${core.version()} | LHS n=${N} seed=${SEED} over ${SAMPLED_KINDS.length} geometries`);
const rand = mulberry32(SEED);
const perKind = Math.ceil(N / SAMPLED_KINDS.length);
const DIMS = 7 + MAX_SHAPE_DIMS;

const rows: Row[] = [];
const rejects = new Map<string, number>();
const acceptedByKind = new Map<GrainKind, number>();
const t0 = Date.now();

for (const kind of SAMPLED_KINDS) {
  // A fresh Latin Hypercube per geometry, so each gets full stratified coverage
  // of its own shape axes rather than a slice of one shared cube.
  const cube = latinHypercube(perKind, DIMS, rand);
  for (let i = 0; i < perKind; i++) {
    const res = runOne(kind, cube[i]);
    if ('reason' in res) {
      const reason = String((res as Rejection).reason);
      rejects.set(reason, (rejects.get(reason) ?? 0) + 1);
    } else {
      rows.push(res);
      acceptedByKind.set(kind, (acceptedByKind.get(kind) ?? 0) + 1);
    }
  }
  process.stdout.write(
    `  ${kind.padEnd(11)} ${String(acceptedByKind.get(kind) ?? 0).padStart(5)}/${perKind} accepted\n`
  );
}
const elapsed = (Date.now() - t0) / 1000;

console.log(`\n${rows.length}/${N} accepted (${((100 * rows.length) / N).toFixed(1)}%) in ${elapsed.toFixed(1)}s`);
if (rejects.size) {
  console.log('rejections:');
  for (const [reason, count] of [...rejects].sort((x, y) => y[1] - x[1]).slice(0, 12)) {
    console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }
}

if (!rows.length) {
  console.error('No accepted samples -- check the ranges in tools/designSpace.mts.');
  process.exit(1);
}

console.log('\ntarget ranges (all geometries):');
for (const t of TARGETS) {
  const vals = rows.map((r) => r[t]);
  console.log(
    `  ${t.padEnd(16)} [${Math.min(...vals).toPrecision(4)}, ${Math.max(...vals).toPrecision(4)}]`
  );
}

// --- write -----------------------------------------------------------------

const header = [
  'grain_kind',
  'length',
  'outer_radius',
  'throat_diameter',
  'expansion_ratio',
  'a',
  'n',
  'density',
  ...TARGETS,
  'grain_json',
];
const lines = [header.join(',')];
for (const r of rows) {
  const numeric = [
    r.length,
    r.outer_radius,
    r.throat_diameter,
    r.expansion_ratio,
    r.a,
    r.n,
    r.density,
    ...TARGETS.map((t) => r[t]),
  ].map((v) => v.toPrecision(10));
  // The grain spec is quoted JSON: it reconstructs the geometry exactly, which
  // matters for Custom DXF whose tables cannot be summarised by a few columns.
  const json = JSON.stringify(r.grain).replace(/"/g, '""');
  lines.push(`${r.grain_kind},${numeric.join(',')},"${json}"`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`\nwrote ${rows.length} rows -> ${path.relative(process.cwd(), OUT)}`);
