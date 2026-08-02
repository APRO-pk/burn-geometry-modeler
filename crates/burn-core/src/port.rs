//! Quasi-1-D axial port flow.
//!
//! The 0-D solver in `sim.rs` treats the whole chamber as one well-stirred
//! volume at a single pressure, with one lumped mass flux driving erosive
//! burning. That is adequate for short, fat grains and wrong for long, thin
//! ones: in a high-L/D port the gas accelerates from rest at the head end to a
//! substantial Mach number at the nozzle end, which
//!
//!   * drops the static pressure along the bore (so the aft grain burns at a
//!     lower local pressure than the head), and
//!   * concentrates mass flux at the aft end (so erosive burning is strongest
//!     there, coning the port out and driving the classic aft-end burnout).
//!
//! This module resolves that axially. The port is divided into `n` equal cells
//! along the grain, each with its own web `y_i`, and the flow is marched from
//! the head end (closed, u = 0) to the nozzle end.
//!
//! # Model
//!
//! The march is quasi-steady: at each timestep the gas is assumed to reach a
//! steady profile instantly, which holds because gas residence time in the port
//! (~ms) is far shorter than the burn (~s). Per cell:
//!
//!   mass added        m_dot_i = m_dot_{i-1} + rho_p * r_b,i * A_b,i
//!   local mass flux   G_i     = m_dot_i / A_port,i
//!   momentum          P_i (1 + gamma M_i^2) = P_head - (friction so far)
//!
//! The momentum relation is the constant-area duct with wall mass injection:
//! propellant gas enters perpendicular to the axis and so carries no axial
//! momentum, giving `P + rho*u^2 = const` along the port. With `u = 0` at the
//! closed head end that constant is the head-end pressure. Friction is added as
//! a Darcy term `f * (dx/D_h) * (rho u^2 / 2)`.
//!
//! Written in terms of Mach number the relation solves in closed form (see
//! `march`), which also exposes the physical limit: such a port cannot exceed
//! `M = 1/sqrt(gamma)`, beyond which the bore itself is thermally choked.
//!
//! Burn rate at cell `i` uses the LOCAL static pressure and the LOCAL mass flux,
//! which is the entire point of the exercise.
//!
//! # Validity
//!
//! This is a subsonic, quasi-steady, single-temperature model. It is not valid
//! once the port itself approaches choking; `MarchResult::max_mach` is reported
//! so the caller can warn. Gas temperature is taken as the flame temperature
//! everywhere (no heat loss to the walls), matching the 0-D model.

use crate::grain::Grain;
use crate::propellant::Propellant;
use crate::sim::ErosiveModel;

/// Per-station profile of the last march. Reused between steps to keep the
/// integrator allocation-free.
#[derive(Debug, Clone, Default)]
pub struct PortProfile {
    /// Static pressure at each cell's downstream face (Pa).
    pub pressure: Vec<f64>,
    /// Mass flux at each cell's downstream face (kg/m^2/s).
    pub mass_flux: Vec<f64>,
    /// Total burn rate, erosive term included (m/s).
    pub burn_rate: Vec<f64>,
    /// Erosive augmentation alone, i.e. total minus the pressure-driven base.
    pub erosive_rate: Vec<f64>,
    /// Cumulative mass flow past each cell's downstream face (kg/s).
    pub mass_flow: Vec<f64>,
    /// Port cross-sectional area at each cell (m^2).
    pub port_area: Vec<f64>,
    /// Web burned at each cell at the instant of the march. Included so a
    /// snapshot taken mid-burn shows the port coning out towards the aft end;
    /// the end-of-run web cannot show it, because by then every station has
    /// reached burnout and the differences have been clamped away.
    pub web: Vec<f64>,
}

impl PortProfile {
    pub fn with_stations(n: usize) -> Self {
        Self {
            pressure: vec![0.0; n],
            mass_flux: vec![0.0; n],
            burn_rate: vec![0.0; n],
            erosive_rate: vec![0.0; n],
            mass_flow: vec![0.0; n],
            port_area: vec![0.0; n],
            web: vec![0.0; n],
        }
    }

    pub fn len(&self) -> usize {
        self.pressure.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pressure.is_empty()
    }
}

