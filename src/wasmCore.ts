// Shared contract between the TypeScript app and the Rust/WASM ballistics core
// (crates/burn-core). Everything here is plain data: the types mirror the serde
// shapes in the crate, and the helpers translate the flat Float64Array the core
// returns into the SimulationResult[] the UI already consumes.
//
// This file is imported by the main thread, by the Web Worker, and by the
// parity tests, so it must stay free of both DOM and wasm imports.

import type {
  SimulationResult,
  ErosiveModelType,
  NozzleMaterialProps,
  GrainUiParams,
  DxfTables,
} from './engine';

// The UI grain shapes live in engine.ts next to `grainFromUi`, the TypeScript
// half of this same mapping. Re-exported so callers can take both from here.
export type { GrainUiParams, DxfTables };

// --- configuration (matches Config in crates/burn-core/src/lib.rs) ---------

export interface BurnPropellantConfig {
  density: number;
  /** St. Robert coefficient in SI: r_b = a * Pc^n, Pc in Pa, r_b in m/s. */
  a: number;
  n: number;
  flame_temp: number;
  gamma: number;
  molecular_weight: number;
  k_erosive?: number;
  g_threshold?: number;
  t_ref?: number;
  sigma_p?: number;
}

/** Internally tagged by `kind`, matching #[serde(tag = "kind")] on GrainConfig. */
export type BurnGrainConfig =
  | { kind: 'BATES'; length: number; outer_radius: number; inner_radius: number }
  | {
      kind: 'Star';
      length: number;
      outer_radius: number;
      valley_radius: number;
      tip_radius: number;
      num_points: number;
    }
  | { kind: 'Tubular'; length: number; outer_radius: number; inner_radius: number }
  | {
      kind: 'RodAndTube';
      length: number;
      outer_radius: number;
      rod_radius: number;
      tube_inner_radius: number;
    }
  | {
      kind: 'MoonBurner';
      length: number;
      outer_radius: number;
      core_radius: number;
      offset: number;
    }
  | {
      kind: 'Finocyl';
      length: number;
      outer_radius: number;
      r_tube: number;
      num_fins: number;
      w_fin: number;
      h_fin: number;
    }
  | {
      kind: 'CustomDXF';
      length: number;
      outer_radius: number;
      dx: number;
      perim_table: number[];
      area_table: number[];
    };

/**
 * Translate UI grain inputs into a core grain config: the wasm counterpart of
 * `grainFromUi` in src/engine.ts, which builds the equivalent TypeScript grain
 * from the same fields. src/wasm.parity.test.ts asserts the two agree for every
 * geometry, so a transposed argument in either one is caught.
 *
 * Unknown or unsatisfiable types fall back to BATES, matching what the app did
 * before the core was introduced.
 */
export function grainConfigFromUi(p: GrainUiParams, dxf?: DxfTables | null): BurnGrainConfig {
  const { length, outerRadius: outer_radius, innerRadius: inner_radius } = p;

  switch (p.grainType) {
    case 'Star':
      return {
        kind: 'Star', length, outer_radius,
        valley_radius: p.valleyRadius ?? 0,
        tip_radius: p.tipRadius ?? 0,
        num_points: p.numPoints ?? 0,
      };
    case 'Tubular':
      return { kind: 'Tubular', length, outer_radius, inner_radius };
    case 'RodAndTube':
      return {
        kind: 'RodAndTube', length, outer_radius,
        rod_radius: p.rodRadius ?? 0,
        tube_inner_radius: inner_radius,
      };
    case 'MoonBurner':
      return {
        kind: 'MoonBurner', length, outer_radius,
        core_radius: inner_radius,
        offset: p.offset ?? 0,
      };
    case 'Finocyl':
      return {
        kind: 'Finocyl', length, outer_radius,
        r_tube: inner_radius,
        num_fins: p.numPoints ?? 0,
        w_fin: p.finWidth ?? 0,
        h_fin: p.finDepth ?? 0,
      };
    case 'CustomDXF':
      if (dxf) {
        return {
          kind: 'CustomDXF', length, outer_radius,
          dx: dxf.dx, perim_table: dxf.perimTable, area_table: dxf.areaTable,
        };
      }
      return { kind: 'BATES', length, outer_radius, inner_radius };
    default:
      return { kind: 'BATES', length, outer_radius, inner_radius };
  }
}

export interface BurnNozzleConfig {
  /** Initial throat diameter (m). */
  throat_diameter: number;
  expansion_ratio: number;
  material?: NozzleMaterialProps | null;
}

export interface BurnIgniterConfig {
  mass: number;
  surface_area: number;
  density: number;
  a: number;
  n: number;
}

/**
 * Spatial model.
 *
 * `0D` lumps the chamber into one volume at one pressure with one mass flux --
 * fast, and the right default for Monte Carlo and parameter sweeps. `quasi1D`
 * resolves the port axially: per-station pressure, mass flux, erosive burning
 * and web, at roughly `stations`x the cost per step.
 */
