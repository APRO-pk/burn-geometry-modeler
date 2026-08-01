//! APRO solid motor internal-ballistics core.
//!
//! This crate is the canonical physics engine. It replaces the solver half of
//! `src/engine.ts`, which is retained (deprecated) as the reference the parity
//! tests compare against.
//!
//! Public wasm-bindgen surface:
//!   - `Solver::new()` / `configure(config)` / `run()`  -- stateful form
//!   - `simulate(config)`                               -- one-shot convenience
//!
//! `config` is a plain JS object:
//! ```js
//! {
//!   propellant: { density, a, n, flame_temp, gamma, molecular_weight,
//!                 k_erosive?, g_threshold?, t_ref?, sigma_p? },
//!   grain:      { kind: "BATES" | "Star" | "Tubular" | "RodAndTube"
//!                       | "MoonBurner" | "Finocyl" | "CustomDXF", ... },
//!   nozzle:     { throat_diameter, expansion_ratio, material?: {...} },
//!   igniter?:   { mass, surface_area, density, a, n },
//!   options?:   { dt?, t_init?, c_star_eff?, cf_eff?, erosive_model?,
//!                 ambient_pressure?, max_time? }
//! }
//! ```
//!
//! `run()` resolves to `{ fields, rows, data: Float64Array, warnings }` where
//! `data` is row-major with one row per timestep and `fields.length` columns.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

pub mod grain;
pub mod igniter;
pub mod nozzle;
pub mod propellant;
pub mod sim;

use grain::{Grain, GrainConfig};
use igniter::{Igniter, IgniterConfig};
use nozzle::{NozzleConfig, NozzleThermal};
use propellant::{Propellant, PropellantConfig};
use sim::{Options, Simulation, N_FIELDS};

/// Column order of the returned `data` buffer. Matches `SimulationResult` in
/// src/engine.ts field-for-field.
pub const FIELDS: [&str; N_FIELDS] = [
    "Time",
    "Ab",
    "Pc",
    "Thrust",
    "PortMassFlux",
    "ThroatArea",
    "PortArea",
    "y",
    "MassFlow",
    "PropellantMassGen",
];

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub propellant: PropellantConfig,
    pub grain: GrainConfig,
    pub nozzle: NozzleConfig,
    #[serde(default)]
    pub igniter: Option<IgniterConfig>,
    #[serde(default)]
    pub options: Option<Options>,
}

fn build(config: &Config) -> Simulation {
    let prop = Propellant::new(&config.propellant);
    let grain = Grain::new(&config.grain);
    let ign = config.igniter.as_ref().map(Igniter::new);
    let nozzle = NozzleThermal::new(config.nozzle.material.clone());
    let opts = config.options.clone().unwrap_or_default();
    Simulation::new(
        prop,
        grain,
        ign,
        nozzle,
        config.nozzle.throat_diameter,
        config.nozzle.expansion_ratio,
        opts,
    )
}

/// Serialise a completed run into the JS result object.
fn to_js(out: sim::RunOutput) -> Result<JsValue, JsValue> {
    let obj = js_sys::Object::new();

    let fields = js_sys::Array::new();
    for f in FIELDS.iter() {
        fields.push(&JsValue::from_str(f));
    }
    js_sys::Reflect::set(&obj, &JsValue::from_str("fields"), &fields)?;
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("rows"),
        &JsValue::from_f64(out.rows as f64),
    )?;

    // Copy into a JS-owned Float64Array so the buffer survives independently of
    // the wasm linear memory (which can be detached by a later allocation).
    let data = js_sys::Float64Array::new_with_length(out.data.len() as u32);
    data.copy_from(&out.data);
    js_sys::Reflect::set(&obj, &JsValue::from_str("data"), &data)?;

    let warns = js_sys::Array::new();
    for w in out.warnings.iter() {
        warns.push(&JsValue::from_str(w));
    }
    js_sys::Reflect::set(&obj, &JsValue::from_str("warnings"), &warns)?;

    Ok(obj.into())
}

/// Stateful solver: `configure(...)` once, then `run()`.
#[wasm_bindgen]
pub struct Solver {
    config: Option<Config>,
}

#[wasm_bindgen]
impl Solver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Solver {
        Solver { config: None }
    }

    /// Validate and store a configuration. Returns an error string on bad input.
    pub fn configure(&mut self, config: JsValue) -> Result<(), JsValue> {
        let parsed: Config = serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
        self.config = Some(parsed);
        Ok(())
    }

    /// Execute the configured motor. Call `configure` first.
    pub fn run(&mut self) -> Result<JsValue, JsValue> {
        let cfg = self
            .config
            .as_ref()
            .ok_or_else(|| JsValue::from_str("run() called before configure()"))?;
        let mut s = build(cfg);
        to_js(s.run())
    }
}

impl Default for Solver {
    fn default() -> Self {
        Self::new()
    }
}

/// One-shot convenience: configure and run in a single call. Used by the Monte
/// Carlo path, which builds a fresh configuration per iteration.
#[wasm_bindgen]
pub fn simulate(config: JsValue) -> Result<JsValue, JsValue> {
    let parsed: Config = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
    let mut s = build(&parsed);
    to_js(s.run())
}

/// The timestep the UI and tests should use, so every path stays comparable.
#[wasm_bindgen]
pub fn sim_dt() -> f64 {
    sim::SIM_DT
}

/// Crate version, useful for asserting the UI loaded the wasm it expects.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
