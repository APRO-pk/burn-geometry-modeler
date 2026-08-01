import math
import pandas as pd
import numpy as np

class SolidPropellant:
    """
    Modular class representing the solid propellant's physical and chemical characteristics.
    """
    def __init__(self, density, a, n, flame_temp, gamma, molecular_weight, k_erosive=0.0, G_threshold=0.0, T_ref=294.0, sigma_p=0.001):
        self.density = density  # kg/m^3
        self.a = a  # burn rate coefficient (m/s / Pa^n)
        self.n = n  # pressure exponent
        self.flame_temp = flame_temp  # K
        self.gamma = gamma # specific heat ratio
        self.molecular_weight = molecular_weight  # kg/mol
        self.T_ref = T_ref # reference temperature (K)
        self.sigma_p = sigma_p # temperature sensitivity (1/K)
        self.R_univ = 8.314  # J/(mol*K)
        self.R_spec = self.R_univ / self.molecular_weight
        
        # Erosive burning parameters
        self.k_erosive = k_erosive
        self.G_threshold = G_threshold
        
        # Calculate C_D (Discharge Coefficient)
        # C_D = Gamma / sqrt(gamma * R_spec * T_f)
        self.Gamma = math.sqrt(self.gamma) * math.pow(2 / (self.gamma + 1), (self.gamma + 1) / (2 * (self.gamma - 1)))
        self.C_D = self.Gamma / math.sqrt(self.R_spec * self.flame_temp)
        self.c_star = 1.0 / self.C_D

class GrainGeometry:
    """
    Superclass for all grain geometries.
    """
    def __init__(self, length, outer_radius):
        self.length = length
        self.outer_radius = outer_radius

    def get_burning_area(self, y):
        raise NotImplementedError

    def get_port_area(self, y):
        raise NotImplementedError

class BATES(GrainGeometry):
    """
    BATES (Ballistic Test Evaluation System) grain geometry.
    Cylindrical grain burning on the inner bore and both ends.
    """
    def __init__(self, length, outer_radius, inner_radius):
        super().__init__(length, outer_radius)
        self.inner_radius = inner_radius
        self.web = outer_radius - inner_radius
        
    def get_burning_area(self, y):
        if y >= self.web:
            return 0.0
        r = self.inner_radius + y
        l = self.length - 2 * y
        if l <= 0:
            return 0.0
        bore_area = 2 * math.pi * r * l
        end_area = 2 * math.pi * (self.outer_radius**2 - r**2)
        return bore_area + end_area

    def get_port_area(self, y):
        r = min(self.inner_radius + y, self.outer_radius)
        return math.pi * r**2

class Star(GrainGeometry):
    """
    Star grain geometry.
    Handles the complex regression of the points until burnout (transitioning to a cylinder).
    """
    def __init__(self, length, outer_radius, valley_radius, tip_radius, num_points):
        super().__init__(length, outer_radius)
        self.valley_radius = valley_radius
        self.tip_radius = tip_radius
        self.N = num_points
        self.web = outer_radius - valley_radius
        self.theta = math.pi / self.N
        
        # Calculate the half-angle of the star point (epsilon)
        self.epsilon = math.atan2(valley_radius * math.sin(self.theta), valley_radius * math.cos(self.theta) - tip_radius)
        self.initial_straight_length = math.hypot(valley_radius * math.sin(self.theta), valley_radius * math.cos(self.theta) - tip_radius)

    def get_burning_area(self, y):
        if y >= self.web:
            return 0.0
        
        # Length of the straight edge of the star as it regresses
        l_straight = self.initial_straight_length - y / math.tan(self.epsilon)
        
        if l_straight > 0:
            # Phase 1: Star burning
            perimeter = 2 * self.N * l_straight + 2 * math.pi * y
        else:
            # Phase 2: Transitioned to a cylinder
            r_cyl = self.valley_radius + y
            if r_cyl < self.outer_radius:
                perimeter = 2 * math.pi * r_cyl
            else:
                perimeter = 0.0
                
        return perimeter * self.length

    def get_port_area(self, y):
        l_straight = self.initial_straight_length - y / math.tan(self.epsilon)
        if l_straight > 0:
            # Star phase: approximate star area
            # Area = N * triangle area from center to each valley point
            # minus the N tip sectors
            r_mean = self.valley_radius + y
            # Polygon approximation (2N-sided)
            star_area = self.N * r_mean**2 * math.sin(2 * self.theta) / 2
            return star_area
        else:
            r_cyl = self.valley_radius + y
            return math.pi * r_cyl**2

