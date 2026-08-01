//! Grain geometries. Direct port of the `GrainGeometry` subclasses in
//! src/engine.ts. `y` is the regressed web distance in metres.
//!
//! The CustomDXF variant keeps the existing split: the perimeter/area
//! regression tables are still produced in TypeScript by src/dxfProcessor.ts
//! (ClipperLib polygon offsetting) and handed in here as plain arrays.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum GrainConfig {
    #[serde(rename = "BATES")]
    Bates {
        length: f64,
        outer_radius: f64,
        inner_radius: f64,
    },
    #[serde(rename = "Star")]
    Star {
        length: f64,
        outer_radius: f64,
        valley_radius: f64,
        tip_radius: f64,
        num_points: f64,
    },
    #[serde(rename = "Tubular")]
    Tubular {
        length: f64,
        outer_radius: f64,
        inner_radius: f64,
    },
    #[serde(rename = "RodAndTube")]
    RodAndTube {
        length: f64,
        outer_radius: f64,
        rod_radius: f64,
        tube_inner_radius: f64,
    },
    #[serde(rename = "MoonBurner")]
    MoonBurner {
        length: f64,
        outer_radius: f64,
        core_radius: f64,
        offset: f64,
    },
    #[serde(rename = "Finocyl")]
    Finocyl {
        length: f64,
        outer_radius: f64,
        r_tube: f64,
        num_fins: f64,
        w_fin: f64,
        h_fin: f64,
    },
    #[serde(rename = "CustomDXF")]
    CustomDxf {
        length: f64,
        outer_radius: f64,
        dx: f64,
        perim_table: Vec<f64>,
        area_table: Vec<f64>,
    },
}

/// Precomputed Star constants (see engine.ts `Star` constructor).
#[derive(Debug, Clone)]
pub struct StarParams {
    pub valley_radius: f64,
    pub tip_radius: f64,
    pub n: f64,
    pub web: f64,
    pub theta: f64,
    pub epsilon: f64,
    pub initial_straight_length: f64,
    pub point_exterior_angle: f64,
    pub initial_port_area: f64,
    pub transition_web: f64,
}

impl StarParams {
    pub fn new(outer_radius: f64, valley_radius: f64, tip_radius: f64, num_points: f64) -> Self {
        let theta = std::f64::consts::PI / num_points;
        let opp = valley_radius * theta.sin();
        let adj = valley_radius * theta.cos() - tip_radius;
        let epsilon = opp.atan2(adj);
        let initial_straight_length = opp.hypot(adj);

        // Exterior (turning) angle at each star point: the arc angle swept by the
        // burning surface around that vertex. Interior angle is 2*phi.
        let cos_phi = (valley_radius - tip_radius * theta.cos()) / initial_straight_length;
        let phi = cos_phi.clamp(-1.0, 1.0).acos();
        let point_exterior_angle = std::f64::consts::PI - 2.0 * phi;

        // Area of the undisturbed star polygon: 2N triangles from the centre.
        let initial_port_area = num_points * valley_radius * tip_radius * theta.sin();

        let tan_eps = epsilon.tan();
        let transition_web = if tan_eps > 0.0 {
            initial_straight_length * tan_eps
        } else {
            f64::INFINITY
        };

        Self {
            valley_radius,
            tip_radius,
            n: num_points,
            web: outer_radius - valley_radius,
            theta,
            epsilon,
            initial_straight_length,
            point_exterior_angle,
            initial_port_area,
            transition_web,
        }
    }

    /// Port area during the star phase, from integrating dA/dy = perimeter(y).
    fn star_phase_area(&self, y: f64) -> f64 {
        self.initial_port_area
            + 2.0 * self.n * self.initial_straight_length * y
            + self.n * y * y * (self.point_exterior_angle / 2.0 - 1.0 / self.epsilon.tan())
    }
}

