/**
 * Give C_BARTZ provenance by comparing the simplified correlation the solver
 * uses against the real Bartz correlation it is named after.
 *
 *   npx tsx tools/calibrateBartz.mts
 *
 * WHAT THE SOLVER USES (crates/burn-core/src/nozzle.rs)
 *
 *   h_g = C_BARTZ * Pc^0.8 * D_t^-0.2 * sqrt(T_flame),   C_BARTZ = 0.005
 *
 * The Pc^0.8 and D_t^-0.2 exponents are genuinely Bartz. Everything else --
 * viscosity, specific heat, Prandtl number, characteristic velocity -- is
 * collapsed into the single scalar 0.005, and the sqrt(T_flame) factor is not
 * part of Bartz at all. So the exponents carry real physics and the MAGNITUDE
 * is a fitted number of unknown origin.
 *
 * WHAT BARTZ ACTUALLY SAYS (Bartz 1957, the standard throat form)
 *
 *   h_g = (0.026 / D_t^0.2) * (mu^0.2 * cp / Pr^0.6) * (Pc / c*)^0.8
 *         * (D_t / R_c)^0.1 * sigma
 *
 * where sigma is the property-variation correction across the boundary layer.
 * Every term there is a measurable property rather than a fit.
 *
 * This script evaluates both over a realistic sweep of motors and gas
 * properties and reports the ratio. It does NOT change the solver; it produces
 * the numbers that MODEL_UNCERTAINTY.md quotes, so that document is derived
 * rather than asserted.
 */

const C_BARTZ = 0.005; // must match crates/burn-core/src/nozzle.rs

/** The simplified form the solver integrates. */
function simplified(pc: number, dt: number, tFlame: number): number {
  return C_BARTZ * Math.pow(pc, 0.8) * Math.pow(dt, -0.2) * Math.sqrt(tFlame);
}

interface Gas {
  /** Dynamic viscosity, Pa*s. */
  mu: number;
  /** Specific heat at constant pressure, J/kg/K. */
  cp: number;
  /** Prandtl number. */
  pr: number;
  /** Characteristic velocity, m/s. */
  cStar: number;
  /** Throat wall radius of curvature over throat diameter. */
  rcOverDt: number;
  /** Property-variation correction factor. */
  sigma: number;
}

/** Bartz 1957, throat form. */
function bartz(pc: number, dt: number, g: Gas): number {
  return (
    (0.026 / Math.pow(dt, 0.2)) *
    ((Math.pow(g.mu, 0.2) * g.cp) / Math.pow(g.pr, 0.6)) *
    Math.pow(pc / g.cStar, 0.8) *
    Math.pow(1 / g.rcOverDt, 0.1) *
    g.sigma
  );
}

/*
 * Property ranges for amateur/experimental solid propellants. These are broad
 * on purpose: the point is to find out whether C_BARTZ is defensible ACROSS
 * plausible propellants, not to tune it to one.
 *
 * Sugar propellants burn cool (~1600-1700 K) and APCP hot (~2700-3000 K), so
 * the sweep spans both.
 */
const GAS_RANGES = {
  mu: [5e-5, 1.1e-4],
  cp: [1500, 2200],
  pr: [0.4, 0.8],
  cStar: [850, 1550],
  rcOverDt: [0.5, 2.0],
  sigma: [0.8, 1.2],
};

const MOTOR_RANGES = {
  pc: [1e6, 1.2e7],
  dt: [0.006, 0.05],
  tFlame: [1500, 3000],
};

function lerp(r: number[], u: number) {
  return r[0] + (r[1] - r[0]) * u;
}

// Deterministic low-discrepancy-ish sweep, so the reported numbers are stable.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rand = rng(20260822);
const ratios: number[] = [];
const N = 20000;

for (let i = 0; i < N; i++) {
  const pc = lerp(MOTOR_RANGES.pc, rand());
  const dt = lerp(MOTOR_RANGES.dt, rand());
  const tFlame = lerp(MOTOR_RANGES.tFlame, rand());
  const g: Gas = {
    mu: lerp(GAS_RANGES.mu, rand()),
    cp: lerp(GAS_RANGES.cp, rand()),
    pr: lerp(GAS_RANGES.pr, rand()),
    cStar: lerp(GAS_RANGES.cStar, rand()),
    rcOverDt: lerp(GAS_RANGES.rcOverDt, rand()),
    sigma: lerp(GAS_RANGES.sigma, rand()),
  };
  ratios.push(simplified(pc, dt, tFlame) / bartz(pc, dt, g));
}

ratios.sort((a, b) => a - b);
const q = (p: number) => ratios[Math.floor(p * (ratios.length - 1))];
const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;

console.log(`\nsimplified / real Bartz, over ${N} sampled motors and gas properties`);
console.log(`  median ${q(0.5).toFixed(2)}x   mean ${mean.toFixed(2)}x`);
console.log(`  5th-95th percentile:  ${q(0.05).toFixed(2)}x  to  ${q(0.95).toFixed(2)}x`);
console.log(`  full range:           ${q(0).toFixed(2)}x  to  ${q(1).toFixed(2)}x`);

// What C_BARTZ would have to be for the two to agree at the median.
console.log(`\n  C_BARTZ that would match real Bartz at the median: ${(C_BARTZ / q(0.5)).toExponential(3)}`);
console.log(`  currently shipped:                                 ${C_BARTZ.toExponential(3)}`);

/*
 * Separately: how much of the disagreement is a constant offset (harmless, it
 * just rescales) versus a SHAPE error (not harmless, it means the model responds
 * to pressure or size differently from the physics)?
 */
const nominal: Gas = { mu: 8e-5, cp: 1900, pr: 0.6, cStar: 1100, rcOverDt: 1.0, sigma: 1.0 };
console.log('\n  shape check at nominal gas properties, ratio vs the median ratio:');
for (const pc of [1e6, 3e6, 7e6, 1.2e7]) {
  const r = simplified(pc, 0.02, 2000) / bartz(pc, 0.02, nominal);
  console.log(`    Pc = ${(pc / 1e6).toFixed(1)} MPa, Dt = 20 mm  ->  ${r.toFixed(2)}x`);
}
for (const dt of [0.006, 0.012, 0.025, 0.05]) {
  const r = simplified(7e6, dt, 2000) / bartz(7e6, dt, nominal);
  console.log(`    Pc = 7.0 MPa, Dt = ${(dt * 1000).toFixed(0)} mm  ->  ${r.toFixed(2)}x`);
}
for (const tf of [1600, 2000, 2500, 3000]) {
  const r = simplified(7e6, 0.02, tf) / bartz(7e6, 0.02, nominal);
  console.log(`    T_flame = ${tf} K, Pc = 7.0 MPa  ->  ${r.toFixed(2)}x`);
}
