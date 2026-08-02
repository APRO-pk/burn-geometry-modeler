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
