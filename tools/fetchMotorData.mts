/**
 * Fetch certified motor measurements from ThrustCurve.org.
 *
 *   npm run validation:fetch
 *
 * These are real static-fire measurements, certified by NAR / TRA / CAR, and
 * they are the closest thing to ground truth available for a solid motor tool.
 *
 * # What this data can and cannot validate
 *
 * ThrustCurve publishes what a certification stand measures: total impulse,
 * burn time, average and peak thrust, and propellant mass. It does NOT publish
 * what the solver needs as INPUT -- grain geometry, the St. Robert coefficients
 * `a` and `n`, throat diameter, expansion ratio. Those are manufacturer trade
 * secrets, and no amount of API querying will produce them.
 *
 * So this dataset cannot validate a predicted pressure trace: there is nothing
 * to feed the solver. What it CAN validate is the half of the model that does
 * not depend on grain geometry at all -- delivered specific impulse, which is
 * set by propellant thermochemistry and nozzle expansion. That is a real check
 * of c*, C_F, the isentropic relations, and the efficiency defaults, against
 * several hundred real motors.
 *
 * The output is committed so the validation suite runs offline and
 * deterministically. Re-fetch only to refresh it, and expect the numbers to
 * move slightly when certifications are updated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, 'data/thrustcurve-motors.json');
const API = 'https://www.thrustcurve.org/api/v1/search.json';

/** Impulse classes swept separately: the API caps results per query. */
const CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'];

interface Motor {
  motorId: string;
  manufacturer: string;
  designation: string;
  commonName: string;
  impulseClass: string;
  propInfo: string;
  type: string;
  diameter: number;
  length: number;
  totalWeightG: number;
  propWeightG: number;
  totImpulseNs: number;
  burnTimeS: number;
  avgThrustN: number;
  maxThrustN: number;
  certOrg: string;
}

const REQUIRED: Array<keyof Motor> = [
  'totImpulseNs',
  'burnTimeS',
  'propWeightG',
  'avgThrustN',
  'maxThrustN',
  'propInfo',
];

async function fetchClass(cls: string): Promise<Motor[]> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ impulseClass: cls, maxResults: 400 }),
  });
  if (!res.ok) throw new Error(`ThrustCurve ${cls}: HTTP ${res.status}`);
  const json = (await res.json()) as { results?: Motor[] };
  return json.results ?? [];
}

const all: Motor[] = [];
for (const cls of CLASSES) {
  try {
    const got = await fetchClass(cls);
    all.push(...got);
    process.stdout.write(`  class ${cls.padEnd(2)} ${String(got.length).padStart(4)} motors\n`);
  } catch (err) {
    console.error(`  class ${cls}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Keep only records complete enough to compute a delivered Isp from.
const usable = all.filter(
  (m) =>
    REQUIRED.every((k) => m[k] !== undefined && m[k] !== null) &&
    m.propWeightG > 0 &&
    m.totImpulseNs > 0 &&
    m.burnTimeS > 0
);

const seen = new Set<string>();
const motors = usable.filter((m) => {
  if (seen.has(m.motorId)) return false;
  seen.add(m.motorId);
  return true;
});

motors.sort((a, b) => a.totImpulseNs - b.totImpulseNs);

const payload = {
  source: 'https://www.thrustcurve.org/api/v1/search.json',
  sourceNote:
    'Certified static-fire measurements published by ThrustCurve.org (NAR / TRA / CAR certification data).',
  fetchedAt: new Date().toISOString(),
  query: { impulseClass: CLASSES, maxResults: 400 },
  fetched: all.length,
  usable: motors.length,
  fields: REQUIRED,
  motors: motors.map((m) => ({
    motorId: m.motorId,
    manufacturer: m.manufacturer,
    designation: m.designation,
    commonName: m.commonName,
    impulseClass: m.impulseClass,
    propInfo: m.propInfo,
    type: m.type,
    diameterMm: m.diameter,
    lengthMm: m.length,
    propWeightG: m.propWeightG,
    totImpulseNs: m.totImpulseNs,
    burnTimeS: m.burnTimeS,
    avgThrustN: m.avgThrustN,
    maxThrustN: m.maxThrustN,
    certOrg: m.certOrg,
  })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
console.log(
  `\nfetched ${all.length}, kept ${motors.length} with complete measurements` +
    `\nwrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} kB)`
);

// A quick look at what the measurements imply, so a refresh that breaks
// something is visible at fetch time rather than in a failing test later.
const byProp = new Map<string, number[]>();
for (const m of motors) {
  const isp = m.totImpulseNs / ((m.propWeightG / 1000) * 9.80665);
  const key = m.propInfo || 'unknown';
  if (!byProp.has(key)) byProp.set(key, []);
  byProp.get(key)!.push(isp);
}
console.log('\nmeasured delivered Isp by propellant (n >= 8):');
[...byProp.entries()]
  .filter(([, v]) => v.length >= 8)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 14)
  .forEach(([name, v]) => {
    const s = [...v].sort((x, y) => x - y);
    const med = s[Math.floor(s.length / 2)];
    console.log(
      `  ${name.slice(0, 26).padEnd(27)} n=${String(v.length).padStart(4)}  ` +
        `median ${med.toFixed(1)} s   range ${s[0].toFixed(0)}-${s[s.length - 1].toFixed(0)}`
    );
  });
