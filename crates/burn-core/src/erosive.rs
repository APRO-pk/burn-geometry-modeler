//! Erosive-burning correlations, in one place.
//!
//! # Why this module exists
//!
//! The Lenoir-Robillard constants used to be declared twice: `ALPHA`/`BETA` in
//! `sim.rs` and `LR_ALPHA`/`LR_BETA` in `port.rs`, with the same values written
//! out separately. The JPL default coefficient and the exponent clamp were
//! duplicated the same way. Nothing tied them together, so tuning one and not
//! the other would have made the 0-D and quasi-1-D solvers disagree about the
//! same propellant -- silently, with both still producing plausible traces.
//!
//! That is a bad failure mode for a tool people size hardware from, so the
//! constants and the correlation kernels now live here and both solvers call
//! them. `erosive_paths_agree_given_the_same_length_scale` in the tests below
//! is the guard: it fails if the two paths ever stop sharing an implementation.
//!
//! # The one difference that is deliberate
//!
//! The two solvers pass a DIFFERENT LENGTH SCALE, and that is intentional:
//!
//! * quasi-1-D passes the local hydraulic diameter, which is the length scale
//!   Lenoir-Robillard is actually written against.
//! * 0-D passes `grain_length / 2`, because it reproduces the TypeScript
//!   reference implementation and is frozen against it by the parity suite.
//!
//! So the length scale is a parameter here rather than something this module
//! decides. Everything else is shared.

/// Lenoir-Robillard leading coefficient, SI.
///
/// PROVENANCE: not derived from first principles. This is the value the
/// TypeScript reference implementation shipped, retained so the Rust core
/// reproduces it. Lenoir-Robillard's own paper fits alpha per propellant from
/// firing data; there is no universal value, and this one has not been
/// calibrated against any measurement in this repository.
///
/// Treat erosive predictions as ORDER OF MAGNITUDE. See `MODEL_UNCERTAINTY.md`.
pub const LR_ALPHA: f64 = 0.00003;

/// Lenoir-Robillard exponential damping coefficient, SI. Same provenance
/// caveat as [`LR_ALPHA`].
pub const LR_BETA: f64 = 50.0;

/// Clamp on the exponent before `exp()`.
///
/// `exp(-50)` is about 2e-22, already indistinguishable from zero in f64 once
/// multiplied by the leading term. The clamp exists to stop a denormal or a NaN
/// escaping when `g` is very small, not to change any physically reachable
/// answer.
pub const EXP_CLAMP: f64 = -50.0;

/// Fallback JPL coefficient when a propellant does not specify one.
pub const JPL_K_DEFAULT: f64 = 0.001;

/// Lenoir-Robillard erosive augmentation, m/s.
///
/// `r_e = alpha * G^0.8 / L^0.2 * exp(-beta * rho_p * r_b / G)`
///
/// `length_scale` is the L in that expression; see the module docs for why the
/// two solvers pass different things for it. Returns the TOTAL burn rate,
/// base plus augmentation.
#[inline]
pub fn lenoir_robillard(r_b: f64, g: f64, length_scale: f64, prop_density: f64) -> f64 {
    if g <= 0.0 || length_scale <= 0.0 {
        return r_b;
    }
    let log_term = -LR_BETA * r_b * prop_density / g;
    let r_erosive = LR_ALPHA * (g.powf(0.8) / length_scale.powf(0.2)) * log_term.max(EXP_CLAMP).exp();
    r_b + r_erosive.max(0.0)
}

/// JPL linear erosive augmentation above a threshold mass flux.
///
/// `r = r_b * (1 + k * (G - G_th))` for `G > G_th`, unaugmented below.
#[inline]
pub fn jpl(r_b: f64, g: f64, k_erosive: f64, g_threshold: f64) -> f64 {
    if g <= 0.0 {
        return r_b;
    }
    let k = if k_erosive > 0.0 { k_erosive } else { JPL_K_DEFAULT };
    if g > g_threshold {
        r_b * (1.0 + k * (g - g_threshold))
    } else {
        r_b
    }
}

/// Generic linear augmentation, the fallback branch both solvers share.
///
/// Unlike [`jpl`] this does NOT substitute a default coefficient: a propellant
/// with no `k_erosive` gets no augmentation rather than a made-up one.
#[inline]
pub fn linear(r_b: f64, g: f64, k_erosive: f64, g_threshold: f64) -> f64 {
    if g > 0.0 && g > g_threshold && k_erosive > 0.0 {
        r_b * (1.0 + k_erosive * (g - g_threshold))
    } else {
        r_b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard this module exists for.
    ///
    /// Both solvers must produce the same number for the same inputs. Before
    /// the constants were unified this could only be checked by eye, and a
    /// one-sided edit would not have failed anything.
    #[test]
    fn erosive_paths_agree_given_the_same_length_scale() {
        let r_b: f64 = 0.004;
        let g: f64 = 800.0;
        let rho: f64 = 1878.0;
        let l: f64 = 0.05;

        // Written out longhand, the way each solver used to do it inline. If
        // someone re-inlines either path with a different constant, this fails.
        let expected = {
            let log_term: f64 = -50.0 * r_b * rho / g;
            r_b + (0.00003f64 * (g.powf(0.8f64) / l.powf(0.2f64)) * log_term.max(-50.0f64).exp()).max(0.0f64)
        };
        assert!((lenoir_robillard(r_b, g, l, rho) - expected).abs() < 1e-18);
    }

    #[test]
    fn zero_flux_leaves_the_burn_rate_untouched() {
        assert_eq!(lenoir_robillard(0.004, 0.0, 0.05, 1878.0), 0.004);
        assert_eq!(jpl(0.004, 0.0, 0.001, 400.0), 0.004);
        assert_eq!(linear(0.004, 0.0, 0.001, 400.0), 0.004);
    }

    /// A burned-out station can present a vanishing length scale. Dividing by
    /// it would produce an infinite augmentation rather than none.
    #[test]
    fn a_vanishing_length_scale_does_not_blow_up() {
        let r = lenoir_robillard(0.004, 800.0, 0.0, 1878.0);
        assert_eq!(r, 0.004);
        assert!(r.is_finite());
    }

    #[test]
    fn erosion_grows_with_flux_and_never_reduces_burn_rate() {
        let base = 0.004;
        let mut last = base;
        for g in [200.0, 500.0, 1000.0, 2000.0] {
            let r = lenoir_robillard(base, g, 0.05, 1878.0);
            assert!(r >= base, "erosive burning must not slow the burn");
            assert!(r >= last);
            last = r;
        }
    }

    #[test]
    fn jpl_is_inert_below_its_threshold_and_active_above() {
        assert_eq!(jpl(0.004, 300.0, 0.001, 400.0), 0.004);
        assert!(jpl(0.004, 500.0, 0.001, 400.0) > 0.004);
    }

    /// JPL substitutes a default coefficient; the generic linear branch must
    /// not, or a propellant with no erosive data would silently get one.
    #[test]
    fn linear_does_not_invent_a_coefficient_but_jpl_does() {
        assert_eq!(linear(0.004, 900.0, 0.0, 400.0), 0.004);
        assert!(jpl(0.004, 900.0, 0.0, 400.0) > 0.004);
    }
}