class Finocyl(GrainGeometry):
    """
    Finocyl (Fin-Cylinder) grain geometry.
    N fins radiating from a central tube of radius r_tube.
    Each fin has width w_fin and height h_fin.
    """
    def __init__(self, length, outer_radius, r_tube, num_fins, w_fin, h_fin):
        super().__init__(length, outer_radius)
        self.r_tube = r_tube
        self.N = num_fins
        self.w_fin = w_fin
        self.h_fin = h_fin
        self.web = outer_radius - r_tube

    def get_burning_area(self, y):
        if y >= self.web:
            return 0.0

        r_bore = self.r_tube + y
        r_tip = self.r_tube + self.h_fin + y
        w_current = self.w_fin + 2 * y

        if r_tip < self.outer_radius:
            # Phase 1: Slots have not reached the casing
            # Formula accounts for central bore and sides/tips of slots
            perimeter = 2 * math.pi * r_bore + 2 * self.N * self.h_fin
        else:
            # Phase 2: Slots have hit the casing
            effective_h = self.outer_radius - r_bore
            if effective_h <= 0:
                return 0.0
            
            # Area between slots regresses until bore hits casing
            perimeter = 2 * math.pi * r_bore - self.N * w_current + 2 * self.N * effective_h
            
        return max(0.0, perimeter * self.length)

    def get_port_area(self, y):
        r_bore = min(self.r_tube + y, self.outer_radius)
        r_tip = min(self.outer_radius, self.r_tube + self.h_fin + y)
        w_current = self.w_fin + 2 * y

        if r_bore >= self.outer_radius:
            return math.pi * self.outer_radius**2

        bore_area = math.pi * r_bore**2
        slot_area = self.N * (r_tip - r_bore) * w_current

        return min(math.pi * self.outer_radius**2, bore_area + slot_area)

