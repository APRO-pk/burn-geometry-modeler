import pytest
import math
import numpy as np
from apro_modeler import SolidPropellant, BATES, Star, MotorSimulation, export_to_eng
import os

def test_bates_grain_area():
    # Setup BATES grain based on Nakka or similar scale
    length = 0.4
    outer_radius = 0.05
    inner_radius = 0.015
    grain = BATES(length, outer_radius, inner_radius)
    web = outer_radius - inner_radius
    
    # y = 0
    area_0 = grain.get_burning_area(0)
    expected_0 = 2 * math.pi * inner_radius * length + 2 * math.pi * (outer_radius**2 - inner_radius**2)
    assert area_0 == pytest.approx(expected_0, rel=1e-5)
    
    # y = web / 2
    y_mid = web / 2
    area_mid = grain.get_burning_area(y_mid)
    r_mid = inner_radius + y_mid
    l_mid = length - 2 * y_mid
    expected_mid = 2 * math.pi * r_mid * l_mid + 2 * math.pi * (outer_radius**2 - r_mid**2)
    assert area_mid == pytest.approx(expected_mid, rel=1e-5)
    
    # y = web
    area_web = grain.get_burning_area(web)
    assert area_web == 0.0

def test_star_grain_continuity():
    # Setup Star grain
    length = 0.4
    outer_radius = 0.05
    valley_radius = 0.03
    tip_radius = 0.01
    num_points = 5
    grain = Star(length, outer_radius, valley_radius, tip_radius, num_points)
    
    # Calculate transition web distance
    # l_straight = initial_straight_length - y / math.tan(epsilon) = 0
    y_transition = grain.initial_straight_length * math.tan(grain.epsilon)
    
    # Check areas just before and after transition
    area_before = grain.get_burning_area(y_transition - 1e-7)
    area_after = grain.get_burning_area(y_transition + 1e-7)
    
    # Check relative jump is small (< 1%)
    assert abs(area_before - area_after) / area_before < 0.01

def test_pressure_equilibrium_kndx():
    # KNDX Propellant Data (Approximate Nakka values)
    # Reference: https://www.nakka-rocketry.net/kndx.html
    prop = SolidPropellant(
        density=1879,
        a=8.875e-5,  # SI units (m/s / Pa^n) for n=0.32
        n=0.32,
        flame_temp=1720, # KNDX flame temp
        gamma=1.13,
        molecular_weight=0.042 # kg/mol
    )
    
    # Simple BATES grain
    length = 0.2
    outer_radius = 0.025
    inner_radius = 0.01
    grain = BATES(length, outer_radius, inner_radius)
    
    # Simulation setup
    sim = MotorSimulation(prop, grain, dt=0.001)
    # Set throat for a specific Kn approx 200
    # Kn = Ab / At -> At = Ab / Kn
    Ab_initial = grain.get_burning_area(0)
    Kn_target = 200.0
    At_target = Ab_initial / Kn_target
    Dt = math.sqrt(4 * At_target / math.pi)
    sim.set_nozzle(D_t=Dt, expansion_ratio=1.0)
    
    # Run simulation
    df, warnings = sim.run()
    
    # Calculate Theoretical Steady State Pc
    # Pc = [ (rho_p * a / C_D) * Kn ] ^ (1 / (1-n))
    theoretical_pc = ( (prop.density * prop.a / prop.C_D) * Kn_target )**(1 / (1 - prop.n))
    
    # Max simulation pressure should be close to theoretical equilibrium
    # (Allowing some discrepancy for dVc/dt impacts and initial igniter flow)
    max_pc = df['Pc'].max()
    assert max_pc == pytest.approx(theoretical_pc, rel=0.1)

def test_eng_export_compliance():
    filename = "test_export.eng"
    if os.path.exists(filename):
        os.remove(filename)
        
    # Mock data
    import pandas as pd
    data = {
        'Time': [0.0, 0.1, 0.2],
        'Thrust': [0.0, 100.0, 0.0]
    }
    df = pd.DataFrame(data)
    
    export_to_eng(df, 1.5, 0.5, "TEST-MOTOR", filename)
    
    assert os.path.exists(filename)
    
    with open(filename, 'r') as f:
        content = f.read()
        lines = content.splitlines()
        
        # Check header
        assert "TEST-MOTOR" in lines[1]
        assert "0.5000 1.5000" in lines[1] # propellant mass and initial total mass
        
        # Check data points
        assert "0.0000 0.0000" in lines[2]
        
    os.remove(filename)