#[derive(Debug, Clone)]
pub enum Grain {
    Bates {
        length: f64,
        outer_radius: f64,
        inner_radius: f64,
        web: f64,
    },
    Star {
        length: f64,
        outer_radius: f64,
        p: StarParams,
    },
    Tubular {
        length: f64,
        outer_radius: f64,
        inner_radius: f64,
    },
    RodAndTube {
        length: f64,
        outer_radius: f64,
        rod_radius: f64,
        tube_inner_radius: f64,
    },
    MoonBurner {
        length: f64,
        outer_radius: f64,
        core_radius: f64,
        offset: f64,
    },
    Finocyl {
        length: f64,
        outer_radius: f64,
        r_tube: f64,
        num_fins: f64,
        w_fin: f64,
        h_fin: f64,
        web: f64,
    },
    CustomDxf {
        length: f64,
        outer_radius: f64,
        dx: f64,
        perim_table: Vec<f64>,
        area_table: Vec<f64>,
    },
}

/// Area of the lens where two circles of radii R and r, centres d apart, overlap.
fn circle_intersection_area(big_r: f64, r: f64, d: f64) -> f64 {
    if d >= big_r + r {
        return 0.0;
    }
    if d <= (big_r - r).abs() {
        return std::f64::consts::PI * big_r.min(r).powi(2);
    }
    let d1 = (r * r - big_r * big_r + d * d) / (2.0 * d);
    let d2 = (big_r * big_r - r * r + d * d) / (2.0 * d);
    let h1 = (r * r - d1 * d1).max(0.0).sqrt();
    let h2 = (big_r * big_r - d2 * d2).max(0.0).sqrt();
    let a1 = r * r * (d1 / r).clamp(-1.0, 1.0).acos() - d1 * h1;
    let a2 = big_r * big_r * (d2 / big_r).clamp(-1.0, 1.0).acos() - d2 * h2;
    a1 + a2
}

impl Grain {
    pub fn new(c: &GrainConfig) -> Self {
        match c {
            GrainConfig::Bates {
                length,
                outer_radius,
                inner_radius,
            } => Grain::Bates {
                length: *length,
                outer_radius: *outer_radius,
                inner_radius: *inner_radius,
                web: outer_radius - inner_radius,
            },
            GrainConfig::Star {
                length,
                outer_radius,
                valley_radius,
                tip_radius,
                num_points,
            } => Grain::Star {
                length: *length,
                outer_radius: *outer_radius,
                p: StarParams::new(*outer_radius, *valley_radius, *tip_radius, *num_points),
            },
            GrainConfig::Tubular {
                length,
                outer_radius,
                inner_radius,
            } => Grain::Tubular {
                length: *length,
                outer_radius: *outer_radius,
                inner_radius: *inner_radius,
            },
            GrainConfig::RodAndTube {
                length,
                outer_radius,
                rod_radius,
                tube_inner_radius,
            } => Grain::RodAndTube {
                length: *length,
                outer_radius: *outer_radius,
                rod_radius: *rod_radius,
                tube_inner_radius: *tube_inner_radius,
            },
            GrainConfig::MoonBurner {
                length,
                outer_radius,
                core_radius,
                offset,
            } => Grain::MoonBurner {
                length: *length,
                outer_radius: *outer_radius,
                core_radius: *core_radius,
                offset: *offset,
            },
            GrainConfig::Finocyl {
                length,
                outer_radius,
                r_tube,
                num_fins,
                w_fin,
                h_fin,
            } => Grain::Finocyl {
                length: *length,
                outer_radius: *outer_radius,
                r_tube: *r_tube,
                num_fins: *num_fins,
                w_fin: *w_fin,
                h_fin: *h_fin,
                web: outer_radius - r_tube,
            },
            GrainConfig::CustomDxf {
                length,
                outer_radius,
                dx,
                perim_table,
                area_table,
            } => Grain::CustomDxf {
                length: *length,
                outer_radius: *outer_radius,
                dx: *dx,
                perim_table: perim_table.clone(),
                area_table: area_table.clone(),
            },
        }
    }

