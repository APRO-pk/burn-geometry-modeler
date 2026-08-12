import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  grainFromUi,
  export_to_eng,
  SimulationResult,
  NozzleMaterialProps,
  GrainUiParams
} from './engine';
import { runMotor, warmUpMotorCore } from './wasmClient';
import { analyzeStructure, initStructural, requiredWallThickness } from './structuralClient';
import { grainConfigFromUi } from './wasmCore';
import type { BurnConfig, SolverModelType, StationProfiles } from './wasmCore';
import {
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { File, Save, Play, Terminal, Download, FolderUp, FolderDown, Calculator, BookOpen, Settings, Upload, Undo, Redo, Zap } from 'lucide-react';
import { processDXF, DXFRegressionResults } from './dxfProcessor';
import { PropellantEditor, PropellantData } from './PropellantEditor';
import { GrainEditor } from './GrainEditor';
import { exportBurnsimXML, parseBurnsimXML } from './BurnsimHandler';
import { OptimizerDialog } from './OptimizerDialog';
import { SurrogatePanel } from './SurrogatePanel';

// Unit Conversion Factors mapping to base SI units
const UNIT_FACTORS: Record<string, Record<string, number>> = {
  Length: { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 },
  Pressure: { Pa: 1, kPa: 1000, MPa: 1e6, GPa: 1e9, psi: 6894.76, bar: 1e5, atm: 101325 },
  Mass: { kg: 1, g: 0.001, lbm: 0.453592 },
  Density: { 'kg/m³': 1, 'g/cm³': 1000, 'lb/in³': 27679.9 },
  Area: { 'm²': 1, 'cm²': 0.0001, 'mm²': 1e-6, 'in²': 0.00064516 },
  Temperature: { K: 1 } // Handled separately if needs shift, but let's assume raw delta/scale for now, or just use suffix="K"
};

export const SettingsContext = React.createContext<any>(null);

const DEFAULT_METRIC_PREFS: Record<string, string> = {
  Length: 'mm',
  Pressure: 'MPa',
  Mass: 'kg',
  Density: 'kg/m³',
  Area: 'mm²'
};

const DEFAULT_IMPERIAL_PREFS: Record<string, string> = {
  Length: 'in',
  Pressure: 'psi',
  Mass: 'lbm',
  Density: 'lb/in³',
  Area: 'in²'
};

const IMPERIAL_OPTIONS: Record<string, string[]> = {
  Length: ['in', 'ft'],
  Pressure: ['psi', 'atm'],
  Mass: ['lbm'],
  Density: ['lb/in³'],
  Area: ['in²']
};

const InputBox = ({ label, value, onChange, suffix, step = "any", type = "number", unitCat = null }: any) => {
  const settings = React.useContext(SettingsContext);
  
  const defaultLocalUnit = React.useMemo(() => {
    if (!unitCat || !UNIT_FACTORS[unitCat]) return suffix || '';
    if (settings) {
      if (settings.unitSystem === 'Imperial' && settings.imperialPrefs[unitCat]) {
        return settings.imperialPrefs[unitCat];
      } else if (settings.unitSystem === 'Metric' && DEFAULT_METRIC_PREFS[unitCat]) {
         return DEFAULT_METRIC_PREFS[unitCat];
      }
    }
    return Object.keys(UNIT_FACTORS[unitCat])[0];
  }, [unitCat, suffix, settings]);

  const [localUnit, setLocalUnit] = useState<string>('');

  React.useEffect(() => {
    setLocalUnit(defaultLocalUnit);
  }, [defaultLocalUnit]);

  // Calculate display value if unitCat is used, else passed directly

  const displayVal = React.useMemo(() => {
    if (type !== 'number' || !unitCat || !UNIT_FACTORS[unitCat]) return value;
    const factor = UNIT_FACTORS[unitCat][localUnit];
    if (!factor) return value;
    // value is SI base. Convert TO local unit.
    const res = Number(value) / factor;
    // Format nicely
    return Number.isInteger(res) ? res.toString() : parseFloat(res.toPrecision(6)).toString();
  }, [value, unitCat, localUnit, type]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value;
    if (type !== 'number') return onChange(raw);
    const num = parseFloat(raw);
    if (isNaN(num)) return onChange(0);

    if (unitCat && UNIT_FACTORS[unitCat] && UNIT_FACTORS[unitCat][localUnit]) {
      const factor = UNIT_FACTORS[unitCat][localUnit];
      // Input is local unit. Convert TO SI base.
      onChange(num * factor);
    } else {
      onChange(num);
    }
  };

  return (
    <>
      <label className="flex items-center justify-end pr-1 text-[#444] text-right leading-tight text-xs">{label}</label>
      <div className="relative flex items-center bg-white border border-[#bbb] rounded overflow-hidden focus-within:border-blue-500">
        <input 
          type={type} 
          step={step} 
          value={displayVal} 
          onChange={handleChange} 
          className="pl-1 pr-1 py-0.5 w-full bg-transparent outline-none text-right font-mono text-xs" 
        />
        {unitCat && UNIT_FACTORS[unitCat] ? (
          <select 
            value={localUnit} 
            onChange={e => setLocalUnit(e.target.value)} 
            className="bg-[#f0f0f0] text-[#555] text-[10px] font-bold border-l border-[#ccc] px-1 py-0.5 outline-none cursor-pointer"
          >
            {Object.keys(UNIT_FACTORS[unitCat]).map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        ) : (
          <span className="bg-[#f0f0f0] text-[#777] px-1.5 py-0.5 border-l border-[#ccc] min-w-[30px] text-center text-[10px] font-bold pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </>
  );
};

export default function AppDesktop() {
  const [unitSystem, setUnitSystem] = useState<'Metric' | 'Imperial'>('Metric');
  const [imperialPrefs, setImperialPrefs] = useState<Record<string, string>>(DEFAULT_IMPERIAL_PREFS);
  const [showPreferences, setShowPreferences] = useState(false);

  const settingsContextValue = React.useMemo(() => ({
    unitSystem,
    imperialPrefs,
    setUnitSystem,
    setImperialPrefs
  }), [unitSystem, imperialPrefs]);

  const DEFAULT_PROPELLANTS: PropellantData[] = [
    // Burn-rate coefficient `a` is in SI (r_b = a * Pc^n with Pc in Pa, r_b in m/s),
    // matching the engine. Published St. Robert coefficients are usually quoted for
    // Pc in MPa; convert with a_SI = a_MPa / 10^(6n) before entering them here.
    { id: '1', name: 'APCP (Typical)', density: 1528, a: 8.40e-5, n: 0.3, molWeight: 0.024, kErosive: 0.001, gThreshold: 500, flameTemp: 2700, gamma: 1.18 },
    { id: '2', name: 'KNSB (Sorbitol)', density: 1800, a: 6.01e-5, n: 0.32, molWeight: 0.040, kErosive: 0.0005, gThreshold: 400, flameTemp: 1600, gamma: 1.13 },
    { id: '3', name: 'KNDX (Dextrose)', density: 1878, a: 4.77e-5, n: 0.35, molWeight: 0.042, kErosive: 0.0006, gThreshold: 450, flameTemp: 1700, gamma: 1.14 }
  ];

  const [propellants, setPropellants] = useState<PropellantData[]>(DEFAULT_PROPELLANTS);
  const [showPropellantEditor, setShowPropellantEditor] = useState(false);
  const [showGrainEditor, setShowGrainEditor] = useState(false);

  // Propellant inputs (Current applied configuration)
  const [density, setDensity] = useState<number>(1528);
  const [a, setA] = useState<number>(8.40e-5); // SI (Pc in Pa); matches APCP default above
  const [n, setN] = useState<number>(0.3);
  const [molWeight, setMolWeight] = useState<number>(0.024);
  const [kErosive, setKErosive] = useState<number>(0.001);
  const [gThreshold, setGThreshold] = useState<number>(500.0);
  const [T_ref, setTRef] = useState<number>(294.0);
  const [sigma_p, setSigmaP] = useState<number>(0.001);
  const [T_init, setTInit] = useState<number>(294.0);

  // Grain inputs
  const [grainType, setGrainType] = useState<'Star' | 'BATES' | 'Tubular' | 'RodAndTube' | 'MoonBurner' | 'Finocyl' | 'CustomDXF'>('Star');
  const [length, setLength] = useState<number>(0.5);
  const [outerRadius, setOuterRadius] = useState<number>(0.05);
  const [innerRadius, setInnerRadius] = useState<number>(0.02); // for BATES/Tubular/RodAndTube/MoonBurner/Finocyl core
  const [valleyRadius, setValleyRadius] = useState<number>(0.03); // for Star
  const [tipRadius, setTipRadius] = useState<number>(0.01); // for Star
  const [numPoints, setNumPoints] = useState<number>(5); // for Star/Finocyl
  const [numSegments, setNumSegments] = useState<number>(1); // for BATES
  const [offset, setOffset] = useState<number>(0.01); // for MoonBurner
  const [rodRadius, setRodRadius] = useState<number>(0.01); // for RodAndTube
  const [finDepth, setFinDepth] = useState<number>(0.035); // for Finocyl
  const [finWidth, setFinWidth] = useState<number>(0.01); // for Finocyl
  
  // Custom DXF state
  const [dxfData, setDxfData] = useState<DXFRegressionResults | null>(null);
  const [dxfFilename, setDxfFilename] = useState<string>('');
  const dxfFileInputRef = React.useRef<HTMLInputElement>(null);

  // Nozzle & Thermo inputs
  const [throatDiameter, setThroatDiameter] = useState<number>(0.015);
  const [expansionRatio, setExpansionRatio] = useState<number>(7.0);
  const [gamma, setGamma] = useState<number>(1.2);
  const [flameTemp, setFlameTemp] = useState<number>(3000);
  const [nozzleMaterial, setNozzleMaterial] = useState<'Graphite' | 'Phenolic' | 'Custom'>('Graphite');
  const [cStarEff, setCStarEff] = useState<number>(0.95);
  const [cfEff, setCfEff] = useState<number>(0.98);
  const [erosiveModel, setErosiveModel] = useState<'None' | 'Lenoir-Robillard' | 'JPL'>('Lenoir-Robillard');

  // Solver model. 0-D is the default: it is the fast path, and for the short,
  // fat grains most hobby motors use it is within a fraction of a percent of the
  // axially resolved answer anyway.
  const [solverModel, setSolverModel] = useState<SolverModelType>('0D');
  const [stationCount, setStationCount] = useState<number>(20);
  
  // Custom Nozzle Thermo
  const [nozzleDensity, setNozzleDensity] = useState<number>(1800);
  const [nozzleHeatOfAblation, setNozzleHeatOfAblation] = useState<number>(25e6);
  const [nozzleOxidationTemp, setNozzleOxidationTemp] = useState<number>(1500);
  const [nozzleThermalShock, setNozzleThermalShock] = useState<number>(0.1);
  const [nozzleThermalConductivity, setNozzleThermalConductivity] = useState<number>(100);
  const [nozzleSpecificHeat, setNozzleSpecificHeat] = useState<number>(710);
  const [nozzleKTempCoeff, setNozzleKTempCoeff] = useState<number>(-0.0001);
  const [nozzleCpTempCoeff, setNozzleCpTempCoeff] = useState<number>(0.0002);

  // Igniter & Casing inputs
  const [igniterMass, setIgniterMass] = useState<number>(0.05);
  const [igniterSurfaceArea, setIgniterSurfaceArea] = useState<number>(0.01);
  const [igniterDensity, setIgniterDensity] = useState<number>(1900);
  const [igniterA, setIgniterA] = useState<number>(1e-4);
  const [igniterN, setIgniterN] = useState<number>(0.4);
  // Actual wall to analyse. The thin-wall sizing rule gives a starting point
  // (metrics.requiredThickness) but the real stress state depends on the wall
  // you actually build, so it is an input rather than a derived value.
  const [caseWallThickness, setCaseWallThickness] = useState<number>(0.003);
  const [caseBoltEdgeDistance, setCaseBoltEdgeDistance] = useState<number>(0.0075);
  const [casingMaterial, setCasingMaterial] = useState<'Al 6061-T6' | 'Steel 4130' | 'Carbon Composite' | 'Custom'>('Al 6061-T6');
  const [casingYieldStress, setCasingYieldStress] = useState<number>(276); // MPa
  const [casingYoungsModulus, setCasingYoungsModulus] = useState<number>(69); // GPa

  // Bolted Closure
  const [numBolts, setNumBolts] = useState<number>(6);
  const [boltDiameter, setBoltDiameter] = useState<number>(0.005);
  const [boltYieldStress, setBoltYieldStress] = useState<number>(400); // MPa
  const [flangeThickness, setFlangeThickness] = useState<number>(0.010);

  const CASING_ALLOYS = {
    'Al 6061-T6': { y: 276, m: 69 },
    'Steel 4130': { y: 435, m: 205 },
    'Carbon Composite': { y: 800, m: 150 }
  };

  const handleCasingChange = (val: string) => {
    setCasingMaterial(val as any);
    if (val !== 'Custom') {
      const data = CASING_ALLOYS[val as keyof typeof CASING_ALLOYS];
      setCasingYieldStress(data.y);
      setCasingYoungsModulus(data.m);
    }
  };

  // UI Modal States
  const [showUnitConverter, setShowUnitConverter] = useState(false);
  const [showFEA, setShowFEA] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const configFileInputRef = React.useRef<HTMLInputElement>(null);

  // Custom Graph State
  const [customXAxis, setCustomXAxis] = useState<string>('Time');
  const [customYAxes, setCustomYAxes] = useState<string[]>(['Kn', 'Pc_MPa', 'Thrust_N']);

  // Results & State
  const [results, setResults] = useState<SimulationResult[]>([]);
  /** Axial station profiles from the last run. Undefined after a 0-D run. */
  const [stations, setStations] = useState<StationProfiles | undefined>(undefined);
  const [stabilityWarnings, setStabilityWarnings] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [visualizerIndex, setVisualizerIndex] = useState<number>(0);
  const [statusMsg, setStatusMsg] = useState<string>('System Ready');
  const [activeTab, setActiveTab] = useState<'ballistics' | 'extended_graphs' | 'geometry' | 'thermo' | 'montecarlo' | 'structural' | 'materials' | 'statistics' | 'surrogate'>('ballistics');

  // Monte Carlo State
  const [mcRuns, setMcRuns] = useState<number>(50);
  const [mcVariance, setMcVariance] = useState<number>(5);
  const [mcResults, setMcResults] = useState<any[]>([]);

  // Console Logs
  const [logs, setLogs] = useState<string[]>(['[SYSTEM] APRO Modeler Initialized. Ready for input.']);
  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    setLogs(prev => [...prev, `[${time}] ${msg}`]);
    setStatusMsg(msg);
  };

  // Instantiate the wasm core in its worker while the user is still setting up,
  // so the first Run does not wait on module compilation.
  useEffect(() => {
    warmUpMotorCore();
  }, []);

  // The structural analysis runs on the main thread (it is closed-form and
  // cheap), so it needs its own instance of the module. Loading it here rather
  // than on first use keeps the Structural tab from flashing empty.
  const [structuralLoaded, setStructuralLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    initStructural()
      .then(() => { if (live) setStructuralLoaded(true); })
      .catch((err) => console.warn('Structural core failed to load', err));
    return () => { live = false; };
  }, []);

  /** The grain inputs, in the shared shape both grain mappings take. */
  const grainUiParams = (): GrainUiParams => ({
    grainType, length, outerRadius, innerRadius,
    valleyRadius, tipRadius, numPoints, rodRadius, offset, finWidth, finDepth,
  });

  const buildNozzleMaterial = (): NozzleMaterialProps | null => {
    if (nozzleMaterial === 'Graphite') {
      return { type: 'Graphite', density: 1800, heat_of_ablation: 25e6, oxidation_temp: 1500, thermal_shock_coeff: 0.1, thermal_conductivity: 100, specific_heat: 710, k_temp_coeff: -0.0001, cp_temp_coeff: 0.0004 };
    }
    if (nozzleMaterial === 'Phenolic') {
      return { type: 'Phenolic', density: 1200, heat_of_ablation: 15e6, oxidation_temp: 800, thermal_shock_coeff: 0.5, thermal_conductivity: 1.2, specific_heat: 1300, k_temp_coeff: 0.0001, cp_temp_coeff: 0.002 };
    }
    if (nozzleMaterial === 'Custom') {
      return { type: 'Custom', density: nozzleDensity, heat_of_ablation: nozzleHeatOfAblation, oxidation_temp: nozzleOxidationTemp, thermal_shock_coeff: nozzleThermalShock, thermal_conductivity: nozzleThermalConductivity, specific_heat: nozzleSpecificHeat, k_temp_coeff: nozzleKTempCoeff, cp_temp_coeff: nozzleCpTempCoeff };
    }
    return null;
  };

  /**
   * Assemble a full run configuration from the current inputs. `overrides` lets
   * the Monte Carlo sweep perturb individual parameters without duplicating the
   * mapping.
   */
  const buildBurnConfig = (
    overrides: {
      a?: number;
      density?: number;
      throatDiameter?: number;
      igniterMass?: number;
      /** Force a spatial model, overriding the UI toggle (Monte Carlo, sweeps). */
      model?: SolverModelType;
    } = {}
  ): BurnConfig => ({
    propellant: {
      density: overrides.density ?? density,
      a: overrides.a ?? a,
      n,
      flame_temp: flameTemp,
      gamma,
      molecular_weight: molWeight,
      k_erosive: kErosive,
      g_threshold: gThreshold,
      t_ref: T_ref,
      sigma_p,
    },
    grain: grainConfigFromUi(grainUiParams(), dxfData),
    nozzle: {
      throat_diameter: overrides.throatDiameter ?? throatDiameter,
      expansion_ratio: expansionRatio,
      material: buildNozzleMaterial(),
    },
    igniter: {
      mass: overrides.igniterMass ?? igniterMass,
      surface_area: igniterSurfaceArea,
      density: igniterDensity,
      a: igniterA,
      n: igniterN,
    },
    options: {
      t_init: T_init,
      c_star_eff: cStarEff,
      cf_eff: cfEff,
      erosive_model: erosiveModel,
      model: overrides.model ?? solverModel,
      stations: stationCount,
    },
  });

  const runSimulation = () => {
    pushHistory();
    addLog('Validating parameters...');
    if (outerRadius <= 0 || innerRadius < 0 || length <= 0) {
      addLog('Error: Invalid geometry dimensions.');
      alert('Invalid Geometry: Dimensions must be greater than zero.');
      return;
    }
    if ((grainType === 'BATES' || grainType === 'Tubular' || grainType === 'MoonBurner' || grainType === 'Finocyl') && innerRadius >= outerRadius) {
      addLog('Error: Inner radius cannot be larger than or equal to outer radius.');
      alert('Invalid Geometry: Inner radius must be smaller than outer radius.');
      return;
    }
    if (grainType === 'Finocyl' && (innerRadius + finDepth >= outerRadius || finDepth <= 0)) {
      addLog('Error: Finocyl fin dimensions overlap casing or core incorrectly.');
      alert('Invalid Geometry: Finocyl fin must be bounded between core and casing correctly.');
      return;
    }
    if (grainType === 'MoonBurner' && innerRadius + offset > outerRadius) {
      addLog('Error: MoonBurner core port intersects casing initially.');
      alert('Invalid Geometry: MoonBurner core port cannot intersect casing initially.');
      return;
    }
    if (grainType === 'RodAndTube' && (rodRadius >= innerRadius || innerRadius >= outerRadius)) {
      addLog('Error: RodAndTube dimensions invalid.');
      alert('Invalid Geometry: Rod radius must be < inner radius < outer radius.');
      return;
    }
    if (grainType === 'Star' && (valleyRadius >= outerRadius || tipRadius >= valleyRadius)) {
      addLog('Error: Invalid Star dimensions.');
      alert('Invalid Geometry: Check Star valley and tip radii combinations.');
      return;
    }
    if (grainType === 'CustomDXF' && !dxfData) {
      addLog('Error: No DXF file loaded.');
      alert('Invalid Geometry: Please load a DXF file first.');
      return;
    }
    if (density <= 0 || a <= 0 || throatDiameter <= 0) {
      addLog('Error: Density, a, and throat diameter must be > 0.');
      alert('Invalid Parameters: Density, a, and Throat Diameter must be > 0.');
      return;
    }

    addLog(
      solverModel === 'quasi1D'
        ? `Starting simulation (quasi-1-D, ${stationCount} axial stations)...`
        : 'Starting simulation (0-D lumped chamber)...'
    );
    setIsSimulating(true);

    // Yield control to the browser so it can render the 'loading' overlay
    setTimeout(async () => {
      try {
        // Geometry is still evaluated in TypeScript for the propellant-volume
        // maths below; the solver itself runs in the wasm core.
        const grain = grainFromUi(grainUiParams(), dxfData);

        const {
          results: simResults,
          warnings: simWarnings,
          stations: simStations,
        } = await runMotor(buildBurnConfig());
        setStations(simStations);
        if (simStations) {
          const N = simStations.count;
          const headToNozzle = simResults.reduce((m, r) => {
            if (r.Ab <= 0 || !r.PcNozzle) return m;
            return Math.max(m, (r.Pc - r.PcNozzle) / r.Pc);
          }, 0);
          addLog(
            `Axial solution: head-to-nozzle pressure drop up to ${(headToNozzle * 100).toFixed(1)}%, ` +
              `aft mass flux ${simStations.massFlux[N - 1].toFixed(0)} kg/m²s ` +
              `(${(simStations.massFlux[N - 1] / Math.max(simStations.massFlux[0], 1e-9)).toFixed(1)}x the head end).`
          );
        }
        setResults(simResults);
        setStabilityWarnings(simWarnings);
        if (simWarnings.length > 0) {
          simWarnings.forEach(w => addLog(w));
        }
        setVisualizerIndex(0);

        if (simResults.length > 0) {
          const maxThrust = Math.max(...simResults.map((r) => r.Thrust));
          const maxPc = Math.max(...simResults.map((r) => r.Pc));
          const avgThrust = simResults.reduce((sum, r) => sum + r.Thrust, 0) / simResults.length;
          const avgPc = simResults.reduce((sum, r) => sum + r.Pc, 0) / simResults.length;
          const peakKn = Math.max(...simResults.map((r) => (r.Ab / r.ThroatArea) || 0));
          const initialKn = (simResults[0].Ab / simResults[0].ThroatArea) || 0;
          const peakMassFlux = Math.max(...simResults.map((r) => r.PortMassFlux));
          
          const initialPortArea = simResults[0].PortArea;
          const initialThroatArea = simResults[0].ThroatArea;
          const portThroatRatio = initialPortArea / initialThroatArea;
          
          let totalImpulse = 0;
          for (let i = 1; i < simResults.length; i++) {
            const dt = simResults[i].Time - simResults[i - 1].Time;
            totalImpulse += ((simResults[i].Thrust + simResults[i - 1].Thrust) / 2) * dt;
          }
          
          const actionTime = simResults[simResults.length - 1].Time;

          let propVol = 0;
          const totalMotorVolume = Math.PI * Math.pow(outerRadius, 2) * length * (grainType === 'BATES' ? numSegments : 1);
          
          if (grainType === 'Star') {
            // Subtract the actual star port area, not a circle of valleyRadius.
            // The star port is much smaller than that circle, so the old form
            // understated propellant volume (and therefore mass and Isp).
            propVol = (Math.PI * Math.pow(outerRadius, 2) - grain.get_port_area(0)) * length;
          } else if (grainType === 'RodAndTube') {
            propVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(innerRadius, 2)) * length + Math.PI * Math.pow(rodRadius, 2) * length;
          } else if (grainType === 'MoonBurner') {
            propVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(innerRadius, 2)) * length; // Same as tubular conceptually for volume initially if not intersecting casing
          } else if (grainType === 'Finocyl') {
            const a_core = Math.PI * Math.pow(innerRadius, 2);
            const tip_center = finDepth - finWidth / 2.0;
            const fin_area = numPoints * (tip_center * finWidth + Math.PI * Math.pow(finWidth / 2, 2) / 2);
            propVol = (Math.PI * Math.pow(outerRadius, 2) - (a_core + fin_area)) * length;
          } else if (grainType === 'CustomDXF' && dxfData) {
            propVol = (Math.PI * Math.pow(outerRadius, 2) - dxfData.areaTable[0]) * length;
          } else {
            propVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(innerRadius, 2)) * length * (grainType === 'BATES' ? numSegments : 1);
          }
          const volumeLoading = propVol / totalMotorVolume;
          
          const propMass = propVol * density;
          const isp = totalImpulse / (propMass * 9.80665);
          
          // Thin-wall sizing rule only, shown next to the real analysis on the
          // Structural tab so the two can be compared. The structural results
          // themselves are computed from the chosen wall in `structural`, below.
          const requiredThickness =
            requiredWallThickness(maxPc, outerRadius, 1.5, casingYieldStress * 1e6) ?? 0.002;

          setMetrics({
            maxThrust,
            avgThrust,
            maxPc,
            avgPc,
            totalImpulse,
            isp,
            actionTime,
            requiredThickness,
            propMass,
            initialKn,
            peakKn,
            peakMassFlux,
            portThroatRatio,
            volumeLoading
          });
          addLog(`Simulation complete. Action Time: ${actionTime.toFixed(3)}s, Max Thrust: ${(maxThrust/1000).toFixed(2)}kN`);
        } else {
          addLog('Simulation failed or produced no results.');
        }
      } catch (err: any) {
        addLog(`Simulation error: ${err.message || 'Unknown error'}`);
      } finally {
        setIsSimulating(false);
      }
    }, 50); // Yield to render frame
  };

  const handleExportENG = () => {
    if (!results.length || !metrics) {
      addLog('Error: No simulation results to export.');
      return;
    }
    addLog('Exporting .ENG file...');
    const content = export_to_eng(results, metrics.propMass + 1.0, metrics.propMass, `APRO-${grainType}-1`);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const aElem = document.createElement('a');
    aElem.href = url;
    aElem.download = `APRO-${grainType}-1.eng`;
    aElem.click();
    URL.revokeObjectURL(url);
    addLog('Export .ENG complete.');
  };

  const handleExportCSV = () => {
    if (!results.length) {
      addLog('Error: No simulation results to export.');
      return;
    }
    addLog('Exporting CSV file...');
    let csv = "Time (s),Thrust (N),Pressure (Pa),Burn Area (m^2),Port Area (m^2)\n";
    results.forEach(r => {
      csv += `${r.Time},${r.Thrust},${r.Pc},${r.Ab},${r.PortArea}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const aElem = document.createElement('a');
    aElem.href = url;
    aElem.download = `APRO-${grainType}-Results.csv`;
    aElem.click();
    URL.revokeObjectURL(url);
    addLog('Export CSV complete.');
  };

  const handleExportSTL = () => {
    addLog('Generating 3D model (STL)...');
    setIsSimulating(true);

    setTimeout(() => {
      try {
        let stl = "solid motor_grain\n";
        const addFacet = (v1: number[], v2: number[], v3: number[]) => {
          const ux = v2[0] - v1[0], uy = v2[1] - v1[1], uz = v2[2] - v1[2];
          const vx = v3[0] - v1[0], vy = v3[1] - v1[1], vz = v3[2] - v1[2];
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (len > 1e-6) { nx /= len; ny /= len; nz /= len; }
          stl += `  facet normal ${nx.toExponential(6)} ${ny.toExponential(6)} ${nz.toExponential(6)}\n    outer loop\n`;
          stl += `      vertex ${v1[0].toExponential(6)} ${v1[1].toExponential(6)} ${v1[2].toExponential(6)}\n`;
          stl += `      vertex ${v2[0].toExponential(6)} ${v2[1].toExponential(6)} ${v2[2].toExponential(6)}\n`;
          stl += `      vertex ${v3[0].toExponential(6)} ${v3[1].toExponential(6)} ${v3[2].toExponential(6)}\n`;
          stl += `    endloop\n  endfacet\n`;
        };

        const radialSteps = 120; // 3 degree steps
        const innerProfile: number[][] = [];
        const outerProfile: number[][] = [];
        const rodProfile: number[][] | null = grainType === 'RodAndTube' ? [] : null;

        for (let i = 0; i < radialSteps; i++) {
          const a = (i * 2 * Math.PI) / radialSteps;
          let r_in = innerRadius;
          let cx = 0, cy = 0;
          if (grainType === 'Star') {
            const sector = (2 * Math.PI) / numPoints;
            let local_a = a % sector;
            if (local_a > sector / 2) {
              local_a = sector - local_a;
            }
            r_in = tipRadius + (valleyRadius - tipRadius) * (local_a / (sector / 2));
          } else if (grainType === 'Tubular' || grainType === 'BATES' || grainType === 'RodAndTube') {
            r_in = innerRadius;
          } else if (grainType === 'MoonBurner') {
            r_in = innerRadius;
            cx = offset;
          } else if (grainType === 'CustomDXF') {
            r_in = dxfData ? Math.sqrt(dxfData.areaTable[0] / Math.PI) : innerRadius;
          } else if (grainType === 'Finocyl') {
            const a_core = Math.PI * Math.pow(innerRadius, 2);
            const tip_center = finDepth - finWidth / 2.0;
            const fin_area = numPoints * (tip_center * finWidth + Math.PI * Math.pow(finWidth / 2, 2) / 2);
            r_in = Math.sqrt((a_core + fin_area) / Math.PI);
          }
          if (r_in > outerRadius) r_in = outerRadius;

          innerProfile.push([cx + Math.cos(a) * r_in, cy + Math.sin(a) * r_in]);
          outerProfile.push([Math.cos(a) * outerRadius, Math.sin(a) * outerRadius]);
          if (rodProfile) rodProfile.push([Math.cos(a) * rodRadius, Math.sin(a) * rodRadius]);
        }

        const segments = grainType === 'BATES' ? numSegments : 1;
        const gap = 2; // 2mm gap visually separating BATES grains

        for (let s = 0; s < segments; s++) {
          const z0 = s * (length + gap);
          const z1 = z0 + length;

          for (let i = 0; i < radialSteps; i++) {
            const next_i = (i + 1) % radialSteps;
            const p1_in = [...innerProfile[i], z0];
            const p2_in = [...innerProfile[next_i], z0];
            const p3_in = [...innerProfile[next_i], z1];
            const p4_in = [...innerProfile[i], z1];

            const p1_out = [...outerProfile[i], z0];
            const p2_out = [...outerProfile[next_i], z0];
            const p3_out = [...outerProfile[next_i], z1];
            const p4_out = [...outerProfile[i], z1];

            // Bottom Face (z0) -> Normal (0,0,-1)
            addFacet(p1_in, p2_in, p1_out);
            addFacet(p2_in, p2_out, p1_out);

            // Top Face (z1) -> Normal (0,0,1)
            addFacet(p4_in, p4_out, p3_in);
            addFacet(p3_in, p4_out, p3_out);

            // Inner Wall -> Normal pointing inward (towards center)
            addFacet(p1_in, p4_in, p2_in);
            addFacet(p4_in, p3_in, p2_in);

            // Outer Wall -> Normal pointing outward
            addFacet(p1_out, p2_out, p4_out);
            addFacet(p2_out, p3_out, p4_out);
            
            // Rod (if exists)
            if (rodProfile) {
              const r1 = [...rodProfile[i], z0];
              const r2 = [...rodProfile[next_i], z0];
              const r3 = [...rodProfile[next_i], z1];
              const r4 = [...rodProfile[i], z1];
              
              // Bottom
              addFacet([0,0,z0], r2, r1);
              // Top
              addFacet([0,0,z1], r4, r3);
              // Wall
              addFacet(r1, r2, r4);
              addFacet(r2, r3, r4);
            }
          }
        }

        stl += "endsolid motor_grain\n";

        const blob = new Blob([stl], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const aElem = document.createElement('a');
        aElem.href = url;
        aElem.download = `APRO-${grainType}-Grain-3D.stl`;
        aElem.click();
        URL.revokeObjectURL(url);
        addLog('3D model (STL) export complete.');
      } catch (err: any) {
        addLog(`STL Generation error: ${err.message || 'Unknown error'}`);
      } finally {
        setIsSimulating(false);
      }
    }, 50);
  };

  const getCasingProfiles = () => {
    const innerRadiusMM = outerRadius * 1000;
    // The CAD export uses the wall the user is actually analysing.
    let casingThicknessMM = caseWallThickness;
    if (casingThicknessMM < 0.1) casingThicknessMM *= 1000;
    const outerRadiusMM = innerRadiusMM + casingThicknessMM;
    const lengthMM = length * 1000;
    const throatRadiusMM = (throatDiameter * 1000) / 2;
    const expRatio = expansionRatio || 3.0;
    const exitRadiusMM = throatRadiusMM * Math.sqrt(expRatio);

    const flangeThick = Math.max(boltDiameter * 1.5, 5);
    const flangeR = outerRadiusMM + Math.max(boltDiameter * 1.5, 8);
    const nozzleThick = Math.max(casingThicknessMM * 1.5, 5.0);
    const domeSteps = 16;
    
    // 1. Main Tube
    const mainTubeProf = [
      [lengthMM, innerRadiusMM],
      [0, innerRadiusMM],
      [0, flangeR],
      [flangeThick, flangeR],
      [flangeThick, outerRadiusMM],
      [lengthMM - flangeThick, outerRadiusMM],
      [lengthMM - flangeThick, flangeR],
      [lengthMM, flangeR]
    ];

    // 2. Forward Closure
    const fwdProf = [];
    for (let i = domeSteps; i >= 0; i--) {
      const theta = (i / domeSteps) * (Math.PI / 2);
      fwdProf.push([
        lengthMM + flangeThick + outerRadiusMM * Math.sin(theta),
        Math.max(0.001, outerRadiusMM * Math.cos(theta))
      ]);
    }
    fwdProf.push([lengthMM + flangeThick, flangeR]);
    fwdProf.push([lengthMM, flangeR]);
    fwdProf.push([lengthMM, Math.max(0.001, innerRadiusMM)]);
    for (let i = 0; i <= domeSteps; i++) {
      const theta = (i / domeSteps) * (Math.PI / 2);
      fwdProf.push([
        lengthMM + innerRadiusMM * Math.sin(theta),
        Math.max(0.001, innerRadiusMM * Math.cos(theta))
      ]);
    }

    // 3. Aft Closure (Nozzle)
    const exitLength = throatRadiusMM * 6;
    const nozzleConvLen = throatRadiusMM * 3;
    const aftProf = [
      [0, Math.max(0.001, innerRadiusMM)],
      [0, flangeR],
      [-flangeThick, flangeR],
      [-flangeThick, outerRadiusMM],
      [-nozzleConvLen, throatRadiusMM + nozzleThick],
      [-nozzleConvLen - exitLength, exitRadiusMM + nozzleThick],
      [-nozzleConvLen - exitLength, Math.max(0.001, exitRadiusMM)],
      [-nozzleConvLen, Math.max(0.001, throatRadiusMM)]
    ];

    return { mainTubeProf, fwdProf, aftProf };
  };

  const handleExportCasingSTL = async () => {
    if (!metrics) {
      addLog('Error: Run simulation first to determine casing thickness.');
      alert('You must run the simulation first to calculate the required casing thickness before exporting the CAD model.');
      return;
    }
    addLog('Generating Assembly Parts (STL ZIP)...');
    setIsSimulating(true);
    
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      const generateSTL = (prof: number[][], name: string) => {
        let stl = `solid ${name}\n`;
        const radialSteps = 120;
        const addFacet = (v1: number[], v2: number[], v3: number[]) => {
          const ux = v2[0] - v1[0], uy = v2[1] - v1[1], uz = v2[2] - v1[2];
          const vx = v3[0] - v1[0], vy = v3[1] - v1[1], vz = v3[2] - v1[2];
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (len > 1e-6) { nx /= len; ny /= len; nz /= len; }
          stl += `  facet normal ${nx.toExponential(6)} ${ny.toExponential(6)} ${nz.toExponential(6)}\n    outer loop\n`;
          stl += `      vertex ${v1[0].toExponential(6)} ${v1[1].toExponential(6)} ${v1[2].toExponential(6)}\n`;
          stl += `      vertex ${v2[0].toExponential(6)} ${v2[1].toExponential(6)} ${v2[2].toExponential(6)}\n`;
          stl += `      vertex ${v3[0].toExponential(6)} ${v3[1].toExponential(6)} ${v3[2].toExponential(6)}\n`;
          stl += `    endloop\n  endfacet\n`;
        };

        for (let i = 0; i < radialSteps; i++) {
          const a1 = (i * 2 * Math.PI) / radialSteps;
          const a2 = ((i + 1) * 2 * Math.PI) / radialSteps;

          for (let p = 0; p < prof.length; p++) {
            const pNext = (p + 1) % prof.length;
            const z1 = prof[p][0], r1 = prof[p][1];
            const z2 = prof[pNext][0], r2 = prof[pNext][1];

            if (Math.abs(z1-z2) < 1e-6 && Math.abs(r1-r2) < 1e-6) continue;

            const p1_a1 = [r1 * Math.cos(a1), r1 * Math.sin(a1), z1];
            const p1_a2 = [r1 * Math.cos(a2), r1 * Math.sin(a2), z1];
            const p2_a1 = [r2 * Math.cos(a1), r2 * Math.sin(a1), z2];
            const p2_a2 = [r2 * Math.cos(a2), r2 * Math.sin(a2), z2];

            addFacet(p1_a1, p2_a1, p1_a2);
            addFacet(p1_a2, p2_a1, p2_a2);
          }
        }
        stl += `endsolid ${name}\n`;
        return stl;
      };

      const { mainTubeProf, fwdProf, aftProf } = getCasingProfiles();
      
      zip.file("MainTube.stl", generateSTL(mainTubeProf, "MainTube"));
      zip.file("ForwardClosure.stl", generateSTL(fwdProf, "ForwardClosure"));
      zip.file("AftClosure.stl", generateSTL(aftProf, "AftClosure"));

      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const aElem = document.createElement('a');
      aElem.href = url;
      aElem.download = `APRO-Casing-Assembly.zip`;
      aElem.click();
      URL.revokeObjectURL(url);
      addLog('Casing Assembly ZIP export complete.');

    } catch (err: any) {
      addLog(`Generation error: ${err.message || 'Unknown error'}`);
    } finally {
      setIsSimulating(false);
    }
  };

  const handleExportCasingSCAD = () => {
    if (!metrics) {
      addLog('Error: Run simulation first to determine casing thickness.');
      alert('You must run the simulation first to calculate the required casing thickness.');
      return;
    }
    try {
      const { mainTubeProf, fwdProf, aftProf } = getCasingProfiles();
      
      const serializeProf = (p: number[][]) => p.map(pt => `[${pt[1].toFixed(4)}, ${pt[0].toFixed(4)}]`).join(', ');

      let scad = `// APRO Assembly Components\n`;
      scad += `// This SCAD file can be opened in OpenSCAD or FreeCAD\n`;
      scad += `// and subsequently exported directly to STEP, IGES, or Parasolid.\n\n`;
      scad += `$fn = 120; // Resolution\n\n`;

      scad += `module MainTube() {\n  rotate_extrude(angle=360)\n    polygon(points=[\n      ${serializeProf(mainTubeProf)}\n    ]);\n}\n\n`;
      
      scad += `module ForwardClosure() {\n  rotate_extrude(angle=360)\n    polygon(points=[\n      ${serializeProf(fwdProf)}\n    ]);\n}\n\n`;
      
      scad += `module AftClosure() {\n  rotate_extrude(angle=360)\n    polygon(points=[\n      ${serializeProf(aftProf)}\n    ]);\n}\n\n`;

      scad += `// Display Full Assembly\n`;
      scad += `MainTube();\n`;
      scad += `ForwardClosure();\n`;
      scad += `AftClosure();\n`;

      const blob = new Blob([scad], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const aElem = document.createElement('a');
      aElem.href = url;
      aElem.download = `APRO-Assembly-CAD.scad`;
      aElem.click();
      URL.revokeObjectURL(url);
      addLog('Full Assembly OpenSCAD script exported. Use FreeCAD to convert to STEP.');
    } catch(err: any) {
      addLog(`SCAD Generation error: ${err.message || 'Unknown error'}`);
    }
  };

  const runMonteCarlo = async () => {
    // Always 0-D, whatever the toggle says. A quasi-1-D run costs roughly
    // `stationCount` times more per step, so a 50-run sweep would take minutes
    // instead of seconds -- and a dispersion study wants many samples of the
    // same model far more than it wants axial detail in each one.
    addLog(
      `Starting Monte Carlo analysis (${mcRuns} runs, ${mcVariance}% variance, 0-D solver for speed)...`
    );
    setIsSimulating(true);
    setMcResults([]);

    const runs: any[] = [];

    // Each run is awaited in turn. The solve happens in the worker, so the main
    // thread is free between runs and the UI keeps painting -- the old
    // setTimeout(0) trampoline existed only to break up in-thread solving.
    for (let currentRun = 0; currentRun < mcRuns; currentRun++) {
      setStatusMsg(`Performing Monte Carlo run ${currentRun + 1} of ${mcRuns}...`);

      try {
        const varFactor = () => 1 + (Math.random() * 2 - 1) * (mcVariance / 100);
        const { results: res } = await runMotor(
          buildBurnConfig({
            a: a * varFactor(),
            density: density * varFactor(),
            throatDiameter: throatDiameter * varFactor(),
            igniterMass: igniterMass * varFactor(),
            model: '0D',
          })
        );

        if (res.length > 0) {
          const maxPc = Math.max(...res.map(r => r.Pc)) / 1e6;
          const maxThrust = Math.max(...res.map(r => r.Thrust)) / 1000;
          runs.push({ run: currentRun + 1, maxPc, maxThrust });
        }
      } catch (e) {
        console.warn(`Monte Carlo Run ${currentRun} failed:`, e);
      }
    }

    setMcResults(runs);
    setIsSimulating(false);
    addLog('Monte Carlo analysis complete.');
    setStatusMsg('System Ready');
  };

  /**
   * Case structural analysis at the run's peak pressure. Recomputes whenever a
   * material, wall or bolt input changes -- it is closed-form and cheap, so
   * there is no reason to make the user re-run the motor to see the effect.
   */
  const structural = useMemo(() => {
    if (!metrics || !structuralLoaded) return undefined;
    try {
      return analyzeStructure({
        max_pressure: metrics.maxPc,
        inner_radius: outerRadius,
        wall_thickness: caseWallThickness,
        yield_stress: casingYieldStress * 1e6,
        youngs_modulus: casingYoungsModulus * 1e9,
        poissons_ratio: casingMaterial === 'Steel 4130' ? 0.29 : 0.33,
        material: casingMaterial,
        case_length: length,
        bolts: {
          count: numBolts,
          diameter: boltDiameter,
          yield_stress: boltYieldStress * 1e6,
          edge_distance: caseBoltEdgeDistance,
        },
      });
    } catch (err) {
      console.warn('Structural analysis failed', err);
      return undefined;
    }
  }, [
    metrics, structuralLoaded, outerRadius, caseWallThickness, casingYieldStress,
    casingYoungsModulus, casingMaterial, length, numBolts, boltDiameter,
    boltYieldStress, caseBoltEdgeDistance,
  ]);

  /** Lame through-wall profile, reshaped for charting. */
  const lameChart = useMemo(() => {
    if (!structural) return [];
    const p = structural.lame.profile;
    return Array.from({ length: p.position.length }, (_, i) => ({
      r_mm: p.position[i] * 1000,
      hoop: p.hoop[i] / 1e6,
      radial: p.radial[i] / 1e6,
      axial: p.axial[i] / 1e6,
      vonMises: p.vonMises[i] / 1e6,
    }));
  }, [structural]);

  /** Edge-bending profile along the case, reshaped for charting. */
  const edgeChart = useMemo(() => {
    if (!structural) return [];
    const p = structural.edge.profile;
    return Array.from({ length: p.position.length }, (_, i) => ({
      x_mm: p.position[i] * 1000,
      hoop: p.hoop[i] / 1e6,
      axial: p.axial[i] / 1e6,
      vonMises: p.vonMises[i] / 1e6,
    }));
  }, [structural]);

  /**
   * The current design in the surrogate's own parameter set. Memoised so the
   * panel's prediction effect only re-fires when a value the model actually
   * consumes changes, not on every unrelated render.
   */
  const surrogateDesign = useMemo(
    () => ({
      length,
      outer_radius: outerRadius,
      inner_radius: innerRadius,
      throat_diameter: throatDiameter,
      expansion_ratio: expansionRatio,
      a,
      n,
      density,
    }),
    [length, outerRadius, innerRadius, throatDiameter, expansionRatio, a, n, density]
  );

  /** Push a design found by inverse search back into the main inputs. */
  const applySurrogateDesign = useCallback((d: typeof surrogateDesign) => {
    pushHistory();
    setLength(d.length);
    setOuterRadius(d.outer_radius);
    setInnerRadius(d.inner_radius);
    setThroatDiameter(d.throat_diameter);
    setExpansionRatio(d.expansion_ratio);
  }, []);

  /** Station profiles reshaped for the axial chart. Empty after a 0-D run. */
  const axialData = useMemo(() => {
    if (!stations) return [];
    return Array.from({ length: stations.count }, (_, i) => ({
      x: stations.x[i],
      Pc_MPa: stations.pressure[i] / 1e6,
      G: stations.massFlux[i],
      rb_mm_s: stations.burnRate[i] * 1000,
      erosive_mm_s: stations.erosiveRate[i] * 1000,
      web_mm: stations.peakWeb[i] * 1000,
    }));
  }, [stations]);

  // Downsample results for charting to improve performance
  const chartData = useMemo(() => {
    if (results.length === 0) return [];
    const step = Math.max(1, Math.floor(results.length / 200));
    const maxMass = results[results.length - 1].PropellantMassGen;
    const initialAt = Math.PI * Math.pow(throatDiameter / 2, 2);
    const gamma = 1.2; // approx, could use propellant.gamma if exposed
    
    // We also need propVol for volume loading, assuming same calculation:
    let totalPropVol = 0;
    const totalMotorVolume = Math.PI * Math.pow(outerRadius, 2) * length * (grainType === 'BATES' ? numSegments : 1);
    let maxWeb = outerRadius - innerRadius;

    if (grainType === 'Star') {
      totalPropVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(valleyRadius, 2)) * length;
      maxWeb = outerRadius - valleyRadius;
    } else if (grainType === 'RodAndTube') {
      totalPropVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(innerRadius, 2)) * length + Math.PI * Math.pow(rodRadius, 2) * length;
      maxWeb = innerRadius - rodRadius; // very rough heuristic for charts
    } else if (grainType === 'MoonBurner') {
      totalPropVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(innerRadius, 2)) * length;
      maxWeb = outerRadius - innerRadius; 
    } else if (grainType === 'Finocyl') {
      const a_core = Math.PI * Math.pow(innerRadius, 2);
      const tip_center = finDepth - finWidth / 2.0;
      const fin_area = numPoints * (tip_center * finWidth + Math.PI * Math.pow(finWidth / 2, 2) / 2);
      totalPropVol = (Math.PI * Math.pow(outerRadius, 2) - (a_core + fin_area)) * length;
      maxWeb = outerRadius - finDepth;
    } else if (grainType === 'CustomDXF' && dxfData) {
      totalPropVol = (Math.PI * Math.pow(outerRadius, 2) - dxfData.areaTable[0]) * length;
      maxWeb = outerRadius; // Simplification
    } else {
      totalPropVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(innerRadius, 2)) * length * (grainType === 'BATES' ? numSegments : 1);
    }
    const maxVolLoad = (totalPropVol / totalMotorVolume) * 100;
    
    return results.filter((_, i) => i % step === 0).map(r => {
      const propVolBurned = r.PropellantMassGen / density;
      const currentPropVol = totalPropVol - propVolBurned;
      const volLoadPct = (currentPropVol / totalMotorVolume) * 100;

      // Mach number approximation based on Area ratio A/A*
      // M < 1 in port.
      const areaRatio = r.PortArea / r.ThroatArea;
      // Very rough approximation for subsonic Mach from Area ratio
      const CoreMachNumber = areaRatio > 1 ? 1 / areaRatio : 1; 
      
      const currentAt = r.ThroatArea;
      const currentDf = Math.sqrt(4 * currentAt / Math.PI);
      const initialDf = Math.sqrt(4 * initialAt / Math.PI);
      
      return {
        ...r,
        Pc_MPa: r.Pc / 1e6,
        Thrust_kN: r.Thrust / 1000, 
        Thrust_N: r.Thrust,
        Kn: r.Ab / r.ThroatArea,
        PortMassFlux_kg_sm2: r.PortMassFlux,
        Regression_mm: r.y * 1000,
        Web_mm: Math.max(0, (maxWeb - r.y) * 1000),
        ThroatDiameter_mm: currentDf * 1000,
        ChangeInThroatDiameter_mm: (currentDf - initialDf) * 1000,
        PropellantMass_kg: Math.max(0, maxMass - r.PropellantMassGen),
        MassFlow_kg_s: r.MassFlow,
        VolumeLoading_pct: Math.max(0, volLoadPct),
        NozzleExitPressure_MPa: (r.Pc * (1 / expansionRatio)) / 1e6, 
        CoreMachNumber: CoreMachNumber
      };
    });
  }, [results, throatDiameter, outerRadius, innerRadius, valleyRadius, length, numSegments, grainType, density, expansionRatio, rodRadius, offset]);

  const burnRateData = useMemo(() => {
    const data = [];
    for (let p = 1; p <= 20; p += 0.5) {
      const rb_m_s = a * Math.pow(p * 1e6, n);
      data.push({ pressure: p, burnRate: rb_m_s * 1000 });
    }
    return data;
  }, [a, n]);

  const currentY = results.length > 0 && visualizerIndex < results.length 
    ? results[visualizerIndex].y 
    : 0;

  const handleSaveMaterial = (type: string) => {
    let payload = {};
    if (type === 'propellant') {
      payload = { type: 'propellant', density, a, n, flameTemp, gamma, molWeight, kErosive, gThreshold };
    } else if (type === 'casing') {
      payload = { type: 'casing', casingMaterial, casingYieldStress, casingYoungsModulus };
    } else if (type === 'nozzle') {
      payload = { type: 'nozzle', nozzleMaterial, nozzleDensity, nozzleHeatOfAblation, nozzleOxidationTemp, nozzleThermalShock, nozzleThermalConductivity, nozzleSpecificHeat, nozzleKTempCoeff, nozzleCpTempCoeff };
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const aLink = document.createElement('a');
    aLink.href = url;
    aLink.download = `${type}_material.json`;
    document.body.appendChild(aLink);
    aLink.click();
    document.body.removeChild(aLink);
  };

  const handleLoadMaterialClick = (type: 'propellant' | 'casing' | 'nozzle') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e: any) => {
      const file = e.target.files[0];
      if (file) {
        setIsSimulating(true);
        setTimeout(() => {
          const reader = new FileReader();
          reader.onload = (re) => {
            try {
              const data = JSON.parse(re.target?.result as string);
              if (data.type === 'propellant' && type === 'propellant') {
                if (data.density) setDensity(data.density);
                if (data.a) setA(data.a);
                if (data.n) setN(data.n);
                if (data.flameTemp) setFlameTemp(data.flameTemp);
                if (data.gamma) setGamma(data.gamma);
                if (data.molWeight) setMolWeight(data.molWeight);
                if (data.kErosive) setKErosive(data.kErosive);
                if (data.gThreshold) setGThreshold(data.gThreshold);
                addLog('Propellant material loaded successfully.');
              } else if (data.type === 'casing' && type === 'casing') {
                if (data.casingMaterial) setCasingMaterial(data.casingMaterial);
                if (data.casingYieldStress) setCasingYieldStress(data.casingYieldStress);
                if (data.casingYoungsModulus) setCasingYoungsModulus(data.casingYoungsModulus);
                addLog('Casing material loaded successfully.');
              } else if (data.type === 'nozzle' && type === 'nozzle') {
                if (data.nozzleMaterial) setNozzleMaterial(data.nozzleMaterial);
                if (data.nozzleDensity) setNozzleDensity(data.nozzleDensity);
                if (data.nozzleHeatOfAblation) setNozzleHeatOfAblation(data.nozzleHeatOfAblation);
                if (data.nozzleOxidationTemp) setNozzleOxidationTemp(data.nozzleOxidationTemp);
                if (data.nozzleThermalShock) setNozzleThermalShock(data.nozzleThermalShock);
                if (data.nozzleThermalConductivity) setNozzleThermalConductivity(data.nozzleThermalConductivity);
                if (data.nozzleSpecificHeat) setNozzleSpecificHeat(data.nozzleSpecificHeat);
                if (data.nozzleKTempCoeff !== undefined) setNozzleKTempCoeff(data.nozzleKTempCoeff);
                if (data.nozzleCpTempCoeff !== undefined) setNozzleCpTempCoeff(data.nozzleCpTempCoeff);
                addLog('Nozzle material loaded successfully.');
              } else {
                addLog(`Error: Type mismatch. Expected ${type} material.`);
              }
            } catch (err) {
              addLog('Error parsing material file.');
            } finally {
              setIsSimulating(false);
            }
          };
          reader.readAsText(file);
        }, 50);
      }
    };
    input.click();
  };

  const [showOptimizer, setShowOptimizer] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const burnsimFileInputRef = useRef<HTMLInputElement>(null);

  const captureDesignState = useCallback(() => ({
      density, a, n, molWeight, kErosive, gThreshold, T_ref, sigma_p, T_init,
      grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius, numPoints, numSegments, offset, rodRadius, finDepth, finWidth,
      throatDiameter, expansionRatio, gamma, flameTemp, nozzleMaterial,
      igniterMass, igniterSurfaceArea, igniterDensity, igniterA, igniterN,
      casingMaterial, casingYieldStress, casingYoungsModulus
  }), [
      density, a, n, molWeight, kErosive, gThreshold,
      grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius, numPoints, numSegments, offset, rodRadius, finDepth, finWidth,
      throatDiameter, expansionRatio, gamma, flameTemp, nozzleMaterial,
      igniterMass, igniterSurfaceArea, igniterDensity, igniterA, igniterN,
      casingMaterial, casingYieldStress, casingYoungsModulus
  ]);

  const applyDesignState = (config: any) => {
      if (config.density !== undefined) setDensity(config.density);
      if (config.a !== undefined) setA(config.a);
      if (config.n !== undefined) setN(config.n);
      if (config.molWeight !== undefined) setMolWeight(config.molWeight);
      if (config.kErosive !== undefined) setKErosive(config.kErosive);
      if (config.gThreshold !== undefined) setGThreshold(config.gThreshold);
      if (config.T_ref !== undefined) setTRef(config.T_ref);
      if (config.sigma_p !== undefined) setSigmaP(config.sigma_p);
      if (config.T_init !== undefined) setTInit(config.T_init);
      if (config.grainType !== undefined) setGrainType(config.grainType);
      if (config.length !== undefined) setLength(config.length);
      if (config.outerRadius !== undefined) setOuterRadius(config.outerRadius);
      if (config.innerRadius !== undefined) setInnerRadius(config.innerRadius);
      if (config.valleyRadius !== undefined) setValleyRadius(config.valleyRadius);
      if (config.tipRadius !== undefined) setTipRadius(config.tipRadius);
      if (config.numPoints !== undefined) setNumPoints(config.numPoints);
      if (config.numSegments !== undefined) setNumSegments(config.numSegments);
      if (config.offset !== undefined) setOffset(config.offset);
      if (config.rodRadius !== undefined) setRodRadius(config.rodRadius);
      if (config.finDepth !== undefined) setFinDepth(config.finDepth);
      if (config.finWidth !== undefined) setFinWidth(config.finWidth);
      if (config.throatDiameter !== undefined) setThroatDiameter(config.throatDiameter);
      if (config.expansionRatio !== undefined) setExpansionRatio(config.expansionRatio);
      if (config.gamma !== undefined) setGamma(config.gamma);
      if (config.flameTemp !== undefined) setFlameTemp(config.flameTemp);
      if (config.nozzleMaterial !== undefined) setNozzleMaterial(config.nozzleMaterial);
      if (config.igniterMass !== undefined) setIgniterMass(config.igniterMass);
      if (config.igniterSurfaceArea !== undefined) setIgniterSurfaceArea(config.igniterSurfaceArea);
      if (config.igniterDensity !== undefined) setIgniterDensity(config.igniterDensity);
      if (config.igniterA !== undefined) setIgniterA(config.igniterA);
      if (config.igniterN !== undefined) setIgniterN(config.igniterN);
      if (config.casingMaterial !== undefined) setCasingMaterial(config.casingMaterial);
      if (config.casingYieldStress !== undefined) setCasingYieldStress(config.casingYieldStress);
      if (config.casingYoungsModulus !== undefined) setCasingYoungsModulus(config.casingYoungsModulus);
  };

  useEffect(() => {
     if (history.length === 0) {
        setHistory([captureDesignState()]);
        setHistoryIndex(0);
     }
  }, [history.length, captureDesignState]);

  const pushHistory = useCallback(() => {
    setHistory(prev => {
        const snap = captureDesignState();
        const nextHist = prev.slice(0, historyIndex + 1);
        nextHist.push(snap);
        return nextHist;
    });
    setHistoryIndex(i => i + 1);
  }, [captureDesignState, historyIndex]);

  const handleUndo = () => {
    if (historyIndex > 0) {
      const idx = historyIndex - 1;
      setHistoryIndex(idx);
      applyDesignState(history[idx]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const idx = historyIndex + 1;
      setHistoryIndex(idx);
      applyDesignState(history[idx]);
    }
  };

  const handleSaveBurnsim = () => {
    const xml = exportBurnsimXML(captureDesignState());
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const aElem = document.createElement('a');
    aElem.href = url;
    aElem.download = `APRO-Export-${new Date().getTime()}.bsd`;
    document.body.appendChild(aElem);
    aElem.click();
    document.body.removeChild(aElem);
    URL.revokeObjectURL(url);
    addLog('Exported to BurnSim (.bsd) format.');
  };

  const handleLoadBurnsim = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsSimulating(true);
    setTimeout(() => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const content = event.target?.result as string;
          const parsed = parseBurnsimXML(content);
          applyDesignState(parsed);
          pushHistory();
          addLog('Loaded configuration from Burnsim file.');
        } catch (err) {
          addLog('Failed to import Burnsim file.');
        }
        setIsSimulating(false);
      };
      reader.readAsText(file);
    }, 50);
  };

  const handleSaveConfig = () => {
    const config = {
      density, a, n, molWeight, kErosive, gThreshold, T_ref, sigma_p, T_init,
      grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius, numPoints, numSegments, offset, rodRadius, finDepth, finWidth,
      throatDiameter, expansionRatio, gamma, flameTemp, nozzleMaterial,
      igniterMass, igniterSurfaceArea, igniterDensity, igniterA, igniterN,
      casingMaterial, casingYieldStress, casingYoungsModulus,
      mcRuns, mcVariance,
      erosiveModel, solverModel, stationCount,
      caseWallThickness, caseBoltEdgeDistance, numBolts, boltDiameter, boltYieldStress
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const aElem = document.createElement('a');
    aElem.href = url;
    aElem.download = `APRO-Config-${new Date().getTime()}.json`;
    document.body.appendChild(aElem);
    aElem.click();
    document.body.removeChild(aElem);
    URL.revokeObjectURL(url);
    addLog('Configuration saved to file.');
  };

  const handleDXFUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDxfFilename(file.name);
    
    // We should show a small loading state because Clipper operations might block UI slightly
    addLog(`Loading DXF geometry from ${file.name}...`);
    setIsSimulating(true);
    
    setTimeout(() => {
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const content = event.target?.result as string;
                // Precompile regression data (.001 step size approx, or we can use 1mm or 0.1mm)
                // Let's use 0.001 m (1mm) table spacing for fast performance, since interpolating is fast
                const dx = 0.001; 
                const results = processDXF(content, outerRadius, dx);
                setDxfData(results);
                addLog(`Successfully processed DXF geometry (Max port area: ${(results.areaTable[0] * 10000).toFixed(2)} cm²).`);
            } catch (err: any) {
                addLog(`Failed to load DXF: ${err.message}`);
                alert(`Error reading DXF: ${err.message}`);
                setDxfFilename('');
                setDxfData(null);
            }
            setIsSimulating(false);
        };
        reader.readAsText(file);
    }, 50);
  };

  const handleLoadConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsSimulating(true);
    setTimeout(() => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const config = JSON.parse(event.target?.result as string);
          if (config.density) setDensity(config.density);
          if (config.a) setA(config.a);
          if (config.n) setN(config.n);
          if (config.molWeight) setMolWeight(config.molWeight);
          if (config.kErosive) setKErosive(config.kErosive);
          if (config.gThreshold) setGThreshold(config.gThreshold);
          if (config.grainType) setGrainType(config.grainType);
          if (config.length) setLength(config.length);
          if (config.outerRadius) setOuterRadius(config.outerRadius);
          if (config.innerRadius) setInnerRadius(config.innerRadius);
          if (config.valleyRadius) setValleyRadius(config.valleyRadius);
          if (config.tipRadius) setTipRadius(config.tipRadius);
          if (config.numPoints) setNumPoints(config.numPoints);
          if (config.numSegments) setNumSegments(config.numSegments);
          if (config.offset) setOffset(config.offset);
          if (config.rodRadius) setRodRadius(config.rodRadius);
          if (config.finDepth) setFinDepth(config.finDepth);
          if (config.finWidth) setFinWidth(config.finWidth);
          if (config.throatDiameter) setThroatDiameter(config.throatDiameter);
          if (config.expansionRatio) setExpansionRatio(config.expansionRatio);
          if (config.gamma) setGamma(config.gamma);
          if (config.flameTemp) setFlameTemp(config.flameTemp);
          if (config.nozzleMaterial) setNozzleMaterial(config.nozzleMaterial);
          if (config.igniterMass) setIgniterMass(config.igniterMass);
          if (config.igniterSurfaceArea) setIgniterSurfaceArea(config.igniterSurfaceArea);
          if (config.igniterDensity) setIgniterDensity(config.igniterDensity);
          if (config.igniterA) setIgniterA(config.igniterA);
          if (config.igniterN) setIgniterN(config.igniterN);
          if (config.casingMaterial) setCasingMaterial(config.casingMaterial);
          if (config.casingYieldStress) setCasingYieldStress(config.casingYieldStress);
          if (config.casingYoungsModulus) setCasingYoungsModulus(config.casingYoungsModulus);
          if (config.mcRuns) setMcRuns(config.mcRuns);
          if (config.mcVariance) setMcVariance(config.mcVariance);
          if (config.erosiveModel) setErosiveModel(config.erosiveModel);
          if (config.solverModel) setSolverModel(config.solverModel);
          if (config.stationCount) setStationCount(config.stationCount);
          if (config.caseWallThickness) setCaseWallThickness(config.caseWallThickness);
          if (config.caseBoltEdgeDistance) setCaseBoltEdgeDistance(config.caseBoltEdgeDistance);
          if (config.numBolts) setNumBolts(config.numBolts);
          if (config.boltDiameter) setBoltDiameter(config.boltDiameter);
          if (config.boltYieldStress) setBoltYieldStress(config.boltYieldStress);
          addLog('Configuration loaded successfully.');
        } catch (err) {
          addLog('Error parsing config file.');
        } finally {
          setIsSimulating(false);
          // clear the file input target
          if (configFileInputRef.current) configFileInputRef.current.value = '';
        }
      };
      reader.readAsText(file);
    }, 50);
  };

  // Unit Converter Logic
  const [ucMode, setUcMode] = useState<'Length' | 'Pressure' | 'Mass' | 'Temp'>('Length');
  const [ucVal1, setUcVal1] = useState<string>('1');
  const [ucUnit1, setUcUnit1] = useState<string>('in');
  const [ucUnit2, setUcUnit2] = useState<string>('mm');

  const unitRates: any = {
    Length: { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 },
    Pressure: { Pa: 1, kPa: 1000, MPa: 1e6, psi: 6894.76, bar: 1e5, atm: 101325 },
    Mass: { kg: 1, g: 0.001, lbm: 0.453592 }
  };

  const getUcConvertedMode = () => {
    const v = parseFloat(ucVal1) || 0;
    if (ucMode === 'Temp') {
      let tK = 0;
      if (ucUnit1 === 'K') tK = v;
      if (ucUnit1 === 'C') tK = v + 273.15;
      if (ucUnit1 === 'F') tK = (v - 32) * 5/9 + 273.15;
      if (ucUnit1 === 'R') tK = v * 5/9;
      
      if (ucUnit2 === 'K') return tK.toFixed(4);
      if (ucUnit2 === 'C') return (tK - 273.15).toFixed(4);
      if (ucUnit2 === 'F') return ((tK - 273.15) * 9/5 + 32).toFixed(4);
      if (ucUnit2 === 'R') return (tK * 9/5).toFixed(4);
    } else {
      const rate1 = unitRates[ucMode]?.[ucUnit1] || 1;
      const rate2 = unitRates[ucMode]?.[ucUnit2] || 1;
      return ((v * rate1) / rate2).toPrecision(6);
    }
    return '';
  };

  return (
    <SettingsContext.Provider value={settingsContextValue}>
      <div className="h-screen w-screen flex flex-col bg-[#ececec] text-[#333] font-sans text-sm overflow-hidden select-none relative">
      <input type="file" accept=".json" className="hidden" ref={configFileInputRef} onChange={handleLoadConfig} />
      
      {showGrainEditor && (
        <GrainEditor 
          initialParams={{
            grainType,
            length,
            outerRadius,
            innerRadius,
            valleyRadius,
            tipRadius,
            numPoints,
            numSegments,
            offset,
            rodRadius,
            finDepth,
            finWidth
          }}
          dxfData={dxfData}
          onApply={(params) => {
            setGrainType(params.grainType);
            setLength(params.length);
            setOuterRadius(params.outerRadius);
            setInnerRadius(params.innerRadius);
            setValleyRadius(params.valleyRadius);
            setTipRadius(params.tipRadius);
            setNumPoints(params.numPoints);
            setNumSegments(params.numSegments);
            setOffset(params.offset);
            setRodRadius(params.rodRadius);
            setFinDepth(params.finDepth);
            setFinWidth(params.finWidth);
            setShowGrainEditor(false);
          }}
          onClose={() => setShowGrainEditor(false)}
        />
      )}

      {showPropellantEditor && (
        <PropellantEditor 
          propellants={propellants} 
          onChange={setPropellants} 
          onApply={(p) => {
            setDensity(p.density);
            setA(p.a);
            setN(p.n);
            setMolWeight(p.molWeight);
            setKErosive(p.kErosive);
            setGThreshold(p.gThreshold);
            setTRef(p.T_ref || 294.0);
            setSigmaP(p.sigma_p || 0.001);
            setFlameTemp(p.flameTemp);
            setGamma(p.gamma);
            setShowPropellantEditor(false);
            addLog(`Applied propellant: ${p.name}`);
          }} 
          onClose={() => setShowPropellantEditor(false)} 
        />
      )}

      {showPreferences && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
          <div className="bg-[#111] border border-[#444] shadow-2xl rounded w-96 flex flex-col font-mono text-[#eee]">
            <div className="bg-[#222] px-3 py-1.5 border-b border-[#444] flex justify-between items-center font-bold text-xs text-[#ffaa00]">
              <div className="flex items-center"><Settings size={14} className="mr-1" /> Preferences</div>
              <button onClick={() => setShowPreferences(false)} className="hover:text-red-500">✕</button>
            </div>
            <div className="p-4 space-y-4 text-xs">
              <div className="border border-[#444] rounded p-3">
                <label className="block mb-2 font-bold text-[#aaa] uppercase border-b border-[#444] pb-1">Unit System</label>
                <div className="flex space-x-4 mb-3">
                  <label className="flex items-center space-x-1 cursor-pointer">
                    <input type="radio" checked={unitSystem === 'Metric'} onChange={() => setUnitSystem('Metric')} className="accent-blue-500" />
                    <span>Metric</span>
                  </label>
                  <label className="flex items-center space-x-1 cursor-pointer">
                    <input type="radio" checked={unitSystem === 'Imperial'} onChange={() => setUnitSystem('Imperial')} className="accent-blue-500" />
                    <span>Imperial</span>
                  </label>
                </div>
                
                {unitSystem === 'Imperial' && (
                  <div className="space-y-2 mt-4 text-[#ddd]">
                    <div className="text-[10px] text-[#888] mb-1">Preferred Imperial Units</div>
                    {Object.keys(IMPERIAL_OPTIONS).map(cat => (
                      <div key={cat} className="flex justify-between items-center">
                        <span>{cat}</span>
                        <select 
                          value={imperialPrefs[cat]} 
                          onChange={e => setImperialPrefs({...imperialPrefs, [cat]: e.target.value})}
                          className="bg-[#222] border border-[#444] rounded px-2 py-0.5 outline-none focus:border-blue-500"
                        >
                          {IMPERIAL_OPTIONS[cat].map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showUnitConverter && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
          <div className="bg-[#111] border border-[#444] shadow-2xl rounded w-80 flex flex-col font-mono text-[#eee]">
            <div className="bg-[#222] px-3 py-1.5 border-b border-[#444] flex justify-between items-center font-bold text-xs text-[#00aaff]">
              <div className="flex items-center"><Calculator size={14} className="mr-1" /> Unit Converter</div>
              <button onClick={() => setShowUnitConverter(false)} className="hover:text-red-500">✕</button>
            </div>
            <div className="p-4 space-y-4 text-xs">
              <div>
                <label className="block mb-1 font-bold text-[#888]">Measurement Type</label>
                <select value={ucMode} onChange={e => {
                  const m = e.target.value as any;
                  setUcMode(m);
                  if(m === 'Length') { setUcUnit1('in'); setUcUnit2('mm'); }
                  if(m === 'Pressure') { setUcUnit1('psi'); setUcUnit2('MPa'); }
                  if(m === 'Mass') { setUcUnit1('lbm'); setUcUnit2('kg'); }
                  if(m === 'Temp') { setUcUnit1('F'); setUcUnit2('C'); }
                }} className="w-full bg-[#222] border border-[#444] text-[#eee] rounded px-2 py-1 outline-none focus:border-[#00aaff]">
                  <option value="Length">Length</option>
                  <option value="Pressure">Pressure</option>
                  <option value="Mass">Mass</option>
                  <option value="Temp">Temperature</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <input type="number" step="any" value={ucVal1} onChange={e => setUcVal1(e.target.value)} className="w-full bg-[#000] border border-[#444] text-[#00ff00] rounded px-2 py-1 mb-1 font-mono text-right outline-none focus:border-[#00aaff]" />
                  <select value={ucUnit1} onChange={e => setUcUnit1(e.target.value)} className="w-full bg-[#222] border border-[#444] text-[#eee] rounded px-2 py-1 outline-none focus:border-[#00aaff]">
                    {ucMode === 'Length' && ['m','cm','mm','in','ft'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Pressure' && ['Pa','kPa','MPa','psi','bar','atm'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Mass' && ['kg','g','lbm'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Temp' && ['K','C','F','R'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <input type="text" readOnly value={getUcConvertedMode()} className="w-full bg-[#000] border border-[#444] text-[#00aaff] rounded px-2 py-1 mb-1 font-mono text-right font-bold outline-none" />
                  <select value={ucUnit2} onChange={e => setUcUnit2(e.target.value)} className="w-full bg-[#222] border border-[#444] text-[#eee] rounded px-2 py-1 outline-none focus:border-[#00aaff]">
                    {ucMode === 'Length' && ['m','cm','mm','in','ft'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Pressure' && ['Pa','kPa','MPa','psi','bar','atm'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Mass' && ['kg','g','lbm'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Temp' && ['K','C','F','R'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showOptimizer && (
        <OptimizerDialog 
          currentConfig={captureDesignState()}
          dxfData={dxfData}
          onApply={(config) => { applyDesignState(config); pushHistory(); }}
          onClose={() => setShowOptimizer(false)}
        />
      )}

      {/* QToolBar */}
      <div className="flex-none h-10 bg-[#f0f0f0] border-b border-[#ccc] flex items-center px-2 space-x-1 shadow-sm z-10 w-full overflow-x-auto">
        <input type="file" accept=".bsd,.bsx,.xml" className="hidden" ref={burnsimFileInputRef} onChange={handleLoadBurnsim} />
        
        <button onClick={handleSaveConfig} className="p-1.5 hover:bg-[#e0e0e0] border border-transparent hover:border-[#ccc] rounded flex items-center text-xs">
          <FolderDown size={14} className="mr-1 text-[#555]" /> Save Config
        </button>
        <button onClick={() => configFileInputRef.current?.click()} className="p-1.5 hover:bg-[#e0e0e0] border border-transparent hover:border-[#ccc] rounded flex items-center text-xs">
          <FolderUp size={14} className="mr-1 text-[#555]" /> Load Config
        </button>
        <div className="w-px h-5 bg-[#ccc] mx-1"></div>
        <button onClick={handleSaveBurnsim} className="p-1.5 hover:bg-[#e0e0e0] border border-transparent hover:border-[#ccc] rounded flex items-center text-xs text-blue-800">
          <FolderDown size={14} className="mr-1" /> Save .BSD
        </button>
        <button onClick={() => burnsimFileInputRef.current?.click()} className="p-1.5 hover:bg-[#e0e0e0] border border-transparent hover:border-[#ccc] rounded flex items-center text-xs text-blue-800">
          <FolderUp size={14} className="mr-1" /> Load .BSD
        </button>
        <div className="w-px h-5 bg-[#ccc] mx-1"></div>
        <button onClick={handleExportENG} className="p-1.5 hover:bg-[#e0e0e0] border border-transparent hover:border-[#ccc] rounded flex items-center text-xs">
          <Save size={14} className="mr-1 text-blue-600" /> Export .ENG
        </button>
        <button onClick={handleExportCSV} className="p-1.5 hover:bg-[#e0e0e0] border border-transparent hover:border-[#ccc] rounded flex items-center text-xs">
          <Download size={14} className="mr-1 text-blue-600" /> Export CSV
        </button>
        <div className="w-px h-5 bg-[#ccc] mx-1"></div>
        
        <button onClick={handleUndo} disabled={historyIndex <= 0} className={`p-1.5 border hover:bg-[#e0e0e0] rounded flex items-center text-xs ${historyIndex <= 0 ? 'opacity-50 cursor-not-allowed border-transparent' : 'border-transparent hover:border-[#ccc]'}`}>
          <Undo size={14} className="mr-1 text-[#555]" /> Undo
        </button>
        <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className={`p-1.5 border hover:bg-[#e0e0e0] rounded flex items-center text-xs ${historyIndex >= history.length - 1 ? 'opacity-50 cursor-not-allowed border-transparent' : 'border-transparent hover:border-[#ccc]'}`}>
          <Redo size={14} className="mr-1 text-[#555]" /> Redo
        </button>
        <div className="w-px h-5 bg-[#ccc] mx-1"></div>

        <button onClick={() => setShowUnitConverter(true)} className="p-1.5 hover:bg-[#e0e0e0] border border-transparent hover:border-[#ccc] rounded flex items-center text-xs">
          <Calculator size={14} className="mr-1 text-[#555]" /> Unit Converter
        </button>
        <button onClick={() => setShowPreferences(true)} className="p-1.5 hover:bg-[#e0e0e0] border border-transparent hover:border-[#ccc] rounded flex items-center text-xs">
          <Settings size={14} className="mr-1 text-[#555]" /> Preferences
        </button>
        <div className="w-px h-5 bg-[#ccc] mx-1"></div>
        <button onClick={() => setShowOptimizer(true)} className="p-1.5 hover:bg-[#ffefd5] border border-transparent hover:border-[#ffcc00] rounded flex items-center text-xs text-[#d37000] font-bold">
          <Zap size={14} className="mr-1" /> Optimize
        </button>
        <button disabled={isSimulating} onClick={runSimulation} className={`p-1.5 border rounded flex items-center text-xs font-semibold ${isSimulating ? 'bg-[#e0e0e0] text-[#888] cursor-not-allowed border-[#ccc]' : 'hover:bg-[#d4edda] border-transparent hover:border-[#c3e6cb] text-green-800'}`}>
          <Play size={14} className={`mr-1 ${isSimulating ? 'text-[#888]' : 'text-green-600'}`} /> {isSimulating ? 'Running...' : 'Run Simulation'}
        </button>
      </div>

      {/* Main Window Area */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left QDockWidget: Motor Parameters */}
        <div className="w-80 flex-none bg-[#f0f0f0] border-r border-[#ccc] flex flex-col z-0">
          <div className="bg-[#e4e4e4] px-2 py-1 border-b border-[#ccc] font-bold text-xs text-[#555] shadow-sm">
            Motor Parameters
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-3 custom-scrollbar">
            
            {/* QGroupBox: Propellant Data */}
            <div className="border border-[#ccc] rounded pt-3 pb-2 px-2 relative mt-2 bg-[#fafafa]">
              <div className="absolute -top-2.5 left-2 bg-[#fafafa] px-1 text-[10px] font-bold text-[#666] uppercase flex items-center space-x-2">
                <span>Propellant Data</span>
                <button onClick={() => setShowPropellantEditor(true)} className="text-[#0056b3] hover:underline decoration-[#0056b3] lowercase font-normal">(library)</button>
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5 text-xs">
                <InputBox label="Density" value={density} onChange={setDensity} suffix="kg/m³" unitCat="Density" />
                <InputBox label="Burn Coeff (a)" value={a} onChange={setA} suffix="" />
                <InputBox label="Pressure Exp (n)" value={n} onChange={setN} suffix="" />
                <InputBox label="Mol Wt" value={molWeight} onChange={setMolWeight} suffix="kg/mol" />
                <InputBox label="T_ref" value={T_ref} onChange={setTRef} suffix="K" unitCat="Temperature" />
                <InputBox label="σ_p" value={sigma_p} onChange={setSigmaP} suffix="1/K" />
                <div className="col-span-2 flex items-center justify-end space-x-2 mt-1 border-t border-[#eee] pt-1">
                  <span className="text-[#888] text-[10px]">Erosive Burning Model</span>
                  <select value={erosiveModel} onChange={e => setErosiveModel(e.target.value as any)} className="border border-[#bbb] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none font-mono text-right text-[10px]">
                    <option value="None">None</option>
                    <option value="Lenoir-Robillard">Lenoir-Robillard</option>
                    <option value="JPL">JPL Linear</option>
                  </select>
                </div>
              </div>
            </div>

            {/* QGroupBox: Solver Model */}
            <div className="border border-[#ccc] rounded pt-3 pb-2 px-2 relative mt-3 bg-[#fafafa]">
              <div className="absolute -top-2.5 left-2 bg-[#fafafa] px-1 text-[10px] font-bold text-[#666] uppercase">
                Solver Model
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5 text-xs">
                <div className="col-span-2 flex items-center justify-between space-x-2">
                  <span className="text-[#888] text-[10px]">Spatial Model</span>
                  <select
                    value={solverModel}
                    onChange={e => setSolverModel(e.target.value as SolverModelType)}
                    className="border border-[#bbb] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none font-mono text-right text-[10px]"
                  >
                    <option value="0D">0-D lumped chamber (fast)</option>
                    <option value="quasi1D">Quasi-1-D axial port</option>
                  </select>
                </div>
                {solverModel === 'quasi1D' && (
                  <InputBox label="Axial Stations" value={stationCount} onChange={setStationCount} suffix="" />
                )}
                <div className="col-span-2 text-[9px] text-[#888] leading-snug border-t border-[#eee] pt-1">
                  {solverModel === 'quasi1D' ? (
                    <>
                      Resolves pressure, mass flux and erosive burning along the port, so the aft end
                      burns faster than the head. Costs ~{stationCount}x a 0-D run. Monte Carlo always
                      uses 0-D.
                    </>
                  ) : (
                    <>
                      One pressure and one mass flux for the whole chamber. Accurate for short, fat
                      grains; understates aft erosion on long, thin ones.
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* QGroupBox: Grain Geometry */}
            <div className="border border-[#ccc] rounded pt-3 pb-2 px-2 relative mt-3 bg-[#fafafa]">
              <div className="absolute -top-2.5 left-2 bg-[#fafafa] px-1 text-[10px] font-bold text-[#666] uppercase flex items-center space-x-2">
                <span>Grain Geometry</span>
                <button onClick={() => setShowGrainEditor(true)} className="text-[#0056b3] hover:underline decoration-[#0056b3] lowercase font-normal">(preview / edit)</button>
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5 text-xs">
                <label className="flex items-center justify-end pr-1 text-[#444] text-right leading-tight text-xs">Type</label>
                <select value={grainType} onChange={e => setGrainType(e.target.value as any)} className="border border-[#bbb] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none w-full font-mono text-right text-xs">
                  <option value="BATES">BATES</option>
                  <option value="Tubular">Tubular</option>
                  <option value="Star">Star</option>
                  <option value="RodAndTube">Rod and Tube</option>
                  <option value="MoonBurner">MoonBurner</option>
                  <option value="Finocyl">Finocyl</option>
                  <option value="CustomDXF">Custom DXF Profile</option>
                </select>
                
                <InputBox label="Length" value={length} onChange={setLength} suffix="mm" unitCat="Length" />
                <InputBox label="Outer Rad" value={outerRadius} onChange={setOuterRadius} suffix="mm" unitCat="Length" />
                
                {grainType === 'CustomDXF' && (
                  <div className="col-span-2 pt-1 border-t border-[#eee] mt-1 space-y-1">
                    <label className="flex items-center text-[#444] text-xs">Upload DXF Cross Section</label>
                    <div className="flex items-center space-x-2">
                       <input type="file" accept=".dxf" className="hidden" ref={dxfFileInputRef} onChange={handleDXFUpload} />
                       <button onClick={() => dxfFileInputRef.current?.click()} className="flex-1 p-1 hover:bg-[#e0e0e0] border border-[#ccc] rounded flex items-center justify-center text-xs text-[#333]">
                         <Upload size={14} className="mr-1" /> Load .DXF
                       </button>
                       <span className="text-[10px] text-[#666] truncate max-w-[100px]">{dxfFilename || 'No file'}</span>
                    </div>
                  </div>
                )}
                
                {grainType === 'Star' && (
                  <>
                    <InputBox label="Valley Rad" value={valleyRadius} onChange={setValleyRadius} suffix="mm" unitCat="Length" />
                    <InputBox label="Tip Rad" value={tipRadius} onChange={setTipRadius} suffix="mm" unitCat="Length" />
                    <InputBox label="Points" value={numPoints} onChange={setNumPoints} suffix="" />
                  </>
                )}
                {(grainType === 'BATES' || grainType === 'Tubular' || grainType === 'RodAndTube' || grainType === 'MoonBurner' || grainType === 'Finocyl') && (
                  <InputBox label={grainType === 'RodAndTube' ? "Tube Inner Rad" : grainType === 'MoonBurner' ? "Core Radius" : grainType === 'Finocyl' ? "Core Radius" : "Inner Rad"} value={innerRadius} onChange={setInnerRadius} suffix="mm" unitCat="Length" />
                )}
                {grainType === 'BATES' && (
                  <InputBox label="Segments" value={numSegments} onChange={setNumSegments} suffix="" />
                )}
                {grainType === 'RodAndTube' && (
                  <InputBox label="Rod Radius" value={rodRadius} onChange={setRodRadius} suffix="mm" unitCat="Length" />
                )}
                {grainType === 'MoonBurner' && (
                  <InputBox label="Offset" value={offset} onChange={setOffset} suffix="mm" unitCat="Length" />
                )}
                {grainType === 'Finocyl' && (
                  <>
                    <InputBox label="Fin Depth" value={finDepth} onChange={setFinDepth} suffix="mm" unitCat="Length" />
                    <InputBox label="Fin Width" value={finWidth} onChange={setFinWidth} suffix="mm" unitCat="Length" />
                    <InputBox label="Fins" value={numPoints} onChange={setNumPoints} suffix="" />
                  </>
                )}
                
                <div className="col-span-2 flex justify-end mt-2 pt-2 border-t border-[#eee]">
                  <button onClick={handleExportSTL} disabled={isSimulating} className="flex items-center space-x-1 border border-[#aaa] rounded px-2 py-1 text-xs bg-white text-[#333] hover:bg-[#e8f4f8] hover:text-[#0056b3] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <Download className="w-3.5 h-3.5" />
                    <span>Export 3D Solid Grain (.stl)</span>
                  </button>
                </div>
              </div>
            </div>

            {/* QGroupBox: Nozzle & Thermo */}
            <div className="border border-[#ccc] rounded pt-3 pb-2 px-2 relative mt-3 bg-[#fafafa]">
              <span className="absolute -top-2.5 left-2 bg-[#fafafa] px-1 text-[10px] font-bold text-[#666] uppercase">Nozzle & Thermo</span>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5 text-xs">
                <InputBox label="Throat Diam" value={throatDiameter} onChange={setThroatDiameter} suffix="mm" unitCat="Length" />
                <InputBox label="Exp Ratio" value={expansionRatio} onChange={setExpansionRatio} suffix="" />
                <InputBox label="Gamma (γ)" value={gamma} onChange={setGamma} suffix="" />
                <InputBox label="Flame Temp" value={flameTemp} onChange={setFlameTemp} suffix="K" unitCat="Temperature" />
                <InputBox label="Init Temp" value={T_init} onChange={setTInit} suffix="K" unitCat="Temperature" />
                
                <InputBox label="C* Efficiency" value={cStarEff} onChange={setCStarEff} step={0.01} suffix="" />
                <InputBox label="Cf Efficiency" value={cfEff} onChange={setCfEff} step={0.01} suffix="" />

                <label className="flex items-center justify-end pr-1 text-[#444] text-right leading-tight text-xs">Material</label>
                <select value={nozzleMaterial} onChange={e => setNozzleMaterial(e.target.value as any)} className="border border-[#bbb] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none w-full font-mono text-right text-xs">
                  <option value="Graphite">Graphite</option>
                  <option value="Phenolic">Phenolic</option>
                  <option value="Custom">Custom</option>
                </select>
                
                {nozzleMaterial === 'Custom' && (
                  <>
                    <InputBox label="Density" value={nozzleDensity} onChange={setNozzleDensity} suffix="kg/m³" unitCat="Density" />
                    <InputBox label="Heat Ablat" value={nozzleHeatOfAblation} onChange={setNozzleHeatOfAblation} suffix="J/kg" />
                    <InputBox label="Oxidat Temp" value={nozzleOxidationTemp} onChange={setNozzleOxidationTemp} suffix="K" unitCat="Temperature" />
                    <InputBox label="Thermal Cond" value={nozzleThermalConductivity} onChange={setNozzleThermalConductivity} suffix="W/m-K" />
                    <InputBox label="Specific Heat" value={nozzleSpecificHeat} onChange={setNozzleSpecificHeat} suffix="J/kg-K" />
                    <InputBox label="k Temp Cf" value={nozzleKTempCoeff} onChange={setNozzleKTempCoeff} suffix="1/K" step={0.0001} />
                    <InputBox label="Cp Temp Cf" value={nozzleCpTempCoeff} onChange={setNozzleCpTempCoeff} suffix="1/K" step={0.0001} />
                  </>
                )}
              </div>
            </div>

            {/* QGroupBox: Igniter & Casing */}
            <div className="border border-[#ccc] rounded pt-3 pb-2 px-2 relative mt-3 bg-[#fafafa]">
              <span className="absolute -top-2.5 left-2 bg-[#fafafa] px-1 text-[10px] font-bold text-[#666] uppercase">Igniter & Casing</span>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5 text-xs">
                <InputBox label="Igniter Mass" value={igniterMass} onChange={setIgniterMass} suffix="kg" unitCat="Mass" />
                <InputBox label="Igniter Area" value={igniterSurfaceArea} onChange={setIgniterSurfaceArea} suffix="m²" unitCat="Area" />
                
                <label className="flex items-center justify-end pr-1 text-[#444] text-right leading-tight text-xs">Casing Alloy</label>
                <select value={casingMaterial} onChange={e => handleCasingChange(e.target.value)} className="border border-[#bbb] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none w-full font-mono text-right text-xs">
                  <option value="Al 6061-T6">Al 6061-T6</option>
                  <option value="Steel 4130">Steel 4130</option>
                  <option value="Carbon Composite">Carbon Composite</option>
                  <option value="Custom">Custom</option>
                </select>
                
                {casingMaterial === 'Custom' && (
                  <>
                    <InputBox label="Casing Yield" value={casingYieldStress * 1e6} onChange={(v: number) => setCasingYieldStress(v/1e6)} suffix="MPa" unitCat="Pressure" />
                    <InputBox label="Casing Mod" value={casingYoungsModulus * 1e9} onChange={(v: number) => setCasingYoungsModulus(v/1e9)} suffix="GPa" unitCat="Pressure" />
                  </>
                )}

                <InputBox label="Wall Thick" value={caseWallThickness} onChange={setCaseWallThickness} suffix="mm" unitCat="Length" />
                {metrics && (
                  <div className="col-span-2 text-[9px] text-[#888] leading-snug -mt-0.5">
                    Thin-wall pR/t sizing at SF 1.5 asks for {(metrics.requiredThickness * 1000).toFixed(2)} mm.
                    That rule ignores the closure junction, so check the Structural tab before trusting it.
                  </div>
                )}

                <div className="col-span-2 border-t border-[#eee] mt-1 pt-1 mb-1 font-bold text-[#666] text-[10px] text-center uppercase">Bolted Closure</div>
                <InputBox label="Num Bolts" value={numBolts} onChange={setNumBolts} suffix="" />
                <InputBox label="Bolt Diam" value={boltDiameter} onChange={setBoltDiameter} suffix="mm" unitCat="Length" />
                <InputBox label="Bolt Yield" value={boltYieldStress * 1e6} onChange={(v: number) => setBoltYieldStress(v/1e6)} suffix="MPa" unitCat="Pressure" />
                <InputBox label="Edge Dist" value={caseBoltEdgeDistance} onChange={setCaseBoltEdgeDistance} suffix="mm" unitCat="Length" />
                
                <div className="col-span-2 flex flex-col justify-end mt-2 pt-2 border-t border-[#eee] space-y-1">
                  <button onClick={handleExportCasingSTL} disabled={isSimulating} className="flex items-center justify-center space-x-1 border border-[#aaa] rounded px-2 py-1 text-xs bg-white text-[#333] hover:bg-[#e8f4f8] hover:text-[#0056b3] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="High-fidelity manufacturing STL">
                    <Download className="w-3.5 h-3.5" />
                    <span>Export Additive Assembly (.stl)</span>
                  </button>
                  <button onClick={handleExportCasingSCAD} disabled={isSimulating} className="flex items-center justify-center space-x-1 border border-[#aaa] rounded px-2 py-1 text-xs bg-white text-[#333] hover:bg-[#e8f4f8] hover:text-[#0056b3] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Use FreeCAD/OpenSCAD to convert this into STEP or Parasolid.">
                    <Download className="w-3.5 h-3.5" />
                    <span>Export CAD Source (.scad)</span>
                  </button>
                </div>
              </div>
            </div>

            {/* QGroupBox: Results Summary */}
            {metrics && (
              <div className="border border-[#ccc] rounded pt-3 pb-2 px-2 relative mt-3 bg-[#e8f4f8]">
                <span className="absolute -top-2.5 left-2 bg-[#e8f4f8] px-1 text-[10px] font-bold text-[#0056b3] uppercase">Results Summary</span>
                <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5 text-xs">
                  <div className="text-[#444] text-right pr-1">Max Thrust:</div><div className="font-mono font-bold text-[#000]">{(metrics.maxThrust/1000).toFixed(2)} kN</div>
                  <div className="text-[#444] text-right pr-1">Max Press:</div><div className="font-mono font-bold text-[#000]">{(metrics.maxPc/1e6).toFixed(2)} MPa</div>
                  <div className="text-[#444] text-right pr-1">Total Imp:</div><div className="font-mono font-bold text-[#000]">{(metrics.totalImpulse/1000).toFixed(1)} kNs</div>
                  <div className="text-[#444] text-right pr-1">Isp:</div><div className="font-mono font-bold text-[#000]">{metrics.isp.toFixed(1)} s</div>
                  <div className="text-[#444] text-right pr-1">Action Time:</div><div className="font-mono font-bold text-[#000]">{metrics.actionTime.toFixed(2)} s</div>
                  <div className="text-[#444] text-right pr-1">Case SF:</div>
                  <div className={`font-mono font-bold ${structural && structural.safetyFactor < 1.5 ? 'text-[#cc0000]' : 'text-[#000]'}`}>
                    {structural ? `${structural.safetyFactor.toFixed(2)}x` : '--'}
                  </div>
                  <div className="text-[#444] text-right pr-1">Bore Growth:</div>
                  <div className="font-mono font-bold text-[#000]">
                    {structural ? `${(structural.boreRadialGrowth * 1e6).toFixed(0)} µm` : '--'}
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Central Widget: Tabbed Layout (QTabWidget) */}
        <div className="flex-1 flex flex-col bg-[#a0a0a0] overflow-hidden">
          
          {/* QTabBar */}
          <div className="flex-none h-7 bg-[#d0d0d0] border-b border-[#888] flex items-end px-1 space-x-0.5 pt-1 overflow-x-auto">
            {[
              { id: 'ballistics', label: 'Internal Ballistics' },
              { id: 'statistics', label: 'Motor Statistics' },
              { id: 'extended_graphs', label: 'Custom Graph' },
              { id: 'geometry', label: 'Grain Geometry' },
              { id: 'thermo', label: 'Propellant Thermo' },
              { id: 'materials', label: 'Material Properties' },
              { id: 'montecarlo', label: 'Monte Carlo' },
              { id: 'structural', label: 'Structural Analysis' },
              { id: 'surrogate', label: 'Surrogate (fast)' }
            ].map(tab => (
              <button 
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-3 py-1 text-xs border border-[#888] border-b-0 rounded-t flex items-center whitespace-nowrap ${activeTab === tab.id ? 'bg-[#a0a0a0] font-bold text-black z-10 relative top-[1px] border-b-[#a0a0a0]' : 'bg-[#e0e0e0] text-[#555] hover:bg-[#d8d8d8]'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content Area */}
          <div className="flex-1 p-1 flex flex-col space-y-1 overflow-hidden bg-[#a0a0a0] relative">
            
            {isSimulating && (
              <div className="absolute inset-0 z-50 bg-[#111] bg-opacity-80 flex flex-col items-center justify-center font-mono">
                <svg className="animate-spin -ml-1 mr-3 h-10 w-10 text-[#00aaff] mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <div className="text-[#00aaff] text-sm animate-pulse tracking-widest font-bold">SOLVING MESH & THERMO MODELS...</div>
              </div>
            )}

            {stabilityWarnings.length > 0 && (
              <div className="flex-none bg-[#fff3cd] border border-[#ffeeba] p-2 rounded flex flex-col space-y-1 mb-1">
                <div className="text-[#856404] text-xs font-bold flex items-center">
                  <Terminal size={14} className="mr-1" /> STABILITY WARNINGS DETECTED
                </div>
                {stabilityWarnings.map((w, idx) => (
                  <div key={idx} className="text-[#856404] text-[11px] font-mono pl-4">• {w}</div>
                ))}
              </div>
            )}

            {/* TAB: BALLISTICS */}
            {activeTab === 'ballistics' && (
              <div className="flex-1 flex flex-col space-y-1">
                <div className="flex-1 bg-black border border-[#555] relative flex flex-col">
                  <div className="absolute top-1 left-2 z-10 text-[#00ff00] text-[10px] font-mono">Chamber Pressure vs. Time</div>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 20, right: 10, bottom: 5, left: 0 }}>
                      <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                      <XAxis dataKey="Time" type="number" domain={['dataMin', 'dataMax']} stroke="#666" tick={{fill: '#888', fontSize: 10}} tickFormatter={(v) => v.toFixed(2)} />
                      <YAxis stroke="#666" tick={{fill: '#888', fontSize: 10}} tickFormatter={(v) => v.toFixed(1)} />
                      <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', color: '#00ff00', fontSize: '11px', fontFamily: 'monospace' }} itemStyle={{ color: '#00ff00' }} />
                      <Line type="stepAfter" dataKey="Pc_MPa" stroke="#00ff00" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex-1 bg-black border border-[#555] relative flex flex-col">
                  <div className="absolute top-1 left-2 z-10 text-[#ff00ff] text-[10px] font-mono">Thrust vs. Time</div>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 20, right: 10, bottom: 5, left: 0 }}>
                      <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                      <XAxis dataKey="Time" type="number" domain={['dataMin', 'dataMax']} stroke="#666" tick={{fill: '#888', fontSize: 10}} tickFormatter={(v) => v.toFixed(2)} />
                      <YAxis stroke="#666" tick={{fill: '#888', fontSize: 10}} tickFormatter={(v) => v.toFixed(1)} />
                      <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', color: '#ff00ff', fontSize: '11px', fontFamily: 'monospace' }} itemStyle={{ color: '#ff00ff' }} />
                      <Line type="stepAfter" dataKey="Thrust_kN" stroke="#ff00ff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Axial profile: only exists after a quasi-1-D run. This is the
                    whole point of the model -- it shows the head end and the aft
                    end of the same grain burning at different rates. */}
                {stations && axialData.length > 0 && (
                  <div className="flex-1 bg-black border border-[#555] relative flex flex-col">
                    <div className="absolute top-1 left-2 z-10 text-[#00aaff] text-[10px] font-mono">
                      Axial Profile at Peak Pressure &mdash; head end (x=0) to nozzle
                    </div>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={axialData} margin={{ top: 20, right: 40, bottom: 5, left: 0 }}>
                        <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                        <XAxis
                          dataKey="x" type="number" domain={['dataMin', 'dataMax']} stroke="#666"
                          tick={{ fill: '#888', fontSize: 10 }} tickFormatter={(v) => v.toFixed(2)}
                        />
                        <YAxis yAxisId="left" stroke="#00aaff" tick={{ fill: '#00aaff', fontSize: 10 }} tickFormatter={(v) => v.toFixed(2)} />
                        <YAxis yAxisId="right" orientation="right" stroke="#ffaa00" tick={{ fill: '#ffaa00', fontSize: 10 }} tickFormatter={(v) => v.toFixed(1)} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#111', borderColor: '#444', fontSize: '11px', fontFamily: 'monospace' }}
                          labelFormatter={(v: any) => `x = ${Number(v).toFixed(3)} m`}
                        />
                        <Legend wrapperStyle={{ fontSize: '10px' }} />
                        <Line yAxisId="left" type="monotone" dataKey="Pc_MPa" name="Static Pc (MPa)" stroke="#00aaff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                        <Line yAxisId="right" type="monotone" dataKey="G" name="Mass flux (kg/m²s)" stroke="#ffaa00" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                        <Line yAxisId="right" type="monotone" dataKey="rb_mm_s" name="Burn rate (mm/s)" stroke="#00ff88" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {/* TAB: EXTENDED GRAPHS (now Custom Graph) */}
            {activeTab === 'extended_graphs' && (
              <div className="flex-1 flex bg-[#222]">
                {/* Graph Controls Sidebar */}
                <div className="w-48 bg-[#2a2a2a] border-r border-[#111] px-2 py-3 flex flex-col space-y-4 overflow-y-auto">
                  
                  {/* X Axis Selector */}
                  <div className="border border-[#444] rounded p-2 bg-[#252525]">
                    <div className="text-[#aaa] text-[10px] font-bold mb-2 uppercase border-b border-[#555] pb-1">X Axis</div>
                    <div className="flex flex-col space-y-1 text-[11px] text-[#ddd]">
                      {['Time', 'Regression Depth', 'Web'].map(opt => (
                        <label key={opt} className="flex items-center space-x-2 cursor-pointer hover:text-[#fff]">
                          <input type="radio" checked={customXAxis === opt} onChange={() => setCustomXAxis(opt)} className="accent-[#00aaff]" />
                          <span>{opt}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  
                  {/* Y Axis Selector */}
                  <div className="border border-[#444] rounded p-2 flex-1 bg-[#252525] flex flex-col overflow-hidden">
                    <div className="text-[#aaa] text-[10px] font-bold mb-2 uppercase border-b border-[#555] pb-1 flex-none">Y Axis</div>
                    <div className="flex flex-col space-y-1 text-[11px] text-[#ddd] overflow-y-auto pr-1 flex-1">
                      {[
                        { label: 'Kn', key: 'Kn', color: '#ffff00' },
                        { label: 'Chamber Pressure', key: 'Pc_MPa', color: '#00ff00' },
                        { label: 'Thrust', key: 'Thrust_N', color: '#ff00ff' },
                        { label: 'Propellant Mass', key: 'PropellantMass_kg', color: '#ff5555' },
                        { label: 'Volume Loading', key: 'VolumeLoading_pct', color: '#5555ff' },
                        { label: 'Mass Flow', key: 'MassFlow_kg_s', color: '#55ff55' },
                        { label: 'Mass Flux', key: 'PortMassFlux_kg_sm2', color: '#00ffff' },
                        { label: 'Regression Depth', key: 'Regression_mm', color: '#ffaa00' },
                        { label: 'Web', key: 'Web_mm', color: '#aaffaa' },
                        { label: 'Nozzle Exit Pressure', key: 'NozzleExitPressure_MPa', color: '#aaaaff' },
                        { label: 'Change in Throat Diameter', key: 'ChangeInThroatDiameter_mm', color: '#ffaaff' },
                        { label: 'Core Mach Number', key: 'CoreMachNumber', color: '#ffffff' },
                      ].map(opt => (
                        <label key={opt.key} className="flex items-center space-x-2 cursor-pointer hover:text-[#fff]">
                          <input type="checkbox" checked={customYAxes.includes(opt.key)} onChange={(e) => {
                            if (e.target.checked) setCustomYAxes([...customYAxes, opt.key]);
                            else setCustomYAxes(customYAxes.filter(k => k !== opt.key));
                          }} className="accent-[#00aaff]" />
                          <div className="w-2 h-2 rounded-full flex-none" style={{ backgroundColor: opt.color }}></div>
                          <span className="truncate" title={opt.label}>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  
                  {/* Grains Selector */}
                  <div className="border border-[#444] rounded p-2 bg-[#252525]">
                    <div className="text-[#aaa] text-[10px] font-bold mb-2 uppercase border-b border-[#555] pb-1">Grains</div>
                    <div className="flex flex-col space-y-1 text-[11px] text-[#ddd]">
                      <label className="flex items-center space-x-2 cursor-pointer hover:text-[#fff]">
                        <input type="checkbox" checked={true} readOnly className="accent-[#00aaff]" />
                        <span>Grain 1..{numSegments}</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Main Graph View */}
                <div className="flex-1 bg-black relative p-2 flex flex-col border border-[#555]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: -20 }}>
                      <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                      <XAxis 
                        dataKey={customXAxis === 'Time' ? 'Time' : customXAxis === 'Regression Depth' ? 'Regression_mm' : 'Web_mm'} 
                        type="number" 
                        domain={['dataMin', 'dataMax']} 
                        stroke="#666" 
                        tick={{fill: '#888', fontSize: 10}} 
                        tickFormatter={(v) => v.toFixed(2)} 
                        label={{ value: customXAxis, position: 'insideBottom', offset: -15, fill: '#888', fontSize: 12 }} 
                      />
                      
                      <YAxis stroke="#666" tick={{fill: '#888', fontSize: 10}} domain={['auto', 'auto']} tickFormatter={(v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(1)} />
                      
                      <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', fontSize: '11px', fontFamily: 'monospace' }} />
                      
                      {/* Lines */}
                      {[
                        { label: 'Kn', key: 'Kn', color: '#ffff00' },
                        { label: 'Chamber Pressure', key: 'Pc_MPa', color: '#00ff00' },
                        { label: 'Thrust', key: 'Thrust_N', color: '#ff00ff' },
                        { label: 'Propellant Mass', key: 'PropellantMass_kg', color: '#ff5555' },
                        { label: 'Volume Loading', key: 'VolumeLoading_pct', color: '#5555ff' },
                        { label: 'Mass Flow', key: 'MassFlow_kg_s', color: '#55ff55' },
                        { label: 'Mass Flux', key: 'PortMassFlux_kg_sm2', color: '#00ffff' },
                        { label: 'Regression Depth', key: 'Regression_mm', color: '#ffaa00' },
                        { label: 'Web', key: 'Web_mm', color: '#aaffaa' },
                        { label: 'Nozzle Exit Pressure', key: 'NozzleExitPressure_MPa', color: '#aaaaff' },
                        { label: 'Change in Throat Diameter', key: 'ChangeInThroatDiameter_mm', color: '#ffaaff' },
                        { label: 'Core Mach Number', key: 'CoreMachNumber', color: '#ffffff' },
                      ]
                        .filter(opt => customYAxes.includes(opt.key))
                        .map(opt => (
                          <Line key={opt.key} name={opt.label} type="stepAfter" dataKey={opt.key} stroke={opt.color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                        ))
                      }
                      <Legend verticalAlign="top" height={36} wrapperStyle={{ fontSize: '10px', fontFamily: 'monospace', color: '#ccc' }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* TAB: GEOMETRY */}
            {activeTab === 'geometry' && (
              <div className="flex-1 bg-black border border-[#555] relative flex flex-col items-center justify-center">
                <div className="absolute top-1 left-2 z-10 text-[#00ffff] text-[10px] font-mono">Grain Cross-Section Regression</div>
                <div className="w-full h-full flex items-center justify-center p-8">
                  <svg viewBox="0 0 200 200" className="w-full h-full max-w-[500px] max-h-[500px] bg-[#222] rounded-full border border-[#444] shadow-2xl">
                    <circle cx="100" cy="100" r={(outerRadius / outerRadius) * 95} fill="#555" />
                    {grainType === 'BATES' || grainType === 'Tubular' ? (
                      <circle cx="100" cy="100" r={Math.min(outerRadius, Math.max(0, innerRadius + currentY)) / outerRadius * 95} fill="#111" />
                    ) : grainType === 'RodAndTube' ? (
                      <>
                        <circle cx="100" cy="100" r={Math.min(outerRadius, Math.max(0, innerRadius + currentY)) / outerRadius * 95} fill="#111" />
                        {rodRadius - currentY > 0 && (
                          <circle cx="100" cy="100" r={Math.max(0, rodRadius - currentY) / outerRadius * 95} fill="#555" />
                        )}
                      </>
                    ) : grainType === 'MoonBurner' ? (
                      <circle cx={100 + (offset / outerRadius) * 95} cy="100" r={Math.min(outerRadius + offset, Math.max(0, innerRadius + currentY)) / outerRadius * 95} fill="#111" />
                    ) : grainType === 'Finocyl' ? (
                      <path d={(() => {
                        const scale = 95 / outerRadius;
                        const rc = Math.min(outerRadius * scale, (innerRadius + currentY) * scale);
                        const hw = (finWidth / 2.0 + currentY) * scale;
                        const td = (finDepth - finWidth / 2.0) * scale;
                        if (rc >= outerRadius * scale) return `M 5,100 A 95,95 0 1,1 195,100 A 95,95 0 1,1 5,100 Z`;
                        
                        let path = "";
                        for(let i=0; i<numPoints; i++) {
                           const angle = (i * 2 * Math.PI) / numPoints;
                           // we essentially draw a rough outline for each fin and the core arc between them
                           // For visual approximation simple circles and rectangles usually suffice
                           // Let's just create a composite shape: core circle + rects + tip circles
                           // Using path strings is easier overall.
                           const nx = Math.sin(angle);
                           const ny = -Math.cos(angle);
                           const tx = -ny;
                           const ty = nx;
                           
                           // Fin tip center
                           const cx = 100 + nx * td;
                           const cy = 100 + ny * td;
                           
                           // Wall points
                           const p1x = 100 + nx * rc + tx * hw;
                           const p1y = 100 + ny * rc + ty * hw;
                           const p2x = cx + tx * hw;
                           const p2y = cy + ty * hw;
                           const p3x = cx - tx * hw;
                           const p3y = cy - ty * hw;
                           const p4x = 100 + nx * rc - tx * hw;
                           const p4y = 100 + ny * rc - ty * hw;

                           if (i === 0) path += `M ${p1x} ${p1y} `;
                           else path += `L ${p1x} ${p1y} `;
                           path += `L ${p2x} ${p2y} `;
                           // Tip arc approximation
                           path += `A ${hw} ${hw} 0 0 1 ${p3x} ${p3y} `;
                           path += `L ${p4x} ${p4y} `;
                           
                           // Core arc to next fin
                           const next_angle = ((i + 1) * 2 * Math.PI) / numPoints;
                           const next_nx = Math.sin(next_angle);
                           const next_ny = -Math.cos(next_angle);
                           const next_tx = -next_ny;
                           const next_ty = next_nx;
                           const next_p1x = 100 + next_nx * rc + next_tx * hw;
                           const next_p1y = 100 + next_ny * rc + next_ty * hw;
                           
                           path += `A ${rc} ${rc} 0 0 1 ${next_p1x} ${next_p1y} `;
                        }
                        return path + "Z";
                      })()} fill="#111" />
                    ) : grainType === 'CustomDXF' && dxfData ? (
                      <circle cx="100" cy="100" r={Math.sqrt(dxfData.areaTable[Math.min(Math.floor(currentY / dxfData.dx), dxfData.areaTable.length - 1)] / Math.PI) / outerRadius * 95} fill="#111" />
                    ) : (
                      <path d={(() => {
                        const scale = 95 / outerRadius;
                        const r_outer = Math.min(outerRadius, valleyRadius + currentY) * scale;
                        const r_inner = Math.min(outerRadius, tipRadius + currentY) * scale;
                        let path = "";
                        for(let i=0; i<numPoints*2; i++) {
                          const radius = i % 2 === 0 ? r_inner : r_outer;
                          const angle = (i * Math.PI) / numPoints;
                          const px = 100 + radius * Math.sin(angle);
                          const py = 100 - radius * Math.cos(angle);
                          path += (i === 0 ? `M ${px} ${py} ` : `L ${px} ${py} `);
                        }
                        return path + "Z";
                      })()} fill="#111" />
                    )}
                  </svg>
                </div>
                <div className="absolute bottom-4 left-4 right-4 flex flex-col space-y-2 bg-[#111] p-3 rounded border border-[#333]">
                  <div className="flex justify-between text-[#00ffff] text-[10px] font-mono px-2">
                    <span>Burn Area: {(results[visualizerIndex]?.Ab * 10000 || 0).toFixed(1)} cm²</span>
                    <span>Port Area: {(results[visualizerIndex]?.PortArea * 10000 || 0).toFixed(1)} cm²</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-[#00ffff] text-[10px] font-mono w-16">T: {results[visualizerIndex]?.Time.toFixed(2) || '0.00'}s</span>
                    <input 
                      type="range" 
                      min="0" 
                      max={Math.max(0, results.length - 1)} 
                      value={visualizerIndex} 
                      onChange={(e) => setVisualizerIndex(Number(e.target.value))}
                      className="flex-1 accent-[#00ffff]"
                      disabled={results.length === 0}
                    />
                    <span className="text-[#00ffff] text-[10px] font-mono w-16 text-right">W: {(currentY * 1000).toFixed(1)}mm</span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: THERMO */}
            {activeTab === 'thermo' && (
              <div className="flex-1 bg-black border border-[#555] relative flex flex-col">
                <div className="absolute top-1 left-2 z-10 text-[#ffff00] text-[10px] font-mono">Burn Rate vs. Chamber Pressure</div>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={burnRateData} margin={{ top: 20, right: 20, bottom: 20, left: 10 }}>
                    <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                    <XAxis dataKey="pressure" type="number" domain={['dataMin', 'dataMax']} stroke="#666" tick={{fill: '#888', fontSize: 10}} label={{ value: 'Pressure (MPa)', position: 'insideBottom', offset: -10, fill: '#888', fontSize: 10 }} />
                    <YAxis stroke="#666" tick={{fill: '#888', fontSize: 10}} label={{ value: 'Burn Rate (mm/s)', angle: -90, position: 'insideLeft', fill: '#888', fontSize: 10 }} />
                    <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', color: '#ffff00', fontSize: '11px', fontFamily: 'monospace' }} itemStyle={{ color: '#ffff00' }} />
                    <Line type="monotone" dataKey="burnRate" stroke="#ffff00" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* TAB: MONTE CARLO */}
            {activeTab === 'montecarlo' && (
              <div className="flex-1 flex flex-col space-y-1">
                <div className="flex-none bg-[#e4e4e4] border border-[#ccc] p-2 flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <label className="text-xs text-[#444] font-bold">Runs:</label>
                    <input type="number" value={mcRuns} onChange={e => setMcRuns(Number(e.target.value))} className="border border-[#bbb] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none w-16 text-xs" />
                  </div>
                  <div className="flex items-center space-x-2">
                    <label className="text-xs text-[#444] font-bold">Variance (%):</label>
                    <input type="number" value={mcVariance} onChange={e => setMcVariance(Number(e.target.value))} className="border border-[#bbb] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none w-16 text-xs" />
                  </div>
                  <button onClick={runMonteCarlo} className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded shadow-sm">
                    Run Analysis
                  </button>
                </div>
                <div className="flex-1 bg-black border border-[#555] relative flex flex-col">
                  <div className="absolute top-1 left-2 z-10 text-[#00aaff] text-[10px] font-mono">Monte Carlo: Max Pressure vs Max Thrust</div>
                  {mcResults.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 10 }}>
                        <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                        <XAxis dataKey="maxPc" type="number" name="Max Pressure" unit=" MPa" stroke="#666" tick={{fill: '#888', fontSize: 10}} domain={['auto', 'auto']} label={{ value: 'Max Pressure (MPa)', position: 'insideBottom', offset: -10, fill: '#888', fontSize: 10 }} />
                        <YAxis dataKey="maxThrust" type="number" name="Max Thrust" unit=" kN" stroke="#666" tick={{fill: '#888', fontSize: 10}} domain={['auto', 'auto']} label={{ value: 'Max Thrust (kN)', angle: -90, position: 'insideLeft', fill: '#888', fontSize: 10 }} />
                        <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ backgroundColor: '#111', borderColor: '#444', color: '#00aaff', fontSize: '11px', fontFamily: 'monospace' }} />
                        <Scatter name="Runs" data={mcResults} fill="#00aaff" />
                      </ScatterChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-[#555] font-mono text-xs">
                      Run analysis to view distribution
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: MATERIALS */}
            {activeTab === 'materials' && (
              <div className="flex-1 bg-black border border-[#555] relative flex flex-col items-center justify-start overflow-y-auto custom-scrollbar p-6">
                <div className="absolute top-1 left-2 z-10 text-[#00aaff] text-[10px] font-mono">Material Properties Library</div>

                <div className="w-full max-w-4xl space-y-6 mt-6">
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {/* Casing Overview Card */}
                    <div className="bg-[#111] border border-[#333] p-4 rounded-md shadow-lg relative">
                      <h3 className="font-mono font-bold text-[#00aaff] mb-4 pb-2 border-b border-[#333] text-sm tracking-wide">CASING ALLOY</h3>
                      <p className="font-mono text-[#eee] font-bold mb-4">{casingMaterial}</p>
                      <div className="grid grid-cols-2 gap-y-2 text-xs font-mono">
                        <div className="text-[#888]">Yield Str:</div>
                        <div className="text-[#00ff00] font-bold">{casingYieldStress} MPa</div>
                        <div className="text-[#888]">Young's Mod:</div>
                        <div className="text-[#00ff00] font-bold">{casingYoungsModulus} GPa</div>
                      </div>
                      <div className="absolute top-2 right-2 flex space-x-1">
                        <button onClick={() => handleSaveMaterial('casing')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Save</button>
                        <button onClick={() => handleLoadMaterialClick('casing')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Load</button>
                      </div>
                    </div>
                    
                    {/* Propellant Overview Card */}
                    <div className="bg-[#111] border border-[#333] p-4 rounded-md shadow-lg relative">
                      <h3 className="font-mono font-bold text-[#00ffff] mb-4 pb-2 border-b border-[#333] text-sm tracking-wide">PROPELLANT</h3>
                      <div className="grid grid-cols-2 gap-y-2 text-xs font-mono">
                        <div className="text-[#888]">Density:</div>
                        <div className="text-[#00ff00] font-bold">{density} kg/m³</div>
                        <div className="text-[#888]">Burn Coeff(a):</div>
                        <div className="text-[#00ff00] font-bold">{a}</div>
                        <div className="text-[#888]">Burn Exp(n):</div>
                        <div className="text-[#00ff00] font-bold">{n}</div>
                        <div className="text-[#888]">Flame Temp:</div>
                        <div className="text-[#00ff00] font-bold">{flameTemp} K</div>
                        <div className="text-[#888]">Mol Wt:</div>
                        <div className="text-[#00ff00] font-bold">{molWeight} kg/mol</div>
                      </div>
                      <div className="absolute top-2 right-2 flex space-x-1">
                        <button onClick={() => handleSaveMaterial('propellant')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Save</button>
                        <button onClick={() => handleLoadMaterialClick('propellant')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Load</button>
                      </div>
                    </div>

                    {/* Nozzle Overview Card */}
                    <div className="bg-[#111] border border-[#333] p-4 rounded-md shadow-lg relative">
                      <h3 className="font-mono font-bold text-[#ffaa00] mb-4 pb-2 border-b border-[#333] text-sm tracking-wide">NOZZLE RESIN</h3>
                      <p className="font-mono text-[#eee] font-bold mb-4">{nozzleMaterial}</p>
                      <div className="grid grid-cols-2 gap-y-2 text-xs font-mono">
                        <div className="text-[#888]">Thermal Cond:</div>
                        <div className="text-[#00ff00] font-bold">{nozzleMaterial === 'Custom' ? nozzleThermalConductivity : (nozzleMaterial === 'Graphite' ? 100 : 1.2)} W/m-K</div>
                        <div className="text-[#888]">Specific Heat:</div>
                        <div className="text-[#00ff00] font-bold">{nozzleMaterial === 'Custom' ? nozzleSpecificHeat : (nozzleMaterial === 'Graphite' ? 710 : 1300)} J/kg-K</div>
                        <div className="col-span-2 mt-4 text-[9px] text-[#555] leading-tight">
                          Advanced properties (Phase Change Enthalpy, Oxidation Temps) are mapped internally based on selection.
                        </div>
                      </div>
                      <div className="absolute top-2 right-2 flex space-x-1">
                        <button onClick={() => handleSaveMaterial('nozzle')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Save</button>
                        <button onClick={() => handleLoadMaterialClick('nozzle')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Load</button>
                      </div>
                    </div>
                  </div>
                  
                  <div className="mt-8 text-[11px] text-[#888] font-mono p-4 border border-[#333] rounded bg-[#0a0a0a]">
                    <span className="font-bold text-[#aaa]">SYSTEM LOG:</span> Material parameters are currently modified directly via the main Motor Parameters dock on the left, or loaded via entire Config '.json' files. The application's thermodynamic erosion models automatically resolve advanced material properties behind-the-scenes when defined combinations (e.g., Graphite, Phenolic) are requested.
                  </div>

                </div>
              </div>
            )}

            {/* TAB: STRUCTURAL */}
            {activeTab === 'structural' && (
              <div className="flex-1 bg-black border border-[#555] relative flex flex-col items-center justify-start overflow-y-auto custom-scrollbar p-6">
                <div className="absolute top-1 left-2 z-10 flex items-center space-x-4">
                  <span className="text-[#00aaff] text-[10px] font-mono">Structural & Erosion Analysis</span>
                  <label className="flex items-center space-x-1 cursor-pointer">
                    <input type="checkbox" checked={showFEA} onChange={e => setShowFEA(e.target.checked)} className="accent-[#00aaff]" />
                    <span className="text-[10px] text-[#eee] font-mono">2D FEA Visualization Mode</span>
                  </label>
                </div>

                {metrics && structural && results.length > 0 ? (
                  <div className="w-full max-w-4xl space-y-6 mt-6">
                    {/* Casing Integrity Panel */}
                    <div className="bg-[#111] border border-[#333] p-5 rounded-md shadow-lg w-full">
                      <div className="flex justify-between items-end border-b border-[#333] pb-2 mb-4">
                        <h3 className="font-mono font-bold text-[#00aaff] text-sm tracking-wide">CASING INTEGRITY & BOLTED CLOSURE</h3>
                        {metrics && (
                          <div className="flex space-x-2">
                            <button onClick={handleExportCasingSTL} disabled={isSimulating} className="flex items-center space-x-1 border border-[#666] rounded px-2 py-1 text-xs bg-[#222] text-[#eee] hover:bg-[#333] hover:text-[#fff] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Export .stl format for additive manufacturing">
                              <Download className="w-3 h-3" />
                              <span>AM (.stl)</span>
                            </button>
                            <button onClick={handleExportCasingSCAD} disabled={isSimulating} className="flex items-center space-x-1 border border-[#666] rounded px-2 py-1 text-xs bg-[#222] text-[#eee] hover:bg-[#333] hover:text-[#fff] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Export .scad format. OpenSCAD or FreeCAD can export this to STEP or Parasolid.">
                              <Download className="w-3 h-3" />
                              <span>CAD Base (.scad)</span>
                            </button>
                          </div>
                        )}
                      </div>
                      
                      {showFEA ? (
                        <div className="flex flex-col items-center space-y-4">
                          <p className="text-xs text-[#888] font-mono self-start">2D Axisymmetric FEA (von Mises Stress Distribution)</p>
                          {/* Advanced SVG FEA Visualizer */}
                          <div className="relative w-full h-40 border border-[#444] bg-[#222] rounded overflow-hidden flex flex-col items-center justify-center">
                            
                            {/* Color logic: Map vonMises / yieldStress to a color hue mapping */}
                            {(() => {
                              const vMises = structural.maxVonMises;
                              const yieldStress = casingYieldStress * 1e6;
                              const stressRatio = Math.min(1.2, vMises / yieldStress); // capping at 1.2
                              
                              // Hues: Blue (240) -> Green (120) -> Yellow (60) -> Red (0)
                              const hueMain = 240 - (stressRatio * 0.8 * 240); // cylinder largely uniform hoop
                              const hueEdge = 240 - (Math.min(1.0, stressRatio * 1.5) * 240); // higher stress near closures
                              // stress logic check here, keeping original code
                              return (
                                <svg viewBox="0 0 800 200" className="w-full h-full drop-shadow-lg">
                                  <defs>
                                    <linearGradient id="feaGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                                      <stop offset="0%" stopColor={`hsl(${hueEdge}, 100%, 50%)`} />
                                      <stop offset="10%" stopColor={`hsl(${hueEdge}, 100%, 50%)`} />
                                      <stop offset="25%" stopColor={`hsl(${hueMain}, 100%, 50%)`} />
                                      <stop offset="75%" stopColor={`hsl(${hueMain}, 100%, 50%)`} />
                                      <stop offset="90%" stopColor={`hsl(${hueEdge}, 100%, 50%)`} />
                                      <stop offset="100%" stopColor={`hsl(${hueEdge}, 100%, 50%)`} />
                                    </linearGradient>
                                    <linearGradient id="nozzleGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                                      <stop offset="0%" stopColor={`hsl(${hueEdge}, 100%, 40%)`} />
                                      <stop offset="100%" stopColor="hsl(240, 50%, 30%)" />
                                    </linearGradient>
                                  </defs>

                                  {/* Centerline */}
                                  <line x1="0" y1="100" x2="800" y2="100" stroke="#555" strokeDasharray="10 5" strokeWidth="1" />

                                  {/* Motor Casing Top Half */}
                                  <rect x="100" y="40" width="500" height="15" fill="url(#feaGradient)" stroke="#111" strokeWidth="1" />
                                  
                                  {/* Motor Casing Bottom Half */}
                                  <rect x="100" y="145" width="500" height="15" fill="url(#feaGradient)" stroke="#111" strokeWidth="1" />

                                  {/* Forward Closure */}
                                  <path d="M 100 40 Q 50 40 50 100 Q 50 160 100 160 Z" fill={`hsl(${hueEdge - 20}, 90%, 45%)`} stroke="#111" strokeWidth="1" />

                                  {/* Aft Closure & Nozzle block */}
                                  <rect x="600" y="30" width="30" height="140" fill={`hsl(${hueEdge}, 90%, 45%)`} stroke="#111" strokeWidth="1" />
                                  <path d="M 630 80 L 700 60 L 750 20 L 750 35 L 700 85 L 630 95 Z" fill="url(#nozzleGradient)" stroke="#111" strokeWidth="1" />
                                  <path d="M 630 120 L 700 140 L 750 180 L 750 165 L 700 115 L 630 105 Z" fill="url(#nozzleGradient)" stroke="#111" strokeWidth="1" />
                                  
                                  {/* Overlay Grid lines to indicate FEA mesh */}
                                  <pattern id="mesh" width="20" height="20" patternUnits="userSpaceOnUse">
                                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
                                  </pattern>
                                  <rect x="100" y="40" width="500" height="15" fill="url(#mesh)" />
                                  <rect x="100" y="145" width="500" height="15" fill="url(#mesh)" />
                                  <rect x="600" y="30" width="30" height="140" fill="url(#mesh)" />

                                  {/* Labels */}
                                  <text x="350" y="30" fill="white" fontSize="11" fontFamily="monospace" textAnchor="middle">Bore Hoop (Lamé) ≈ {(structural.lame.inner.hoop / 1e6).toFixed(1)} MPa</text>
                                  <text x="100" y="25" fill="#ff4444" fontSize="11" fontFamily="monospace" textAnchor="end">Peak von Mises ≈ {(structural.maxVonMises / 1e6).toFixed(1)} MPa</text>
                                  <text x="640" y="20" fill="#ffff00" fontSize="11" fontFamily="monospace">Aft Closure Bending Moment</text>
                                </svg>
                              );
                            })()}
                          </div>
                          {/* Legend */}
                          <div className="flex items-center space-x-2 text-[10px] font-mono w-full justify-between">
                            <span className="text-[#888]">
                              Safety factor {structural.safetyFactor.toFixed(2)}x at the {structural.whereMax}.
                              Colours are indicative only &mdash; this is a schematic, not a mesh.
                            </span>
                            <div className="flex items-center space-x-2">
                              <span className="text-blue-400">Low</span>
                              <div className="w-32 h-3 bg-gradient-to-r from-blue-500 via-green-500 via-yellow-500 to-red-500 rounded border border-[#555]"></div>
                              <span className="text-red-500">Yield</span>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-5 text-xs font-mono">
                          {/* --- inputs governing the analysis --- */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <p className="text-[#888] mb-1">Peak Chamber Pressure:</p>
                              <p className="text-[#ff4444] font-bold">{(metrics.maxPc / 1e6).toFixed(2)} MPa</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Case Bore Radius:</p>
                              <p className="text-[#eee]">{(outerRadius * 1000).toFixed(1)} mm</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Wall Thickness (analysed):</p>
                              <p className="text-[#eee]">{(caseWallThickness * 1000).toFixed(2)} mm</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Material:</p>
                              <p className="text-[#eee]">{casingMaterial} &middot; {casingYieldStress} MPa yield</p>
                            </div>
                          </div>

                          {/* --- headline result --- */}
                          <div className="border border-[#333] rounded p-3 bg-[#0c0c0c] grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <p className="text-[#888] mb-1">Peak von Mises:</p>
                              <p className="text-xl text-[#ffaa00] font-bold">{(structural.maxVonMises / 1e6).toFixed(1)} MPa</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Governing Location:</p>
                              <p className="text-[#eee] leading-tight">{structural.whereMax}</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Safety Factor:</p>
                              <p className={`text-xl font-bold ${structural.safetyFactor < 1 ? 'text-[#ff4444]' : structural.safetyFactor < 1.5 ? 'text-[#ffaa00]' : 'text-[#00ff00]'}`}>
                                {structural.safetyFactor.toFixed(2)}x
                              </p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Margin of Safety:</p>
                              <p className={`text-xl font-bold ${structural.marginOfSafety < 0 ? 'text-[#ff4444]' : 'text-[#00ff00]'}`}>
                                {structural.marginOfSafety >= 0 ? '+' : ''}{structural.marginOfSafety.toFixed(3)}
                              </p>
                            </div>
                          </div>

                          {/* --- Lame through-wall distribution --- */}
                          <div>
                            <p className="text-[#00aaff] font-bold mb-2 border-b border-[#333] pb-1">
                              THICK-WALL (LAMÉ) STRESS DISTRIBUTION
                            </p>
                            <div className="overflow-x-auto">
                              <table className="w-full text-[11px]">
                                <thead className="text-[#888]">
                                  <tr>
                                    <th className="text-left py-1">Location</th>
                                    <th className="text-right py-1">Hoop σθ</th>
                                    <th className="text-right py-1">Radial σr</th>
                                    <th className="text-right py-1">Axial σz</th>
                                    <th className="text-right py-1">von Mises</th>
                                  </tr>
                                </thead>
                                <tbody className="text-[#eee]">
                                  <tr className="border-t border-[#222]">
                                    <td className="py-1">Inner wall (bore, r = {(outerRadius * 1000).toFixed(1)} mm)</td>
                                    <td className="text-right">{(structural.lame.inner.hoop / 1e6).toFixed(1)}</td>
                                    <td className="text-right">{(structural.lame.inner.radial / 1e6).toFixed(1)}</td>
                                    <td className="text-right">{(structural.lame.inner.axial / 1e6).toFixed(1)}</td>
                                    <td className="text-right text-[#ffaa00]">{(structural.lame.inner.vonMises / 1e6).toFixed(1)}</td>
                                  </tr>
                                  <tr className="border-t border-[#222]">
                                    <td className="py-1">Outer wall (r = {((outerRadius + caseWallThickness) * 1000).toFixed(1)} mm)</td>
                                    <td className="text-right">{(structural.lame.outer.hoop / 1e6).toFixed(1)}</td>
                                    <td className="text-right">{(structural.lame.outer.radial / 1e6).toFixed(1)}</td>
                                    <td className="text-right">{(structural.lame.outer.axial / 1e6).toFixed(1)}</td>
                                    <td className="text-right text-[#ffaa00]">{(structural.lame.outer.vonMises / 1e6).toFixed(1)}</td>
                                  </tr>
                                </tbody>
                              </table>
                              <p className="text-[#666] text-[10px] mt-1">All values MPa. Hoop stress peaks at the bore and falls through the wall.</p>
                            </div>

                            {lameChart.length > 0 && (
                              <div className="h-40 mt-3 border border-[#333] rounded bg-[#0c0c0c]">
                                <ResponsiveContainer width="100%" height="100%">
                                  <LineChart data={lameChart} margin={{ top: 12, right: 20, bottom: 4, left: 0 }}>
                                    <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                                    <XAxis dataKey="r_mm" type="number" domain={['dataMin', 'dataMax']} stroke="#666" tick={{ fill: '#888', fontSize: 9 }} tickFormatter={(v) => v.toFixed(1)} label={{ value: 'radius (mm)', position: 'insideBottom', offset: -2, fill: '#666', fontSize: 9 }} />
                                    <YAxis stroke="#666" tick={{ fill: '#888', fontSize: 9 }} tickFormatter={(v) => v.toFixed(0)} />
                                    <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', fontSize: '10px', fontFamily: 'monospace' }} formatter={(v: any) => `${Number(v).toFixed(1)} MPa`} />
                                    <Legend wrapperStyle={{ fontSize: '9px' }} />
                                    <Line type="monotone" dataKey="hoop" name="hoop" stroke="#00aaff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                    <Line type="monotone" dataKey="radial" name="radial" stroke="#ff00ff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                    <Line type="monotone" dataKey="axial" name="axial" stroke="#00ff88" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                    <Line type="monotone" dataKey="vonMises" name="von Mises" stroke="#ffaa00" strokeWidth={2} dot={false} isAnimationActive={false} />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            )}

                            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-3">
                              <div>
                                <p className="text-[#888] mb-1">Wall Regime:</p>
                                <p className={structural.lame.thinWallApplicable ? 'text-[#00ff00]' : 'text-[#ffaa00]'}>
                                  {structural.lame.thinWallApplicable ? 'Thin' : 'THICK'} &mdash; R_mean/t = {structural.lame.rMeanOverT.toFixed(1)}
                                </p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Thin-wall pR/t would give:</p>
                                <p className="text-[#eee]">
                                  {(structural.lame.thinWallHoop / 1e6).toFixed(1)} MPa ({(structural.lame.thinWallError * 100).toFixed(1)}% error)
                                </p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Bore Growth at Peak P:</p>
                                <p className="text-[#eee]">
                                  {(structural.boreRadialGrowth * 1e6).toFixed(1)} µm ({(structural.boreHoopStrain * 100).toFixed(4)}% strain)
                                </p>
                              </div>
                            </div>
                          </div>

                          {/* --- edge bending --- */}
                          <div>
                            <p className="text-[#00aaff] font-bold mb-2 border-b border-[#333] pb-1">
                              DISCONTINUITY STRESS AT THE CASE-TO-CLOSURE JUNCTION
                            </p>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                              <div>
                                <p className="text-[#888] mb-1">Peak Combined (von Mises):</p>
                                <p className="text-xl text-[#ffaa00] font-bold">{(structural.edge.peak.vonMises / 1e6).toFixed(1)} MPa</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Axial Location:</p>
                                <p className="text-[#eee]">
                                  {(structural.edge.peakLocation * 1000).toFixed(2)} mm from joint
                                  <span className="text-[#666]"> ({structural.edge.peakLocationOverChar.toFixed(2)}/β)</span>
                                </p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Critical Surface:</p>
                                <p className="text-[#eee]">{structural.edge.peakSurface === 'bore' ? 'Bore (inner)' : 'Outer'}</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Decay Length (3/β):</p>
                                <p className="text-[#eee]">{(structural.edge.decayLength * 1000).toFixed(1)} mm</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">β = [3(1&minus;ν²)/(R²t²)]<sup>1/4</sup>:</p>
                                <p className="text-[#eee]">{structural.edge.beta.toFixed(1)} m⁻¹</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Edge Moment M₀ = p/2β²:</p>
                                <p className="text-[#eee]">{structural.edge.m0.toFixed(1)} N·m/m</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Edge Shear Q₀ = &minus;p/β:</p>
                                <p className="text-[#eee]">{(structural.edge.q0 / 1000).toFixed(1)} kN/m</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Bending / Membrane Hoop:</p>
                                <p className="text-[#eee]">{structural.edge.bendingToHoop.toFixed(2)}x</p>
                              </div>
                            </div>

                            {edgeChart.length > 0 && (
                              <div className="h-40 mt-3 border border-[#333] rounded bg-[#0c0c0c]">
                                <ResponsiveContainer width="100%" height="100%">
                                  <LineChart data={edgeChart} margin={{ top: 12, right: 20, bottom: 4, left: 0 }}>
                                    <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                                    <XAxis dataKey="x_mm" type="number" domain={['dataMin', 'dataMax']} stroke="#666" tick={{ fill: '#888', fontSize: 9 }} tickFormatter={(v) => v.toFixed(0)} label={{ value: 'distance from joint (mm)', position: 'insideBottom', offset: -2, fill: '#666', fontSize: 9 }} />
                                    <YAxis stroke="#666" tick={{ fill: '#888', fontSize: 9 }} tickFormatter={(v) => v.toFixed(0)} />
                                    <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', fontSize: '10px', fontFamily: 'monospace' }} formatter={(v: any) => `${Number(v).toFixed(1)} MPa`} />
                                    <Legend wrapperStyle={{ fontSize: '9px' }} />
                                    <Line type="monotone" dataKey="hoop" name="hoop" stroke="#00aaff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                    <Line type="monotone" dataKey="axial" name="axial" stroke="#00ff88" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                    <Line type="monotone" dataKey="vonMises" name="von Mises" stroke="#ffaa00" strokeWidth={2} dot={false} isAnimationActive={false} />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            )}
                            <p className="text-[#666] text-[10px] mt-1">
                              Cylindrical-shell edge bending for a clamped junction. Membrane hoop stress is suppressed to
                              zero at the joint (the closure holds the radius) and recovers over ~{(structural.edge.decayLength * 1000).toFixed(0)} mm.
                            </p>
                          </div>

                          {/* --- bolted closure --- */}
                          {structural.bolts && (
                            <div>
                              <p className="text-[#00aaff] font-bold mb-2 border-b border-[#333] pb-1">
                                BOLTED CLOSURE &mdash; {structural.bolts.count} × ⌀{(structural.bolts.diameter * 1000).toFixed(1)} mm
                              </p>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <div>
                                  <p className="text-[#888] mb-1">Total Closure Load:</p>
                                  <p className="text-[#eee]">{(structural.bolts.totalForce / 1000).toFixed(2)} kN</p>
                                </div>
                                <div>
                                  <p className="text-[#888] mb-1">Load per Bolt:</p>
                                  <p className="text-[#eee]">{(structural.bolts.forcePerBolt / 1000).toFixed(2)} kN</p>
                                </div>
                                <div>
                                  <p className="text-[#888] mb-1">Stress on Shank Area:</p>
                                  <p className="text-[#eee]">{(structural.bolts.nominalStress / 1e6).toFixed(1)} MPa (SF {structural.bolts.safetyFactorNominal.toFixed(2)})</p>
                                </div>
                                <div>
                                  <p className="text-[#888] mb-1">Stress on Thread Area:</p>
                                  <p className={`font-bold ${structural.bolts.safetyFactorStressArea < 1.5 ? 'text-[#ff4444]' : 'text-[#00ff00]'}`}>
                                    {(structural.bolts.stressAreaStress / 1e6).toFixed(1)} MPa (SF {structural.bolts.safetyFactorStressArea.toFixed(2)})
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[#888] mb-1">Flange Shear-Out:</p>
                                  <p className={`${structural.bolts.safetyFactorShearOut < 1.5 ? 'text-[#ff4444]' : 'text-[#00ff00]'}`}>
                                    {(structural.bolts.shearOutStress / 1e6).toFixed(1)} MPa (SF {structural.bolts.safetyFactorShearOut.toFixed(2)})
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[#888] mb-1">Bolt Edge Distance:</p>
                                  <p className="text-[#eee]">
                                    {(structural.bolts.edgeDistance * 1000).toFixed(1)} mm
                                    <span className="text-[#666]"> (min {(structural.bolts.minEdgeDistance * 1000).toFixed(1)})</span>
                                  </p>
                                </div>
                                <div className="col-span-2">
                                  <p className="text-[#888] mb-1">Min Thread Engagement:</p>
                                  <p className="text-[#eee]">
                                    {(structural.bolts.minEngagementSteel * 1000).toFixed(1)} mm into steel,
                                    {' '}{(structural.bolts.minEngagementAluminium * 1000).toFixed(1)} mm into aluminium
                                  </p>
                                </div>
                              </div>
                              <p className="text-[#666] text-[10px] mt-2 leading-snug">
                                Design to the THREAD tensile-stress area (≈74% of the shank), not the shank. Engagement
                                shorter than the values above lets the threads strip before the bolt yields, which is the
                                failure the tension numbers do not cover. Shear-out assumes two tear planes per bolt
                                through the wall at the stated edge distance, against 0.577·σ_yield of the case material.
                              </p>
                            </div>
                          )}

                          {/* --- assumptions and warnings: the point of the exercise --- */}
                          {structural.warnings.length > 0 && (
                            <div className="border border-[#663333] bg-[#1a0d0d] rounded p-3">
                              <p className="text-[#ff6666] font-bold mb-2 text-[11px]">FLAGS</p>
                              <ul className="space-y-1.5">
                                {structural.warnings.map((w, i) => (
                                  <li key={i} className="text-[#ffaaaa] text-[10px] leading-snug">• {w}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <div className="border border-[#333] rounded p-3 bg-[#0c0c0c]">
                            <p className="text-[#888] font-bold mb-2 text-[11px]">ASSUMPTIONS</p>
                            <ul className="space-y-1.5">
                              {structural.assumptions.map((a, i) => (
                                <li key={i} className="text-[#777] text-[10px] leading-snug">• {a}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                    
                    {/* Nozzle Erosion Panel */}
                    <div className="bg-[#111] border border-[#333] p-5 rounded-md shadow-lg w-full">
                      <h3 className="font-mono font-bold text-[#00aaff] mb-4 pb-2 border-b border-[#333] text-sm tracking-wide">NOZZLE EROSION (CONVECTIVE MODEL)</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-xs font-mono">
                        <div>
                          <p className="text-[#888] mb-1">Throat Material:</p>
                          <p className="text-[#eee]">{nozzleMaterial}</p>
                        </div>
                        <div className="col-span-2 md:col-span-3 text-[#888] text-[10px] leading-tight flex items-center">
                          Note: Convective ablation model driven by the selected throat material's thermal properties. Bartz heat-transfer coefficient scales as Pc^0.8 * Tf^0.5 * Dt^-0.2; recession begins once the surface reaches the material's oxidation temperature.
                        </div>
                        
                        <div className="col-span-2 border-t border-[#333] pt-4 mt-2">
                          <p className="text-[#888] mb-1">Initial Throat Diameter:</p>
                          <p className="text-lg text-[#eee]">{(throatDiameter * 1000).toFixed(2)} mm</p>
                        </div>
                        <div className="col-span-2 border-t border-[#333] pt-4 mt-2">
                          <p className="text-[#888] mb-1">Final Throat Diameter:</p>
                          <p className="text-xl text-[#ffaa00] font-bold">
                            {(Math.sqrt(4 * results[results.length - 1].ThroatArea / Math.PI) * 1000).toFixed(3)} mm
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-[#666] italic font-mono text-xs mt-6">
                    {metrics && results.length > 0
                      ? 'Loading the structural core...'
                      : 'Run a simulation to view structural analysis.'}
                  </div>
                )}
              </div>
            )}

            {/* TAB: STATISTICS */}
            {/* TAB: SURROGATE */}
            {activeTab === 'surrogate' && (
              <div className="flex-1 bg-black border border-[#555] relative flex flex-col items-center justify-start overflow-y-auto custom-scrollbar p-6">
                <div className="absolute top-1 left-2 z-10 text-[#00aaff] text-[10px] font-mono">
                  Physics-Trained Surrogate
                </div>
                {grainType !== 'BATES' ? (
                  <div className="text-[#666] italic font-mono text-xs mt-6 max-w-lg text-center">
                    The surrogate was trained on BATES grains only. Switch the grain type to BATES to
                    use it, or keep using the full solver — which handles every geometry.
                  </div>
                ) : (
                  <SurrogatePanel
                    design={surrogateDesign}
                    onApplyDesign={applySurrogateDesign}
                    addLog={addLog}
                  />
                )}
              </div>
            )}

            {activeTab === 'statistics' && (
              <div className="flex-1 bg-black border border-[#555] relative flex flex-col items-center justify-start overflow-y-auto custom-scrollbar p-6">
                <div className="absolute top-1 left-2 z-10 text-[#00ff00] text-[10px] font-mono">Motor Statistics & Summary</div>
                
                {metrics ? (
                  <div className="w-full max-w-4xl space-y-4 mt-6">
                    <div className="bg-[#111] border border-[#333] p-5 rounded-md shadow-lg text-[#ddd]">
                      <div className="text-[12px] uppercase font-bold text-[#aaa] border-b border-[#555] pb-2 mb-4 tracking-wider">Comprehensive Performance Data</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8 text-sm font-mono">
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Motor Designation:</span>
                          <span className="text-white">{(metrics.totalImpulse > 0 && metrics.totalImpulse < 100000) ? 
                            String.fromCharCode(65 + Math.min(25, Math.floor(Math.log2(metrics.totalImpulse / 2.5)))) : 'M'} ({(metrics.volumeLoading * 100).toFixed(0)}%)</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Average Pressure:</span>
                          <span className="text-white">{(metrics.avgPc / 6894.76).toFixed(2)} psi / {(metrics.avgPc / 1e6).toFixed(2)} MPa</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Propellant Mass:</span>
                          <span className="text-white">{(metrics.propMass * 2.20462).toFixed(2)} lb / {metrics.propMass.toFixed(2)} kg</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Impulse:</span>
                          <span className="text-white">{metrics.totalImpulse.toFixed(2)} Ns</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Peak Pressure:</span>
                          <span className="text-white">{(metrics.maxPc / 6894.76).toFixed(2)} psi / {(metrics.maxPc / 1e6).toFixed(2)} MPa</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Propellant Length:</span>
                          <span className="text-white">{(length * 39.3701).toFixed(2)} in / {(length * 1000).toFixed(1)} mm</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Delivered ISP:</span>
                          <span className="text-white">{metrics.isp.toFixed(2)} s</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Initial Kn:</span>
                          <span className="text-white">{metrics.initialKn.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Port/Throat Ratio:</span>
                          <span className="text-white">{metrics.portThroatRatio.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Burn Time:</span>
                          <span className="text-white">{metrics.actionTime.toFixed(2)} s</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Peak Kn:</span>
                          <span className="text-white">{metrics.peakKn.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Peak Mass Flux:</span>
                          <span className="text-white">{(metrics.peakMassFlux * 0.00142233).toFixed(2)} lb/(in²·s)</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Volume Loading:</span>
                          <span className="text-white">{(metrics.volumeLoading * 100).toFixed(2)}%</span>
                        </div>
                        <div className="flex justify-between border-b border-[#444] pb-1">
                          <span className="text-[#888]">Thrust Coefficient:</span>
                          <span className="text-white">{(metrics.maxThrust / (metrics.maxPc * Math.PI * Math.pow(throatDiameter/2, 2))).toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-[#666] italic font-mono text-xs">Run a simulation to view motor statistics.</div>
                )}
              </div>
            )}
            
          </div>
        </div>
      </div>

      {/* Bottom QDockWidget: Console */}
      <div className="h-24 flex-none bg-[#f0f0f0] border-t border-[#ccc] flex flex-col z-10">
        <div className="bg-[#e4e4e4] px-2 py-1 border-b border-[#ccc] font-bold text-xs text-[#555] shadow-sm flex items-center">
          <Terminal size={12} className="mr-1" /> System Output Console
        </div>
        <div className="flex-1 bg-black text-[#00ff00] font-mono text-[11px] p-2 overflow-y-auto whitespace-pre-wrap leading-tight">
          {logs.map((log, i) => (
            <div key={i}>{log}</div>
          ))}
        </div>
      </div>

      {/* QStatusBar */}
      <div className="h-6 flex-none bg-[#f0f0f0] border-t border-[#ccc] flex items-center px-3 z-20">
        <span className="text-[11px] text-[#555] font-medium">{statusMsg}</span>
      </div>

    </div>
    </SettingsContext.Provider>
  );
}
