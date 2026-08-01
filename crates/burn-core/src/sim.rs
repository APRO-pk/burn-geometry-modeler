//! 0-D internal ballistics solver.
//!
//! Port of `MotorSimulation` from src/engine.ts, with the integrator upgraded
//! from semi-implicit Euler to a fixed-step classical RK4 on the coupled fast
//! state `(Pc, y, V_c)`.
//!
//! Operator splitting: the slow auxiliary states -- throat diameter (nozzle
//! ablation), nozzle surface temperature, igniter mass consumed, and cumulative
//! propellant generated -- are advanced with explicit Euler around the RK4 step,
//! exactly where the TypeScript reference advances them. They are forcing terms
//! rather than part of the stiff coupled system, and the nozzle thermal model is
//! history-dependent (it reads absolute `time`), which makes it ill-suited to
//! being evaluated at RK4 sub-stages.

use serde::Deserialize;

use crate::grain::Grain;
use crate::igniter::Igniter;
use crate::nozzle::NozzleThermal;
use crate::propellant::Propellant;

/// Numerical floors keeping the pressure ODE well-posed (see engine.ts).
pub const PC_FLOOR: f64 = 1.0; // Pa
pub const V_C_FLOOR: f64 = 1e-9; // m^3

/// Shared nominal timestep. Must match SIM_DT in src/engine.ts.
pub const SIM_DT: f64 = 0.001;

pub const N_FIELDS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum ErosiveModel {
    None,
    #[serde(rename = "Lenoir-Robillard")]
    LenoirRobillard,
    #[serde(rename = "JPL")]
    Jpl,
}

