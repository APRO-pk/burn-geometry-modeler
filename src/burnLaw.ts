import type { BurnRateRegime } from './wasmCore';

/**
 * TypeScript mirror of `Propellant::coefficients_at` / `base_burn_rate` in
 * crates/burn-core/src/propellant.rs.
 *
 * WHY A MIRROR EXISTS AT ALL
 *
 * The solver does not output burn rate, so the app cannot read it back. It can
 * however recover the ACTUAL rate as dy/dt from the web and time columns, and
 * dividing that by the base (non-erosive) rate gives the erosive augmentation
 * as a fraction -- which is what the model-uncertainty panel needs in order to
 * scale erosive uncertainty to the motor in front of you instead of applying a
 * blanket figure.
 *
 * Computing the base rate requires evaluating the burn law here.
 *
 * A duplicated implementation is exactly the hazard that made the two
 * Lenoir-Robillard constant declarations dangerous, so this one is pinned:
 * src/burnLaw.parity.test.ts drives the same inputs through the real Rust core
 * and asserts agreement, including at band boundaries and outside the banded
 * range. If the Rust rule changes, that test fails.
 */

/** The (a, n) pair governing burn rate at this chamber pressure. */
export function coefficientsAt(
  a: number,
  n: number,
  regimes: BurnRateRegime[] | undefined,
  pc: number
): { a: number; n: number } {
  if (!regimes || regimes.length === 0) return { a, n };

  // The Rust side sorts on construction; sort a copy so callers may pass any
  // order and still match it.
  const sorted = [...regimes].sort((x, y) => x.from_pressure - y.from_pressure);
  for (const r of sorted) {
    if (pc >= r.from_pressure && pc <= r.to_pressure) return { a: r.a, n: r.n };
  }
  // Outside the banded range the nearest END band is extrapolated, not the
  // single-law fallback -- switching laws at the edge would step the burn rate
  // exactly where the ignition transient sweeps through.
  const edge = pc < sorted[0].from_pressure ? sorted[0] : sorted[sorted.length - 1];
  return { a: edge.a, n: edge.n };
}

/** Pressure-driven burn rate before erosive augmentation, m/s. */
export function baseBurnRate(
  a: number,
  n: number,
  regimes: BurnRateRegime[] | undefined,
  pc: number
): number {
  const c = coefficientsAt(a, n, regimes, pc);
  return c.a * Math.pow(pc, c.n);
}

/**
 * Peak erosive augmentation as a fraction of the base burn rate.
 *
 * Recovered from the simulation output rather than recomputed from the erosive
 * correlation, so it reflects whatever the solver actually did -- including the
 * model selection, the temperature correction and the quasi-1-D station march.
 * Nothing about the erosive correlation is duplicated here.
 *
 * Returns 0 when the trace is too short or the rate cannot be recovered.
 */
export function peakErosiveFraction(
  samples: Array<{ time: number; web: number; pc: number }>,
  a: number,
  n: number,
  regimes: BurnRateRegime[] | undefined,
  tempCorrection = 1
): number {
  let peak = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].time - samples[i - 1].time;
    if (dt <= 0) continue;

    // Actual total rate the solver produced over this step.
    const actual = (samples[i].web - samples[i - 1].web) / dt;
    if (!Number.isFinite(actual) || actual <= 0) continue;

    // What the same step would have been with pressure alone. Midpoint
    // pressure, since the rate is a step average rather than an endpoint value.
    const pcMid = (samples[i].pc + samples[i - 1].pc) / 2;
    const base = baseBurnRate(a, n, regimes, pcMid) * tempCorrection;
    if (!Number.isFinite(base) || base <= 0) continue;

    const fraction = (actual - base) / base;
    if (fraction > peak) peak = fraction;
  }
  // A negative or absurd result means the recovery failed rather than that
  // erosion is negative; clamp rather than report nonsense.
  return Number.isFinite(peak) ? Math.min(Math.max(peak, 0), 10) : 0;
}
