//! Solid propellant thermochemistry. Direct port of `SolidPropellant` in
//! src/engine.ts; all quantities SI (burn rate m/s, pressure Pa).

use serde::Deserialize;

/// One pressure band of a piecewise burn-rate law.
///
/// Real propellants do not always follow a single Saint-Robert law. Nakka's
/// strand-burner measurements of KN-Dextrose and KN-Sorbitol are NON-MONOTONIC
/// in pressure -- burn rate falls as pressure rises over parts of the range,
/// which `r = a * Pc^n` with n > 0 cannot express at any coefficients. His
/// published fits use five bands each, two of them with negative exponents.
///
/// Supplying bands here recovers roughly four percentage points of accuracy
/// against those measurements (5-6% mean error down to 1-2%); see
/// src/burnRate.validation.test.ts.
#[derive(Debug, Clone, Deserialize)]
pub struct BurnRateRegime {
    /// Lower bound of the band, Pa absolute. Inclusive.
    pub from_pressure: f64,
    /// Upper bound of the band, Pa absolute. Inclusive.
    pub to_pressure: f64,
    /// St. Robert coefficient for this band, SI (Pc in Pa, r_b in m/s).
    pub a: f64,
    pub n: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PropellantConfig {
    pub density: f64,
    /// St. Robert coefficient in SI: r_b = a * Pc^n with Pc in Pa, r_b in m/s.
    ///
    /// Always required. When `burn_rate_regimes` is supplied this remains the
    /// fallback outside the banded range, and is what `check_stability` and any
    /// consumer wanting a single representative pair (such as the surrogate)
    /// reads.
    pub a: f64,
    pub n: f64,
    /// Optional piecewise law. Empty means the single `a`/`n` above is used
    /// everywhere, which is the behaviour every existing configuration gets.
    #[serde(default)]
    pub burn_rate_regimes: Vec<BurnRateRegime>,
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
    /// Sorted by `from_pressure`; empty for a single-law propellant.
    pub burn_rate_regimes: Vec<BurnRateRegime>,
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

        // Sorted once so lookup can assume order and fall back to the ends.
        let mut burn_rate_regimes = c.burn_rate_regimes.clone();
        burn_rate_regimes.sort_by(|x, y| {
            x.from_pressure
                .partial_cmp(&y.from_pressure)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Self {
            density: c.density,
            a: c.a,
            n: c.n,
            burn_rate_regimes,
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

    /// The (a, n) pair governing burn rate at this chamber pressure.
    ///
    /// With no regimes configured this is the single law, unchanged -- which is
    /// what keeps every existing result bit-identical.
    ///
    /// Outside the banded range the nearest band is used rather than the
    /// single-law fallback. Extrapolating the end band is continuous at the
    /// boundary; dropping to a different law there would put a step in the burn
    /// rate exactly where the ignition transient sweeps through.
    #[inline]
    pub fn coefficients_at(&self, pc: f64) -> (f64, f64) {
        let regimes = &self.burn_rate_regimes;
        if regimes.is_empty() {
            return (self.a, self.n);
        }
        for r in regimes {
            if pc >= r.from_pressure && pc <= r.to_pressure {
                return (r.a, r.n);
            }
        }
        let first = &regimes[0];
        if pc < first.from_pressure {
            return (first.a, first.n);
        }
        let last = &regimes[regimes.len() - 1];
        (last.a, last.n)
    }

    /// Pressure-driven burn rate, before any erosive augmentation, m/s.
    ///
    /// The one place the burn-rate law is evaluated, so a piecewise propellant
    /// cannot be honoured in one solver path and silently ignored in another.
    #[inline]
    pub fn base_burn_rate(&self, pc: f64) -> f64 {
        let (a, n) = self.coefficients_at(pc);
        a * pc.powf(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regime(from: f64, to: f64, a: f64, n: f64) -> BurnRateRegime {
        BurnRateRegime { from_pressure: from, to_pressure: to, a, n }
    }

    fn cfg(regimes: Vec<BurnRateRegime>) -> PropellantConfig {
        PropellantConfig {
            density: 1878.0,
            a: 8.377e-5,
            n: 0.3157,
            burn_rate_regimes: regimes,
            flame_temp: 1700.0,
            gamma: 1.14,
            molecular_weight: 0.042,
            k_erosive: 0.0006,
            g_threshold: 450.0,
            t_ref: 294.0,
            sigma_p: 0.001,
        }
    }

    /// No regimes must mean the single law, bit for bit. Every motor file that
    /// predates this feature depends on that being exactly true, not close.
    #[test]
    fn empty_regimes_reproduce_the_single_law_exactly() {
        let p = Propellant::new(&cfg(vec![]));
        for pc in [1.0e5, 1.0e6, 5.5e6, 2.0e7] {
            assert_eq!(p.base_burn_rate(pc), p.a * pc.powf(p.n));
            assert_eq!(p.coefficients_at(pc), (p.a, p.n));
        }
    }

    #[test]
    fn a_pressure_selects_the_band_containing_it() {
        let p = Propellant::new(&cfg(vec![
            regime(1.0e5, 1.0e6, 1.0, 0.1),
            regime(1.0e6, 5.0e6, 2.0, 0.2),
            regime(5.0e6, 1.0e7, 3.0, 0.3),
        ]));
        assert_eq!(p.coefficients_at(5.0e5), (1.0, 0.1));
        assert_eq!(p.coefficients_at(3.0e6), (2.0, 0.2));
        assert_eq!(p.coefficients_at(8.0e6), (3.0, 0.3));
    }

    /// Bounds are inclusive on both sides, so a shared edge resolves to the
    /// lower band rather than falling through to the fallback.
    #[test]
    fn shared_boundaries_resolve_to_the_lower_band() {
        let p = Propellant::new(&cfg(vec![
            regime(1.0e5, 1.0e6, 1.0, 0.1),
            regime(1.0e6, 5.0e6, 2.0, 0.2),
        ]));
        assert_eq!(p.coefficients_at(1.0e6), (1.0, 0.1));
    }

    /// Outside the banded range the nearest END band is extrapolated, NOT the
    /// single-law fallback. Switching laws at the edge would put a step in the
    /// burn rate right where the ignition transient sweeps through.
    #[test]
    fn outside_the_range_extrapolates_the_nearest_band() {
        let p = Propellant::new(&cfg(vec![
            regime(1.0e6, 5.0e6, 2.0, 0.2),
            regime(5.0e6, 1.0e7, 3.0, 0.3),
        ]));
        assert_eq!(p.coefficients_at(1.0e5), (2.0, 0.2));
        assert_eq!(p.coefficients_at(5.0e7), (3.0, 0.3));

        // Continuous across the low edge: approaching from inside and from
        // outside must agree.
        let inside = p.base_burn_rate(1.0e6 + 1.0);
        let outside = p.base_burn_rate(1.0e6 - 1.0);
        assert!((inside - outside).abs() / inside < 1e-6);
    }

    /// The constructor sorts, so a config listing bands out of order still
    /// looks them up correctly instead of matching whichever came first.
    #[test]
    fn regimes_are_sorted_on_construction() {
        let p = Propellant::new(&cfg(vec![
            regime(5.0e6, 1.0e7, 3.0, 0.3),
            regime(1.0e5, 1.0e6, 1.0, 0.1),
            regime(1.0e6, 5.0e6, 2.0, 0.2),
        ]));
        assert_eq!(p.burn_rate_regimes[0].a, 1.0);
        assert_eq!(p.burn_rate_regimes[2].a, 3.0);
        assert_eq!(p.coefficients_at(3.0e6), (2.0, 0.2));
        assert_eq!(p.coefficients_at(5.0e5), (1.0, 0.1));
    }

    /// Nakka's fits carry negative exponents over parts of the range, which is
    /// the whole reason a single law cannot represent this data.
    #[test]
    fn negative_exponents_give_a_falling_burn_rate() {
        let p = Propellant::new(&cfg(vec![regime(1.0e6, 1.0e7, 8.5496e-3, -0.009)]));
        assert!(p.base_burn_rate(8.0e6) < p.base_burn_rate(2.0e6));
        assert!(p.base_burn_rate(8.0e6) > 0.0);
    }
}
