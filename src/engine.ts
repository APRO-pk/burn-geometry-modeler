// Shared nominal integration timestep (s), used by both the nominal run and
// Monte Carlo sweeps so dispersion results stay comparable to the baseline.
export const SIM_DT = 0.001;

// Numerical floors that keep the chamber-pressure ODE well-posed. Physically
// negligible; they exist so a degenerate geometry cannot divide by zero or
// feed a negative base into the fractional-exponent burn-rate law.
const PC_FLOOR = 1.0; // Pa
const V_C_FLOOR = 1e-9; // m^3

export class SolidPropellant {
  density: number;
  a: number;
  n: number;
  flame_temp: number;
  gamma: number;
  molecular_weight: number;
  k_erosive: number;
  G_threshold: number;
  T_ref: number;
  sigma_p: number;
  R_univ: number;
  R_spec: number;
  Gamma: number;
  C_D: number;
  c_star: number;

  constructor(
    density: number,
    a: number,
    n: number,
    flame_temp: number,
    gamma: number,
    molecular_weight: number,
    k_erosive: number = 0.0,
    G_threshold: number = 0.0,
    T_ref: number = 294.0,
    sigma_p: number = 0.001
  ) {
    this.density = density;
    this.a = a;
    this.n = n;
    this.flame_temp = flame_temp;
    this.gamma = gamma;
    this.molecular_weight = molecular_weight;
    this.k_erosive = k_erosive;
    this.G_threshold = G_threshold;
    this.T_ref = T_ref;
    this.sigma_p = sigma_p;

    this.R_univ = 8.314;
    this.R_spec = this.R_univ / this.molecular_weight;

    this.Gamma =
      Math.sqrt(this.gamma) *
      Math.pow(2 / (this.gamma + 1), (this.gamma + 1) / (2 * (this.gamma - 1)));
    this.C_D =
      this.Gamma / Math.sqrt(this.R_spec * this.flame_temp);
    this.c_star = 1.0 / this.C_D;
  }
}

export abstract class GrainGeometry {
  length: number;
  outer_radius: number;

  constructor(length: number, outer_radius: number) {
    this.length = length;
    this.outer_radius = outer_radius;
  }

  abstract get_burning_area(y: number): number;
  abstract get_port_area(y: number): number;
}

export class BATES extends GrainGeometry {
  inner_radius: number;
  web: number;

  constructor(length: number, outer_radius: number, inner_radius: number) {
    super(length, outer_radius);
    this.inner_radius = inner_radius;
    this.web = outer_radius - inner_radius;
  }

  get_burning_area(y: number): number {
    if (y >= this.web) return 0.0;
    const r = this.inner_radius + y;
    const l = this.length - 2 * y;
    if (l <= 0) return 0.0;
    const bore_area = 2 * Math.PI * r * l;
    const end_area = 2 * Math.PI * (Math.pow(this.outer_radius, 2) - Math.pow(r, 2));
    return bore_area + end_area;
  }

  get_port_area(y: number): number {
    const r = Math.min(this.inner_radius + y, this.outer_radius);
    return Math.PI * Math.pow(r, 2);
  }
}

export class Star extends GrainGeometry {
  valley_radius: number;
  tip_radius: number;
  N: number;
  web: number;
  theta: number;
  epsilon: number;
  initial_straight_length: number;
  point_exterior_angle: number;
  initial_port_area: number;
  transition_web: number;

  constructor(
    length: number,
    outer_radius: number,
    valley_radius: number,
    tip_radius: number,
    num_points: number
  ) {
    super(length, outer_radius);
    this.valley_radius = valley_radius;
    this.tip_radius = tip_radius;
    this.N = num_points;
    this.web = outer_radius - valley_radius;
    this.theta = Math.PI / this.N;

    this.epsilon = Math.atan2(
      valley_radius * Math.sin(this.theta),
      valley_radius * Math.cos(this.theta) - tip_radius
    );
    this.initial_straight_length = Math.hypot(
      valley_radius * Math.sin(this.theta),
      valley_radius * Math.cos(this.theta) - tip_radius
    );

    // Exterior (turning) angle at each star point, i.e. the arc angle swept by
    // the burning surface around that vertex as it regresses. The interior
    // angle is 2*phi, so the exterior angle is pi - 2*phi.
    const cos_phi =
      (valley_radius - tip_radius * Math.cos(this.theta)) / this.initial_straight_length;
    const phi = Math.acos(Math.max(-1, Math.min(1, cos_phi)));
    this.point_exterior_angle = Math.PI - 2 * phi;

    // Area of the undisturbed star polygon: 2N triangles from the centre, each
    // spanning a valley_radius and a tip_radius vertex with included angle theta.
    this.initial_port_area = this.N * valley_radius * tip_radius * Math.sin(this.theta);

    // Web at which the straight flanks vanish and the port becomes circular.
    // A non-positive tan(epsilon) means the flanks never shorten (degenerate
    // proportions), so the transition is never reached.
    const tan_eps = Math.tan(this.epsilon);
    this.transition_web =
      tan_eps > 0 ? this.initial_straight_length * tan_eps : Number.POSITIVE_INFINITY;
  }

