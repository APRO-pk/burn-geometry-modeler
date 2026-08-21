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

pub const N_FIELDS: usize = 11;

/// Which spatial model the solver uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum SolverModel {
    /// One well-stirred chamber volume at a single pressure, one lumped mass
    /// flux. Fast; the right choice for Monte Carlo sweeps and parameter scans.
    #[serde(rename = "0D")]
    ZeroD,
    /// Axially resolved port: per-station pressure, mass flux, erosive burning
    /// and web. Costs roughly `stations` times more per step.
    #[serde(rename = "quasi1D")]
    Quasi1D,
}

impl Default for SolverModel {
    fn default() -> Self {
        SolverModel::ZeroD
    }
}

fn default_stations() -> usize {
    20
}

/// Darcy friction factor for the port bore. A fully-developed turbulent pipe
/// flow at motor Reynolds numbers sits around 0.02-0.03; it is exposed as an
/// option rather than computed from a Blasius correlation because the gas
/// viscosity is not among the propellant inputs this tool collects.
fn default_friction_factor() -> f64 {
    0.02
}

/// Port Mach number above which the quasi-1-D assumptions start to fail.
const PORT_MACH_WARN: f64 = 0.9;
/// A near-choked port is only reported if it persists for at least this many
/// steps AND this fraction of the burn, so the ignition transient stays quiet.
const PORT_CHOKE_MIN_STEPS: usize = 10;
const PORT_CHOKE_MIN_FRACTION: f64 = 0.01;

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
    #[serde(default)]
    pub model: SolverModel,
    /// Number of axial stations for the quasi-1-D model. Ignored when 0-D.
    #[serde(default = "default_stations")]
    pub stations: usize,
    #[serde(default = "default_friction_factor")]
    pub friction_factor: f64,
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
            model: SolverModel::ZeroD,
            stations: default_stations(),
            friction_factor: default_friction_factor(),
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
    /// PropellantMassGen, PcNozzle.
    ///
    /// `Pc` is the head-end pressure and `PcNozzle` the stagnation pressure at
    /// the nozzle entry; they are equal in 0-D and differ in quasi-1-D.
    /// `PortMassFlux` and `PortArea` are aft-end values in quasi-1-D (the aft end
    /// is where mass flux peaks and erosion bites), and `y` is the mean web
    /// across stations.
    ///
    /// `PropellantMassGen` also differs between the models: 0-D integrates the
    /// pre-erosive rate (reproducing the TypeScript reference, and undercounting
    /// when erosive burning is on), quasi-1-D the actual rate. See `Q1dStage`.
    pub data: Vec<f64>,
    pub rows: usize,
    pub warnings: Vec<String>,
    /// Axial profiles. `None` for 0-D, which has no axial dimension.
    pub stations: Option<StationOutput>,
}

/// Axially resolved output from a quasi-1-D run.
pub struct StationOutput {
    pub count: usize,
    /// Station centres measured from the head end (m).
    pub x: Vec<f64>,
    /// Web burned at each station at the END of the run. Note that a grain that
    /// burns out completely ends up near-uniform here, because every station
    /// clamps at its web limit; `peak.web` is the one that shows the coning.
    pub web: Vec<f64>,
    /// The full station profile captured at the step of PEAK head-end pressure
    /// -- the design point. (For a progressive grain that is late in the burn,
    /// by which time the bore has grown and the axial gradient is past its
    /// strongest; the gradient over time is in the `Pc`/`PcNozzle` columns.)
    pub peak: crate::port::PortProfile,
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