export type SolverModelType = '0D' | 'quasi1D';

export interface BurnOptions {
  dt?: number;
  t_init?: number;
  c_star_eff?: number;
  cf_eff?: number;
  erosive_model?: ErosiveModelType;
  ambient_pressure?: number;
  max_time?: number;
  model?: SolverModelType;
  /** Axial cells for the quasi-1-D model. Ignored under 0-D. Default 20. */
  stations?: number;
  /** Darcy friction factor for the port bore. Default 0.02. */
  friction_factor?: number;
}

/**
 * Axial profiles from a quasi-1-D run. Absent for 0-D runs, which have no axial
 * dimension. `web` is the end-of-run state; every other array is the profile at
 * the timestep of peak head-end pressure (the design point).
 */
export interface StationProfiles {
  count: number;
  /** Station centres from the head end (m). */
  x: Float64Array;
  /**
   * Web burned at each station at the end of the run (m). A fully burned-out
   * grain is near-uniform here; `peakWeb` is where port coning shows.
   */
  web: Float64Array;
  /** Web burned at each station at the peak-pressure step (m). */
  peakWeb: Float64Array;
  /** Local static pressure (Pa). */
  pressure: Float64Array;
  /** Local mass flux (kg/m^2/s). */
  massFlux: Float64Array;
  /** Local total burn rate (m/s). */
  burnRate: Float64Array;
  /** Local erosive augmentation alone (m/s). */
  erosiveRate: Float64Array;
  /** Cumulative mass flow past the station (kg/s). */
  massFlow: Float64Array;
  /** Local port area (m^2). */
  portArea: Float64Array;
}

export interface BurnConfig {
  propellant: BurnPropellantConfig;
  grain: BurnGrainConfig;
  nozzle: BurnNozzleConfig;
  igniter?: BurnIgniterConfig | null;
  options?: BurnOptions;
}

// --- results ---------------------------------------------------------------

/** Exactly what `simulate()` / `Solver::run()` resolve to. */
export interface RawRunOutput {
  fields: string[];
  rows: number;
  /** Row-major, `fields.length` values per row. */
  data: Float64Array;
  warnings: string[];
  /** Present only for quasi-1-D runs. */
  stations?: StationProfiles;
}

export interface MotorRunResult {
  results: SimulationResult[];
  warnings: string[];
  stations?: StationProfiles;
}

/**
 * Expand the core's flat row-major buffer into the record-per-step array the
 * charts, exports and metrics already expect.
 *
 * Columns are looked up by name from `fields` rather than by fixed index, so a
 * change to the column order in the Rust crate surfaces as a thrown error here
 * instead of as silently transposed physics.
 */
export function unpackResults(raw: RawRunOutput): SimulationResult[] {
  const { fields, rows, data } = raw;
  const stride = fields.length;

  // PcNozzle is required, not optional: a wasm build old enough to lack it also
  // predates the `model` option, and serde ignores unknown fields -- so it would
  // quietly answer a quasi-1-D request with a 0-D run. Failing here turns that
  // silent wrong answer into an explicit "rebuild" instruction.
  const expected: Array<keyof SimulationResult> = [
    'Time', 'Ab', 'Pc', 'Thrust', 'PortMassFlux',
    'ThroatArea', 'PortArea', 'y', 'MassFlow', 'PropellantMassGen', 'PcNozzle',
  ];
  const at: Record<string, number> = {};
  for (const name of expected) {
    const idx = fields.indexOf(name);
    if (idx < 0) {
      throw new Error(
        `burn-core returned no "${name}" column (got: ${fields.join(', ')}). ` +
          'The wasm build is out of step with src/wasmCore.ts — rerun npm run wasm:build.'
      );
    }
    at[name] = idx;
  }
  if (data.length < rows * stride) {
    throw new Error(`burn-core returned ${data.length} values for ${rows} x ${stride} rows.`);
  }

  const out: SimulationResult[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    const b = i * stride;
    out[i] = {
      Time: data[b + at.Time],
      Ab: data[b + at.Ab],
      Pc: data[b + at.Pc],
      Thrust: data[b + at.Thrust],
      PortMassFlux: data[b + at.PortMassFlux],
      ThroatArea: data[b + at.ThroatArea],
      PortArea: data[b + at.PortArea],
      y: data[b + at.y],
      MassFlow: data[b + at.MassFlow],
      PropellantMassGen: data[b + at.PropellantMassGen],
      PcNozzle: data[b + at.PcNozzle],
    };
  }
  return out;
}

// --- worker protocol -------------------------------------------------------

export interface BurnWorkerRequest {
  id: number;
  config: BurnConfig;
}

export type BurnWorkerResponse =
  | {
      id: number;
      ok: true;
      fields: string[];
      rows: number;
      data: ArrayBuffer;
      warnings: string[];
      /** Structured-cloned rather than transferred: 20-odd floats per array. */
      stations?: StationProfiles;
    }
  | { id: number; ok: false; error: string };
