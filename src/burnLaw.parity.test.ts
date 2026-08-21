import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { baseBurnRate, coefficientsAt } from './burnLaw';
import type { BurnRateRegime } from './wasmCore';

/*
 * ============================================================================
 * THE TS BURN-LAW MIRROR MUST NOT DRIFT FROM RUST
 * ============================================================================
 *
 * src/burnLaw.ts reimplements Propellant::coefficients_at so the app can
 * recover the erosive fraction from a simulation trace. A second
 * implementation of the same rule is precisely the hazard that made the
 * duplicated Lenoir-Robillard constants dangerous -- change one, and the two
 * disagree silently while both keep producing plausible numbers.
 *
 * The Rust core has no direct entry point for "evaluate the burn law", so this
 * probes it INDIRECTLY: a motor whose burn law differs between the two
 * implementations produces a different trace. Running the real solver at a
 * series of pressures and comparing against the mirror pins the rule at the
 * boundaries that matter -- inside a band, on a shared edge, and outside the
 * banded range in both directions.
 * ============================================================================
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const core = require(path.resolve(HERE, '../crates/burn-core/pkg-node/burn_core.js'));

/** Nakka's measured KNDX bands, as shipped. */
const KNDX_REGIMES: BurnRateRegime[] = [
  { from_pressure: 103000, to_pressure: 779000, a: 1.7156e-6, n: 0.619 },
  { from_pressure: 779000, to_pressure: 2570000, a: 8.5496e-3, n: -0.009 },
  { from_pressure: 2570000, to_pressure: 5930000, a: 2.8598e-7, n: 0.688 },
  { from_pressure: 5930000, to_pressure: 8500000, a: 1.329e-1, n: -0.148 },
  { from_pressure: 8500000, to_pressure: 11200000, a: 1.0652e-5, n: 0.442 },
];

const A = 8.377e-5;
const N = 0.3157;

/**
 * Recover the burn rate the Rust core actually used, by running a motor and
 * differentiating its web against time.
 *
 * A long, thick BATES grain with a generous port keeps mass flux low so no
 * erosive augmentation contaminates the measurement, and keeps the pressure
 * roughly steady so the recovered rate maps to a known pressure.
 */
function rateFromCore(regimes: BurnRateRegime[] | undefined, throat: number) {
  const L = 0.5;
  const Ro = 0.05;
  const Ri = 0.035;
  const out = core.simulate({
    propellant: {
      density: 1878,
      a: A,
      n: N,
      flame_temp: 1700,
      gamma: 1.14,
      molecular_weight: 0.042,
      ...(regimes ? { burn_rate_regimes: regimes } : {}),
    },
    grain: { kind: 'BATES', length: L, outer_radius: Ro, inner_radius: Ri },
    nozzle: { throat_diameter: throat, expansion_ratio: 6, material: null },
    options: { model: '0D', erosive_model: 'None' },
  });

  const NF = out.fields.length;
  const ix = (f: string) => out.fields.indexOf(f);
  const cT = ix('Time');
  const cY = ix('y');
  const cP = ix('Pc');

  /*
   * Every step of the trace, not one sampled point.
   *
   * A single sample was fragile: at high chamber pressure this grain is already
   * burned out by mid-trace, so dy/dt was zero and the comparison divided by it.
   * Walking the whole trace also makes the test stronger -- it checks agreement
   * at every pressure the motor passes through rather than at one.
   */
  const steps: Array<{ rate: number; pc: number }> = [];
  for (let i = 0; i + 1 < out.rows; i++) {
    const dt = out.data[(i + 1) * NF + cT] - out.data[i * NF + cT];
    const dy = out.data[(i + 1) * NF + cY] - out.data[i * NF + cY];
    if (dt <= 0 || dy <= 0) continue;
    const pc = (out.data[(i + 1) * NF + cP] + out.data[i * NF + cP]) / 2;
    if (pc <= 0) continue;
    steps.push({ rate: dy / dt, pc });
  }
  return steps;
}