  get_burning_area(y: number): number {
    if (y >= this.web) return 0.0;

    const l_straight = this.initial_straight_length - y / Math.tan(this.epsilon);
    let perimeter = 0;

    if (l_straight > 0) {
      // Star phase. The port is the original star polygon grown outward by y,
      // so its perimeter is the 2N straight flanks (each shortened at the
      // notch end by y/tan(epsilon)) plus one arc of radius y at each of the N
      // star points. The arcs total N * point_exterior_angle * y.
      //
      // This previously used 2*PI*y, which is the Steiner term for a CONVEX
      // polygon. A star is not convex: its concave notches subtract turning,
      // so 2*PI understates the arc angle (by >2x at N=5). That made burning
      // area DECREASE with web instead of increasing, and left a large jump at
      // the transition below. Verified against ClipperLib polygon offsetting:
      // this form is exact to <0.005% over the whole star phase.
      perimeter = 2 * this.N * l_straight + this.N * this.point_exterior_angle * y;
    } else {
      // Post-transition: the flanks have burned away and the port tends to a
      // circle of radius valley_radius + y. This is an approximation -- the
      // rounded star points still bulge, so the true perimeter is larger near
      // the transition. Measured against ClipperLib: up to ~15% low right at
      // the transition, converging to <1% within a few mm of web. A closed
      // form here would require modelling the merging point arcs.
      const r_cyl = this.valley_radius + y;
      if (r_cyl < this.outer_radius) {
        perimeter = 2 * Math.PI * r_cyl;
      } else {
        perimeter = 0.0;
      }
    }

    return perimeter * this.length;
  }

  /** Port area during the star phase, from integrating dA/dy = perimeter(y). */
  private _star_phase_area(y: number): number {
    return (
      this.initial_port_area +
      2 * this.N * this.initial_straight_length * y +
      this.N * y * y * (this.point_exterior_angle / 2 - 1 / Math.tan(this.epsilon))
    );
  }

  get_port_area(y: number): number {
    const outer_area = Math.PI * Math.pow(this.outer_radius, 2);
    const l_straight = this.initial_straight_length - y / Math.tan(this.epsilon);

    if (l_straight > 0) {
      // Exact area of the star polygon grown outward by y. Because the offset
      // family satisfies dA/dy = perimeter(y), integrating the (now exact)
      // star-phase perimeter gives this closed form.
      //
      // This previously used N*(valley_radius+y)^2*sin(2*theta)/2, the area of
      // a regular 2N-gon whose vertices all sit at valley_radius+y. That
      // ignores the notches at tip_radius and overstated port area by ~2.4x,
      // which understated port mass flux G and so under-triggered erosive
      // burning. Verified exact against ClipperLib polygon offsetting.
      return Math.min(outer_area, this._star_phase_area(y));
    } else {
      // Post-transition, continue integrating the circular perimeter from the
      // area reached at the transition, so port area stays continuous.
      const yT = this.transition_web;
      const rT = this.valley_radius + yT;
      const r_cyl = this.valley_radius + y;
      const area =
        this._star_phase_area(yT) + Math.PI * (r_cyl * r_cyl - rT * rT);
      return Math.min(outer_area, Math.max(0, area));
    }
  }
}

export class Tubular extends GrainGeometry {
  inner_radius: number;

  constructor(length: number, outer_radius: number, inner_radius: number) {
    super(length, outer_radius);
    this.inner_radius = inner_radius;
  }

  get_burning_area(y: number): number {
    const r = this.inner_radius + y;
    if (r >= this.outer_radius) return 0.0;
    return 2 * Math.PI * r * this.length;
  }

  get_port_area(y: number): number {
    const r = Math.min(this.inner_radius + y, this.outer_radius);
    return Math.PI * Math.pow(r, 2);
  }
}

export class RodAndTube extends GrainGeometry {
  rod_radius: number;
  tube_inner_radius: number;

  constructor(length: number, outer_radius: number, rod_radius: number, tube_inner_radius: number) {
    super(length, outer_radius);
    this.rod_radius = rod_radius;
    this.tube_inner_radius = tube_inner_radius;
  }

