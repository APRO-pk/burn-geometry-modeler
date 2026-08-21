/**
 * Extract Richard Nakka's measured strand-burner data into a fixture.
 *
 *   npx tsx tools/extractNakkaBurnRate.mts <ds_burn.txt>
 *
 * Source: "Effect of Chamber Pressure on Burning Rate for the Potassium
 * Nitrate - Dextrose and Potassium Nitrate - Sorbitol Rocket Propellants",
 * R. Nakka, June 1999, Issue 1. Tables 2 and 3 carry the raw measurements;
 * Tables 4 and 5 carry the piecewise fits Nakka derived from them.
 *
 * The numbers are PARSED, never typed. Hand-transcribing a measurement is
 * exactly where a validation fixture silently acquires a digit nobody measured,
 * and the entire value of validating against real data is that the data is real.
 * Re-running this against the source regenerates the fixture identically.
 *
 * The source PDF is Nakka's work and is not redistributed here -- only the
 * measured values, with attribution. Convert it first:
 *
 *   pdftotext -layout ds_burn.pdf ds_burn.txt
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, 'data/nakka-strand-burner.json');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error(
    'usage: npx tsx tools/extractNakkaBurnRate.mts <ds_burn.txt>\n' +
      '  produce it with:  pdftotext -layout ds_burn.pdf ds_burn.txt'
  );
  process.exit(1);
}
const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);

const PSI_TO_MPA = 0.00689476;

/**
 * Rows of Tables 2 and 3: psig, psia, MPa(abs), cm/s, in/s.
 *
 * Rows are matched on their SHAPE -- five numbers that are consistent unit
 * conversions of one another -- rather than on line offsets, which would break
 * the moment the source is re-paginated. A line that does not survive its own
 * conversions is not a data row.
 *
 * Anchoring took three attempts, each wrong in a way worth recording:
 *   - the propellant name matched its first mention in the introduction, pages
 *     before any data;
 *   - "Table 2 " matched the prose "In Table 2 and Table 3, the results are
 *     reproduced...", which also precedes the tables;
 *   - a fixed lookback let the Sorbitol scan reach back into the Dextrose table
 *     and return both sets as one.
 * Hence: a caption fragment unique to the table, scanned backwards, stopped at
 * whatever caption precedes it.
 */
function parseMeasurements(caption: string) {
  const end = lines.findIndex((l) => l.includes(caption));
  if (end < 0) throw new Error('could not find caption: ' + caption);

  const rows: Array<{ pressureMPa: number; burnRateCmS: number }> = [];
  for (let i = end - 1; i >= 0 && i > end - 40; i--) {
    const line = lines[i];
    if (/Table\s+\d/.test(line)) break; // the previous caption bounds this table

    const nums = (line.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (nums.length !== 5) continue;
    const [psig, psia, mpa, cms, ins] = nums;

    if (!(Math.abs(psia - (psig + 14.7)) < 1.5)) continue;
    if (!(Math.abs(mpa - psia * PSI_TO_MPA) < 0.02)) continue;
    if (!(Math.abs(ins - cms / 2.54) < 0.005)) continue;

    rows.unshift({ pressureMPa: mpa, burnRateCmS: cms });
  }
  return rows;
}

/** Rows of Tables 4 and 5: the piecewise fits, SI half (MPa, mm/s). */
function parseRegimes(caption: string) {
  const end = lines.findIndex((l) => l.includes(caption));
  if (end < 0) throw new Error('could not find caption: ' + caption);

  const rows: Array<{ fromMPa: number; toMPa: number; a: number; n: number }> = [];
  for (let i = end - 1; i >= 0 && i > end - 14; i--) {
    const nums = (lines[i].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    // psiFrom, psiTo, a_imperial, n_imperial, mpaFrom, mpaTo, a_si, n_si
    if (nums.length !== 8) continue;
    const [psiFrom, psiTo, , nImp, mpaFrom, mpaTo, aSi, nSi] = nums;
    if (!(Math.abs(mpaFrom - psiFrom * PSI_TO_MPA) < 0.02)) continue;
    if (!(Math.abs(mpaTo - psiTo * PSI_TO_MPA) < 0.02)) continue;
    // The exponent is dimensionless, so both unit systems must agree on it.
    if (Math.abs(nImp - nSi) > 1e-9) continue;
    rows.unshift({ fromMPa: mpaFrom, toMPa: mpaTo, a: aSi, n: nSi });
  }
  return rows;
}

const dextrose = parseMeasurements('Experimental results for KN-Dextrose');
const sorbitol = parseMeasurements('Experimental results for KN-Sorbitol');
const dextroseFits = parseRegimes('Table 4');
const sorbitolFits = parseRegimes('Table 5');

for (const [name, m, f] of [
  ['KN-Dextrose', dextrose, dextroseFits],
  ['KN-Sorbitol', sorbitol, sorbitolFits],
] as const) {
  if (m.length < 10) throw new Error(name + ': only ' + m.length + ' measurements parsed');
  if (f.length !== 5) throw new Error(name + ': expected 5 fitted regimes, got ' + f.length);
}

const payload = {
  source: {
    title:
      'Effect of Chamber Pressure on Burning Rate for the Potassium Nitrate - Dextrose ' +
      'and Potassium Nitrate - Sorbitol Rocket Propellants',
    author: 'Richard Nakka',
    date: '1999-06',
    issue: 1,
    site: 'https://www.nakka-rocketry.net/',
    file: path.basename(src),
    tables: 'Tables 2 and 3 (measurements), Tables 4 and 5 (piecewise fits)',
  },
  method: {
    apparatus: 'Strand burner',
    oxidiserFuelRatio: '65/35',
    note:
      'Strand burner, not motor firings. These are burn RATES at controlled vessel ' +
      'pressure, so they validate the burn-rate law directly but carry no grain ' +
      'geometry, thrust, or motor pressure trace.',
    erosiveBurning:
      'Nakka notes these results exclude erosive burning, which he reports as ' +
      'insignificant above a port-to-throat area ratio of about 6.',
  },
  units: {
    pressure: 'MPa absolute',
    burnRate: 'cm/s',
    fitA: 'mm/s at 1 MPa',
    fitN: 'dimensionless',
  },
  extractedAt: new Date().toISOString(),
  propellants: {
    'KN-Dextrose': { measurements: dextrose, nakkaFits: dextroseFits },
    'KN-Sorbitol': { measurements: sorbitol, nakkaFits: sorbitolFits },
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));

console.log('parsed measurements (MPa -> cm/s) -- check these against the source tables:');
for (const [name, set] of [
  ['KN-Dextrose', dextrose],
  ['KN-Sorbitol', sorbitol],
] as const) {
  console.log('\n  ' + name + ' (' + set.length + ' points)');
  for (const r of set) {
    console.log('    ' + String(r.pressureMPa).padStart(7) + '  ' + r.burnRateCmS);
  }
}
console.log('\nfitted regimes (MPa range -> a mm/s, n):');
for (const [name, set] of [
  ['KN-Dextrose', dextroseFits],
  ['KN-Sorbitol', sorbitolFits],
] as const) {
  console.log('  ' + name);
  for (const r of set) {
    console.log('    ' + r.fromMPa + ' - ' + r.toMPa + '  a=' + r.a + '  n=' + r.n);
  }
}
console.log('\nwrote ' + path.relative(process.cwd(), OUT));
