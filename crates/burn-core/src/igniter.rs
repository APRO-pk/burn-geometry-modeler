//! Igniter charge. Port of `Igniter` in src/engine.ts: the charge is modelled
//! as shrinking granules, so burning surface falls as (mass remaining)^(2/3).

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct IgniterConfig {
    pub mass: f64,
    pub surface_area: f64,
    pub density: f64,
    pub a: f64,
    pub n: f64,
}

#[derive(Debug, Clone)]
pub struct Igniter {
    pub mass: f64,
    pub initial_mass: f64,
    pub surface_area: f64,
    pub density: f64,
    pub a: f64,
    pub n: f64,
    pub mass_consumed: f64,
}

impl Igniter {
    pub fn new(c: &IgniterConfig) -> Self {
        Self {
            mass: c.mass,
            initial_mass: c.mass,
            surface_area: c.surface_area,
            density: c.density,
            a: c.a,
            n: c.n,
            mass_consumed: 0.0,
        }
    }

    /// Mass flow contributed at chamber pressure `pc`. Pure: the caller is
    /// responsible for advancing `mass_consumed`, which lets the RK4 stages
    /// evaluate this without mutating state mid-step.
    pub fn m_dot(&self, pc: f64, dt: f64) -> f64 {
        if self.mass_consumed >= self.mass {
            return 0.0;
        }
        let mass_remaining = self.mass - self.mass_consumed;
        let radius_ratio = (mass_remaining / self.initial_mass).max(0.0).cbrt();
        let current_surface_area = self.surface_area * radius_ratio.powi(2);
        let mut mdot = current_surface_area * self.density * self.a * pc.max(0.0).powf(self.n);

        // Never release more than the charge has left in one step.
        if dt > 0.0 && mdot * dt > mass_remaining {
            mdot = mass_remaining / dt;
        }
        mdot
    }
}
