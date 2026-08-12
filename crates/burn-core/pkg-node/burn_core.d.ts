/* tslint:disable */
/* eslint-disable */
/**
 * One-shot convenience: configure and run in a single call. Used by the Monte
 * Carlo path, which builds a fresh configuration per iteration.
 */
export function simulate(config: any): any;
/**
 * The timestep the UI and tests should use, so every path stays comparable.
 */
export function sim_dt(): number;
/**
 * Crate version, useful for asserting the UI loaded the wasm it expects.
 */
export function version(): string;
/**
 * Closed-form case structural analysis at the run's peak pressure.
 *
 * Independent of the ballistics solver: it takes the peak pressure as an input,
 * so the UI can re-run it when the case material or bolt pattern changes
 * without re-simulating the motor.
 */
export function analyze_structure(config: any): any;
/**
 * Thin-wall sizing rule, exposed so the UI can show the wall a `pR/t`
 * calculation would ask for next to what the real analysis says about it.
 */
export function required_wall_thickness(max_pressure: number, inner_radius: number, safety_factor: number, yield_stress: number): number;
/**
 * Stateful solver: `configure(...)` once, then `run()`.
 */
export class Solver {
  free(): void;
  constructor();
  /**
   * Execute the configured motor. Call `configure` first.
   */
  run(): any;
  /**
   * Validate and store a configuration. Returns an error string on bad input.
   */
  configure(config: any): void;
}