  get_burning_area(y: number): number {
    let p = 0;
    const r_rod = this.rod_radius - y;
    if (r_rod > 0) p += 2 * Math.PI * r_rod;
    const r_tube = this.tube_inner_radius + y;
    if (r_tube < this.outer_radius) p += 2 * Math.PI * r_tube;
    return p * this.length;
  }

  get_port_area(y: number): number {
    let a_rod = 0;
    const r_rod = this.rod_radius - y;
    if (r_rod > 0) a_rod = Math.PI * Math.pow(r_rod, 2);
    const r_tube = Math.min(this.tube_inner_radius + y, this.outer_radius);
    const a_tube = Math.PI * Math.pow(r_tube, 2);
    return Math.max(0, a_tube - a_rod);
  }
}

function circleIntersectionArea(R: number, r: number, d: number): number {
  if (d >= R + r) return 0;
  if (d <= Math.abs(R - r)) return Math.PI * Math.pow(Math.min(R, r), 2);
  const d1 = (Math.pow(r, 2) - Math.pow(R, 2) + Math.pow(d, 2)) / (2 * d);
  const d2 = (Math.pow(R, 2) - Math.pow(r, 2) + Math.pow(d, 2)) / (2 * d);
  const h1 = Math.sqrt(Math.max(0, Math.pow(r, 2) - Math.pow(d1, 2)));
  const h2 = Math.sqrt(Math.max(0, Math.pow(R, 2) - Math.pow(d2, 2)));
  const a1 = Math.pow(r, 2) * Math.acos(Math.max(-1, Math.min(1, d1 / r))) - d1 * h1;
  const a2 = Math.pow(R, 2) * Math.acos(Math.max(-1, Math.min(1, d2 / R))) - d2 * h2;
  return a1 + a2;
}

export class MoonBurner extends GrainGeometry {
  core_radius: number;
  offset: number;

  constructor(length: number, outer_radius: number, core_radius: number, offset: number) {
    super(length, outer_radius);
    this.core_radius = core_radius;
    this.offset = offset;
  }

  get_burning_area(y: number): number {
    const r = this.core_radius + y;
    if (r + this.offset <= this.outer_radius) {
      return 2 * Math.PI * r * this.length;
    } else if (r - this.offset >= this.outer_radius) {
      return 0.0;
    } else {
      const cosPhi = (Math.pow(r, 2) + Math.pow(this.offset, 2) - Math.pow(this.outer_radius, 2)) / (2 * r * this.offset);
      const phi = Math.acos(Math.max(-1, Math.min(1, cosPhi)));
      return 2 * phi * r * this.length; // Wait, shouldn't it be phi or 2*phi depending on if phi is half-angle? phi is half-angle in the formula. Yes, 2*phi
    }
  }

  get_port_area(y: number): number {
    const r = this.core_radius + y;
    return circleIntersectionArea(this.outer_radius, r, this.offset);
  }
}

export class Finocyl extends GrainGeometry {
  r_tube: number;
  num_fins: number;
  w_fin: number;
  h_fin: number;
  web: number;

  constructor(length: number, outer_radius: number, r_tube: number, num_fins: number, w_fin: number, h_fin: number) {
    super(length, outer_radius);
    this.r_tube = r_tube;
    this.num_fins = num_fins;
    this.w_fin = w_fin;
    this.h_fin = h_fin;
    this.web = outer_radius - r_tube;
  }

  get_burning_area(y: number): number {
    if (y >= this.web) return 0.0;

    const r_bore = this.r_tube + y;
    const r_tip = this.r_tube + this.h_fin + y;
    const w_current = this.w_fin + 2 * y;

    let perimeter = 0;
    if (r_tip < this.outer_radius) {
      // Phase 1: Slots have not reached the casing
      perimeter = 2 * Math.PI * r_bore + 2 * this.num_fins * (this.h_fin + y); // Actually sides are h_fin, tip is w_fin? No, simple model.
      // Wait, let's use the Python model which is consistent.
      perimeter = 2 * Math.PI * r_bore + 2 * this.num_fins * this.h_fin; 
      // Actually, if we have a slot of width w and height h, the perimeter added is 2*h + w? No, it replaces a part of the bore.
      // Python model: perimeter = 2 * math.pi * r_bore + 2 * self.N * self.h_fin
      // This assumes the slot width doesn't subtract from the bore perimeter yet? 
      // If the slot is rectangular, it covers w_current of the bore.
      // Better model:
      const bore_perim = 2 * Math.PI * r_bore - this.num_fins * w_current;
      const slot_perim = 2 * this.num_fins * this.h_fin + this.num_fins * w_current; // side + side + tip
      perimeter = bore_perim + slot_perim;
    } else {
      // Phase 2: Slots hit the casing
      const effective_h = this.outer_radius - r_bore;
      if (effective_h <= 0) return 0.0;
      perimeter = 2 * Math.PI * r_bore - this.num_fins * w_current + 2 * this.num_fins * effective_h;
    }
    
    return Math.max(0.0, perimeter * this.length);
  }

