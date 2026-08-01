//! Solid propellant thermochemistry. Direct port of `SolidPropellant` in
//! src/engine.ts; all quantities SI (burn rate m/s, pressure Pa).

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct PropellantConfig {
    pub density: f64,
    /// St. Robert coefficient in SI: r_b = a * Pc^n with Pc in Pa, r_b in m/s.
    pub a: f64,
    pub n: f64,
    pub flame_temp: f64,
    pub gamma: f64,
    pub molecular_weight: f64,
    #[serde(default)]
    pub k_erosive: f64,
    #[serde(default)]
    pub g_threshold: f64,
    #[serde(default = "default_t_ref")]
    pub t_ref: f64,
    #[serde(default = "default_sigma_p")]
    pub sigma_p: f64,
}

fn default_t_ref() -> f64 {
    294.0
}
fn default_sigma_p() -> f64 {
    0.001
}

#[derive(Debug, Clone)]
pub struct Propellant {
    pub density: f64,
    pub a: f64,
    pub n: f64,
    pub flame_temp: f64,
    pub gamma: f64,
    pub molecular_weight: f64,
    pub k_erosive: f64,
    pub g_threshold: f64,
    pub t_ref: f64,
    pub sigma_p: f64,
    pub r_spec: f64,
    /// Vandenkerckhove function.
    pub big_gamma: f64,
    /// Discharge coefficient: m_dot = C_D * Pc * At.
    pub c_d: f64,
    pub c_star: f64,
}

pub const R_UNIV: f64 = 8.314;

impl Propellant {
    pub fn new(c: &PropellantConfig) -> Self {
        let r_spec = R_UNIV / c.molecular_weight;
        let g = c.gamma;
        let big_gamma = g.sqrt() * (2.0 / (g + 1.0)).powf((g + 1.0) / (2.0 * (g - 1.0)));
        let c_d = big_gamma / (r_spec * c.flame_temp).sqrt();
        Self {
            density: c.density,
            a: c.a,
            n: c.n,
            flame_temp: c.flame_temp,
            gamma: c.gamma,
            molecular_weight: c.molecular_weight,
            k_erosive: c.k_erosive,
            g_threshold: c.g_threshold,
            t_ref: c.t_ref,
            sigma_p: c.sigma_p,
            r_spec,
            big_gamma,
            c_d,
            c_star: 1.0 / c_d,
        }
    }

    /// Bulk-temperature sensitivity multiplier on the burn-rate coefficient.
    pub fn temp_correction(&self, t_init: f64) -> f64 {
        1.0 + self.sigma_p * (t_init - self.t_ref)
    }
}
