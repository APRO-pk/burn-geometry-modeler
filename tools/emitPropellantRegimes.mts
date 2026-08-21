/**
 * Emit the TypeScript propellant-library entries implied by Nakka's measured
 * data, so the numbers in src/AppDesktop.tsx are derived rather than typed.
 *
 *   npx tsx tools/emitPropellantRegimes.mts
 *
 * Two things are produced per propellant:
 *
 *   burnRateRegimes  Nakka's five published bands, converted to the solver's
 *                    SI convention.
 *   a, n             the best single power law over the same measurements, used
 *                    as the fallback outside the banded range and by consumers
 *                    that need one representative pair (the surrogate).
 *
 * Unit conversion, done here rather than by hand:
 *
 *   Nakka:   r [mm/s] = a_N * P[MPa]^n
 *   solver:  r [m/s]  = a_SI * P[Pa]^n
 *   =>       a_SI = (a_N / 1000) * 10^(-6n)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, 'data/nakka-strand-burner.json');

interface Measurement {
  pressureMPa: number;
  burnRateCmS: number;
}
interface Fit {
  fromMPa: number;
  toMPa: number;
  a: number;
  n: number;
}

const d = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
  propellants: Record<string, { measurements: Measurement[]; nakkaFits: Fit[] }>;
};

/** Nakka's (mm/s at 1 MPa) -> the solver's (m/s at 1 Pa). */
const toSI = (aNakka: number, n: number) => (aNakka / 1000) * Math.pow(10, -6 * n);

/** Least squares on log r = log a + n log P, over the motor operating range. */
function bestSinglePowerLaw(pts: Measurement[]) {
  const X = pts.map((p) => Math.log(p.pressureMPa * 1e6));
  const Y = pts.map((p) => Math.log(p.burnRateCmS / 100));
  const mx = X.reduce((s, v) => s + v, 0) / X.length;
  const my = Y.reduce((s, v) => s + v, 0) / Y.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < X.length; i++) {
    num += (X[i] - mx) * (Y[i] - my);
    den += (X[i] - mx) ** 2;
  }
  const n = num / den;
  return { a: Math.exp(my - n * mx), n };
}

const sig = (v: number, digits = 4) => Number(v.toPrecision(digits));

for (const [name, set] of Object.entries(d.propellants)) {
  const operating = set.measurements.filter((m) => m.pressureMPa >= 1.0);
  const best = bestSinglePowerLaw(operating);

  console.log(`\n// ${name} -- Nakka 1999 strand burner, 65/35 O/F`);
  console.log(`a: ${sig(best.a).toExponential(4)}, n: ${sig(best.n, 4)},`);
  console.log('burnRateRegimes: [');
  for (const f of set.nakkaFits) {
    const aSI = toSI(f.a, f.n);
    console.log(
      `  { from_pressure: ${sig(f.fromMPa * 1e6, 6)}, to_pressure: ${sig(f.toMPa * 1e6, 6)}, ` +
        `a: ${aSI.toExponential(4)}, n: ${f.n} },`
    );
  }
  console.log('],');

  // Show what each form achieves, so the choice is visible at the point of use.
  const err = (fn: (p: number) => number) => {
    let s = 0;
    for (const m of operating) {
      const measured = m.burnRateCmS / 100;
      s += Math.abs((fn(m.pressureMPa) - measured) / measured);
    }
    return (100 * s) / operating.length;
  };
  const single = err((pMPa) => best.a * Math.pow(pMPa * 1e6, best.n));
  const piece = err((pMPa) => {
    const f =
      set.nakkaFits.find((r) => pMPa >= r.fromMPa && pMPa <= r.toMPa) ??
      set.nakkaFits[set.nakkaFits.length - 1];
    return toSI(f.a, f.n) * Math.pow(pMPa * 1e6, f.n);
  });
  console.log(
    `// mean |err| over ${operating.length} measurements >= 1 MPa: ` +
      `single law ${single.toFixed(1)}%, piecewise ${piece.toFixed(1)}%`
  );
}