    /// Exit/chamber pressure ratio for a given expansion ratio, by bisection on
    /// the area-ratio relation. Port of `_solve_pe_pc`.
    ///
    /// Takes `epsilon` as an argument rather than reading `self.expansion_ratio`
    /// because the expansion ratio is not constant once the throat ablates --
    /// see `current_expansion_ratio`.
    fn solve_pe_pc(&self, epsilon: f64) -> f64 {
        let gamma = self.prop.gamma;
        let big_gamma = self.prop.big_gamma;

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

    /// Expansion ratio for the CURRENT throat area.
    ///
    /// The old engine solved the exit-pressure ratio once at t = 0 and reused it
    /// for the whole burn, while simultaneously growing the throat by ablation.
    /// Those two cannot both be true: the exit area of a nozzle is fixed
    /// hardware, so as the throat erodes, `epsilon = A_e / A_t` FALLS. Holding
    /// epsilon fixed silently modelled a nozzle whose exit grew in lockstep with
    /// its throat, overstating C_F late in a burn with a heavily eroding throat.
    ///
    /// `exit_area` is captured from the initial geometry; the ratio is clamped at
    /// 1.0 because the isentropic area relation has no solution below it (and a
    /// nozzle whose throat has grown to its exit area no longer has a diverging
    /// section at all).
    fn current_expansion_ratio(&self, exit_area: f64, at: f64) -> f64 {
        if at <= 0.0 {
            return self.expansion_ratio.max(1.0);
        }
        (exit_area / at).max(1.0)
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
    ///
    /// `_a_port` is deliberately unused. Lenoir-Robillard is written against a
    /// port diameter, but the TypeScript reference this path reproduces uses
    /// `grain_length / 2` instead, and the 0-D path is frozen against it. The
    /// quasi-1-D path in port.rs uses the local hydraulic diameter, which is the
    /// length scale the correlation actually calls for.
    fn apply_erosive(&self, r_b: f64, g: f64, _a_port: f64) -> f64 {
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

        // Goes through Propellant so a piecewise law is honoured here and in
        // port.rs alike; identical to a * pc^n when no regimes are configured.
        let r_b_base = self.prop.base_burn_rate(pc_eff);
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
        match self.opts.model {
            SolverModel::ZeroD => self.run_0d(),
            SolverModel::Quasi1D => self.run_quasi1d(),
        }
    }

    fn run_0d(&mut self) -> RunOutput {
        let mut warnings = self.check_stability();

        let mut time = 0.0_f64;
        let mut y = 0.0_f64;
        let mut pc = self.opts.ambient_pressure;
        let pa = self.opts.ambient_pressure;
        let dt = self.opts.dt;

        let mut v_c = (self.grain.port_area(y) * self.grain.length()).max(V_C_FLOOR);
        // Fixed hardware: the exit area does not change as the throat ablates.
        let exit_area =
            self.expansion_ratio * (std::f64::consts::PI / 4.0) * self.d_t * self.d_t;
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
            // Both the pressure ratio and the pressure-thrust term are re-solved
            // every step against the CURRENT throat, so an ablating nozzle loses
            // expansion as it erodes instead of keeping its t = 0 value.
            let epsilon = self.current_expansion_ratio(exit_area, at);
            let pr_ratio = self.solve_pe_pc(epsilon);
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
            let c_f_ideal = (term1 * term2 * term3).sqrt() + ((pe - pa) / pc) * epsilon;
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
                // 0-D has no axial gradient, so the nozzle sees the chamber
                // pressure. The column exists so both models share a schema.
                pc,
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
            stations: None,
        }
    }

    /// Quasi-1-D solver.
    ///
    /// The state is the head-end pressure, the chamber volume, and ONE WEB PER
    /// STATION -- the last of these is what makes the model worth having, since
    /// stronger aft erosive burning regresses the aft web faster and cones the
    /// port out over the burn.
    ///
    /// The lumped mass balance is unchanged in form; what changes is that its
    /// two mass terms are now resolved:
    ///
    ///   * inflow is summed per station, each station burning at its own local
    ///     static pressure and local mass flux, and
    ///   * outflow discharges on the nozzle STAGNATION pressure at the aft end
    ///     rather than on the head-end pressure.
    ///
    /// Both reduce exactly to the 0-D terms as the port flow slows, which is the
    /// property the "short fat grain collapses onto 0-D" test pins.
    fn run_quasi1d(&mut self) -> RunOutput {
        let mut warnings = self.check_stability();

        let n = self.opts.stations.max(1);
        let dt = self.opts.dt;
        let pa = self.opts.ambient_pressure;
        let gamma = self.prop.gamma;
        let crit = ((gamma + 1.0) / 2.0).powf(gamma / (gamma - 1.0));
        let exit_area =
            self.expansion_ratio * (std::f64::consts::PI / 4.0) * self.d_t * self.d_t;

        let mut time = 0.0_f64;
        let mut pc = pa; // head-end stagnation pressure
        let mut webs = vec![0.0_f64; n];
        let mut v_c = (self.grain.port_area(0.0) * self.grain.length()).max(V_C_FLOOR);
        let mut total_propellant = 0.0_f64;

        // Scratch reused across steps and RK4 stages so the loop never allocates.
        let mut profile = crate::port::PortProfile::with_stations(n);
        let mut k_dy: Vec<Vec<f64>> = (0..4).map(|_| vec![0.0; n]).collect();
        let mut webs_trial = vec![0.0_f64; n];

        let mut data: Vec<f64> = Vec::new();
        let mut rows = 0usize;
        let mut peak_pc = f64::NEG_INFINITY;
        let mut peak_profile: Option<crate::port::PortProfile> = None;
        let mut choked_steps = 0usize;
        let mut peak_mach = 0.0_f64;

        loop {
            let at = (std::f64::consts::PI / 4.0) * self.d_t * self.d_t;

            let inp = self.march_inputs();
            let probe = crate::port::march(&inp, pc.max(PC_FLOOR), &webs, &mut profile);
            if probe.burning_area <= 0.0 && pc <= pa * 1.01 {
                break;
            }

            // ---- RK4 on (Pc_head, webs[..], V_c) ----
            let h = dt;
            let mut d_pc = [0.0_f64; 4];
            let mut d_vc = [0.0_f64; 4];
            let mut m_ign = [0.0_f64; 4];
            let mut m_generated = [0.0_f64; 4];

            for stage in 0..4 {
                let (pc_s, vc_s) = match stage {
                    0 => (pc, v_c),
                    1 => (pc + 0.5 * h * d_pc[0], v_c + 0.5 * h * d_vc[0]),
                    2 => (pc + 0.5 * h * d_pc[1], v_c + 0.5 * h * d_vc[1]),
                    _ => (pc + h * d_pc[2], v_c + h * d_vc[2]),
                };
                for i in 0..n {
                    webs_trial[i] = match stage {
                        0 => webs[i],
                        1 => webs[i] + 0.5 * h * k_dy[0][i],
                        2 => webs[i] + 0.5 * h * k_dy[1][i],
                        _ => webs[i] + h * k_dy[2][i],
                    };
                }

                let st = self.stage(pc_s, &webs_trial, vc_s, at, h, &mut profile);
                d_pc[stage] = st.d_pc;
                d_vc[stage] = st.d_vc;
                m_ign[stage] = st.m_dot_igniter;
                m_generated[stage] = st.m_dot_generated;
                k_dy[stage].copy_from_slice(&profile.burn_rate);
            }

            let w = |a: [f64; 4]| (a[0] + 2.0 * a[1] + 2.0 * a[2] + a[3]) / 6.0;

            total_propellant += w(m_generated) * h;
            let new_pc = pc + h * w(d_pc);
            let new_vc = v_c + h * w(d_vc);

            if !new_pc.is_finite() {
                warnings.push(
                    "Critical: pressure solution diverged (non-finite). Simulation stopped early. \
                     Check grain geometry, throat diameter, and propellant burn-rate coefficients."
                        .to_string(),
                );
                break;
            }

            pc = new_pc.max(PC_FLOOR);
            v_c = new_vc.max(V_C_FLOOR);
            for i in 0..n {
                webs[i] += h * (k_dy[0][i] + 2.0 * k_dy[1][i] + 2.0 * k_dy[2][i] + k_dy[3][i]) / 6.0;
            }

            if let Some(ig) = self.igniter.as_mut() {
                ig.mass_consumed += w(m_ign) * h;
            }

            let erosion_rate = self
                .nozzle
                .step(pc, self.d_t, self.prop.flame_temp, time, h);
            self.d_t += erosion_rate * h;
            time += h;

            // ---- reporting march at the end-of-step state ----
            // Unlike the 0-D path (which reports the step-START burning area
            // alongside the step-END pressure, a quirk inherited from the
            // TypeScript reference), every value in a quasi-1-D row is evaluated
            // at the same state, so head pressure, nozzle pressure and the
            // station profile are mutually consistent.
            let inp = self.march_inputs();
            let res = crate::port::march(&inp, pc, &webs, &mut profile);

            // Tallied rather than warned on immediately: the ignition fill
            // starts the port at ambient pressure, so the first millisecond or
            // two legitimately runs at a high Mach number on almost every motor.
            // Warning there would fire on every run and mean nothing. What
            // matters is a port that stays near choking for a real part of the
            // burn.
            if res.max_mach > PORT_MACH_WARN {
                choked_steps += 1;
            }
            peak_mach = peak_mach.max(res.max_mach);

            // ---- thrust, from NOZZLE STAGNATION conditions ----
            let p0 = res.p0_nozzle.max(PC_FLOOR);
            let epsilon = self.current_expansion_ratio(exit_area, at);
            let pr_ratio = self.solve_pe_pc(epsilon);
            let pe = p0 * pr_ratio;
            let term1 = (2.0 * gamma * gamma) / (gamma - 1.0);
            let term2 = (2.0 / (gamma + 1.0)).powf((gamma + 1.0) / (gamma - 1.0));
            let mut term3 = 1.0 - (pe / p0).powf((gamma - 1.0) / gamma);
            if term3 < 0.0 {
                term3 = 0.0;
            }
            let is_choked = p0 >= pa * crit;
            let c_f_ideal = (term1 * term2 * term3).sqrt() + ((pe - pa) / p0) * epsilon;
            let c_f = if is_choked {
                (c_f_ideal * self.opts.cf_eff).max(0.0)
            } else {
                0.0
            };
            let thrust = c_f * p0 * at;

            let c_d_eff = self.prop.c_d / self.opts.c_star_eff;
            let mean_web = webs.iter().sum::<f64>() / n as f64;

            if pc > peak_pc {
                peak_pc = pc;
                peak_profile = Some(profile.clone());
            }

            data.extend_from_slice(&[
                time,
                res.burning_area,
                pc,
                thrust,
                res.g_aft,
                at,
                res.a_port_aft,
                mean_web,
                c_d_eff * p0 * at,
                total_propellant,
                p0,
            ]);
            rows += 1;

            if time > self.opts.max_time {
                break;
            }
        }

        // Report a near-choked port only if it persisted; see the tally above.
        if rows > 0
            && choked_steps > PORT_CHOKE_MIN_STEPS
            && (choked_steps as f64) / (rows as f64) > PORT_CHOKE_MIN_FRACTION
        {
            warnings.push(format!(
                "Warning: the port ran at Mach {:.2} or above for {:.0}% of the burn (peak {:.2}). \
                 The quasi-1-D model assumes subsonic port flow and a constant-area port cannot \
                 exceed Mach {:.2}, so these results understate the real pressure drop. Increase \
                 the port area or reduce the grain L/D.",
                PORT_MACH_WARN,
                100.0 * (choked_steps as f64) / (rows as f64),
                peak_mach,
                1.0 / gamma.sqrt(),
            ));
        }

        RunOutput {
            data,
            rows,
            warnings,
            stations: Some(StationOutput {
                count: n,
                x: (0..n)
                    .map(|i| (i as f64 + 0.5) * self.grain.length() / n as f64)
                    .collect(),
                web: webs,
                peak: peak_profile.unwrap_or_else(|| crate::port::PortProfile::with_stations(n)),
            }),
        }
    }

    fn march_inputs(&self) -> crate::port::MarchInputs<'_> {
        crate::port::MarchInputs {
            grain: &self.grain,
            prop: &self.prop,
            temp_corr: self.temp_corr,
            erosive: self.opts.erosive_model,
            friction_factor: self.opts.friction_factor,
        }
    }

