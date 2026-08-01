//! Nozzle throat thermal / ablation model. Port of the `nozzle_props` branch in
//! `MotorSimulation.run` (src/engine.ts).
//!
//! Surface temperature is driven by a simplified Bartz convective coefficient
//! against a semi-infinite-solid penetration depth. Recession only begins once
//! the surface reaches the material's oxidation temperature, after which the
//! surface is pinned there and the excess flux drives ablation.
//!
//! When no material is supplied the throat is treated as non-eroding. (The old
//! dimensionally-broken fallback erosion model was removed in 3b474ea.)

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct NozzleMaterialProps {
    #[serde(default)]
    pub kind: String,
    pub density: f64,
    pub heat_of_ablation: f64,
    pub oxidation_temp: f64,
    pub thermal_shock_coeff: f64,
    pub thermal_conductivity: f64,
    pub specific_heat: f64,
    #[serde(default)]
    pub k_temp_coeff: f64,
    #[serde(default)]
    pub cp_temp_coeff: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NozzleConfig {
    /// Initial throat diameter (m).
    pub throat_diameter: f64,
    pub expansion_ratio: f64,
    #[serde(default)]
    pub material: Option<NozzleMaterialProps>,
}

/// Tuning constant on the simplified Bartz heat-transfer coefficient.
const C_BARTZ: f64 = 0.005;

#[derive(Debug, Clone)]
pub struct NozzleThermal {
    pub surface_temp: f64,
    pub material: Option<NozzleMaterialProps>,
}

impl NozzleThermal {
    pub fn new(material: Option<NozzleMaterialProps>) -> Self {
        Self {
            surface_temp: 300.0,
            material,
        }
    }

    /// Advance the surface temperature by one step and return the throat
    /// recession rate (m/s of diameter). Explicit Euler, matching the TS model:
    /// this is a slow auxiliary state, not part of the RK4 system.
    pub fn step(&mut self, pc: f64, d_t: f64, flame_temp: f64, time: f64, dt: f64) -> f64 {
        let m = match &self.material {
            Some(m) => m.clone(),
            None => return 0.0,
        };

        // Temperature-dependent thermal properties.
        let t_diff = (self.surface_temp - 300.0).max(0.0);
        let current_k = (m.thermal_conductivity * (1.0 + m.k_temp_coeff * t_diff)).max(0.1);
        let current_cp = (m.specific_heat * (1.0 + m.cp_temp_coeff * t_diff)).max(10.0);

        let h_g = C_BARTZ * pc.max(0.0).powf(0.8) * d_t.powf(-0.2) * flame_temp.sqrt();
        let q_dot = h_g * (flame_temp - self.surface_temp);

        // Approximate 1D transient conduction into a semi-infinite solid.
        let thermal_diffusivity = current_k / (m.density * current_cp);
        let effective_time = time.max(0.001);
        let penetration_depth = (thermal_diffusivity * effective_time).sqrt();

        let delta_t = (q_dot * dt) / (m.density * current_cp * penetration_depth);
        self.surface_temp += delta_t;

        if self.surface_temp > m.oxidation_temp {
            let ablation_q_dot = h_g * (flame_temp - m.oxidation_temp);
            // Thermal shock: strongest at the start of the burn.
            let shock_factor = 1.0 + m.thermal_shock_coeff * (-time * 2.0).exp();
            let ablation_rate = (ablation_q_dot / (m.density * m.heat_of_ablation)) * shock_factor;
            // Pin the surface at the phase-change plateau.
            self.surface_temp = m.oxidation_temp;
            // x2: recession happens on both sides of the diameter.
            return ablation_rate * 2.0;
        }
        0.0
    }
}
