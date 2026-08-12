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
//!                 ambient_pressure?, max_time?,
//!                 model?: "0D" | "quasi1D",   // default "0D"
//!                 stations?,                  // quasi-1-D cells, default 20
//!                 friction_factor? }          // Darcy, port bore, default 0.02
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
pub mod port;
pub mod propellant;
pub mod sim;
pub mod structural;

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
    "PcNozzle",
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

    // Axial profiles, present only for quasi-1-D runs.
    if let Some(st) = out.stations.as_ref() {
        let s = js_sys::Object::new();
        set_f64_array(&s, "x", &st.x)?;
        set_f64_array(&s, "web", &st.web)?;
        set_f64_array(&s, "pressure", &st.peak.pressure)?;
        set_f64_array(&s, "massFlux", &st.peak.mass_flux)?;
        set_f64_array(&s, "burnRate", &st.peak.burn_rate)?;
        set_f64_array(&s, "erosiveRate", &st.peak.erosive_rate)?;
        set_f64_array(&s, "massFlow", &st.peak.mass_flow)?;
        set_f64_array(&s, "portArea", &st.peak.port_area)?;
        set_f64_array(&s, "peakWeb", &st.peak.web)?;
        js_sys::Reflect::set(
            &s,
            &JsValue::from_str("count"),
            &JsValue::from_f64(st.count as f64),
        )?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("stations"), &s)?;
    }

    Ok(obj.into())
}

/// Copy a slice into a JS-owned Float64Array and attach it under `key`.
fn set_f64_array(obj: &js_sys::Object, key: &str, src: &[f64]) -> Result<(), JsValue> {
    let arr = js_sys::Float64Array::new_with_length(src.len() as u32);
    arr.copy_from(src);
    js_sys::Reflect::set(obj, &JsValue::from_str(key), &arr)?;
    Ok(())
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

/// Closed-form case structural analysis at the run's peak pressure.
///
/// Independent of the ballistics solver: it takes the peak pressure as an input,
/// so the UI can re-run it when the case material or bolt pattern changes
/// without re-simulating the motor.
#[wasm_bindgen]
pub fn analyze_structure(config: JsValue) -> Result<JsValue, JsValue> {
    let cfg: structural::StructuralConfig = serde_wasm_bindgen::from_value(config)
        .map_err(|e| JsValue::from_str(&format!("invalid structural config: {e}")))?;
    structural_to_js(&structural::analyze(&cfg))
}

/// Thin-wall sizing rule, exposed so the UI can show the wall a `pR/t`
/// calculation would ask for next to what the real analysis says about it.
#[wasm_bindgen]
pub fn required_wall_thickness(
    max_pressure: f64,
    inner_radius: f64,
    safety_factor: f64,
    yield_stress: f64,
) -> f64 {
    structural::required_thickness_thin_wall(
        max_pressure,
        inner_radius,
        safety_factor,
        yield_stress,
    )
}

fn stress_states_to_js(states: &[structural::StressState]) -> Result<JsValue, JsValue> {
    let obj = js_sys::Object::new();
    let field = |pick: fn(&structural::StressState) -> f64| -> Vec<f64> {
        states.iter().map(pick).collect()
    };
    set_f64_array(&obj, "position", &field(|s| s.position))?;
    set_f64_array(&obj, "hoop", &field(|s| s.hoop))?;
    set_f64_array(&obj, "radial", &field(|s| s.radial))?;
    set_f64_array(&obj, "axial", &field(|s| s.axial))?;
    set_f64_array(&obj, "vonMises", &field(|s| s.von_mises))?;
    Ok(obj.into())
}

fn stress_state_to_js(s: &structural::StressState) -> Result<JsValue, JsValue> {
    let obj = js_sys::Object::new();
    set_num(&obj, "position", s.position)?;
    set_num(&obj, "hoop", s.hoop)?;
    set_num(&obj, "radial", s.radial)?;
    set_num(&obj, "axial", s.axial)?;
    set_num(&obj, "vonMises", s.von_mises)?;
    Ok(obj.into())
}

fn set_num(obj: &js_sys::Object, key: &str, v: f64) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), &JsValue::from_f64(v))?;
    Ok(())
}

fn set_str(obj: &js_sys::Object, key: &str, v: &str) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), &JsValue::from_str(v))?;
    Ok(())
}

fn set_strings(obj: &js_sys::Object, key: &str, v: &[String]) -> Result<(), JsValue> {
    let arr = js_sys::Array::new();
    for s in v {
        arr.push(&JsValue::from_str(s));
    }
    js_sys::Reflect::set(obj, &JsValue::from_str(key), &arr)?;
    Ok(())
}

