//! Closed-form pressure-vessel mechanics for the motor case.
//!
//! This replaces a placeholder that computed "bending stress" as a hard-coded
//! 1.3x the hoop stress and described itself in its own comments as a proxy for
//! the FEA colour map. Everything here is a standard closed-form result with a
//! citable derivation, and every reported number carries the assumption it was
//! computed under.
//!
//! # What is modelled
//!
//! * **Lame thick-wall cylinder** -- the exact elasticity solution for hoop,
//!   radial and axial stress through the wall of a closed-end cylinder under
//!   internal pressure. Valid at any radius ratio, unlike the thin-wall `pR/t`
//!   formula, which is a limit of it.
//!
//! * **Cylindrical-shell edge bending** -- the real discontinuity stress where
//!   the case meets a stiff closure. A bulkhead restrains the radial growth the
//!   pressurised cylinder would otherwise undergo, so the shell bends locally.
//!   This is governed by the attenuation parameter
//!   `beta = [3(1-nu^2)/(R^2 t^2)]^(1/4)`, and the disturbance decays over a few
//!   multiples of `1/beta`.
//!
//! * **Bolted closure** -- axial pressure load shared over the bolt circle, with
//!   the distinction between nominal shank area and thread tensile-stress area,
//!   plus thread-engagement and flange shear-out checks.
//!
//! # What is NOT modelled
//!
//! No thermal stress, no fatigue, no stress concentrations at ports or holes, no
//! weld or bond-line strength, and no buckling. Composite cases are computed
//! with isotropic relations, which is flagged rather than silently applied: a
//! filament-wound case is orthotropic and fails by a fibre-direction criterion
//! that these formulas cannot express.

use serde::Deserialize;

/// Below this mean-radius-to-thickness ratio the thin-wall approximation is not
/// considered applicable. The usual engineering threshold is 10 (equivalently
/// D/t = 20).
const THIN_WALL_RATIO: f64 = 10.0;

/// Ratio of thread tensile-stress area to nominal shank area, for ISO coarse
/// threads. Derived from A_t = 0.7854*(d - 0.9382*p)^2 with a representative
/// coarse pitch p ~ 0.15d, which holds to a few percent from M5 to M12.
const THREAD_STRESS_AREA_RATIO: f64 = 0.7386;

/// Von Mises shear yield fraction, for the shear-out check.
const SHEAR_YIELD_FRACTION: f64 = 0.577;