    pub fn length(&self) -> f64 {
        match self {
            Grain::Bates { length, .. }
            | Grain::Star { length, .. }
            | Grain::Tubular { length, .. }
            | Grain::RodAndTube { length, .. }
            | Grain::MoonBurner { length, .. }
            | Grain::Finocyl { length, .. }
            | Grain::CustomDxf { length, .. } => *length,
        }
    }

    pub fn burning_area(&self, y: f64) -> f64 {
        const PI: f64 = std::f64::consts::PI;
        match self {
            Grain::Bates {
                length,
                outer_radius,
                inner_radius,
                web,
            } => {
                if y >= *web {
                    return 0.0;
                }
                let r = inner_radius + y;
                let l = length - 2.0 * y;
                if l <= 0.0 {
                    return 0.0;
                }
                2.0 * PI * r * l + 2.0 * PI * (outer_radius.powi(2) - r * r)
            }

            Grain::Star {
                length,
                outer_radius,
                p,
            } => {
                if y >= p.web {
                    return 0.0;
                }
                let l_straight = p.initial_straight_length - y / p.epsilon.tan();
                let perimeter = if l_straight > 0.0 {
                    // Star phase: 2N straight flanks (shortened at the notch end by
                    // y/tan(epsilon)) plus an arc of radius y at each star point.
                    // The arc term is N*point_exterior_angle*y, NOT 2*pi*y -- a star
                    // is not convex, so the Steiner term for a convex polygon does
                    // not apply. Exact to <0.005% vs ClipperLib offsetting.
                    2.0 * p.n * l_straight + p.n * p.point_exterior_angle * y
                } else {
                    // Post-transition the port tends to a circle. Approximate: the
                    // rounded points still bulge, so this runs up to ~15% low right
                    // at the transition, converging to <1% within a few mm of web.
                    let r_cyl = p.valley_radius + y;
                    if r_cyl < *outer_radius {
                        2.0 * PI * r_cyl
                    } else {
                        0.0
                    }
                };
                perimeter * length
            }

            Grain::Tubular {
                length,
                outer_radius,
                inner_radius,
            } => {
                let r = inner_radius + y;
                if r >= *outer_radius {
                    return 0.0;
                }
                2.0 * PI * r * length
            }

            Grain::RodAndTube {
                length,
                outer_radius,
                rod_radius,
                tube_inner_radius,
            } => {
                let mut p = 0.0;
                let r_rod = rod_radius - y;
                if r_rod > 0.0 {
                    p += 2.0 * PI * r_rod;
                }
                let r_tube = tube_inner_radius + y;
                if r_tube < *outer_radius {
                    p += 2.0 * PI * r_tube;
                }
                p * length
            }

            Grain::MoonBurner {
                length,
                outer_radius,
                core_radius,
                offset,
            } => {
                let r = core_radius + y;
                if r + offset <= *outer_radius {
                    2.0 * PI * r * length
                } else if r - offset >= *outer_radius {
                    0.0
                } else {
                    let cos_phi = (r * r + offset * offset - outer_radius.powi(2))
                        / (2.0 * r * offset);
                    let phi = cos_phi.clamp(-1.0, 1.0).acos();
                    2.0 * phi * r * length
                }
            }

            Grain::Finocyl {
                length,
                outer_radius,
                r_tube,
                num_fins,
                w_fin,
                h_fin,
                web,
            } => {
                if y >= *web {
                    return 0.0;
                }
                let r_bore = r_tube + y;
                let r_tip = r_tube + h_fin + y;
                let w_current = w_fin + 2.0 * y;

                let perimeter = if r_tip < *outer_radius {
                    // Phase 1: slots have not reached the casing.
                    let bore_perim = 2.0 * PI * r_bore - num_fins * w_current;
                    let slot_perim = 2.0 * num_fins * h_fin + num_fins * w_current;
                    bore_perim + slot_perim
                } else {
                    // Phase 2: slots have hit the casing.
                    let effective_h = outer_radius - r_bore;
                    if effective_h <= 0.0 {
                        return 0.0;
                    }
                    2.0 * PI * r_bore - num_fins * w_current + 2.0 * num_fins * effective_h
                };

                (perimeter * length).max(0.0)
            }

            Grain::CustomDxf {
                length,
                dx,
                perim_table,
                ..
            } => {
                if perim_table.len() < 2 {
                    return 0.0;
                }
                let idx_f = (y / dx).floor();
                if idx_f < 0.0 {
                    return perim_table[0] * length;
                }
                let idx = idx_f as usize;
                if idx >= perim_table.len() - 1 {
                    return 0.0;
                }
                let t = (y - idx_f * dx) / dx;
                let perim = perim_table[idx] * (1.0 - t) + perim_table[idx + 1] * t;
                perim * length
            }
        }
    }

