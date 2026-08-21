import { useState } from 'react';
import type { BurnRateRegime, SolverModelType } from './wasmCore';
import type { DXFRegressionResults } from './dxfProcessor';

/**
 * Every design input for a motor, in one place.
 *
 * WHY THIS HOOK EXISTS
 *
 * AppDesktop held 88 `useState` calls in a single 3,000-line component. The
 * practical cost was not aesthetic: nothing in it could be unit tested, because
 * there was no way to reach the state without rendering the whole application,
 * and reasoning about which of forty inputs a change touched meant reading the
 * whole file.
 *
 * The design inputs are the largest coherent group, so they move first.
 *
 * WHY IT RETURNS THE SAME NAMES
 *
 * The hook deliberately returns `density`, `setDensity` and so on rather than a
 * nested object. Those identifiers appear at several hundred call sites across
 * the component, and a refactor that renames all of them is a refactor whose
 * diff nobody can review -- the risk of a silent mistake in one of the hundreds
 * of edits outweighs the tidiness. Destructuring keeps every call site byte
 * identical while the state itself becomes testable in isolation.
 *
 * Defaults are the shipped APCP propellant and a mid-size Star grain, matching
 * what the app has always started with.
 */

export type GrainType =
  | 'Star'
  | 'BATES'
  | 'Tubular'
  | 'RodAndTube'
  | 'MoonBurner'
  | 'Finocyl'
  | 'CustomDXF';

export type NozzleMaterialName = 'Graphite' | 'Phenolic' | 'Custom';

export type CasingMaterialName =
  | 'Al 6061-T6'
  | 'Steel 4130'
  | 'Carbon Composite'
  | 'Custom';

/** Yield strength (MPa) and Young's modulus (GPa) for the stock alloys. */
export const CASING_ALLOYS: Record<string, { y: number; m: number }> = {
  'Al 6061-T6': { y: 276, m: 69 },
  'Steel 4130': { y: 435, m: 205 },
  'Carbon Composite': { y: 800, m: 150 },
};

export interface MotorConfigDefaults {
  propellantName: string;
  density: number;
  a: number;
  n: number;
  molWeight: number;
}