fn structural_to_js(r: &structural::StructuralResult) -> Result<JsValue, JsValue> {
    let root = js_sys::Object::new();

    // ---- Lame ----
    let lame = js_sys::Object::new();
    js_sys::Reflect::set(
        &lame,
        &JsValue::from_str("profile"),
        &stress_states_to_js(&r.lame.profile)?,
    )?;
    js_sys::Reflect::set(
        &lame,
        &JsValue::from_str("inner"),
        &stress_state_to_js(&r.lame.inner)?,
    )?;
    js_sys::Reflect::set(
        &lame,
        &JsValue::from_str("outer"),
        &stress_state_to_js(&r.lame.outer)?,
    )?;
    set_num(&lame, "axial", r.lame.axial)?;
    set_num(&lame, "thinWallHoop", r.lame.thin_wall_hoop)?;
    set_num(&lame, "thinWallError", r.lame.thin_wall_error)?;
    set_num(&lame, "rMeanOverT", r.lame.r_mean_over_t)?;
    js_sys::Reflect::set(
        &lame,
        &JsValue::from_str("thinWallApplicable"),
        &JsValue::from_bool(r.lame.thin_wall_applicable),
    )?;
    js_sys::Reflect::set(&root, &JsValue::from_str("lame"), &lame)?;

    // ---- edge bending ----
    let edge = js_sys::Object::new();
    set_num(&edge, "beta", r.edge.beta)?;
    set_num(&edge, "characteristicLength", r.edge.characteristic_length)?;
    set_num(&edge, "decayLength", r.edge.decay_length)?;
    set_num(&edge, "flexuralRigidity", r.edge.flexural_rigidity)?;
    set_num(&edge, "m0", r.edge.m0)?;
    set_num(&edge, "q0", r.edge.q0)?;
    set_num(&edge, "bendingStress", r.edge.bending_stress)?;
    set_num(&edge, "bendingToHoop", r.edge.bending_to_hoop)?;
    set_num(&edge, "membraneHoop", r.edge.membrane_hoop)?;
    set_num(&edge, "peakLocation", r.edge.peak_location)?;
    set_num(&edge, "peakLocationOverChar", r.edge.peak_location_over_char)?;
    set_str(&edge, "peakSurface", r.edge.peak_surface)?;
    js_sys::Reflect::set(
        &edge,
        &JsValue::from_str("peak"),
        &stress_state_to_js(&r.edge.peak)?,
    )?;
    js_sys::Reflect::set(
        &edge,
        &JsValue::from_str("profile"),
        &stress_states_to_js(&r.edge.profile)?,
    )?;
    js_sys::Reflect::set(&root, &JsValue::from_str("edge"), &edge)?;

    // ---- bolts ----
    if let Some(b) = r.bolts.as_ref() {
        let o = js_sys::Object::new();
        set_num(&o, "count", b.count)?;
        set_num(&o, "diameter", b.diameter)?;
        set_num(&o, "totalForce", b.total_force)?;
        set_num(&o, "forcePerBolt", b.force_per_bolt)?;
        set_num(&o, "nominalArea", b.nominal_area)?;
        set_num(&o, "stressArea", b.stress_area)?;
        set_num(&o, "nominalStress", b.nominal_stress)?;
        set_num(&o, "stressAreaStress", b.stress_area_stress)?;
        set_num(&o, "safetyFactorNominal", b.safety_factor_nominal)?;
        set_num(&o, "safetyFactorStressArea", b.safety_factor_stress_area)?;
        set_num(&o, "minEngagementSteel", b.min_engagement_steel)?;
        set_num(&o, "minEngagementAluminium", b.min_engagement_aluminium)?;
        set_num(&o, "edgeDistance", b.edge_distance)?;
        set_num(&o, "minEdgeDistance", b.min_edge_distance)?;
        set_num(&o, "shearOutArea", b.shear_out_area)?;
        set_num(&o, "shearOutStress", b.shear_out_stress)?;
        set_num(&o, "safetyFactorShearOut", b.safety_factor_shear_out)?;
        js_sys::Reflect::set(&root, &JsValue::from_str("bolts"), &o)?;
    }

    // ---- summary ----
    set_num(&root, "maxVonMises", r.max_von_mises)?;
    set_str(&root, "whereMax", r.where_max)?;
    set_num(&root, "safetyFactor", r.safety_factor)?;
    set_num(&root, "marginOfSafety", r.margin_of_safety)?;
    set_num(&root, "boreHoopStrain", r.bore_hoop_strain)?;
    set_num(&root, "boreRadialGrowth", r.bore_radial_growth)?;
    set_strings(&root, "assumptions", &r.assumptions)?;
    set_strings(&root, "warnings", &r.warnings)?;

    Ok(root.into())
}