class MotorSimulation:
    """
    The Ballistic Simulation Engine.
    """
    def __init__(self, propellant, grain, dt=0.001, T_init=294.0):
        self.propellant = propellant
        self.grain = grain
        self.dt = dt
        self.time = 0.0
        self.y = 0.0  # web burned
        self.Pc = 101325.0  # Initial chamber pressure (1 atm)
        self.Pa = 101325.0  # Ambient pressure
        self.D_t = 0.0  # Throat diameter
        self.erosion_rate = 0.0  # m/s
        self.results = []
        self.expansion_ratio = 1.0
        self.T_init = T_init

    def set_nozzle(self, D_t, expansion_ratio, erosion_rate=0.0):
        self.D_t = D_t
        self.expansion_ratio = expansion_ratio
        self.erosion_rate = erosion_rate
        
    def _solve_pe_pc(self):
        """
        Iteratively solves for the exit pressure ratio (Pe/Pc) given the expansion ratio.
        """
        gamma = self.propellant.gamma
        Gamma = self.propellant.Gamma
        epsilon = self.expansion_ratio
        
        def f(pr):
            if pr <= 0 or pr >= 1: return 1e9
            return Gamma / math.sqrt( 2*gamma/(gamma-1) * math.pow(pr, 2/gamma) * (1 - math.pow(pr, (gamma-1)/gamma)) ) - epsilon

        low = 0.00001
        high = math.pow(2 / (gamma + 1), gamma / (gamma - 1))
        
        for _ in range(50):
            mid = (low + high) / 2
            if f(mid) > 0:
                low = mid
            else:
                high = mid
                
        return (low + high) / 2

    def check_stability(self):
        """
        Performs pre-run checks for ballistic stability and safety.
        Returns a list of warning strings.
        """
        warnings = []
        Ab_initial = self.grain.get_burning_area(0)
        At_initial = math.pi / 4 * self.D_t**2
        
        if At_initial <= 0:
            warnings.append("Critical: Throat diameter is zero or negative.")
            return warnings

        Kn = Ab_initial / At_initial
        
        # 1. Kn Check
        if Kn > 400:
            warnings.append(f"Warning: Initial Kn ({Kn:.1f}) is very high (> 400). Potential over-pressure.")
        
        # 2. Exponent Check
        if self.propellant.n >= 1.0:
            warnings.append(f"Warning: Pressure exponent n ({self.propellant.n:.2f}) is >= 1.0. Combustion is theoretically unstable.")
            return warnings # Skip PC eq check if n >= 1 to avoid division by zero or complex numbers
            
        # 3. Equilibrium Pressure Check
        # a_corr = a * temp_corr
        temp_corr = 1 + self.propellant.sigma_p * (self.T_init - self.propellant.T_ref)
        a_corr = self.propellant.a * temp_corr
        
        try:
            pc_eq = math.pow((self.propellant.density * a_corr / self.propellant.C_D) * Kn, 1 / (1 - self.propellant.n))
            if pc_eq > 30e6:
                warnings.append(f"Warning: Predicted equilibrium pressure ({pc_eq/1e6:.1f} MPa) exceeds 30 MPa. Highly unrealistic/dangerous.")
        except (ValueError, OverflowError):
            warnings.append("Warning: Could not calculate equilibrium pressure. Possible numeric instability.")
            
        return warnings

    def run(self):
        warnings = self.check_stability()
        V_c = self.grain.get_port_area(self.y) * self.grain.length
        igniter_mass_flow = 0.1 # kg/s for initial pressurization
        
        pr_ratio = self._solve_pe_pc()
        gamma = self.propellant.gamma
        
        while True:
            Ab = self.grain.get_burning_area(self.y)
            A_port = self.grain.get_port_area(self.y)
            At = math.pi / 4 * self.D_t**2
            
            if Ab <= 0.0 and self.Pc <= self.Pa * 1.01:
                break # Burnout and depressurized
                
            # Base burn rate (Saint Robert's Law) with temperature correction
            r_b_base = self.propellant.a * (self.Pc ** self.propellant.n)
            temp_corr = 1 + self.propellant.sigma_p * (self.T_init - self.propellant.T_ref)
            r_b = r_b_base * temp_corr
            
            # Erosive burning modifier
            m_dot_ideal = self.propellant.density * Ab * r_b
            G = m_dot_ideal / A_port if A_port > 0 else 0
            if G > self.propellant.G_threshold:
                r_b = r_b * (1 + self.propellant.k_erosive * (G - self.propellant.G_threshold))
            
            if Ab <= 0.0:
                r_b = 0.0
                
            m_dot_in = self.propellant.density * Ab * r_b
            
            # Add igniter mass flow for the first 0.05 seconds
            if self.time < 0.05:
                m_dot_in += igniter_mass_flow
                
            m_dot_out = self.propellant.C_D * self.Pc * At
            
            # Chamber pressure differential equation (Mass Conservation)
            dVc_dt = Ab * r_b
            dPc_dt = (self.propellant.R_spec * self.propellant.flame_temp / V_c) * \
                     (m_dot_in - m_dot_out - (self.Pc / (self.propellant.R_spec * self.propellant.flame_temp)) * dVc_dt)
            
            # Update variables
            def _rk4_step(self, Pc, V_c, y, dt):
                def dPc(pc, vc, web):
                    Ab = self.grain.get_burning_area(web)
                    r_b_base = self.propellant.a * (pc ** self.propellant.n)
                    temp_corr = 1 + self.propellant.sigma_p * (self.T_init - self.propellant.T_ref)
                    r_b = r_b_base * temp_corr
                    m_in = self.propellant.density * Ab * r_b
                    At = math.pi / 4 * self.D_t**2
                    m_out = self.propellant.C_D * pc * At
                    dVc = Ab * r_b
                    return (self.propellant.R_spec * self.propellant.flame_temp / vc) * \
                    (m_in - m_out - (pc / (self.propellant.R_spec * self.propellant.flame_temp)) * dVc)
                k1 = dPc(Pc, V_c, y)
                k2 = dPc(Pc + 0.5*dt*k1, V_c, y)
                k3 = dPc(Pc + 0.5*dt*k2, V_c, y)
                k4 = dPc(Pc + dt*k3, V_c, y)
                return Pc + (dt/6) * (k1 + 2*k2 + 2*k3 + k4)
            self.y += r_b * self.dt
            V_c += dVc_dt * self.dt
            self.D_t += self.erosion_rate * self.dt
            self.time += self.dt
            
            # Calculate Thrust
            Pe = self.Pc * pr_ratio
            term1 = 2 * gamma**2 / (gamma - 1)
            term2 = math.pow(2 / (gamma + 1), (gamma + 1) / (gamma - 1))
            term3 = 1 - math.pow(Pe / self.Pc, (gamma - 1) / gamma)
            if term3 < 0: term3 = 0
            
            C_F = math.sqrt(term1 * term2 * term3) + (Pe - self.Pa) / self.Pc * self.expansion_ratio
            Thrust = C_F * self.Pc * At
            
            self.results.append({
                'Time': self.time,
                'Ab': Ab,
                'Pc': self.Pc,
                'Thrust': Thrust,
                'Port Mass Flux': G,
                'Throat Area': At
            })
            
            if self.time > 30.0: # Safety break
                break

        return pd.DataFrame(self.results), warnings

