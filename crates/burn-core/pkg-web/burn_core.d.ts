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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_solver_free: (a: number, b: number) => void;
  readonly analyze_structure: (a: any) => [number, number, number];
  readonly required_wall_thickness: (a: number, b: number, c: number, d: number) => number;
  readonly sim_dt: () => number;
  readonly simulate: (a: any) => [number, number, number];
  readonly solver_configure: (a: number, b: any) => [number, number];
  readonly solver_new: () => number;
  readonly solver_run: (a: number) => [number, number, number];
  readonly version: () => [number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