  get_port_area(y: number): number {
    const r_bore = Math.min(this.r_tube + y, this.outer_radius);
    const r_tip = Math.min(this.outer_radius, this.r_tube + this.h_fin + y);
    const w_current = this.w_fin + 2 * y;

    if (r_bore >= this.outer_radius) {
      return Math.PI * Math.pow(this.outer_radius, 2);
    }

    const bore_area = Math.PI * Math.pow(r_bore, 2);
    const slot_area = this.num_fins * (r_tip - r_bore) * w_current;

    return Math.min(Math.PI * Math.pow(this.outer_radius, 2), bore_area + slot_area);
  }
}

export class CustomDXF extends GrainGeometry {
  dx: number;
  perimTable: number[];
  areaTable: number[];

  constructor(length: number, outer_radius: number, dx: number, perimTable: number[], areaTable: number[]) {
    super(length, outer_radius);
    this.dx = dx;
    this.perimTable = perimTable;
    this.areaTable = areaTable;
  }

  get_burning_area(y: number): number {
    const idx = Math.floor(y / this.dx);
    if (idx >= this.perimTable.length - 1) return 0;
    const t = (y - idx * this.dx) / this.dx;
    const perim = this.perimTable[idx] * (1 - t) + this.perimTable[idx + 1] * t;
    return perim * this.length;
  }

  get_port_area(y: number): number {
    const idx = Math.floor(y / this.dx);
    if (idx >= this.areaTable.length - 1) {
        return Math.PI * Math.pow(this.outer_radius, 2);
    }
    let area = 0;
    if (idx < 0) area = this.areaTable[0];
    else {
      const t = (y - idx * this.dx) / this.dx;
      area = this.areaTable[idx] * (1 - t) + this.areaTable[idx + 1] * t;
    }
    return Math.min(Math.PI * Math.pow(this.outer_radius, 2), Math.max(0, area));
  }
}

/** The grain fields the UI carries, in the names the editors use. */
export interface GrainUiParams {
  grainType: string;
  length: number;
  outerRadius: number;
  innerRadius: number;
  valleyRadius?: number;
  tipRadius?: number;
  numPoints?: number;
  rodRadius?: number;
  offset?: number;
  finWidth?: number;
  finDepth?: number;
}

export interface DxfTables {
  dx: number;
  perimTable: number[];
  areaTable: number[];
}

/**
 * Build the grain for a set of UI inputs.
 *
 * This is the ONLY place the UI's field names get mapped onto the geometry
 * constructors, because the constructors take positional arguments whose
 * meaning shifts between geometries -- `innerRadius` is the tube bore for
 * RodAndTube but the core radius for MoonBurner and Finocyl, and Finocyl takes
 * (num_fins, w_fin, h_fin) in an order that does not match the order the fields
 * appear in the editor. Written out per call site, that mapping drifts: the
 * grain preview spent several commits passing Finocyl's fin depth as its fin
 * COUNT and the star-point count as its fin HEIGHT, which made the previewed
 * cross-section meaningless while the simulation stayed correct.
 *
 * `grainConfigFromUi` in src/wasmCore.ts is the same mapping for the Rust core,
 * and src/wasm.parity.test.ts asserts the two agree for every geometry.
 *
 * Unknown or unsatisfiable types fall back to BATES.
 */
export function grainFromUi(p: GrainUiParams, dxf?: DxfTables | null): GrainGeometry {
  const { length, outerRadius, innerRadius } = p;

  switch (p.grainType) {
    case 'Star':
      return new Star(length, outerRadius, p.valleyRadius ?? 0, p.tipRadius ?? 0, p.numPoints ?? 0);
    case 'Tubular':
      return new Tubular(length, outerRadius, innerRadius);
    case 'RodAndTube':
      return new RodAndTube(length, outerRadius, p.rodRadius ?? 0, innerRadius);
    case 'MoonBurner':
      return new MoonBurner(length, outerRadius, innerRadius, p.offset ?? 0);
    case 'Finocyl':
      return new Finocyl(
        length, outerRadius, innerRadius,
        p.numPoints ?? 0, p.finWidth ?? 0, p.finDepth ?? 0
      );
    case 'CustomDXF':
      if (dxf) return new CustomDXF(length, outerRadius, dxf.dx, dxf.perimTable, dxf.areaTable);
      return new BATES(length, outerRadius, innerRadius);
    default:
      return new BATES(length, outerRadius, innerRadius);
  }
}