/** Median relative disagreement between the mirror and the core, over a trace. */
function disagreement(
  steps: Array<{ rate: number; pc: number }>,
  regimes: BurnRateRegime[] | undefined
) {
  const errs = steps
    .map((s) => Math.abs(baseBurnRate(A, N, regimes, s.pc) - s.rate) / s.rate)
    .sort((a, b) => a - b);
  return { median: errs[Math.floor(errs.length / 2)], n: errs.length };
}

describe('the TypeScript mirror agrees with the Rust core', () => {
  it('reproduces the single power law', () => {
    for (const throat of [0.008, 0.011, 0.015, 0.02]) {
      const steps = rateFromCore(undefined, throat);
      expect(steps.length, 'no usable steps').toBeGreaterThan(20);
      const d = disagreement(steps, undefined);
      expect(d.median, `throat ${throat} m, ${d.n} steps`).toBeLessThan(0.02);
    }
  });

  it('reproduces the piecewise law across several bands', () => {
    /*
     * Different throats put the motor at different chamber pressures, which
     * lands it in different bands. If the mirror picked bands differently from
     * Rust -- an exclusive bound, a different sort, a different fallback -- the
     * rates would diverge by the several percent that separates adjacent bands.
     */
    const seen = new Set<number>();
    for (const throat of [0.008, 0.010, 0.012, 0.015, 0.018, 0.022]) {
      const steps = rateFromCore(KNDX_REGIMES, throat);
      expect(steps.length, 'no usable steps').toBeGreaterThan(20);
      for (const st of steps) {
        seen.add(KNDX_REGIMES.findIndex((r) => st.pc >= r.from_pressure && st.pc <= r.to_pressure));
      }
      const d = disagreement(steps, KNDX_REGIMES);
      expect(d.median, `throat ${throat} m, ${d.n} steps`).toBeLessThan(0.02);
    }
    // Only meaningful if the traces actually crossed more than one band.
    console.log(`
    bands exercised: ${[...seen].sort().join(', ')}`);
    expect(seen.size, 'all steps landed in the same band').toBeGreaterThan(2);
  });
});

describe('the band-selection rule itself', () => {
  it('treats both bounds as inclusive, resolving a shared edge to the lower band', () => {
    // Mirrors shared_boundaries_resolve_to_the_lower_band in propellant.rs.
    expect(coefficientsAt(A, N, KNDX_REGIMES, 779000).n).toBe(0.619);
    expect(coefficientsAt(A, N, KNDX_REGIMES, 2570000).n).toBe(-0.009);
  });

  it('extrapolates the nearest end band outside the range, not the fallback', () => {
    // Mirrors outside_the_range_extrapolates_the_nearest_band in propellant.rs.
    expect(coefficientsAt(A, N, KNDX_REGIMES, 1000).n).toBe(0.619);
    expect(coefficientsAt(A, N, KNDX_REGIMES, 5e7).n).toBe(0.442);
    expect(coefficientsAt(A, N, KNDX_REGIMES, 1000).a).not.toBe(A);
  });

  it('is continuous across the low edge of the banded range', () => {
    const inside = baseBurnRate(A, N, KNDX_REGIMES, 103000 + 1);
    const outside = baseBurnRate(A, N, KNDX_REGIMES, 103000 - 1);
    expect(Math.abs(inside - outside) / inside).toBeLessThan(1e-4);
  });

  it('falls back to the single law when no bands are configured', () => {
    expect(baseBurnRate(A, N, undefined, 5e6)).toBe(A * Math.pow(5e6, N));
    expect(baseBurnRate(A, N, [], 5e6)).toBe(A * Math.pow(5e6, N));
  });

  it('does not depend on the order bands are supplied in', () => {
    const shuffled = [...KNDX_REGIMES].reverse();
    for (const pc of [5e5, 1.5e6, 4e6, 7e6, 1e7]) {
      expect(baseBurnRate(A, N, shuffled, pc)).toBe(baseBurnRate(A, N, KNDX_REGIMES, pc));
    }
  });
});