export function useMotorConfig(defaults: MotorConfigDefaults) {
  // ---- propellant -------------------------------------------------------
  const [density, setDensity] = useState<number>(defaults.density);
  /** SI: r_b = a * Pc^n with Pc in Pa and r_b in m/s. */
  const [a, setA] = useState<number>(defaults.a);
  const [n, setN] = useState<number>(defaults.n);
  const [molWeight, setMolWeight] = useState<number>(defaults.molWeight);
  const [kErosive, setKErosive] = useState<number>(0.001);
  const [gThreshold, setGThreshold] = useState<number>(500.0);
  const [T_ref, setTRef] = useState<number>(294.0);
  const [sigma_p, setSigmaP] = useState<number>(0.001);
  const [T_init, setTInit] = useState<number>(294.0);
  /**
   * Piecewise burn-rate bands for the selected propellant, if it has any.
   * Empty means the single a/n law, which is what a custom propellant gets.
   */
  const [burnRateRegimes, setBurnRateRegimes] = useState<BurnRateRegime[]>([]);
  /**
   * Name of the propellant currently loaded from the library.
   *
   * Used to report model uncertainty, which differs sharply between a
   * propellant measured against strand-burner data and one that never has been.
   */
  const [propellantName, setPropellantName] = useState<string>(defaults.propellantName);

  // ---- grain ------------------------------------------------------------
  const [grainType, setGrainType] = useState<GrainType>('Star');
  const [length, setLength] = useState<number>(0.5);
  const [outerRadius, setOuterRadius] = useState<number>(0.05);
  /** Bore for BATES/Tubular, tube inner for RodAndTube, core for MoonBurner/Finocyl. */
  const [innerRadius, setInnerRadius] = useState<number>(0.02);
  const [valleyRadius, setValleyRadius] = useState<number>(0.03);
  const [tipRadius, setTipRadius] = useState<number>(0.01);
  /** Star points, or Finocyl fins. */
  const [numPoints, setNumPoints] = useState<number>(5);
  const [numSegments, setNumSegments] = useState<number>(1);
  const [offset, setOffset] = useState<number>(0.01);
  const [rodRadius, setRodRadius] = useState<number>(0.01);
  const [finDepth, setFinDepth] = useState<number>(0.035);
  const [finWidth, setFinWidth] = useState<number>(0.01);
  const [dxfData, setDxfData] = useState<DXFRegressionResults | null>(null);
  const [dxfFilename, setDxfFilename] = useState<string>('');

  // ---- nozzle and thermo ------------------------------------------------
  const [throatDiameter, setThroatDiameter] = useState<number>(0.015);
  const [expansionRatio, setExpansionRatio] = useState<number>(7.0);
  const [gamma, setGamma] = useState<number>(1.2);
  const [flameTemp, setFlameTemp] = useState<number>(3000);
  const [nozzleMaterial, setNozzleMaterial] = useState<NozzleMaterialName>('Graphite');
  const [cStarEff, setCStarEff] = useState<number>(0.95);
  const [cfEff, setCfEff] = useState<number>(0.98);
  const [erosiveModel, setErosiveModel] = useState<'None' | 'Lenoir-Robillard' | 'JPL'>(
    'Lenoir-Robillard'
  );

  /*
   * 0-D is the default: it is the fast path, and for the short, fat grains most
   * hobby motors use it lands within a fraction of a percent of the axially
   * resolved answer anyway.
   */
  const [solverModel, setSolverModel] = useState<SolverModelType>('0D');
  const [stationCount, setStationCount] = useState<number>(20);

  // ---- custom nozzle thermal properties ---------------------------------
  const [nozzleDensity, setNozzleDensity] = useState<number>(1800);
  const [nozzleHeatOfAblation, setNozzleHeatOfAblation] = useState<number>(25e6);
  const [nozzleOxidationTemp, setNozzleOxidationTemp] = useState<number>(1500);
  const [nozzleThermalShock, setNozzleThermalShock] = useState<number>(0.1);
  const [nozzleThermalConductivity, setNozzleThermalConductivity] = useState<number>(100);
  const [nozzleSpecificHeat, setNozzleSpecificHeat] = useState<number>(710);
  const [nozzleKTempCoeff, setNozzleKTempCoeff] = useState<number>(-0.0001);
  const [nozzleCpTempCoeff, setNozzleCpTempCoeff] = useState<number>(0.0002);

  // ---- igniter ----------------------------------------------------------
  const [igniterMass, setIgniterMass] = useState<number>(0.05);
  const [igniterSurfaceArea, setIgniterSurfaceArea] = useState<number>(0.01);
  const [igniterDensity, setIgniterDensity] = useState<number>(1900);
  const [igniterA, setIgniterA] = useState<number>(1e-4);
  const [igniterN, setIgniterN] = useState<number>(0.4);

  // ---- casing and closure -----------------------------------------------
  /*
   * The wall to ANALYSE, not the wall the sizing rule suggests. The thin-wall
   * rule gives a starting point (metrics.requiredThickness) but the real stress
   * state depends on the wall you actually build, so this is an input.
   */
  const [caseWallThickness, setCaseWallThickness] = useState<number>(0.003);
  const [caseBoltEdgeDistance, setCaseBoltEdgeDistance] = useState<number>(0.0075);
  const [casingMaterial, setCasingMaterial] = useState<CasingMaterialName>('Al 6061-T6');
  /** MPa. */
  const [casingYieldStress, setCasingYieldStress] = useState<number>(276);
  /** GPa. */
  const [casingYoungsModulus, setCasingYoungsModulus] = useState<number>(69);
  const [numBolts, setNumBolts] = useState<number>(6);
  const [boltDiameter, setBoltDiameter] = useState<number>(0.005);
  /** MPa. */
  const [boltYieldStress, setBoltYieldStress] = useState<number>(400);

  return {
    density, setDensity,
    a, setA,
    n, setN,
    molWeight, setMolWeight,
    kErosive, setKErosive,
    gThreshold, setGThreshold,
    T_ref, setTRef,
    sigma_p, setSigmaP,
    T_init, setTInit,
    burnRateRegimes, setBurnRateRegimes,
    propellantName, setPropellantName,

    grainType, setGrainType,
    length, setLength,
    outerRadius, setOuterRadius,
    innerRadius, setInnerRadius,
    valleyRadius, setValleyRadius,
    tipRadius, setTipRadius,
    numPoints, setNumPoints,
    numSegments, setNumSegments,
    offset, setOffset,
    rodRadius, setRodRadius,
    finDepth, setFinDepth,
    finWidth, setFinWidth,
    dxfData, setDxfData,
    dxfFilename, setDxfFilename,

    throatDiameter, setThroatDiameter,
    expansionRatio, setExpansionRatio,
    gamma, setGamma,
    flameTemp, setFlameTemp,
    nozzleMaterial, setNozzleMaterial,
    cStarEff, setCStarEff,
    cfEff, setCfEff,
    erosiveModel, setErosiveModel,
    solverModel, setSolverModel,
    stationCount, setStationCount,

    nozzleDensity, setNozzleDensity,
    nozzleHeatOfAblation, setNozzleHeatOfAblation,
    nozzleOxidationTemp, setNozzleOxidationTemp,
    nozzleThermalShock, setNozzleThermalShock,
    nozzleThermalConductivity, setNozzleThermalConductivity,
    nozzleSpecificHeat, setNozzleSpecificHeat,
    nozzleKTempCoeff, setNozzleKTempCoeff,
    nozzleCpTempCoeff, setNozzleCpTempCoeff,

    igniterMass, setIgniterMass,
    igniterSurfaceArea, setIgniterSurfaceArea,
    igniterDensity, setIgniterDensity,
    igniterA, setIgniterA,
    igniterN, setIgniterN,

    caseWallThickness, setCaseWallThickness,
    caseBoltEdgeDistance, setCaseBoltEdgeDistance,
    casingMaterial, setCasingMaterial,
    casingYieldStress, setCasingYieldStress,
    casingYoungsModulus, setCasingYoungsModulus,
    numBolts, setNumBolts,
    boltDiameter, setBoltDiameter,
    boltYieldStress, setBoltYieldStress,
  };
}

export type MotorConfig = ReturnType<typeof useMotorConfig>;

/*
 * The permitted values for each enumerated input, as runtime arrays.
 *
 * A TypeScript union type vanishes at runtime, so it cannot validate a value
 * read from a user-supplied BurnSim file. These arrays are the runtime half,
 * and `satisfies readonly GrainType[]` keeps them in step with the type: add a
 * geometry to the union without adding it here and this stops compiling.
 */
export const GRAIN_TYPES = [
  'Star',
  'BATES',
  'Tubular',
  'RodAndTube',
  'MoonBurner',
  'Finocyl',
  'CustomDXF',
] as const satisfies readonly GrainType[];

export const NOZZLE_MATERIALS = [
  'Graphite',
  'Phenolic',
  'Custom',
] as const satisfies readonly NozzleMaterialName[];

export const CASING_MATERIALS = [
  'Al 6061-T6',
  'Steel 4130',
  'Carbon Composite',
  'Custom',
] as const satisfies readonly CasingMaterialName[];