def calculate_casing_thickness(max_pressure, case_radius, safety_factor=1.5, yield_stress=276e6):
    """
    Calculates the required motor casing thickness based on hoop stress limits.
    """
    return (max_pressure * case_radius * safety_factor) / yield_stress

def export_to_eng(df, initial_mass, propellant_mass, motor_designation, filename="motor.eng"):
    """
    Automatically formats and outputs a strictly compliant RockSim (.eng) text string.
    """
    with open(filename, 'w') as f:
        f.write(f"; APRO Burn & Geometry Modeler Export\n")
        f.write(f"{motor_designation} 38 200 0 {propellant_mass:.4f} {initial_mass:.4f} APRO\n")
        
        sample_rate = max(1, len(df) // 500)
        for idx, row in df.iloc[::sample_rate].iterrows():
            f.write(f"{row['Time']:.4f} {row['Thrust']:.4f}\n")
        
        last_time = df['Time'].iloc[-1]
        f.write(f"{last_time + 0.01:.4f} 0.0000\n")

if __name__ == "__main__":
    # --- Example Usage for APRO ---
    
    # 1. Define Propellant (KNSB example)
    prop = SolidPropellant(
        density=1700, 
        a=5e-5, 
        n=0.35, 
        flame_temp=3000, 
        gamma=1.2, 
        molecular_weight=0.024,
        k_erosive=0.001,
        G_threshold=500.0
    )
    
    # 2. Define Grain Geometry (Finocyl)
    # length, outer_radius, r_tube, num_fins, w_fin, h_fin
    grain = Finocyl(
        length=0.4, 
        outer_radius=0.05, 
        r_tube=0.015, 
        num_fins=6,
        w_fin=0.005,
        h_fin=0.03
    )
    
    # 3. Initialize Simulation
    sim = MotorSimulation(prop, grain, dt=0.001)
    sim.set_nozzle(D_t=0.014, expansion_ratio=8.0, erosion_rate=0.00005)
    
    # 4. Run Simulation
    print("Running Ballistic Simulation Engine (Finocyl Mode)...")
    df, warnings = sim.run()
    
    for warning in warnings:
        print(f"STABILITY WARNING: {warning}")
    
    # 5. Calculate Performance Metrics
    max_thrust = df['Thrust'].max()
    max_pc = df['Pc'].max()
    avg_thrust = df['Thrust'].mean()
    total_impulse = np.trapz(df['Thrust'], df['Time'])
    action_time = df['Time'].iloc[-1]
    
    # Propellant mass calculation for Finocyl
    fin_void = grain.get_port_area(0) * grain.length
    prop_vol = math.pi * grain.outer_radius**2 * grain.length - fin_void
    prop_mass = prop_vol * prop.density
    isp = total_impulse / (prop_mass * 9.80665)
    
    print(f"\n--- APRO Burn & Geometry Modeler Results (Finocyl) ---")
    print(f"Max Thrust:       {max_thrust:.2f} N")
    print(f"Average Thrust:   {avg_thrust:.2f} N")
    print(f"Max Pressure:     {max_pc/1e6:.2f} MPa")
    print(f"Total Impulse:    {total_impulse:.2f} Ns")
    print(f"Specific Impulse: {isp:.2f} s")
    print(f"Action Time:      {action_time:.2f} s")
    
    # 6. Casing Structural Margin
    casing_thickness = calculate_casing_thickness(max_pc, grain.outer_radius, yield_stress=276e6) # Al 6061-T6
    print(f"\nRequired Casing Thickness (SF=1.5): {casing_thickness*1000:.2f} mm")
    
    # 7. Export
    export_to_eng(df, prop_mass + 0.8, prop_mass, "APRO-Finocyl-1", "APRO-Finocyl-1.eng")
    print("\nExported RockSim compliant file to 'APRO-Finocyl-1.eng'")