/// Aggregates the caller needs after a march.
#[derive(Debug, Clone, Copy, Default)]
pub struct MarchResult {
    /// Total propellant mass generation rate over the whole grain (kg/s).
    pub m_dot_total: f64,
    /// Total burning area over the whole grain (m^2).
    pub burning_area: f64,
    /// Static pressure at the aft end of the port (Pa).
    pub p_aft: f64,
    /// Stagnation pressure presented to the nozzle (Pa).
    pub p0_nozzle: f64,
    /// Mach number at the aft end of the port.
    pub mach_aft: f64,
    /// Largest Mach number anywhere in the port.
    pub max_mach: f64,
    /// Mass flux at the aft end (kg/m^2/s), the value that drives aft erosion.
    pub g_aft: f64,
    /// Volume creation rate from burn-back, sum of A_b,i * r_b,i (m^3/s).
    pub d_volume: f64,
    /// Port area at the aft end (m^2).
    pub a_port_aft: f64,
}

/// Floor on hydraulic diameter (m), so a burned-out cell cannot divide by zero.
const D_H_FLOOR: f64 = 1e-6;

/// Per-station Lenoir-Robillard constants, as in the 0-D path.
const LR_ALPHA: f64 = 0.00003;
const LR_BETA: f64 = 50.0;

/// Inputs that do not change during a march.
pub struct MarchInputs<'a> {
    pub grain: &'a Grain,
    pub prop: &'a Propellant,
    pub temp_corr: f64,
    pub erosive: ErosiveModel,
    pub friction_factor: f64,
}

/// March the port from the head end to the nozzle end.
///
/// `webs[i]` is the web already burned at station `i`; `head_pressure` is the
/// stagnation pressure at the closed forward end. Writes the per-station profile
/// into `out` and returns the aggregates.
pub fn march(
    inp: &MarchInputs,
    head_pressure: f64,
    webs: &[f64],
    out: &mut PortProfile,
) -> MarchResult {
    let n = webs.len();
    debug_assert_eq!(out.len(), n);

    let prop = inp.prop;
    let grain = inp.grain;
    let rt = prop.r_spec * prop.flame_temp;
    let gamma = prop.gamma;
    // Ceiling on port Mach number for constant-area flow with wall mass
    // addition; see the momentum block below.
    let mach_choke = 1.0 / gamma.sqrt();

    let length = grain.length();
    let dx = if n > 0 { length / n as f64 } else { 0.0 };

    let mut res = MarchResult::default();
    let mut m_dot = 0.0_f64;
    let mut friction_total = 0.0_f64;
    // Static pressure at the upstream face of the current cell. The head end is
    // closed, so there the static pressure is the head-end stagnation pressure.
    let mut p_upstream = head_pressure;

    for i in 0..n {
        let y = webs[i];

        // ---- geometry of this cell ----
        let a_port = grain.port_area(y).max(1e-12);
        let perim = grain.wetted_perimeter(y);
        let d_h = if perim > 0.0 {
            (4.0 * a_port / perim).max(D_H_FLOOR)
        } else {
            D_H_FLOOR
        };

        // Lateral area is spread evenly over the stations; end-face area (BATES
        // only) is split between the first and last cell, where those faces are.
        let mut a_burn = grain.lateral_area(y) / n as f64;
        let end_area = grain.end_area(y);
        if end_area > 0.0 && (i == 0 || i + 1 == n) {
            // With a single station both halves land on the same cell.
            a_burn += if n == 1 { end_area } else { end_area / 2.0 };
        }

        // ---- burn rate from the LOCAL upstream pressure ----
        let p_for_burn = p_upstream.max(crate::sim::PC_FLOOR);
        let r_b_base = prop.a * p_for_burn.powf(prop.n) * inp.temp_corr;

        // Provisional mass flux using the base rate, so the erosive term has a
        // flux to work with; the flux is then recomputed with the augmented rate.
        let m_dot_cell_base = prop.density * a_burn * r_b_base;
        let g_provisional = (m_dot + m_dot_cell_base) / a_port;

        let r_b = apply_erosive(
            inp.erosive,
            r_b_base,
            g_provisional,
            d_h,
            prop.density,
            prop.k_erosive,
            prop.g_threshold,
        );
        let r_b = if a_burn > 0.0 { r_b } else { 0.0 };

        // ---- mass bookkeeping ----
        let m_dot_cell = prop.density * a_burn * r_b;
        m_dot += m_dot_cell;
        let g = m_dot / a_port;

        // ---- momentum ----
        //
        // The balance is P + rho*u^2 = P_head - (friction so far), measured from
        // the closed head end where u = 0. Substituting the ideal gas law makes
        // it exactly solvable rather than something to iterate:
        //
        //   rho u^2 = gamma P M^2   =>   P (1 + gamma M^2) = P_avail
        //   G       = rho u = P M sqrt(gamma / RT)
        //
        // Eliminating P leaves a quadratic in M whose subsonic root is taken
        // below. Solving it this way matters: iterating `P = P_avail - G^2/rho`
        // with rho tied to P diverges as soon as gamma*M^2 approaches 1, driving
        // the static pressure to its floor and the Mach number to nonsense --
        // which is a numerical artefact, not the physical choke.
        //
        // The real limit falls out of the discriminant: a constant-area port
        // with wall mass addition cannot exceed M = 1/sqrt(gamma) (~0.94 for
        // gamma = 1.13). Past that the flow is thermally choked in the BORE, and
        // the model is outside its range -- reported through `max_mach` so the
        // caller can warn.
        let p_avail = (head_pressure - friction_total).max(crate::sim::PC_FLOOR);
        let k = g * (rt / gamma).sqrt() / p_avail;
        let disc = 1.0 - 4.0 * gamma * k * k;
        let mach = if k <= 0.0 {
            0.0
        } else if disc <= 0.0 {
            mach_choke // bore-choked: pin at the limit and let the caller warn
        } else {
            // Subsonic root of gamma*k*M^2 - M + k = 0.
            (1.0 - disc.sqrt()) / (2.0 * gamma * k)
        };

        let p_static = (p_avail / (1.0 + gamma * mach * mach)).max(crate::sim::PC_FLOOR);

        // Darcy friction over this cell, carried forward as a head loss.
        friction_total +=
            inp.friction_factor * (dx / d_h) * (gamma * p_static * mach * mach / 2.0);

        out.pressure[i] = p_static;
        out.mass_flux[i] = g;
        out.burn_rate[i] = r_b;
        out.erosive_rate[i] = (r_b - r_b_base).max(0.0);
        out.mass_flow[i] = m_dot;
        out.port_area[i] = a_port;
        out.web[i] = y;

        res.burning_area += a_burn;
        res.d_volume += a_burn * r_b;
        res.max_mach = res.max_mach.max(mach);

        if i + 1 == n {
            res.p_aft = p_static;
            res.mach_aft = mach;
            res.g_aft = g;
            res.a_port_aft = a_port;

            // Isentropic stagnation pressure presented to the nozzle -- what the
            // nozzle actually discharges on. The Mach number is bounded by the
            // choke limit above, so this cannot run away; it is additionally
            // capped at the head-end pressure, which is a hard physical bound,
            // since mass addition and friction can only DESTROY stagnation
            // pressure along the port, never create it.
            let p0 =
                p_static * (1.0 + (gamma - 1.0) / 2.0 * mach * mach).powf(gamma / (gamma - 1.0));
            res.p0_nozzle = p0.min(head_pressure).max(crate::sim::PC_FLOOR);
        }

        p_upstream = p_static;
    }

    res.m_dot_total = m_dot;

    if n == 0 {
        res.p_aft = head_pressure;
        res.p0_nozzle = head_pressure;
        res.a_port_aft = grain.port_area(0.0);
    }

    res
}