export interface SimulationResult {
  Time: number;
  /** Head-end chamber pressure (Pa). Equals `PcNozzle` under the 0-D model. */
  Pc: number;
  Ab: number;
  Thrust: number;
  PortMassFlux: number;
  ThroatArea: number;
  PortArea: number;
  y: number;
  MassFlow: number;
  PropellantMassGen: number;
  /**
   * Stagnation pressure at the nozzle entry (Pa).
   *
   * Only the quasi-1-D core resolves this separately from `Pc`; the deprecated
   * TypeScript solver in this file has no axial dimension and does not set it.
   */
  PcNozzle?: number;
}

export class Igniter {
  mass: number;
  initial_mass: number;
  surface_area: number; // initial surface area
  density: number;
  a: number;
  n: number;
  mass_consumed: number;

  constructor(mass: number, surface_area: number, density: number, a: number, n: number) {
    this.mass = mass;
    this.initial_mass = mass;
    this.surface_area = surface_area;
    this.density = density;
    this.a = a;
    this.n = n;
    this.mass_consumed = 0.0;
  }

  get_m_dot(Pc: number, dt: number): number {
    if (this.mass_consumed >= this.mass) return 0.0;
    
    // Model the igniter charge roughly as shrinking spheres or granules
    // Area shrinks proportional to (volume remaining)^(2/3)
    const mass_remaining = this.mass - this.mass_consumed;
    let radius_ratio = Math.pow(mass_remaining / this.initial_mass, 1.0 / 3.0);
    if (radius_ratio < 0) radius_ratio = 0;
    
    const current_surface_area = this.surface_area * Math.pow(radius_ratio, 2.0);
    let mdot = current_surface_area * this.density * this.a * Math.pow(Pc, this.n);

    // Explicit burnout logic: prevent exceeding remaining mass
    if (mdot * dt > mass_remaining) {
      mdot = mass_remaining / dt;
    }

    return mdot;
  }
}

export interface NozzleMaterialProps {
  type: string;
  density: number; // kg/m^3
  heat_of_ablation: number; // J/kg (enthalpy change for phase change/charring)
  oxidation_temp: number; // K
  thermal_shock_coeff: number; // multiplier for early rapid heating
  thermal_conductivity: number; // base W/m-K
  specific_heat: number; // base J/kg-K
  k_temp_coeff?: number; // 1/K, e.g. -0.0001 for decreasing conductivity with temp
  cp_temp_coeff?: number; // 1/K
}

export type ErosiveModelType = 'None' | 'Lenoir-Robillard' | 'JPL';

export class MotorSimulation {
  propellant: SolidPropellant;
  grain: GrainGeometry;
  dt: number;
  time: number;
  y: number;
  Pc: number;
  Pa: number;
  D_t: number;
  nozzle_props: NozzleMaterialProps | null;
  nozzle_surface_temp: number; // K
  results: SimulationResult[];
  expansion_ratio: number;
  igniter: Igniter | null;
  c_star_eff: number;
  cf_eff: number;
  erosive_model: ErosiveModelType;
  T_init: number;

  constructor(propellant: SolidPropellant, grain: GrainGeometry, dt: number = 0.001, T_init: number = 294.0) {
    this.propellant = propellant;
    this.grain = grain;
    this.dt = dt;
    this.time = 0.0;
    this.y = 0.0;
    this.Pc = 101325.0;
    this.Pa = 101325.0;
    this.D_t = 0.0;
    this.nozzle_props = null;
    this.nozzle_surface_temp = 300.0; // Assume 300K initial ambient
    this.results = [];
    this.expansion_ratio = 1.0;
    this.igniter = null;
    this.c_star_eff = 1.0;
    this.cf_eff = 1.0;
    this.erosive_model = 'None';
    this.T_init = T_init;
  }

  set_efficiencies(c_star_eff: number, cf_eff: number) {
    this.c_star_eff = c_star_eff;
    this.cf_eff = cf_eff;
  }

  set_erosive_burning(model: ErosiveModelType) {
    this.erosive_model = model;
  }

  set_nozzle(D_t: number, expansion_ratio: number, props: NozzleMaterialProps | null = null) {
    this.D_t = D_t;
    this.expansion_ratio = expansion_ratio;
    this.nozzle_props = props;
  }

  set_igniter(igniter: Igniter) {
    this.igniter = igniter;
  }

