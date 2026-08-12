// Main-thread access to the case structural analysis in the Rust core.
//
// Unlike the ballistics solver this does not go through the Web Worker. It is a
// handful of closed-form evaluations over ~150 points -- microseconds, not the
// thousands of RK4 steps a burn takes -- and keeping it synchronous lets the
// structural panel recompute as the user drags a wall thickness or bolt count
// without any request plumbing.
//
// The wasm module is instantiated lazily and shared with nothing else, so the
// first call pays for compilation. Callers get `undefined` until it is ready.

import initWasm, {
  analyze_structure,
  required_wall_thickness,
} from '../crates/burn-core/pkg-web/burn_core.js';
import wasmUrl from '../crates/burn-core/pkg-web/burn_core_bg.wasm?url';
import type { StructuralConfig, StructuralResult } from './wasmCore';

let ready: Promise<unknown> | null = null;
let loaded = false;

/** Begin instantiating. Safe to call repeatedly. */
export function initStructural(): Promise<unknown> {
  if (!ready) {
    ready = initWasm({ module_or_path: wasmUrl }).then((m) => {
      loaded = true;
      return m;
    });
  }
  return ready;
}

export function structuralReady(): boolean {
  return loaded;
}

/**
 * Run the analysis. Returns `undefined` if the module has not finished loading,
 * rather than throwing -- callers are React render paths.
 */
export function analyzeStructure(config: StructuralConfig): StructuralResult | undefined {
  if (!loaded) {
    void initStructural();
    return undefined;
  }
  return analyze_structure(config) as StructuralResult;
}

/**
 * Thin-wall sizing rule, `p*R*SF/sigma_y`. This is a starting point for choosing
 * a wall, NOT a result: it ignores the closure junction entirely, so a wall
 * sized by it lands below the requested safety factor once edge bending is
 * accounted for.
 */
export function requiredWallThickness(
  maxPressure: number,
  innerRadius: number,
  safetyFactor: number,
  yieldStress: number
): number | undefined {
  if (!loaded) {
    void initStructural();
    return undefined;
  }
  return required_wall_thickness(maxPressure, innerRadius, safetyFactor, yieldStress);
}