    pub fn port_area(&self, y: f64) -> f64 {
        const PI: f64 = std::f64::consts::PI;
        match self {
            Grain::Bates {
                outer_radius,
                inner_radius,
                ..
            } => {
                let r = (inner_radius + y).min(*outer_radius);
                PI * r * r
            }

            Grain::Star {
                outer_radius, p, ..
            } => {
                let outer_area = PI * outer_radius.powi(2);
                let l_straight = p.initial_straight_length - y / p.epsilon.tan();
                if l_straight > 0.0 {
                    // Exact offset area of the star polygon (integral of perimeter).
                    outer_area.min(p.star_phase_area(y))
                } else {
                    // Continue integrating the circular perimeter from the area
                    // reached at the transition, so port area stays continuous.
                    let y_t = p.transition_web;
                    let r_t = p.valley_radius + y_t;
                    let r_cyl = p.valley_radius + y;
                    let area = p.star_phase_area(y_t) + PI * (r_cyl * r_cyl - r_t * r_t);
                    outer_area.min(area.max(0.0))
                }
            }

            Grain::Tubular {
                outer_radius,
                inner_radius,
                ..
            } => {
                let r = (inner_radius + y).min(*outer_radius);
                PI * r * r
            }

            Grain::RodAndTube {
                outer_radius,
                rod_radius,
                tube_inner_radius,
                ..
            } => {
                let mut a_rod = 0.0;
                let r_rod = rod_radius - y;
                if r_rod > 0.0 {
                    a_rod = PI * r_rod * r_rod;
                }
                let r_tube = (tube_inner_radius + y).min(*outer_radius);
                let a_tube = PI * r_tube * r_tube;
                (a_tube - a_rod).max(0.0)
            }

            Grain::MoonBurner {
                outer_radius,
                core_radius,
                offset,
                ..
            } => {
                let r = core_radius + y;
                circle_intersection_area(*outer_radius, r, *offset)
            }

            Grain::Finocyl {
                outer_radius,
                r_tube,
                num_fins,
                w_fin,
                h_fin,
                ..
            } => {
                let outer_area = PI * outer_radius.powi(2);
                let r_bore = (r_tube + y).min(*outer_radius);
                let r_tip = outer_radius.min(r_tube + h_fin + y);
                let w_current = w_fin + 2.0 * y;

                if r_bore >= *outer_radius {
                    return outer_area;
                }
                let bore_area = PI * r_bore * r_bore;
                let slot_area = num_fins * (r_tip - r_bore) * w_current;
                outer_area.min(bore_area + slot_area)
            }

            Grain::CustomDxf {
                outer_radius,
                dx,
                area_table,
                ..
            } => {
                let outer_area = PI * outer_radius.powi(2);
                if area_table.is_empty() {
                    return outer_area;
                }
                let idx_f = (y / dx).floor();
                if idx_f < 0.0 {
                    return outer_area.min(area_table[0].max(0.0));
                }
                let idx = idx_f as usize;
                if idx >= area_table.len() - 1 {
                    return outer_area;
                }
                let t = (y - idx_f * dx) / dx;
                let area = area_table[idx] * (1.0 - t) + area_table[idx + 1] * t;
                outer_area.min(area.max(0.0))
            }
        }
    }
}