  _solve_pe_pc(): number {
    const gamma = this.propellant.gamma;
    const Gamma = this.propellant.Gamma;
    const epsilon = this.expansion_ratio;

    const f = (pr: number) => {
      if (pr <= 0 || pr >= 1) return 1e9;
      return (
        Gamma /
          Math.sqrt(
            (2 * gamma) / (gamma - 1) * Math.pow(pr, 2 / gamma) * (1 - Math.pow(pr, (gamma - 1) / gamma))
          ) -
        epsilon
      );
    };

    let low = 0.00001;
    let high = Math.pow(2 / (gamma + 1), gamma / (gamma - 1));

    for (let i = 0; i < 50; i++) {
      const mid = (low + high) / 2;
      if (f(mid) > 0) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return (low + high) / 2;
  }

  check_stability(): string[] {
    const warnings: string[] = [];
    const Ab_initial = this.grain.get_burning_area(0);
    const At_initial = (Math.PI / 4) * Math.pow(this.D_t, 2);

    if (At_initial <= 0) {
      warnings.push("Critical: Throat diameter is zero or negative.");
      return warnings;
    }

    const Kn = Ab_initial / At_initial;

    // 1. Kn Check
    if (Kn > 400) {
      warnings.push(`Warning: Initial Kn (${Kn.toFixed(1)}) is very high (> 400). Potential over-pressure.`);
    }

    // 2. Exponent Check
    if (this.propellant.n >= 1.0) {
      warnings.push(`Warning: Pressure exponent n (${this.propellant.n.toFixed(2)}) is >= 1.0. Combustion is theoretically unstable.`);
      return warnings;
    }

    // 3. Equilibrium Pressure Check
    const temp_corr = 1 + this.propellant.sigma_p * (this.T_init - this.propellant.T_ref);
    const a_corr = this.propellant.a * temp_corr;

    try {
      const pc_eq = Math.pow((this.propellant.density * a_corr / this.propellant.C_D) * Kn, 1 / (1 - this.propellant.n));
      if (pc_eq > 30e6) {
        warnings.push(`Warning: Predicted equilibrium pressure (${(pc_eq / 1e6).toFixed(1)} MPa) exceeds 30 MPa. Highly unrealistic/dangerous.`);
      }
    } catch {
      warnings.push("Warning: Could not calculate equilibrium pressure. Possible numeric instability.");
    }

    return warnings;
  }

  run(): { results: SimulationResult[]; warnings: string[] } {
    const warnings = this.check_stability();
    let V_c = Math.max(this.grain.get_port_area(this.y) * this.grain.length, V_C_FLOOR);

    const pr_ratio = this._solve_pe_pc();
    const gamma = this.propellant.gamma;
    let total_propellant_consumed = 0;

    // Critical pressure ratio for choked nozzle flow. Below Pc = Pa * crit the
    // throat is subsonic, so the isentropic C_F relation does not apply.
    const crit = Math.pow((gamma + 1) / 2, gamma / (gamma - 1));

    while (true) {
      const Ab = this.grain.get_burning_area(this.y);
      const A_port = this.grain.get_port_area(this.y);
      const At = (Math.PI / 4) * Math.pow(this.D_t, 2);

      if (Ab <= 0.0 && this.Pc <= this.Pa * 1.01) {
        break;
      }

      let r_b_base = this.propellant.a * Math.pow(this.Pc, this.propellant.n);
      let temp_corr = 1 + this.propellant.sigma_p * (this.T_init - this.propellant.T_ref);
      let r_b = r_b_base * temp_corr;

      const m_dot_ideal = this.propellant.density * Ab * r_b;
      total_propellant_consumed += m_dot_ideal * this.dt;
      const G = A_port > 0 ? m_dot_ideal / A_port : 0;
      
      if (this.erosive_model === 'Lenoir-Robillard' && G > 0) {
        // Lenoir-Robillard formulation
        /*
         * A THIRD copy of the Lenoir-Robillard constants, and deliberately so.
         *
         * crates/burn-core/src/erosive.rs holds the single definition the two
         * Rust solvers share. This class is the frozen TypeScript REFERENCE
         * that src/wasm.parity.test.ts checks the Rust core against, so its
         * numbers must not move when the shared ones are tuned -- that is the
         * whole point of a reference. Do not "unify" these.
         */
        const alpha = 0.00003;
        const beta = 50;
        const L_eff = this.grain.length / 2; 
        const log_term = -beta * r_b * this.propellant.density / G;
        // Limit log_term to prevent underflow/overflow
        const r_erosive = alpha * (Math.pow(G, 0.8) / Math.pow(L_eff, 0.2)) * Math.exp(Math.max(-50, log_term));
        r_b += Math.max(0, r_erosive);
      } else if (this.erosive_model === 'JPL' && G > 0) {
        // JPL approximation: linear mass flux multiplier
        const k_jpl = this.propellant.k_erosive > 0 ? this.propellant.k_erosive : 0.001;
        if (G > this.propellant.G_threshold) {
          r_b = r_b * (1 + k_jpl * (G - this.propellant.G_threshold));
        }
      } else if (G > this.propellant.G_threshold && this.propellant.k_erosive > 0 && this.erosive_model !== 'None') {
        // Fallback generic linear
        r_b = r_b * (1 + this.propellant.k_erosive * (G - this.propellant.G_threshold));
      }

      if (Ab <= 0.0) {
        r_b = 0.0;
      }

      let m_dot_in = this.propellant.density * Ab * r_b;

      if (this.igniter) {
        const m_dot_igniter = this.igniter.get_m_dot(this.Pc, this.dt);
        m_dot_in += m_dot_igniter;
        this.igniter.mass_consumed += m_dot_igniter * this.dt;
      }

      const C_D_eff = this.propellant.C_D / this.c_star_eff;
      const m_dot_out = C_D_eff * this.Pc * At;

      const dVc_dt = Ab * r_b;
      const RT = this.propellant.R_spec * this.propellant.flame_temp;

      // Chamber pressure ODE, written as dPc/dt = A_gain - B_loss * Pc, where
      // the nozzle outflow and the volume-growth term are both linear in Pc.
      // These are stiff during the ignition fill, so they are taken implicitly
      // (backward Euler). Explicit Euler overshot badly here: a single step
      // could drive Pc negative, and Math.pow(negative, n) then poisoned the
      // rest of the run with NaN. Because A_gain >= 0 and B_loss >= 0, this
      // form keeps Pc strictly positive and is unconditionally stable, while
      // converging to the same equilibrium pressure as the explicit form.
      const A_gain = (RT / V_c) * m_dot_in;
      const B_loss = (RT * C_D_eff * At + dVc_dt) / V_c;
      this.Pc = (this.Pc + A_gain * this.dt) / (1 + B_loss * this.dt);
      if (this.Pc < PC_FLOOR) this.Pc = PC_FLOOR;

      if (!Number.isFinite(this.Pc)) {
        warnings.push(
          'Critical: pressure solution diverged (non-finite). Simulation stopped early. Check grain geometry, throat diameter, and propellant burn-rate coefficients.'
        );
        break;
      }

      this.y += r_b * this.dt;
      V_c += dVc_dt * this.dt;
      
      // Advanced Thermodynamic Erosion model (Phase Change, Charring, Thermal Shock)
      let current_erosion_rate = 0.0;
      if (this.nozzle_props) {
        const { density, heat_of_ablation, oxidation_temp, thermal_shock_coeff, k_temp_coeff = 0, cp_temp_coeff = 0 } = this.nozzle_props;
        
        // Temperature-dependent thermal properties
        const T_diff = Math.max(0, this.nozzle_surface_temp - 300);
        const current_k = Math.max(0.1, this.nozzle_props.thermal_conductivity * (1 + k_temp_coeff * T_diff));
        const current_cp = Math.max(10, this.nozzle_props.specific_heat * (1 + cp_temp_coeff * T_diff));

        // Simplified Bartz equation for convective heat transfer coefficient (h_g)
        const C_bartz = 0.005; // Tuning constant for heat transfer
        const h_g = C_bartz * Math.pow(this.Pc, 0.8) * Math.pow(this.D_t, -0.2) * Math.pow(this.propellant.flame_temp, 0.5);
        
        // Calculate heat flux using current nozzle surface temperature
        const q_dot = h_g * (this.propellant.flame_temp - this.nozzle_surface_temp);
        
        // Approximate 1D transient heat conduction for a semi-infinite solid
        const thermal_diffusivity = current_k / (density * current_cp);
        const effective_time = Math.max(this.time, 0.001); // avoid div by zero
        const thermal_penetration_depth = Math.sqrt(thermal_diffusivity * effective_time);
        
        const delta_T = (q_dot * this.dt) / (density * current_cp * thermal_penetration_depth);
        this.nozzle_surface_temp += delta_T;

        // Erosion/surface recession only occurs if surface temperature exceeds oxidation/melting threshold
        if (this.nozzle_surface_temp > oxidation_temp) {
          // Heat flux available for ablation after surface reaches oxidation temp
          // Assume excess heat goes into phase change / charring
          const ablation_q_dot = h_g * (this.propellant.flame_temp - oxidation_temp);
          
          // Thermal Shock modification: Highest at the beginning of the burn
          const shock_factor = 1.0 + (thermal_shock_coeff * Math.exp(-this.time * 2.0));
          
          // Ablation rate (m/s) = q_dot / (rho * H_ab)
          // Multiply by 2.0 to account for erosion on both sides of the diameter
          const ablation_rate = (ablation_q_dot / (density * heat_of_ablation)) * shock_factor;
          
          current_erosion_rate = ablation_rate * 2.0;

          // Clamp surface temperature near oxidation point to indicate phase change is capping it
          this.nozzle_surface_temp = oxidation_temp;
        }
      }
      // When no nozzle material is supplied the throat is treated as
      // non-eroding (current_erosion_rate stays 0).

      this.D_t += current_erosion_rate * this.dt;
      
      this.time += this.dt;

      const Pe = this.Pc * pr_ratio;
      const term1 = (2 * Math.pow(gamma, 2)) / (gamma - 1);
      const term2 = Math.pow(2 / (gamma + 1), (gamma + 1) / (gamma - 1));
      let term3 = 1 - Math.pow(Pe / this.Pc, (gamma - 1) / gamma);
      if (term3 < 0) term3 = 0;

      // Report no thrust until the nozzle chokes; during the ignition fill
      // transient the throat is subsonic and the isentropic C_F is not valid.
      const is_choked = this.Pc >= this.Pa * crit;

      // The over-expansion term ((Pe - Pa)/Pc) * epsilon can dominate at low
      // chamber pressure and drive C_F negative. A real nozzle does not pull
      // backwards there: the flow separates from the wall and the exit
      // pressure recovers toward ambient. Modelling separation properly is a
      // larger change, so clamp at zero rather than report negative thrust.
      const C_F_ideal =
        Math.sqrt(term1 * term2 * term3) + ((Pe - this.Pa) / this.Pc) * this.expansion_ratio;
      const C_F = is_choked ? Math.max(0, C_F_ideal * this.cf_eff) : 0;
      const Thrust = C_F * this.Pc * At;

      this.results.push({
        Time: this.time,
        Ab: Ab,
        Pc: this.Pc,
        Thrust: Thrust,
        PortMassFlux: G,
        ThroatArea: At,
        PortArea: A_port,
        y: this.y,
        MassFlow: m_dot_out,
        PropellantMassGen: total_propellant_consumed,
      });

      if (this.time > 30.0) {
        break;
      }
    }

    return { results: this.results, warnings };
  }
}

/*
 * The structural analysis that used to live here has moved to the Rust core:
 * crates/burn-core/src/structural.rs, reached through `analyzeStructure` in
 * src/structuralClient.ts.
 *
 * What was here:
 *   calculate_casing_thickness    thin-wall pR/t sizing rule. Still available,
 *                                 as `required_wall_thickness` in the core, but
 *                                 labelled a SIZING RULE rather than an
 *                                 analysis result -- feeding its own answer back
 *                                 through the real analysis gives a safety
 *                                 factor below the one requested, because pR/t
 *                                 knows nothing about the closure junction.
 *   calculate_casing_strain       uniaxial hoop strain pR/tE, which ignores the
 *                                 radial and axial stresses. Replaced by the
 *                                 full triaxial Hooke's law at the bore.
 *   calculate_discontinuity_stress  computed "max bending stress" as a literal
 *                                 1.3x the hoop stress -- its own comment called
 *                                 it "approximation for visual proxy". It also
 *                                 computed beta, Q0 and M0 and then used none of
 *                                 them. Replaced by real cylindrical-shell edge
 *                                 bending, where the ratio is
 *                                 sqrt(3)/sqrt(1-nu^2) ~ 1.82, so the old value
 *                                 was ~30% low everywhere, non-conservatively.
 */

export function export_to_eng(
  results: SimulationResult[],
  initial_mass: number,
  propellant_mass: number,
  motor_designation: string
): string {
  let out = `; APRO Burn & Geometry Modeler Export\n`;
  out += `${motor_designation} 38 200 0 ${propellant_mass.toFixed(4)} ${initial_mass.toFixed(4)} APRO\n`;

  const sample_rate = Math.max(1, Math.floor(results.length / 500));
  for (let i = 0; i < results.length; i += sample_rate) {
    out += `${results[i].Time.toFixed(4)} ${results[i].Thrust.toFixed(4)}\n`;
  }

  const last_time = results[results.length - 1].Time;
  out += `${(last_time + 0.01).toFixed(4)} 0.0000\n`;

  return out;
}