#[derive(Debug, Clone, Deserialize)]
pub struct BoltConfig {
    pub count: f64,
    /// Nominal (shank) diameter, m.
    pub diameter: f64,
    /// Bolt material yield stress, Pa.
    pub yield_stress: f64,
    /// Distance from bolt centre to the flange edge, m. Used for shear-out.
    /// Defaults to the usual 1.5x diameter minimum if not supplied.
    #[serde(default)]
    pub edge_distance: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StructuralConfig {
    /// Peak internal pressure, Pa GAUGE (the analysis takes external pressure
    /// as zero, so this must already be relative to ambient).
    pub max_pressure: f64,
    /// Case bore radius, m.
    pub inner_radius: f64,
    /// Wall thickness, m.
    pub wall_thickness: f64,
    /// Case material yield stress, Pa.
    pub yield_stress: f64,
    /// Case material Young's modulus, Pa.
    pub youngs_modulus: f64,
    #[serde(default = "default_poisson")]
    pub poissons_ratio: f64,
    /// Free-text material name. Only used to decide whether to raise the
    /// isotropy caveat for composites.
    #[serde(default)]
    pub material: String,
    /// Case length, m. Bounds the edge-bending scan; optional.
    #[serde(default)]
    pub case_length: Option<f64>,
    #[serde(default)]
    pub bolts: Option<BoltConfig>,
    #[serde(default = "default_wall_stations")]
    pub wall_stations: usize,
    #[serde(default = "default_axial_stations")]
    pub axial_stations: usize,
}

fn default_poisson() -> f64 {
    0.33
}
fn default_wall_stations() -> usize {
    21
}
fn default_axial_stations() -> usize {
    120
}

/// Stress state at one point, in the principal directions of an axisymmetric
/// pressure vessel. All Pa.
#[derive(Debug, Clone, Copy, Default)]
pub struct StressState {
    /// Radius (Lame) or axial distance from the junction (edge bending), m.
    pub position: f64,
    pub hoop: f64,
    pub radial: f64,
    pub axial: f64,
    pub von_mises: f64,
}

/// Von Mises equivalent stress from the three principal stresses.
pub fn von_mises(hoop: f64, radial: f64, axial: f64) -> f64 {
    let a = hoop - radial;
    let b = radial - axial;
    let c = axial - hoop;
    (0.5 * (a * a + b * b + c * c)).sqrt()
}

// --- Lame thick-wall cylinder ---------------------------------------------

pub struct LameResult {
    pub profile: Vec<StressState>,
    pub inner: StressState,
    pub outer: StressState,
    /// Uniform through the wall for a closed-end cylinder.
    pub axial: f64,
    /// Thin-wall hoop stress at the MEAN radius, p*R_mean/t, for comparison.
    pub thin_wall_hoop: f64,
    /// Relative error the thin-wall formula would make against the true peak.
    pub thin_wall_error: f64,
    pub r_mean_over_t: f64,
    pub thin_wall_applicable: bool,
}

/// Exact elasticity solution for a closed-end thick cylinder under internal
/// pressure, external pressure zero.
///
///   sigma_hoop(r)   = p a^2 / (b^2 - a^2) * (1 + b^2/r^2)
///   sigma_radial(r) = p a^2 / (b^2 - a^2) * (1 - b^2/r^2)
///   sigma_axial     = p a^2 / (b^2 - a^2)
///
/// Hoop stress is largest at the BORE and falls through the wall, which is why
/// reporting a single number for "the hoop stress" hides where the case will
/// actually yield first.
pub fn lame(cfg: &StructuralConfig) -> LameResult {
    let p = cfg.max_pressure;
    let a = cfg.inner_radius;
    let b = cfg.inner_radius + cfg.wall_thickness;
    let t = cfg.wall_thickness;

    let denom = b * b - a * a;
    let k = if denom > 0.0 { p * a * a / denom } else { 0.0 };
    let axial = k;

    let n = cfg.wall_stations.max(2);
    let mut profile = Vec::with_capacity(n);
    for i in 0..n {
        let r = a + (b - a) * (i as f64) / ((n - 1) as f64);
        let r2 = (r * r).max(1e-30);
        let hoop = k * (1.0 + b * b / r2);
        let radial = k * (1.0 - b * b / r2);
        profile.push(StressState {
            position: r,
            hoop,
            radial,
            axial,
            von_mises: von_mises(hoop, radial, axial),
        });
    }

    let inner = profile[0];
    let outer = profile[n - 1];

    let r_mean = a + t / 2.0;
    let thin_wall_hoop = if t > 0.0 { p * r_mean / t } else { f64::INFINITY };
    let thin_wall_error = if inner.hoop.abs() > 0.0 {
        (thin_wall_hoop - inner.hoop) / inner.hoop
    } else {
        0.0
    };
    let r_mean_over_t = if t > 0.0 { r_mean / t } else { f64::INFINITY };

    LameResult {
        profile,
        inner,
        outer,
        axial,
        thin_wall_hoop,
        thin_wall_error,
        r_mean_over_t,
        thin_wall_applicable: r_mean_over_t >= THIN_WALL_RATIO,
    }
}

// --- Cylindrical-shell edge bending ---------------------------------------

pub struct EdgeResult {
    /// Attenuation parameter, 1/m.
    pub beta: f64,
    /// 1/beta, the length over which the disturbance decays by 1/e.
    pub characteristic_length: f64,
    /// ~3/beta: beyond this the junction is not felt (membrane solution holds).
    pub decay_length: f64,
    /// Flexural rigidity, N*m.
    pub flexural_rigidity: f64,
    /// Edge moment at a clamped junction, N*m/m.
    pub m0: f64,
    /// Edge shear at a clamped junction, N/m.
    pub q0: f64,
    /// Peak axial bending stress at the junction, 6*M0/t^2, Pa.
    pub bending_stress: f64,
    /// Ratio of that to the far-field hoop stress. The placeholder this replaces
    /// asserted 1.3 unconditionally; the real value depends on R/t and nu.
    pub bending_to_hoop: f64,
    pub profile: Vec<StressState>,
    /// Worst point found along the scan.
    pub peak: StressState,
    /// Distance of the worst point from the junction, m.
    pub peak_location: f64,
    /// That distance expressed in characteristic lengths.
    pub peak_location_over_char: f64,
    /// Which surface the worst point is on.
    pub peak_surface: &'static str,
    /// Far-field membrane hoop stress, p*R/t.
    pub membrane_hoop: f64,
}

/// Discontinuity stress where the case is built into a stiff closure.
///
/// A long cylinder under internal pressure grows radially by
/// `delta = p R^2 / (E t)`. A rigid bulkhead holds the end at zero radial
/// displacement, and the shell bends over a short length to make up the
/// difference. For a clamped edge the standard solution is
///
///   w(x)  = delta * [1 - e^(-beta x) (cos beta x + sin beta x)]
///   M(x)  = M0 * e^(-beta x) (cos beta x - sin beta x),   M0 = p / (2 beta^2)
///   Q0    = -p / beta
///
/// Axial bending stress is `6M/t^2`, and the hoop direction picks up `nu` times
/// that through plate action. Because `w(0) = 0`, the membrane hoop stress
/// vanishes AT the junction and recovers to `pR/t` over roughly `3/beta` -- so
/// the junction trades hoop stress for bending stress rather than simply adding
/// to it, which is exactly what a fixed 1.3x multiplier cannot represent.
///
/// The moment reverses sign at `x = pi/(4 beta)`, past which the critical
/// surface swaps from bore to outer. The scan below covers both.
///
/// # On the 1.3x placeholder
///
/// The ratio of clamped-edge bending stress to far-field hoop stress is
///
///   (6 M0 / t^2) / (p R / t) = 3 / (beta^2 t R) = sqrt(3) / sqrt(1 - nu^2)
///
/// which is a CONSTANT, independent of R, t and p -- about 1.82 for metals. The
/// code this replaces hard-coded 1.3, so it understated the edge bending by
/// roughly 40% for every case, in the non-conservative direction. The constant
/// falls out only for a fully clamped edge on a long cylinder; the scan is still
/// needed because the peak COMBINED stress depends on how the recovering
/// membrane hoop stress stacks against the decaying bending stress.
pub fn edge_bending(cfg: &StructuralConfig) -> EdgeResult {
    let p = cfg.max_pressure;
    let t = cfg.wall_thickness;
    let nu = cfg.poissons_ratio;
    let e = cfg.youngs_modulus;
    // Shell theory is written about the mid-surface radius.
    let r = cfg.inner_radius + t / 2.0;

    let beta = if r > 0.0 && t > 0.0 {
        (3.0 * (1.0 - nu * nu) / (r * r * t * t)).powf(0.25)
    } else {
        0.0
    };
    let flexural_rigidity = e * t * t * t / (12.0 * (1.0 - nu * nu));

    let m0 = if beta > 0.0 { p / (2.0 * beta * beta) } else { 0.0 };
    let q0 = if beta > 0.0 { -p / beta } else { 0.0 };
    let bending_stress = if t > 0.0 { 6.0 * m0 / (t * t) } else { 0.0 };

    let membrane_hoop = if t > 0.0 { p * r / t } else { 0.0 };
    let membrane_axial = membrane_hoop / 2.0;

    let characteristic_length = if beta > 0.0 { 1.0 / beta } else { 0.0 };
    let decay_length = 3.0 * characteristic_length;

    // Scan far enough to pass the moment reversal and reach the membrane state.
    let mut span = 4.0 * decay_length;
    if let Some(l) = cfg.case_length {
        if l > 0.0 {
            span = span.min(l / 2.0);
        }
    }

    let n = cfg.axial_stations.max(2);
    let mut profile = Vec::with_capacity(n);
    let mut peak = StressState::default();
    let mut peak_surface = "bore";

    for i in 0..n {
        let x = span * (i as f64) / ((n - 1) as f64);
        let bx = beta * x;
        let damp = (-bx).exp();
        let w_ratio = 1.0 - damp * (bx.cos() + bx.sin());
        let moment = m0 * damp * (bx.cos() - bx.sin());
        let sigma_b = if t > 0.0 { 6.0 * moment / (t * t) } else { 0.0 };

        let hoop_mem = membrane_hoop * w_ratio;

        // Bore surface: bending adds axially (the restrained edge curves away
        // from the axis, putting the inner fibre in tension), and the radial
        // stress there is the applied pressure acting inwards.
        let bore = StressState {
            position: x,
            hoop: hoop_mem + nu * sigma_b,
            radial: -p,
            axial: membrane_axial + sigma_b,
            von_mises: 0.0,
        };
        let bore_vm = von_mises(bore.hoop, bore.radial, bore.axial);

        // Outer surface: opposite bending fibre, free of radial stress.
        let outer = StressState {
            position: x,
            hoop: hoop_mem - nu * sigma_b,
            radial: 0.0,
            axial: membrane_axial - sigma_b,
            von_mises: 0.0,
        };
        let outer_vm = von_mises(outer.hoop, outer.radial, outer.axial);

        let (worse, surface, vm) = if bore_vm >= outer_vm {
            (bore, "bore", bore_vm)
        } else {
            (outer, "outer", outer_vm)
        };
        let point = StressState {
            von_mises: vm,
            ..worse
        };
        if vm > peak.von_mises {
            peak = point;
            peak_surface = surface;
        }
        profile.push(point);
    }

    EdgeResult {
        beta,
        characteristic_length,
        decay_length,
        flexural_rigidity,
        m0,
        q0,
        bending_stress,
        bending_to_hoop: if membrane_hoop > 0.0 {
            bending_stress / membrane_hoop
        } else {
            0.0
        },
        peak_location: peak.position,
        peak_location_over_char: if characteristic_length > 0.0 {
            peak.position / characteristic_length
        } else {
            0.0
        },
        peak_surface,
        peak,
        profile,
        membrane_hoop,
    }
}

// --- Bolted closure --------------------------------------------------------

pub struct BoltResult {
    pub count: f64,
    pub diameter: f64,
    /// Total axial force the closure must react, N.
    pub total_force: f64,
    pub force_per_bolt: f64,
    pub nominal_area: f64,
    pub stress_area: f64,
    /// Stress on the plain shank area -- optimistic for a threaded fastener.
    pub nominal_stress: f64,
    /// Stress on the thread tensile-stress area -- the number to design to.
    pub stress_area_stress: f64,
    pub safety_factor_nominal: f64,
    pub safety_factor_stress_area: f64,
    /// Minimum thread engagement so the bolt fails in tension, not by stripping.
    pub min_engagement_steel: f64,
    pub min_engagement_aluminium: f64,
    pub edge_distance: f64,
    pub min_edge_distance: f64,
    /// Flange tear-out area per bolt, m^2.
    pub shear_out_area: f64,
    pub shear_out_stress: f64,
    pub safety_factor_shear_out: f64,
}

/// Bolt tension, thread engagement and flange shear-out.
///
/// The pressure load is taken over the BORE area: the closure only sees pressure
/// where the case is open. (The placeholder used the case outer radius, which
/// overstates the load by `(r_o/r_i)^2`.)
pub fn bolts(cfg: &StructuralConfig, b: &BoltConfig) -> BoltResult {
    let a = cfg.inner_radius;
    let total_force = cfg.max_pressure * std::f64::consts::PI * a * a;
    let count = b.count.max(1.0);
    let force_per_bolt = total_force / count;

    let nominal_area = std::f64::consts::PI * (b.diameter / 2.0).powi(2);
    let stress_area = nominal_area * THREAD_STRESS_AREA_RATIO;

    let nominal_stress = if nominal_area > 0.0 {
        force_per_bolt / nominal_area
    } else {
        f64::INFINITY
    };
    let stress_area_stress = if stress_area > 0.0 {
        force_per_bolt / stress_area
    } else {
        f64::INFINITY
    };

    // Shear-out: the flange material behind each bolt tears along two planes of
    // length `edge_distance` through the wall thickness.
    let min_edge_distance = 1.5 * b.diameter;
    let edge_distance = b.edge_distance.unwrap_or(min_edge_distance);
    let shear_out_area = 2.0 * edge_distance * cfg.wall_thickness;
    let shear_out_stress = if shear_out_area > 0.0 {
        force_per_bolt / shear_out_area
    } else {
        f64::INFINITY
    };
    let shear_allow = SHEAR_YIELD_FRACTION * cfg.yield_stress;

    BoltResult {
        count,
        diameter: b.diameter,
        total_force,
        force_per_bolt,
        nominal_area,
        stress_area,
        nominal_stress,
        stress_area_stress,
        safety_factor_nominal: safe_ratio(b.yield_stress, nominal_stress),
        safety_factor_stress_area: safe_ratio(b.yield_stress, stress_area_stress),
        // Rules of thumb: 1x diameter into steel, 2x into aluminium, so the
        // threads out-strength the bolt in tension.
        min_engagement_steel: b.diameter,
        min_engagement_aluminium: 2.0 * b.diameter,
        edge_distance,
        min_edge_distance,
        shear_out_area,
        shear_out_stress,
        safety_factor_shear_out: safe_ratio(shear_allow, shear_out_stress),
    }
}

fn safe_ratio(allowable: f64, actual: f64) -> f64 {
    if actual > 0.0 && actual.is_finite() {
        allowable / actual
    } else {
        f64::INFINITY
    }
}

// --- assembled analysis ----------------------------------------------------

pub struct StructuralResult {
    pub lame: LameResult,
    pub edge: EdgeResult,
    pub bolts: Option<BoltResult>,
    /// Worst von Mises anywhere considered, Pa.
    pub max_von_mises: f64,
    pub where_max: &'static str,
    pub safety_factor: f64,
    /// `yield/vm - 1`. Negative means the case yields.
    pub margin_of_safety: f64,
    /// Hoop strain at the bore, from the full 3-D Hooke's law.
    pub bore_hoop_strain: f64,
    /// Radial growth of the bore at peak pressure, m.
    pub bore_radial_growth: f64,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn analyze(cfg: &StructuralConfig) -> StructuralResult {
    let lame_res = lame(cfg);
    let edge_res = edge_bending(cfg);
    let bolt_res = cfg.bolts.as_ref().map(|b| bolts(cfg, b));

    // The junction governs unless the wall is thick enough that the bore does.
    let (max_von_mises, where_max) = if edge_res.peak.von_mises >= lame_res.inner.von_mises {
        (
            edge_res.peak.von_mises,
            "case-to-closure junction (edge bending)",
        )
    } else {
        (lame_res.inner.von_mises, "case bore (membrane)")
    };

    let safety_factor = safe_ratio(cfg.yield_stress, max_von_mises);
    let margin_of_safety = safety_factor - 1.0;

    // Hoop strain at the bore under the full triaxial state, not the uniaxial
    // shortcut the old code used.
    let e = cfg.youngs_modulus;
    let nu = cfg.poissons_ratio;
    let i = &lame_res.inner;
    let bore_hoop_strain = if e > 0.0 {
        (i.hoop - nu * (i.radial + i.axial)) / e
    } else {
        0.0
    };
    let bore_radial_growth = bore_hoop_strain * cfg.inner_radius;

    let mut assumptions = vec![
        "Lame closed-end thick-wall cylinder; external pressure taken as zero (pressures are gauge)."
            .to_string(),
        format!(
            "Linear elastic, isotropic, homogeneous material; nu = {:.2}.",
            nu
        ),
        "Static peak pressure only: no thermal stress, fatigue, stress concentrations, or buckling."
            .to_string(),
        format!(
            "Edge bending assumes a fully CLAMPED junction to a rigid closure, which bounds the \
             bending stress; a flexible or pinned closure would give less. Disturbance decays \
             within {:.1} mm of the joint.",
            edge_res.decay_length * 1000.0
        ),
    ];

    if lame_res.thin_wall_applicable {
        assumptions.push(format!(
            "Thin-wall regime (R_mean/t = {:.1} >= {:.0}): the pR/t formula would be within \
             {:.1}% of the exact bore hoop stress here, but the Lame value is reported.",
            lame_res.r_mean_over_t,
            THIN_WALL_RATIO,
            lame_res.thin_wall_error.abs() * 100.0
        ));
    } else {
        assumptions.push(format!(
            "THICK-wall regime (R_mean/t = {:.1} < {:.0}): the pR/t thin-wall formula is not \
             applicable and would be {:.1}% off at the bore. Thick-wall Lame is required.",
            lame_res.r_mean_over_t,
            THIN_WALL_RATIO,
            lame_res.thin_wall_error.abs() * 100.0
        ));
    }

    let mut warnings = Vec::new();

    // Edge bending comes from THIN-shell theory. On a thick wall the decay
    // length stops being large compared with the thickness, the through-wall
    // stress is no longer linear, and the result is not trustworthy -- so say
    // so rather than reporting it as though it were.
    if !lame_res.thin_wall_applicable {
        warnings.push(format!(
            "Edge-bending results are outside their validity: cylindrical-shell theory assumes a \
             thin wall (R_mean/t >= {:.0}) and this case is at {:.1}. The Lame stresses remain \
             exact, but the junction numbers should be treated as indicative only -- a thick \
             junction needs axisymmetric FEA.",
            THIN_WALL_RATIO, lame_res.r_mean_over_t
        ));
    }

    let material = cfg.material.to_ascii_lowercase();
    if material.contains("composite") || material.contains("carbon") || material.contains("fib") {
        warnings.push(
            "Composite case: these results use ISOTROPIC elasticity and a von Mises yield \
             criterion, neither of which applies to a filament-wound or laminated case. A real \
             composite is orthotropic, its strength depends on fibre orientation and stacking, \
             and it fails by a directional criterion (Tsai-Wu, max stress, or max strain) rather \
             than by yielding. Treat the numbers below as an isotropic-equivalent sanity check \
             only, and size the case from laminate analysis or test data."
                .to_string(),
        );
    }

    if safety_factor < 1.0 {
        warnings.push(format!(
            "Case yields at peak pressure: von Mises {:.1} MPa exceeds yield {:.1} MPa at the {} \
             (safety factor {:.2}).",
            max_von_mises / 1e6,
            cfg.yield_stress / 1e6,
            where_max,
            safety_factor
        ));
    } else if safety_factor < 1.5 {
        warnings.push(format!(
            "Safety factor {:.2} at the {} is below the customary 1.5 minimum for a pressure \
             vessel.",
            safety_factor, where_max
        ));
    }

    if let Some(b) = bolt_res.as_ref() {
        if b.safety_factor_stress_area < 1.5 {
            warnings.push(format!(
                "Bolt safety factor {:.2} on the thread tensile-stress area is below 1.5.",
                b.safety_factor_stress_area
            ));
        }
        if b.safety_factor_shear_out < 1.5 {
            warnings.push(format!(
                "Flange shear-out safety factor {:.2} is below 1.5. Increase the bolt edge \
                 distance (currently {:.1} mm) or the wall thickness.",
                b.safety_factor_shear_out,
                b.edge_distance * 1000.0
            ));
        }
    }

    StructuralResult {
        lame: lame_res,
        edge: edge_res,
        bolts: bolt_res,
        max_von_mises,
        where_max,
        safety_factor,
        margin_of_safety,
        bore_hoop_strain,
        bore_radial_growth,
        assumptions,
        warnings,
    }
}

/// Thin-wall sizing rule, kept as a DESIGN aid rather than an analysis result:
/// the wall a `pR/t` calculation would call for at the given safety factor. The
/// honest check is to feed the chosen wall back through `analyze`.
pub fn required_thickness_thin_wall(
    max_pressure: f64,
    inner_radius: f64,
    safety_factor: f64,
    yield_stress: f64,
) -> f64 {
    if yield_stress <= 0.0 {
        return f64::INFINITY;
    }
    max_pressure * inner_radius * safety_factor / yield_stress
}