    /// One RK4 stage of the quasi-1-D system. The per-station burn rates (which
    /// are dy/dt) are left in `profile.burn_rate` for the caller to copy out.
    fn stage(
        &self,
        pc: f64,
        webs: &[f64],
        vc: f64,
        at: f64,
        dt: f64,
        profile: &mut crate::port::PortProfile,
    ) -> Q1dStage {
        let inp = self.march_inputs();
        let res = crate::port::march(&inp, pc.max(PC_FLOOR), webs, profile);

        let m_dot_igniter = match &self.igniter {
            Some(ig) => ig.m_dot(pc.max(PC_FLOOR), dt),
            None => 0.0,
        };
        let m_dot_in = res.m_dot_total + m_dot_igniter;

        let c_d_eff = self.prop.c_d / self.opts.c_star_eff;
        // The nozzle discharges on the stagnation pressure it actually sees.
        let m_dot_out = c_d_eff * res.p0_nozzle.max(PC_FLOOR) * at;

        let rt = self.prop.r_spec * self.prop.flame_temp;
        let vc_safe = vc.max(V_C_FLOOR);
        let d_pc = (rt / vc_safe) * (m_dot_in - m_dot_out)
            - (pc.max(PC_FLOOR) / vc_safe) * res.d_volume;

        Q1dStage {
            d_pc,
            d_vc: res.d_volume,
            m_dot_igniter,
            m_dot_generated: res.m_dot_total,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct Q1dStage {
    d_pc: f64,
    d_vc: f64,
    m_dot_igniter: f64,
    /// Propellant actually generated, erosive contribution included.
    ///
    /// This differs from the 0-D path on purpose. That path accumulates the
    /// PRE-erosive rate, faithfully reproducing the TypeScript reference, which
    /// means its `PropellantMassGen` column undercounts whenever erosive burning
    /// is switched on -- by ~17% on the long, thin test grain. The quasi-1-D
    /// model exists to take erosive burning seriously, so it reports the mass
    /// the motor really consumed, and mass conservation holds as a testable
    /// invariant instead of a near-miss.
    m_dot_generated: f64,
}