impl Default for ErosiveModel {
    fn default() -> Self {
        ErosiveModel::None
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Options {
    #[serde(default = "default_dt")]
    pub dt: f64,
    #[serde(default = "default_t_init")]
    pub t_init: f64,
    #[serde(default = "default_eff")]
    pub c_star_eff: f64,
    #[serde(default = "default_eff")]
    pub cf_eff: f64,
    #[serde(default)]
    pub erosive_model: ErosiveModel,
    #[serde(default = "default_pa")]
    pub ambient_pressure: f64,
    #[serde(default = "default_max_time")]
    pub max_time: f64,
}

fn default_dt() -> f64 {
    SIM_DT
}
fn default_t_init() -> f64 {
    294.0
}
fn default_eff() -> f64 {
    1.0
}
fn default_pa() -> f64 {
    101325.0
}
fn default_max_time() -> f64 {
    30.0
}

impl Default for Options {
    fn default() -> Self {
        Self {
            dt: SIM_DT,
            t_init: 294.0,
            c_star_eff: 1.0,
            cf_eff: 1.0,
            erosive_model: ErosiveModel::None,
            ambient_pressure: 101325.0,
            max_time: 30.0,
        }
    }
}

/// One RK4 stage evaluation.
#[derive(Debug, Clone, Copy, Default)]
struct Derivs {
    d_pc: f64,
    d_y: f64,
    d_vc: f64,
    m_dot_igniter: f64,
    // Diagnostics, reported from the k1 (step-start) evaluation only.
    ab: f64,
    a_port: f64,
    g: f64,
    m_dot_out: f64,
    m_dot_ideal: f64,
}

pub struct Simulation {
    pub prop: Propellant,
    pub grain: Grain,
    pub igniter: Option<Igniter>,
    pub nozzle: NozzleThermal,
    pub opts: Options,
    pub d_t: f64,
    pub expansion_ratio: f64,
    temp_corr: f64,
}

pub struct RunOutput {
    /// Row-major, `N_FIELDS` values per sample:
    /// Time, Ab, Pc, Thrust, PortMassFlux, ThroatArea, PortArea, y, MassFlow,
    /// PropellantMassGen.
    pub data: Vec<f64>,
    pub rows: usize,
    pub warnings: Vec<String>,
}

impl Simulation {
    pub fn new(
        prop: Propellant,
        grain: Grain,
        igniter: Option<Igniter>,
        nozzle: NozzleThermal,
        throat_diameter: f64,
        expansion_ratio: f64,
        opts: Options,
    ) -> Self {
        let temp_corr = prop.temp_correction(opts.t_init);
        Self {
            prop,
            grain,
            igniter,
            nozzle,
            opts,
            d_t: throat_diameter,
            expansion_ratio,
            temp_corr,
        }
    }

    /// Exit/chamber pressure ratio for the configured expansion ratio, by
    /// bisection on the area-ratio relation. Port of `_solve_pe_pc`.
    fn solve_pe_pc(&self) -> f64 {
        let gamma = self.prop.gamma;
        let big_gamma = self.prop.big_gamma;
        let epsilon = self.expansion_ratio;

        let f = |pr: f64| -> f64 {
            if pr <= 0.0 || pr >= 1.0 {
                return 1e9;
            }
            let denom = (2.0 * gamma) / (gamma - 1.0)
                * pr.powf(2.0 / gamma)
                * (1.0 - pr.powf((gamma - 1.0) / gamma));
            big_gamma / denom.sqrt() - epsilon
        };

        let mut low = 0.00001_f64;
        let mut high = (2.0 / (gamma + 1.0)).powf(gamma / (gamma - 1.0));
        for _ in 0..50 {
            let mid = (low + high) / 2.0;
            if f(mid) > 0.0 {
                low = mid;
            } else {
                high = mid;
            }
        }
        (low + high) / 2.0
    }

    /// Port of `check_stability`.
    fn check_stability(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        let ab_initial = self.grain.burning_area(0.0);
        let at_initial = (std::f64::consts::PI / 4.0) * self.d_t * self.d_t;

        if at_initial <= 0.0 {
            warnings.push("Critical: Throat diameter is zero or negative.".to_string());
            return warnings;
        }

        let kn = ab_initial / at_initial;
        if kn > 400.0 {
            warnings.push(format!(
                "Warning: Initial Kn ({:.1}) is very high (> 400). Potential over-pressure.",
                kn
            ));
        }

        if self.prop.n >= 1.0 {
            warnings.push(format!(
                "Warning: Pressure exponent n ({:.2}) is >= 1.0. Combustion is theoretically unstable.",
                self.prop.n
            ));
            return warnings;
        }

        let a_corr = self.prop.a * self.temp_corr;
        let pc_eq = ((self.prop.density * a_corr / self.prop.c_d) * kn)
            .powf(1.0 / (1.0 - self.prop.n));
        if pc_eq.is_finite() && pc_eq > 30e6 {
            warnings.push(format!(
                "Warning: Predicted equilibrium pressure ({:.1} MPa) exceeds 30 MPa. Highly unrealistic/dangerous.",
                pc_eq / 1e6
            ));
        } else if !pc_eq.is_finite() {
            warnings.push(
                "Warning: Could not calculate equilibrium pressure. Possible numeric instability."
                    .to_string(),
            );
        }
        warnings
    }

    /// Apply the configured erosive-burning augmentation to a base burn rate.
    fn apply_erosive(&self, r_b: f64, g: f64, a_port: f64) -> f64 {
        match self.opts.erosive_model {
            ErosiveModel::LenoirRobillard if g > 0.0 => {
                const ALPHA: f64 = 0.00003;
                const BETA: f64 = 50.0;
                let l_eff = self.grain.length() / 2.0;
                let log_term = -BETA * r_b * self.prop.density / g;
                let r_erosive = ALPHA * (g.powf(0.8) / l_eff.powf(0.2))
                    * log_term.max(-50.0).exp();
                r_b + r_erosive.max(0.0)
            }
            ErosiveModel::Jpl if g > 0.0 => {
                let k_jpl = if self.prop.k_erosive > 0.0 {
                    self.prop.k_erosive
                } else {
                    0.001
                };
                if g > self.prop.g_threshold {
                    r_b * (1.0 + k_jpl * (g - self.prop.g_threshold))
                } else {
                    r_b
                }
            }
            // Generic linear fallback, mirroring the final else-if in engine.ts.
            _ => {
                if self.opts.erosive_model != ErosiveModel::None
                    && g > self.prop.g_threshold
                    && self.prop.k_erosive > 0.0
                {
                    r_b * (1.0 + self.prop.k_erosive * (g - self.prop.g_threshold))
                } else {
                    r_b
                }
            }
        }
    }

    /// Evaluate the RHS of the coupled system at a trial state.
    fn derivs(&self, pc: f64, y: f64, vc: f64, at: f64, dt: f64) -> Derivs {
        let pc_eff = pc.max(PC_FLOOR);
        let ab = self.grain.burning_area(y);
        let a_port = self.grain.port_area(y);

        let r_b_base = self.prop.a * pc_eff.powf(self.prop.n);
        let mut r_b = r_b_base * self.temp_corr;

        let m_dot_ideal = self.prop.density * ab * r_b;
        let g = if a_port > 0.0 { m_dot_ideal / a_port } else { 0.0 };

        r_b = self.apply_erosive(r_b, g, a_port);

        if ab <= 0.0 {
            r_b = 0.0;
        }

        let mut m_dot_in = self.prop.density * ab * r_b;
        let m_dot_igniter = match &self.igniter {
            Some(ig) => ig.m_dot(pc_eff, dt),
            None => 0.0,
        };
        m_dot_in += m_dot_igniter;

        let c_d_eff = self.prop.c_d / self.opts.c_star_eff;
        let m_dot_out = c_d_eff * pc_eff * at;

        let d_vc = ab * r_b;
        let rt = self.prop.r_spec * self.prop.flame_temp;
        let vc_safe = vc.max(V_C_FLOOR);

        // dPc/dt = (RT/Vc)(m_in - m_out) - (Pc/Vc) dVc/dt
        let d_pc = (rt / vc_safe) * (m_dot_in - m_dot_out) - (pc_eff / vc_safe) * d_vc;

        Derivs {
            d_pc,
            d_y: r_b,
            d_vc,
            m_dot_igniter,
            ab,
            a_port,
            g,
            m_dot_out,
            m_dot_ideal,
        }
    }

    pub fn run(&mut self) -> RunOutput {
        let mut warnings = self.check_stability();

        let mut time = 0.0_f64;
        let mut y = 0.0_f64;
        let mut pc = self.opts.ambient_pressure;
        let pa = self.opts.ambient_pressure;
        let dt = self.opts.dt;

        let mut v_c = (self.grain.port_area(y) * self.grain.length()).max(V_C_FLOOR);
        let pr_ratio = self.solve_pe_pc();
        let gamma = self.prop.gamma;
        let mut total_propellant = 0.0_f64;

        // Critical pressure ratio for choked flow.
        let crit = ((gamma + 1.0) / 2.0).powf(gamma / (gamma - 1.0));

        let mut data: Vec<f64> = Vec::new();
        let mut rows = 0usize;

        loop {
            let at = (std::f64::consts::PI / 4.0) * self.d_t * self.d_t;
            let ab_now = self.grain.burning_area(y);

            if ab_now <= 0.0 && pc <= pa * 1.01 {
                break;
            }

            // ---- RK4 on (Pc, y, V_c) ----
            let h = dt;
            let k1 = self.derivs(pc, y, v_c, at, h);
            let k2 = self.derivs(
                pc + 0.5 * h * k1.d_pc,
                y + 0.5 * h * k1.d_y,
                v_c + 0.5 * h * k1.d_vc,
                at,
                h,
            );
            let k3 = self.derivs(
                pc + 0.5 * h * k2.d_pc,
                y + 0.5 * h * k2.d_y,
                v_c + 0.5 * h * k2.d_vc,
                at,
                h,
            );
            let k4 = self.derivs(
                pc + h * k3.d_pc,
                y + h * k3.d_y,
                v_c + h * k3.d_vc,
                at,
                h,
            );

            let w = |a: f64, b: f64, c: f64, d: f64| (a + 2.0 * b + 2.0 * c + d) / 6.0;

            // Cumulative propellant generated uses the pre-erosive ideal rate,
            // matching the TypeScript reference.
            total_propellant += w(
                k1.m_dot_ideal,
                k2.m_dot_ideal,
                k3.m_dot_ideal,
                k4.m_dot_ideal,
            ) * h;

            let new_pc = pc + h * w(k1.d_pc, k2.d_pc, k3.d_pc, k4.d_pc);
            let new_y = y + h * w(k1.d_y, k2.d_y, k3.d_y, k4.d_y);
            let new_vc = v_c + h * w(k1.d_vc, k2.d_vc, k3.d_vc, k4.d_vc);

            if !new_pc.is_finite() {
                warnings.push(
                    "Critical: pressure solution diverged (non-finite). Simulation stopped early. \
                     Check grain geometry, throat diameter, and propellant burn-rate coefficients."
                        .to_string(),
                );
                break;
            }

            pc = new_pc.max(PC_FLOOR);
            y = new_y;
            v_c = new_vc.max(V_C_FLOOR);

            // Igniter consumption, RK4-weighted across the stages.
            if let Some(ig) = self.igniter.as_mut() {
                let m_ign = w(
                    k1.m_dot_igniter,
                    k2.m_dot_igniter,
                    k3.m_dot_igniter,
                    k4.m_dot_igniter,
                );
                ig.mass_consumed += m_ign * h;
            }

            // ---- Auxiliary Euler updates (order matches engine.ts) ----
            let erosion_rate = self
                .nozzle
                .step(pc, self.d_t, self.prop.flame_temp, time, h);
            self.d_t += erosion_rate * h;
            time += h;

            // ---- Thrust ----
            let pe = pc * pr_ratio;
            let term1 = (2.0 * gamma * gamma) / (gamma - 1.0);
            let term2 = (2.0 / (gamma + 1.0)).powf((gamma + 1.0) / (gamma - 1.0));
            let mut term3 = 1.0 - (pe / pc).powf((gamma - 1.0) / gamma);
            if term3 < 0.0 {
                term3 = 0.0;
            }

            // No thrust until the nozzle chokes; the isentropic C_F relation does
            // not hold while the throat is subsonic.
            let is_choked = pc >= pa * crit;
            let c_f_ideal =
                (term1 * term2 * term3).sqrt() + ((pe - pa) / pc) * self.expansion_ratio;
            // A real over-expanded nozzle separates rather than pulling backwards.
            let c_f = if is_choked {
                (c_f_ideal * self.opts.cf_eff).max(0.0)
            } else {
                0.0
            };
            let thrust = c_f * pc * at;

            data.extend_from_slice(&[
                time,
                k1.ab,
                pc,
                thrust,
                k1.g,
                at,
                k1.a_port,
                y,
                k1.m_dot_out,
                total_propellant,
            ]);
            rows += 1;

            if time > self.opts.max_time {
                break;
            }
        }

        RunOutput {
            data,
            rows,
            warnings,
        }
    }
}