/// Erosive-burning augmentation for one station.
///
/// Unlike the 0-D path -- which reproduces the TypeScript reference's use of
/// `grain_length / 2` as the Lenoir-Robillard length scale -- this uses the
/// LOCAL hydraulic diameter, which is the length scale the correlation is
/// actually written against. That makes the two models differ slightly even
/// with no pressure gradient, so the "quasi-1-D collapses onto 0-D" test uses
/// no erosive burning to isolate the axial effect.
fn apply_erosive(
    model: ErosiveModel,
    r_b: f64,
    g: f64,
    d_h: f64,
    prop_density: f64,
    k_erosive: f64,
    g_threshold: f64,
) -> f64 {
    if g <= 0.0 {
        return r_b;
    }
    match model {
        ErosiveModel::None => r_b,
        ErosiveModel::LenoirRobillard => {
            // r_e = alpha * G^0.8 / D^0.2 * exp(-beta * rho_p * r_b / G)
            let log_term = -LR_BETA * r_b * prop_density / g;
            let r_erosive =
                LR_ALPHA * (g.powf(0.8) / d_h.powf(0.2)) * log_term.max(-50.0).exp();
            r_b + r_erosive.max(0.0)
        }
        ErosiveModel::Jpl => {
            let k = if k_erosive > 0.0 { k_erosive } else { 0.001 };
            if g > g_threshold {
                r_b * (1.0 + k * (g - g_threshold))
            } else {
                r_b
            }
        }
    }
}
