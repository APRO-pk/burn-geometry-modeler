import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useFieldIds } from './useFieldIds';
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
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts';
import { Play, Terminal, Download, Calculator, Settings, Upload, Undo, Redo, Zap, ChevronDown, ChevronUp } from 'lucide-react';
import { processDXF } from './dxfProcessor';
import { PropellantEditor, PropellantData } from './PropellantEditor';
import { GrainEditor } from './GrainEditor';
import { exportBurnsimXML, parseBurnsimXML } from './BurnsimHandler';
import { OptimizerDialog } from './OptimizerDialog';
import { SurrogatePanel } from './SurrogatePanel';
import type { MotorMetrics } from './motorMetrics';
import { peakErosiveFraction } from './burnLaw';
import {
  useMotorConfig,
  CASING_ALLOYS,
  GRAIN_TYPES,
  NOZZLE_MATERIALS,
  CASING_MATERIALS,
  SOLVER_MODELS,
  type GrainType,
  type NozzleMaterialName,
  type CasingMaterialName,
} from './useMotorConfig';
import { ErrorBoundary } from './ErrorBoundary';
import { StructuralTab } from './StructuralTab';
import { BallisticsChart, SERIES } from './BallisticsChart';
import { modelUncertainty, formatBand } from './modelUncertainty';
import './ui/theme.css';
import { MenuBar, Toolbar, ToolbarSep, ToolbarSpacer, Dock, TabStrip, StatusBar } from './ui/shell';
import { useNotifications, NotificationBell } from './ui/notifications';
import { AlertChip } from './ui/AlertChip';
import { Button, Checkbox, Stat, FieldGroup } from './ui/primitives';
import { MonteCarloTab } from './MonteCarloTab';
import { MaterialsTab } from './MaterialsTab';
import { CustomGraphTab } from './CustomGraphTab';
import { StatisticsTab } from './StatisticsTab';
import {
  useDesignHistory,
  applyNumber,
  applyEnum,
  applyArray,
  isBurnRateRegime,
  type DesignSnapshot,
} from './useDesignHistory';
import { validateDesign, errorsOnly, byField, type ValidationIssue } from './designValidation';
import { useAutosave } from './useAutosave';
import { usePersistentState, isOneOf, isStringRecord } from './usePersistentState';
// three.js is ~150 kB gzipped and only this tab needs it, so it is code-split
// rather than carried by everyone who opens the app.
const GrainBurn3D = React.lazy(() => import('./GrainBurn3D'));
import type { SurrogateGrain } from './surrogate/features';

// Unit Conversion Factors mapping to base SI units
const UNIT_FACTORS: Record<string, Record<string, number>> = {
  Length: { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 },
  Pressure: { Pa: 1, kPa: 1000, MPa: 1e6, GPa: 1e9, psi: 6894.76, bar: 1e5, atm: 101325 },
  Mass: { kg: 1, g: 0.001, lbm: 0.453592 },
  Density: { 'kg/m³': 1, 'g/cm³': 1000, 'lb/in³': 27679.9 },
  Area: { 'm²': 1, 'cm²': 0.0001, 'mm²': 1e-6, 'in²': 0.00064516 },
  Temperature: { K: 1 } // Handled separately if needs shift, but let's assume raw delta/scale for now, or just use suffix="K"
};

/**
 * Display preferences, shared with every InputBox so units convert app-wide.
 *
 * Typed rather than `any` because InputBox reads `imperialPrefs[unitCat]`
 * deep inside a render -- an `any` context meant a typo there produced
 * undefined and a silently unconverted number, not an error.
 *
 * The default is null: an InputBox rendered outside the provider falls back to
 * its own suffix, which is the existing behaviour.
 */
export interface UnitSettings {
  unitSystem: 'Metric' | 'Imperial';
  imperialPrefs: Record<string, string>;
  setUnitSystem: React.Dispatch<React.SetStateAction<'Metric' | 'Imperial'>>;
  setImperialPrefs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

export const SettingsContext = React.createContext<UnitSettings | null>(null);

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

/**
 * A labelled numeric input with unit conversion and inline validation.
 *
 * Three things were wrong with the previous version and are fixed here:
 *
 *   Props were typed `any`, so nothing checked that callers passed a real
 *   onChange or a sensible unit category.
 *
 *   The label was not associated with its input. Screen readers announced an
 *   unlabelled text box, and clicking the label did not focus the field.
 *
 *   There was nowhere to show a validation message, so problems could only be
 *   reported by an alert() at run time -- long after the value was typed, and
 *   only for the first problem found.
 */
interface InputBoxProps {
  label: string;
  value: number | string;
  onChange: (v: never) => void;
  suffix?: string;
  step?: string | number;
  type?: string;
  /** Key into UNIT_FACTORS, enabling the unit dropdown. */
  unitCat?: string | null;
  /** Validation issues for this field, rendered underneath. */
  issues?: ValidationIssue[];
}

const InputBox = ({
  label,
  value,
  onChange,
  suffix,
  step = 'any',
  type = 'number',
  unitCat = null,
  issues = [],
}: InputBoxProps) => {
  const settings = React.useContext(SettingsContext);
  const inputId = React.useId();
  const issueId = `${inputId}-issues`;

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
    const raw = e.target.value;
    if (type !== 'number') return onChange(raw as never);
    const num = parseFloat(raw);
    /*
     * An unparseable entry used to become 0, which is worse than it looks: a
     * half-typed "-" or "1e" silently set the field to zero, and zero is a
     * legal-looking radius that produces a confusing failure much later. Leave
     * the previous value alone instead and let validation speak.
     */
    if (isNaN(num)) return;

    if (unitCat && UNIT_FACTORS[unitCat] && UNIT_FACTORS[unitCat][localUnit]) {
      const factor = UNIT_FACTORS[unitCat][localUnit];
      // Input is local unit. Convert TO SI base.
      onChange((num * factor) as never);
    } else {
      onChange(num as never);
    }
  };

  const errors = issues.filter((i) => i.severity === 'error');
  const worst = errors.length ? 'error' : issues.length ? 'warning' : null;

  /*
   * Markup matches the Field primitive in src/ui/primitives.tsx rather than
   * carrying its own styles.
   *
   * InputBox predates that primitive and is used at roughly forty call sites.
   * Rewriting all of them was not worth the risk for a visual change, so
   * instead this adopts the same class names -- which is what actually makes
   * the form look uniform. New code should use Field; this stays because it
   * already handles unit conversion, which Field does not.
   */
  return (
    <div className={`ui-field ${worst ? `is-${worst}` : ''}`}>
      <label className="ui-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="ui-field-control">
        <input
          id={inputId}
          type={type}
          step={step}
          value={displayVal}
          onChange={handleChange}
          aria-invalid={errors.length > 0 || undefined}
          aria-describedby={issues.length ? issueId : undefined}
          className="ui-input ui-input-num"
        />
        <div className="ui-field-suffix">
          {unitCat && UNIT_FACTORS[unitCat] ? (
            <select
              value={localUnit}
              onChange={(e) => setLocalUnit(e.target.value)}
              aria-label={`Unit for ${label}`}
            >
              {Object.keys(UNIT_FACTORS[unitCat]).map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          ) : (
            <span>{suffix}</span>
          )}
        </div>
      </div>
      {issues.length > 0 && (
        <div id={issueId} className="ui-field-msgs">
          {issues.map((i, idx) => (
            <p
              key={idx}
              // Errors are announced immediately; warnings wait for a pause, so
              // typing a value that is briefly invalid is not read out mid-edit.
              role={i.severity === 'error' ? 'alert' : undefined}
              className={`ui-field-msg is-${i.severity}`}
            >
              {i.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * The analysis views, in tab order.
 *
 * At module scope because both the tab bar and its keyboard handler need the
 * same ordering -- a second copy inline would be a list that could silently
 * disagree with itself about which tab comes next.
 */
/*
 * Labels are short on purpose. Ten tabs with names like "Material Properties"
 * overflowed the strip once both docks were open, and a tab you have to scroll
 * to find is a tab you forget exists. The qualifier lives in the tooltip.
 */
const TAB_DEFS = [
  { id: 'ballistics', label: 'Ballistics' },
  { id: 'statistics', label: 'Statistics' },
  { id: 'extended_graphs', label: 'Custom Graph' },
  { id: 'geometry', label: 'Geometry' },
  { id: 'thermo', label: 'Thermo' },
  { id: 'materials', label: 'Materials' },
  { id: 'montecarlo', label: 'Monte Carlo' },
  { id: 'structural', label: 'Structural' },
  { id: 'surrogate', label: 'Surrogate' },
  { id: 'burn3d', label: '3-D Burn' },
] as const;

export type TabId = (typeof TAB_DEFS)[number]['id'];

/**
 * The message from a thrown value, whatever it turns out to be.
 *
 * `catch (err: any)` then reading `err.message` is a lie in two directions: a
 * thrown string has no .message, and a thrown object might have one that is not
 * a string. Neither crashes here, but both produce "undefined" in the log where
 * an explanation should be.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Unknown error';
}

export default function AppDesktop() {
  const fieldId = useFieldIds();
  /*
   * Display preferences, remembered across reloads.
   *
   * These used to reset to Metric on every load, so anyone working in inches
   * had to set it again each time they opened the app. They are stored
   * separately from the design autosave: preferences should be restored
   * silently, whereas replacing someone's design has to be their choice.
   */
  const [unitSystem, setUnitSystem] = usePersistentState<'Metric' | 'Imperial'>(
    'apro-burn-modeler:unitSystem:v1',
    'Metric',
    isOneOf(['Metric', 'Imperial'] as const)
  );
  const [imperialPrefs, setImperialPrefs] = usePersistentState<Record<string, string>>(
    'apro-burn-modeler:imperialPrefs:v1',
    DEFAULT_IMPERIAL_PREFS,
    isStringRecord
  );
  const { notify } = useNotifications();

  const [showPreferences, setShowPreferences] = useState(false);

  /*
   * Window layout, remembered across reloads.
   *
   * Dock widths and whether the console is open are exactly the kind of thing a
   * desktop application is expected to restore -- being handed back a layout you
   * did not choose, every launch, is a small insult repeated forever.
   */
  const [leftDockWidth, setLeftDockWidth] = usePersistentState<number>(
    'apro:layout:leftDock:v1', 300, (v): v is number => typeof v === 'number' && v >= 200 && v <= 560
  );
  const [rightDockWidth, setRightDockWidth] = usePersistentState<number>(
    'apro:layout:rightDock:v1', 250, (v): v is number => typeof v === 'number' && v >= 200 && v <= 560
  );
  /**
   * Which channels the main trace plots. Remembered, because a user who works
   * on pressure and mass flux should not have to re-pick them every session.
   */
  const [enabledSeries, setEnabledSeries] = usePersistentState<string[]>(
    'apro:layout:series:v1',
    ['Pc_MPa', 'Thrust_kN'],
    (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
  );

  const [leftDockOpen, setLeftDockOpen] = usePersistentState<boolean>(
    'apro:layout:leftOpen:v1', true, (v): v is boolean => typeof v === 'boolean'
  );
  const [rightDockOpen, setRightDockOpen] = usePersistentState<boolean>(
    'apro:layout:rightOpen:v1', true, (v): v is boolean => typeof v === 'boolean'
  );

  const [consoleOpen, setConsoleOpen] = usePersistentState<boolean>(
    'apro:layout:console:v1', true, (v): v is boolean => typeof v === 'boolean'
  );

  const settingsContextValue = React.useMemo(() => ({
    unitSystem,
    imperialPrefs,
    setUnitSystem,
    setImperialPrefs
  }), [unitSystem, imperialPrefs, setUnitSystem, setImperialPrefs]);

  const DEFAULT_PROPELLANTS: PropellantData[] = [
    // Burn-rate coefficient `a` is in SI (r_b = a * Pc^n with Pc in Pa, r_b in m/s),
    // matching the engine. Published St. Robert coefficients are usually quoted for
    // Pc in MPa; convert with a_SI = a_MPa / 10^(6n) before entering them here.
    { id: '1', name: 'APCP (Typical)', density: 1528, a: 8.40e-5, n: 0.3, molWeight: 0.024, kErosive: 0.001, gThreshold: 500, flameTemp: 2700, gamma: 1.18 },
    /*
     * The two sugar propellants carry Nakka's measured burn-rate law.
     *
     * a/n are the best single power law over his strand-burner measurements
     * above 1 MPa; burnRateRegimes are his five published bands. Both are
     * DERIVED from tools/data/nakka-strand-burner.json by
     * tools/emitPropellantRegimes.mts rather than typed, and validated in
     * src/burnRate.validation.test.ts.
     *
     * KNSB's previous a=6.01e-5, n=0.32 under-predicted burn rate at every
     * measured point above 0.75 MPa, worst -28.5%, mean 13.8%. That bias runs
     * the unsafe way for a pressure vessel: burn rate too slow means chamber
     * pressure predicted too LOW.
     *
     *   propellant   single law   piecewise
     *   KNSB         5.4%         1.8%
     *   KNDX         6.1%         1.2%
     */
    { id: '2', name: 'KNSB (Sorbitol)', density: 1800, a: 3.628e-4, n: 0.2117, molWeight: 0.040, kErosive: 0.0005, gThreshold: 400, flameTemp: 1600, gamma: 1.13,
      burnRateRegimes: [
        { from_pressure: 103000, to_pressure: 807000, a: 1.9045e-6, n: 0.625 },
        { from_pressure: 807000, to_pressure: 1500000, a: 6.7089e-1, n: -0.314 },
        { from_pressure: 1500000, to_pressure: 3790000, a: 9.3968e-3, n: -0.013 },
        { from_pressure: 3790000, to_pressure: 7030000, a: 2.4090e-6, n: 0.535 },
        { from_pressure: 7030000, to_pressure: 10670000, a: 3.9871e-3, n: 0.064 },
      ] },
    { id: '3', name: 'KNDX (Dextrose)', density: 1878, a: 8.377e-5, n: 0.3157, molWeight: 0.042, kErosive: 0.0006, gThreshold: 450, flameTemp: 1700, gamma: 1.14,
      burnRateRegimes: [
        { from_pressure: 103000, to_pressure: 779000, a: 1.7156e-6, n: 0.619 },
        { from_pressure: 779000, to_pressure: 2570000, a: 8.5496e-3, n: -0.009 },
        { from_pressure: 2570000, to_pressure: 5930000, a: 2.8598e-7, n: 0.688 },
        { from_pressure: 5930000, to_pressure: 8500000, a: 1.3290e-1, n: -0.148 },
        { from_pressure: 8500000, to_pressure: 11200000, a: 1.0652e-5, n: 0.442 },
      ] }
  ];

  const [propellants, setPropellants] = useState<PropellantData[]>(DEFAULT_PROPELLANTS);
  const [showPropellantEditor, setShowPropellantEditor] = useState(false);
  const [showGrainEditor, setShowGrainEditor] = useState(false);

  /*
   * Every design input, extracted into src/useMotorConfig.ts.
   *
   * Destructured back into the same identifiers this component has always used,
   * so the several hundred call sites below are untouched. The point of the move
   * is that the state is now reachable -- and testable -- without rendering the
   * whole application, which it was not while it lived here as forty-odd
   * useState calls.
   */
  const {
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
  } = useMotorConfig({
    propellantName: DEFAULT_PROPELLANTS[0].name,
    density: DEFAULT_PROPELLANTS[0].density,
    a: DEFAULT_PROPELLANTS[0].a,
    n: DEFAULT_PROPELLANTS[0].n,
    molWeight: DEFAULT_PROPELLANTS[0].molWeight,
  });

  const dxfFileInputRef = React.useRef<HTMLInputElement>(null);

  /*
   * Editing a or n by hand drops any piecewise law.
   *
   * The bands take priority over a/n inside their pressure range, so if they
   * survived the edit the user could retype the burn coefficient and watch
   * nothing change from 0.1 to 10.7 MPa. Reverting to a plain power law is the
   * honest reading of "I am setting the coefficient myself"; the log line makes
   * the trade visible, and re-applying the propellant restores the bands.
   */
  const dropRegimesOnManualEdit = () => {
    if (burnRateRegimes.length) {
      setBurnRateRegimes([]);
      addLog('Manual burn coefficient: measured piecewise law dropped, now r = a*Pc^n');
    }
  };
  const setBurnCoeffA = (v: number) => { setA(v); dropRegimesOnManualEdit(); };
  const setBurnExponentN = (v: number) => { setN(v); dropRegimesOnManualEdit(); };

  /*
   * Live validation of the current design.
   *
   * The same rules that gate the Run button, evaluated on every change so the
   * user sees a problem beside the field that caused it rather than in a modal
   * after pressing Run. Pure and tested; see src/designValidation.ts.
   */
  const validationIssues = useMemo(
    () =>
      validateDesign({
        grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius,
        numPoints, numSegments, offset, rodRadius, finDepth, finWidth,
        hasDxf: !!dxfData,
        density, a, n, throatDiameter, expansionRatio, flameTemp, gamma,
      }),
    [
      grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius,
      numPoints, numSegments, offset, rodRadius, finDepth, finWidth, dxfData,
      density, a, n, throatDiameter, expansionRatio, flameTemp, gamma,
    ]
  );
  const issuesFor = useMemo(() => byField(validationIssues), [validationIssues]);

  const blockingIssues = useMemo(() => errorsOnly(validationIssues), [validationIssues]);

  /*
   * Design snapshots for undo/redo.
   *
   * These live HIGH in the component on purpose. They used to sit several
   * hundred lines further down, below callbacks that call them, which meant a
   * correct dependency array would have referenced them before their const was
   * initialised -- a temporal-dead-zone error at render. Declared here, every
   * consumer below can depend on them honestly.
   */
  const captureDesignState = useCallback(() => ({
      density, a, n, molWeight, kErosive, gThreshold, T_ref, sigma_p, T_init,
      grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius, numPoints, numSegments, offset, rodRadius, finDepth, finWidth,
      throatDiameter, expansionRatio, gamma, flameTemp, nozzleMaterial,
      igniterMass, igniterSurfaceArea, igniterDensity, igniterA, igniterN,
      casingMaterial, casingYieldStress, casingYoungsModulus,
      /*
       * The piecewise burn law and the solver choice.
       *
       * Both were missing, which meant undo/redo silently reverted a propellant
       * to its single power law -- the design you got back was not the design
       * you had, and nothing said so. It also meant the optimizer swept with a
       * different burn law from the one the Run button uses.
       */
      burnRateRegimes, propellantName, solverModel, stationCount
  }), [
      density, a, n, molWeight, kErosive, gThreshold,
      grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius, numPoints, numSegments, offset, rodRadius, finDepth, finWidth,
      throatDiameter, expansionRatio, gamma, flameTemp, nozzleMaterial,
      igniterMass, igniterSurfaceArea, igniterDensity, igniterA, igniterN,
      casingMaterial, casingYieldStress, casingYoungsModulus,
      // Returned by this callback, so they belong here. Omitting them meant
      // undo/redo restored whatever temperature settings were current when the
      // callback was last rebuilt, rather than the ones being captured.
      T_ref, sigma_p, T_init,
      burnRateRegimes, propellantName, solverModel, stationCount
  ]);

  const applyDesignState = useCallback((config: DesignSnapshot) => {
      applyNumber(config.density, setDensity);
      applyNumber(config.a, setA);
      applyNumber(config.n, setN);
      applyNumber(config.molWeight, setMolWeight);
      applyNumber(config.kErosive, setKErosive);
      applyNumber(config.gThreshold, setGThreshold);
      applyNumber(config.T_ref, setTRef);
      applyNumber(config.sigma_p, setSigmaP);
      applyNumber(config.T_init, setTInit);
      applyEnum(config.grainType, GRAIN_TYPES, setGrainType);
      applyNumber(config.length, setLength);
      applyNumber(config.outerRadius, setOuterRadius);
      applyNumber(config.innerRadius, setInnerRadius);
      applyNumber(config.valleyRadius, setValleyRadius);
      applyNumber(config.tipRadius, setTipRadius);
      applyNumber(config.numPoints, setNumPoints);
      applyNumber(config.numSegments, setNumSegments);
      applyNumber(config.offset, setOffset);
      applyNumber(config.rodRadius, setRodRadius);
      applyNumber(config.finDepth, setFinDepth);
      applyNumber(config.finWidth, setFinWidth);
      applyNumber(config.throatDiameter, setThroatDiameter);
      applyNumber(config.expansionRatio, setExpansionRatio);
      applyNumber(config.gamma, setGamma);
      applyNumber(config.flameTemp, setFlameTemp);
      applyEnum(config.nozzleMaterial, NOZZLE_MATERIALS, setNozzleMaterial);
      applyNumber(config.igniterMass, setIgniterMass);
      applyNumber(config.igniterSurfaceArea, setIgniterSurfaceArea);
      applyNumber(config.igniterDensity, setIgniterDensity);
      applyNumber(config.igniterA, setIgniterA);
      applyNumber(config.igniterN, setIgniterN);
      applyEnum(config.casingMaterial, CASING_MATERIALS, setCasingMaterial);
      applyNumber(config.casingYieldStress, setCasingYieldStress);
      applyNumber(config.casingYoungsModulus, setCasingYoungsModulus);
      applyArray(config.burnRateRegimes, isBurnRateRegime, setBurnRateRegimes);
      if (typeof config.propellantName === 'string') setPropellantName(config.propellantName);
      applyEnum(config.solverModel, SOLVER_MODELS, setSolverModel);
      applyNumber(config.stationCount, setStationCount);
    /*
     * The setters. They come from useMotorConfig rather than a useState call in
     * this component, so ESLint cannot see that React guarantees their identity
     * is stable and asks for them by name. Listing them is truthful and costs
     * nothing at runtime -- and if one is ever replaced by a non-stable
     * function, this memo will correctly start invalidating.
     */
  }, [setBurnRateRegimes, setPropellantName, setSolverModel, setStationCount,
    setA, setCasingMaterial, setCasingYieldStress, setCasingYoungsModulus, setDensity,
    setExpansionRatio, setFinDepth, setFinWidth, setFlameTemp, setGThreshold, setGamma,
    setGrainType, setIgniterA, setIgniterDensity, setIgniterMass, setIgniterN,
    setIgniterSurfaceArea, setInnerRadius, setKErosive, setLength, setMolWeight, setN,
    setNozzleMaterial, setNumPoints, setNumSegments, setOffset, setOuterRadius, setRodRadius,
    setSigmaP, setTInit, setTRef, setThroatDiameter, setTipRadius, setValleyRadius,
  ]);

  /*
   * Keep the working design in localStorage.
   *
   * There was no persistence at all: closing the tab lost everything unless the
   * user had remembered to export. Restore is offered on load rather than
   * applied, so starting deliberately from the defaults is still possible.
   */
  const autosave = useAutosave(captureDesignState, applyDesignState, [
    density, a, n, molWeight, kErosive, gThreshold, T_ref, sigma_p, T_init,
    burnRateRegimes, propellantName,
    grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius,
    numPoints, numSegments, offset, rodRadius, finDepth, finWidth,
    throatDiameter, expansionRatio, gamma, flameTemp, nozzleMaterial,
    solverModel, stationCount,
    igniterMass, igniterSurfaceArea, igniterDensity, igniterA, igniterN,
    casingMaterial, casingYieldStress, casingYoungsModulus,
  ]);

  const designHistory = useDesignHistory(captureDesignState, applyDesignState);
  const pushHistory = designHistory.push;
  const handleUndo = designHistory.undo;
  const handleRedo = designHistory.redo;

  /*
   * ---------------------------------------------------------------------
   * Things worth telling the user about
   * ---------------------------------------------------------------------
   *
   * Each of these used to interrupt: the recovery offer was a banner parked
   * across the top of the chart, and validation failures were alert() calls
   * that froze the application one problem at a time. As notifications they
   * announce themselves and then get out of the way, while the centre keeps
   * the record for anyone who was looking elsewhere.
   */

  // A design left over from a previous session. This one asks a question, so
  // it carries actions and therefore never auto-dismisses.
  const recoveryOffered = useRef(false);
  useEffect(() => {
    if (!autosave.recovered || recoveryOffered.current) return;
    recoveryOffered.current = true;
    const when = new Date(autosave.recovered.savedAt).toLocaleString();
    notify({
      title: 'Unsaved design found',
      body: `Last edited ${when}. Restoring replaces what is currently in the editor.`,
      severity: 'info',
      actions: [
        {
          label: 'Restore',
          primary: true,
          onClick: () => {
            autosave.acceptRecovery();
            addLog('Restored the autosaved design.');
          },
        },
        { label: 'Discard', onClick: autosave.dismissRecovery },
      ],
    });
  }, [autosave, notify]);




  const handleCasingChange = (val: string) => {
    setCasingMaterial(val as CasingMaterialName);
    if (val !== 'Custom') {
      const data = CASING_ALLOYS[val as keyof typeof CASING_ALLOYS];
      setCasingYieldStress(data.y);
      setCasingYoungsModulus(data.m);
    }
  };

  // UI Modal States
  const [showUnitConverter, setShowUnitConverter] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const configFileInputRef = React.useRef<HTMLInputElement>(null);

  // Custom Graph State

  // Results & State
  const [results, setResults] = useState<SimulationResult[]>([]);
  /** Axial station profiles from the last run. Undefined after a 0-D run. */
  const [stations, setStations] = useState<StationProfiles | undefined>(undefined);
  const [stabilityWarnings, setStabilityWarnings] = useState<string[]>([]);

  /*
   * Solver stability warnings, raised once per distinct set.
   *
   * Keyed on the joined text so a re-run producing the same warnings does not
   * announce them again -- these come back on every run of a marginal design,
   * and repeating them would train the user to ignore the corner they appear in.
   */
  const lastWarnings = useRef('');
  useEffect(() => {
    const key = stabilityWarnings.join('|');
    if (!key || key === lastWarnings.current) return;
    lastWarnings.current = key;
    notify({
      title: `Solver stability: ${stabilityWarnings.length} warning${stabilityWarnings.length > 1 ? 's' : ''}`,
      body: stabilityWarnings[0],
      severity: 'warning',
      dedupe: 'stability',
    });
  }, [stabilityWarnings, notify]);
  /**
   * Summary numbers every tab reads.
   *
   * This was `any`, which is how a removed field could disappear from the core
   * and leave the UI rendering `undefined` with tsc still green -- exactly what
   * happened when calculate_discontinuity_stress went away. Typed now, so the
   * compiler is the thing that notices.
   */
  const [metrics, setMetrics] = useState<MotorMetrics | null>(null);

  /**
   * How much of the peak burn rate came from erosive burning, recovered from
   * the trace the solver just produced.
   *
   * Lets the uncertainty panel scale the (uncalibrated) erosive model's
   * contribution to how much erosion THIS motor actually has. Without it the
   * panel applied a blanket figure and reported +-75% on peak pressure for a
   * motor whose erosion was a couple of percent, which teaches users to ignore
   * the number.
   *
   * Derived from dy/dt against the pressure-only law rather than by recomputing
   * the erosive correlation, so nothing about that correlation is duplicated
   * here. src/burnLaw.parity.test.ts pins the law against the Rust core.
   */
  const erosiveFraction = useMemo(() => {
    if (!results.length) return undefined;
    return peakErosiveFraction(
      results.map((r) => ({ time: r.Time, web: r.y, pc: r.Pc })),
      a,
      n,
      burnRateRegimes,
      1 + sigma_p * (T_init - T_ref)
    );
  }, [results, a, n, burnRateRegimes, sigma_p, T_init, T_ref]);

  /**
   * The live error budget, computed for whatever is currently configured.
   *
   * Shown in the right dock and the status strip rather than only inside the
   * statistics tab, because uncertainty that you have to go looking for does
   * not inform the design decision you are making right now.
   */
  const uncertaintyBudget = useMemo(
    () =>
      modelUncertainty({
        grainKind: grainType,
        n,
        hasBurnRateRegimes: burnRateRegimes.length > 0,
        propellantName,
        erosiveModel,
        hasNozzleMaterial: !!nozzleMaterial,
        erosiveFraction,
      }),
    [grainType, n, burnRateRegimes, propellantName, erosiveModel, nozzleMaterial, erosiveFraction]
  );
  const peakPcBand = useMemo(
    () => uncertaintyBudget.find((u) => u.output === 'peak_pressure'),
    [uncertaintyBudget]
  );
  const impulseBand = useMemo(
    () => uncertaintyBudget.find((u) => u.output === 'total_impulse'),
    [uncertaintyBudget]
  );
  const burnTimeBand = useMemo(
    () => uncertaintyBudget.find((u) => u.output === 'burn_time'),
    [uncertaintyBudget]
  );

  /**
   * NAR/TRA-style impulse class letter, plus volume loading.
   *
   * Each class is double the previous, starting at 2.5 N*s for an A, so the
   * letter is log2 of the ratio. Clamped at Z rather than running off the end
   * of the alphabet for an absurd design.
   */
  const motorDesignation = useMemo(() => {
    if (!metrics || !(metrics.totalImpulse > 0)) return String.fromCharCode(63);
    const letter = String.fromCharCode(
      65 + Math.max(0, Math.min(25, Math.floor(Math.log2(metrics.totalImpulse / 2.5))))
    );
    return letter + " (" + (metrics.volumeLoading * 100).toFixed(0) + "%)";
  }, [metrics]);
  const [visualizerIndex, setVisualizerIndex] = useState<number>(0);
  const [statusMsg, setStatusMsg] = useState<string>('System Ready');
  // TabId is derived from TAB_DEFS, so the tab bar and this state cannot
  // disagree about which views exist.
  const [activeTab, setActiveTab] = useState<TabId>('ballistics');

  // Monte Carlo State
  const [mcRuns, setMcRuns] = useState<number>(50);
  const [mcVariance, setMcVariance] = useState<number>(5);
  /**
   * Spatial model for the Monte Carlo sweep, chosen separately from the main
   * Run button.
   *
   * It was hardcoded to 0-D, which is a defensible default -- hundreds of
   * solves at a few hundred stations each is slow -- but it left no way to ask
   * "does my dispersion look different with axial resolution?", which is
   * exactly the question a sweep exists to answer for a long grain where
   * erosive burning matters. Still defaults to 0-D.
   */
  const [mcSolverModel, setMcSolverModel] = useState<SolverModelType>('0D');
  const [mcResults, setMcResults] = useState<Array<{ run: number; maxPc: number; maxThrust: number }>>([]);

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
      // Empty array is the same as absent: the core falls back to a/n.
      ...(burnRateRegimes.length ? { burn_rate_regimes: burnRateRegimes } : {}),
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

    /*
     * One gate, shared with the inline field errors.
     *
     * This used to be nine separate checks, each ending in an alert() and a
     * return -- so the user was told about one problem at a time, by a modal,
     * only after pressing Run. Now the same rules have already been shown
     * beside the offending fields, and this just refuses to start.
     */
    if (blockingIssues.length > 0) {
      addLog(`Cannot run: ${blockingIssues.length} problem${blockingIssues.length > 1 ? 's' : ''} with the design.`);
      for (const issue of blockingIssues) addLog(`  - ${issue.message}`);
      setStatusMsg('Fix the highlighted inputs before running.');
      notify({
        title: `Cannot run: ${blockingIssues.length} problem${blockingIssues.length > 1 ? 's' : ''}`,
        // The first is enough for a toast; the console has them all, and the
        // offending fields are already marked.
        body: blockingIssues[0].message,
        severity: 'error',
        dedupe: 'validation',
      });
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
          notify({
            title: 'Simulation complete',
            body: `${(maxThrust / 1000).toFixed(2)} kN peak, ${actionTime.toFixed(3)} s burn, ${(maxPc / 1e6).toFixed(2)} MPa peak pressure.`,
            severity: 'success',
            dedupe: 'sim',
          });
        } else {
          addLog('Simulation failed or produced no results.');
          notify({
            title: 'Simulation produced no results',
            body: 'The solver returned an empty trace. Check the geometry and propellant.',
            severity: 'error',
            dedupe: 'sim',
          });
        }
      } catch (err: unknown) {
        addLog(`Simulation error: ${errorMessage(err)}`);
        notify({ title: 'Simulation failed', body: errorMessage(err), severity: 'error', dedupe: 'sim' });
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
          let cx = 0;
          const cy = 0;
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
      } catch (err: unknown) {
        addLog(`STL Generation error: ${errorMessage(err)}`);
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

    } catch (err: unknown) {
      addLog(`Generation error: ${errorMessage(err)}`);
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
    } catch (err: unknown) {
      addLog(`SCAD Generation error: ${errorMessage(err)}`);
    }
  };

  const runMonteCarlo = async () => {
    // Always 0-D, whatever the toggle says. A quasi-1-D run costs roughly
    // `stationCount` times more per step, so a 50-run sweep would take minutes
    // instead of seconds -- and a dispersion study wants many samples of the
    // same model far more than it wants axial detail in each one.
    addLog(
      `Starting Monte Carlo analysis (${mcRuns} runs, ${mcVariance}% variance, ` +
        `${mcSolverModel === 'quasi1D' ? `quasi-1-D with ${stationCount} stations` : '0-D'} solver)...`
    );
    setIsSimulating(true);
    setMcResults([]);

    const runs: Array<{ run: number; maxPc: number; maxThrust: number }> = [];

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
            model: mcSolverModel,
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

  /** Edge-bending profile along the case, reshaped for charting. */

  /**
   * The current design in the surrogate's own parameter set. Memoised so the
   * panel's prediction effect only re-fires when a value the model actually
   * consumes changes, not on every unrelated render.
   */
  /**
   * The grain alone, for the 3-D view. Built through the same
   * grainConfigFromUi the solver and the surrogate use, so the shape on screen
   * is the shape being simulated rather than a second interpretation of the
   * same inputs.
   */
  const burn3dGrain = useMemo(
    () => grainConfigFromUi(grainUiParams(), dxfData) as SurrogateGrain,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius,
      numPoints, rodRadius, offset, finWidth, finDepth, dxfData,
    ]
  );

  const surrogateDesign = useMemo(
    () => ({
      // The surrogate takes the grain itself, not a flat parameter list: it
      // predicts from the burn-back curves, so every geometry goes through the
      // same path and grainConfigFromUi is the one place that mapping lives.
      grain: grainConfigFromUi(grainUiParams(), dxfData) as SurrogateGrain,
      throat_diameter: throatDiameter,
      expansion_ratio: expansionRatio,
      a,
      n,
      density,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      grainType, length, outerRadius, innerRadius, valleyRadius, tipRadius, numPoints,
      rodRadius, offset, finWidth, finDepth, dxfData,
      throatDiameter, expansionRatio, a, n, density,
    ]
  );

  /**
   * Push a design found by inverse search back into the main inputs.
   *
   * The search returns a grain of whatever geometry was active, so this unpacks
   * each kind into the editor fields it corresponds to. Note that several kinds
   * share `innerRadius` for different physical things -- the tube bore, the
   * MoonBurner core, the Finocyl bore -- which is the editor's existing
   * convention, mirrored by grainConfigFromUi in the other direction.
   */
  const applySurrogateDesign = useCallback((d: { grain: SurrogateGrain; throat_diameter: number; expansion_ratio: number }) => {
    pushHistory();
    const g = d.grain;
    setLength(g.length);
    setOuterRadius(g.outer_radius);
    switch (g.kind) {
      case 'BATES':
      case 'Tubular':
        setInnerRadius(g.inner_radius);
        break;
      case 'Star':
        setValleyRadius(g.valley_radius);
        setTipRadius(g.tip_radius);
        setNumPoints(g.num_points);
        break;
      case 'RodAndTube':
        setRodRadius(g.rod_radius);
        setInnerRadius(g.tube_inner_radius);
        break;
      case 'MoonBurner':
        setInnerRadius(g.core_radius);
        setOffset(g.offset);
        break;
      case 'Finocyl':
        setInnerRadius(g.r_tube);
        setNumPoints(g.num_fins);
        setFinWidth(g.w_fin);
        setFinDepth(g.h_fin);
        break;
      case 'CustomDXF':
        // The traced profile is the user's file; only the scale changes.
        break;
    }
    setThroatDiameter(d.throat_diameter);
    setExpansionRatio(d.expansion_ratio);
    // pushHistory is now declared above this callback (it moved into
    // useDesignHistory), so depending on it here is finally possible -- it used
    // to be a temporal-dead-zone error. Setters are listed for the reason given
    // on applyDesignState above.
  }, [pushHistory, setExpansionRatio, setFinDepth, setFinWidth, setInnerRadius, setLength,
    setNumPoints, setOffset, setOuterRadius, setRodRadius, setThroatDiameter, setTipRadius,
    setValleyRadius,
  ]);

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
  }, [results, throatDiameter, outerRadius, innerRadius, valleyRadius, length, numSegments, grainType, density, expansionRatio, rodRadius,
      // Fin geometry and the traced profile feed the same grain the rows are
      // computed from; without them the table did not refresh when they changed.
      finDepth, finWidth, numPoints, dxfData]);

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
    input.onchange = (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
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
            } catch {
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
  const burnsimFileInputRef = useRef<HTMLInputElement>(null);



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
        } catch {
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
            } catch (err: unknown) {
                addLog(`Failed to load DXF: ${errorMessage(err)}`);
                alert(`Error reading DXF: ${errorMessage(err)}`);
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
        } catch {
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

  const unitRates: Record<string, Record<string, number>> = {
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
      <div className="app-root">
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
            // Always assign, so switching to a single-law propellant clears the
            // previous one's bands rather than leaving them applied.
            setBurnRateRegimes(p.burnRateRegimes ?? []);
            setPropellantName(p.name);
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
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--scrim)]">
          <div className="bg-[var(--s-canvas)] border border-[var(--b-strong)] shadow-2xl rounded w-96 flex flex-col font-mono text-[var(--t-primary)]">
            <div className="bg-[var(--s-sunken)] px-3 py-1.5 border-b border-[var(--b-strong)] flex justify-between items-center font-bold text-xs text-[var(--sem-warn)]">
              <div className="flex items-center"><Settings size={14} className="mr-1" /> Preferences</div>
              <button onClick={() => setShowPreferences(false)} className="hover:text-red-500">✕</button>
            </div>
            <div className="p-4 space-y-4 text-xs">
              {/*
                * A fieldset with a legend, not a label above two loose radios.
                *
                * "Unit System" names a GROUP, and a <label> cannot name a group
                * -- screen readers announced it as a label with nothing to
                * label. The radios were also missing a shared `name`, so the
                * browser never treated them as one group and arrow keys did not
                * move between them; they only happened to behave exclusively
                * because the click handlers set the same state.
                */}
              <fieldset className="border border-[var(--b-strong)] rounded p-3">
                <legend className="mb-2 font-bold text-[var(--t-secondary)] uppercase px-1">Unit System</legend>
                <div className="flex space-x-4 mb-3">
                  <label className="flex items-center space-x-1 cursor-pointer">
                    <input type="radio" name="unit-system" value="Metric" checked={unitSystem === 'Metric'} onChange={() => setUnitSystem('Metric')} className="accent-blue-500" />
                    <span>Metric</span>
                  </label>
                  <label className="flex items-center space-x-1 cursor-pointer">
                    <input type="radio" name="unit-system" value="Imperial" checked={unitSystem === 'Imperial'} onChange={() => setUnitSystem('Imperial')} className="accent-blue-500" />
                    <span>Imperial</span>
                  </label>
                </div>
                
                {unitSystem === 'Imperial' && (
                  <div className="space-y-2 mt-4 text-[var(--t-primary)]">
                    <div className="text-[10px] text-[var(--t-secondary)] mb-1">Preferred Imperial Units</div>
                    {Object.keys(IMPERIAL_OPTIONS).map(cat => (
                      <div key={cat} className="flex justify-between items-center">
                        <span>{cat}</span>
                        <select 
                          value={imperialPrefs[cat]} 
                          onChange={e => setImperialPrefs({...imperialPrefs, [cat]: e.target.value})}
                          className="bg-[var(--s-sunken)] border border-[var(--b-strong)] rounded px-2 py-0.5 outline-none focus:border-blue-500"
                        >
                          {IMPERIAL_OPTIONS[cat].map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </fieldset>
            </div>
          </div>
        </div>
      )}

      {showUnitConverter && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--scrim)]">
          <div className="bg-[var(--s-canvas)] border border-[var(--b-strong)] shadow-2xl rounded w-80 flex flex-col font-mono text-[var(--t-primary)]">
            <div className="bg-[var(--s-sunken)] px-3 py-1.5 border-b border-[var(--b-strong)] flex justify-between items-center font-bold text-xs text-[var(--a-accent)]">
              <div className="flex items-center"><Calculator size={14} className="mr-1" /> Unit Converter</div>
              <button onClick={() => setShowUnitConverter(false)} className="hover:text-red-500">✕</button>
            </div>
            <div className="p-4 space-y-4 text-xs">
              <div>
                <label className="block mb-1 font-bold text-[var(--t-secondary)]" htmlFor={fieldId('measurement-type')}>Measurement Type</label>
                <select id={fieldId('measurement-type')} value={ucMode} onChange={e => {
                  const m = e.target.value as 'Length' | 'Pressure' | 'Mass' | 'Temp';
                  setUcMode(m);
                  if(m === 'Length') { setUcUnit1('in'); setUcUnit2('mm'); }
                  if(m === 'Pressure') { setUcUnit1('psi'); setUcUnit2('MPa'); }
                  if(m === 'Mass') { setUcUnit1('lbm'); setUcUnit2('kg'); }
                  if(m === 'Temp') { setUcUnit1('F'); setUcUnit2('C'); }
                }} className="w-full bg-[var(--s-sunken)] border border-[var(--b-strong)] text-[var(--t-primary)] rounded px-2 py-1 outline-none focus:border-[var(--a-accent)]">
                  <option value="Length">Length</option>
                  <option value="Pressure">Pressure</option>
                  <option value="Mass">Mass</option>
                  <option value="Temp">Temperature</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <input type="number" step="any" value={ucVal1} onChange={e => setUcVal1(e.target.value)} className="w-full bg-[var(--s-canvas)] border border-[var(--b-strong)] text-[var(--sem-ok)] rounded px-2 py-1 mb-1 font-mono text-right outline-none focus:border-[var(--a-accent)]" />
                  <select value={ucUnit1} onChange={e => setUcUnit1(e.target.value)} className="w-full bg-[var(--s-sunken)] border border-[var(--b-strong)] text-[var(--t-primary)] rounded px-2 py-1 outline-none focus:border-[var(--a-accent)]">
                    {ucMode === 'Length' && ['m','cm','mm','in','ft'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Pressure' && ['Pa','kPa','MPa','psi','bar','atm'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Mass' && ['kg','g','lbm'].map(u => <option key={u} value={u}>{u}</option>)}
                    {ucMode === 'Temp' && ['K','C','F','R'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <input type="text" readOnly value={getUcConvertedMode()} className="w-full bg-[var(--s-canvas)] border border-[var(--b-strong)] text-[var(--a-accent)] rounded px-2 py-1 mb-1 font-mono text-right font-bold outline-none" />
                  <select value={ucUnit2} onChange={e => setUcUnit2(e.target.value)} className="w-full bg-[var(--s-sunken)] border border-[var(--b-strong)] text-[var(--t-primary)] rounded px-2 py-1 outline-none focus:border-[var(--a-accent)]">
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

      {/*
        * Menu bar, then a slim toolbar of the few actions worth a permanent
        * button.
        *
        * The previous UI put all twelve actions in one horizontal strip, which
        * meant the two anyone actually presses -- Run and Optimize -- sat in a
        * queue behind Save Config and Export CSV. Desktop tools put the long
        * tail in menus and keep the toolbar for what you reach for repeatedly.
        */}
      <MenuBar
        menus={[
          {
            label: 'File',
            items: [
              { label: 'Save Configuration…', accel: 'Ctrl+S', onSelect: handleSaveConfig },
              { label: 'Load Configuration…', accel: 'Ctrl+O', onSelect: () => configFileInputRef.current?.click() },
              { label: 'Save BurnSim (.bsd)…', separatorBefore: true, onSelect: handleSaveBurnsim },
              { label: 'Load BurnSim (.bsd)…', onSelect: () => burnsimFileInputRef.current?.click() },
              { label: 'Export Engine File (.eng)…', separatorBefore: true, onSelect: handleExportENG },
              { label: 'Export Data (.csv)…', onSelect: handleExportCSV },
            ],
          },
          {
            label: 'Edit',
            items: [
              { label: 'Undo', accel: 'Ctrl+Z', onSelect: handleUndo, disabled: !designHistory.canUndo },
              { label: 'Redo', accel: 'Ctrl+Y', onSelect: handleRedo, disabled: !designHistory.canRedo },
              { label: 'Preferences…', separatorBefore: true, onSelect: () => setShowPreferences(true) },
            ],
          },
          {
            label: 'Simulate',
            items: [
              { label: 'Run Simulation', accel: 'Ctrl+R', onSelect: runSimulation, disabled: isSimulating },
              { label: 'Parameter Sweep…', separatorBefore: true, onSelect: () => setShowOptimizer(true) },
              { label: 'Monte Carlo', onSelect: () => setActiveTab('montecarlo') },
            ],
          },
          {
            label: 'Design',
            items: [
              { label: 'Grain Editor…', onSelect: () => setShowGrainEditor(true) },
              { label: 'Propellant Library…', onSelect: () => setShowPropellantEditor(true) },
              { label: 'Unit Converter…', separatorBefore: true, onSelect: () => setShowUnitConverter(true) },
            ],
          },
          {
            label: 'Analyze',
            items: [
              { label: 'Model Uncertainty', onSelect: () => setActiveTab('statistics') },
              { label: 'Structural Analysis', onSelect: () => setActiveTab('structural') },
              { label: 'Surrogate (fast)', onSelect: () => setActiveTab('surrogate') },
              { label: '3-D Burn-back', separatorBefore: true, onSelect: () => setActiveTab('burn3d') },
            ],
          },
        ]}
      />

      <Toolbar>
        <input type="file" accept=".bsd,.bsx,.xml" className="hidden" ref={burnsimFileInputRef} onChange={handleLoadBurnsim} />
        <Button
          variant="primary"
          icon={<Play size={12} />}
          onClick={runSimulation}
          disabled={isSimulating || blockingIssues.length > 0}
          title={blockingIssues.length ? `${blockingIssues.length} problem(s) must be fixed first` : 'Run the full simulation (Ctrl+R)'}
        >
          {isSimulating ? 'Running…' : 'Run'}
        </Button>
        <Button icon={<Zap size={12} />} onClick={() => setShowOptimizer(true)} disabled={isSimulating}>
          Sweep
        </Button>
        <ToolbarSep />
        <Button variant="ghost" icon={<Undo size={12} />} onClick={handleUndo} disabled={!designHistory.canUndo} title="Undo" aria-label="Undo" />
        <Button variant="ghost" icon={<Redo size={12} />} onClick={handleRedo} disabled={!designHistory.canRedo} title="Redo" aria-label="Redo" />
        <ToolbarSep />
        <Button variant="ghost" icon={<Settings size={12} />} onClick={() => setShowPropellantEditor(true)}>
          Propellant
        </Button>
        <Button variant="ghost" icon={<Calculator size={12} />} onClick={() => setShowGrainEditor(true)}>
          Grain
        </Button>

        <ToolbarSpacer />

        {/*
          * Blocking problems get a permanent home in the toolbar rather than
          * only appearing beside their field. With forty inputs across
          * collapsible groups, the offending one can easily be scrolled out of
          * sight, and "Run does nothing" is a miserable thing to debug.
          */}
        {/*
          * Two compact chips rather than banners.
          *
          * Both conditions used to take a full-width stripe: validation as a
          * blocking alert, stability as a panel that pushed the chart down on
          * every run of a marginal design. Neither earns that space -- they are
          * a line of text you read once.
          *
          * The toast announces them; these persist for as long as the condition
          * holds, because a faded toast is not a record and the console scrolls
          * away. Hover for the text, click for the list.
          */}
        <AlertChip
          severity="error"
          noun="problem"
          title="Design problems blocking the run"
          items={blockingIssues.map((i) => i.message)}
          footer="Each is also marked on the field that caused it."
        />
        <AlertChip
          severity="warning"
          noun="warning"
          title="Solver stability warnings"
          items={stabilityWarnings}
          footer="Raised by the solver during the last run."
        />
        <NotificationBell />
        <span className="sh-toolbar-note">
          {autosave.unavailable
            ? 'Autosave off'
            : autosave.lastSavedAt
              ? `Saved ${new Date(autosave.lastSavedAt).toLocaleTimeString()}`
              : 'Autosave pending'}
        </span>
      </Toolbar>

      {/* Main Window Area */}
      <div className="sh-body">
        <Dock
          side="left"
          width={leftDockWidth}
          onWidthChange={setLeftDockWidth}
          label="Motor Parameters"
          railLabel="Parameters"
          open={leftDockOpen}
          onOpenChange={setLeftDockOpen}
        >
          <div className="sh-dock-scroll">
            
            {/* QGroupBox: Propellant Data */}
            <div className="ui-groupbox">
              <div className="ui-groupbox-title">
                <span>Propellant Data</span>
                <button onClick={() => setShowPropellantEditor(true)} className="ui-link">(library)</button>
              </div>
              <div className="ui-fields">
                <InputBox label="Density" value={density} onChange={setDensity} suffix="kg/m³" unitCat="Density" issues={issuesFor.get('density')} />
                <InputBox label="Burn Coeff (a)" value={a} onChange={setBurnCoeffA} suffix="" issues={issuesFor.get('a')} />
                <InputBox label="Pressure Exp (n)" value={n} onChange={setBurnExponentN} suffix="" issues={issuesFor.get('n')} />
                {burnRateRegimes.length > 0 && (
                  <div className="ui-note is-accent">
                    Measured {burnRateRegimes.length}-band burn law active
                    ({(burnRateRegimes[0].from_pressure / 1e6).toFixed(2)}–
                    {(burnRateRegimes[burnRateRegimes.length - 1].to_pressure / 1e6).toFixed(2)} MPa).
                    a/n above apply only outside that range; editing either drops the bands.
                  </div>
                )}
                <InputBox label="Mol Wt" value={molWeight} onChange={setMolWeight} suffix="kg/mol" />
                <InputBox label="T_ref" value={T_ref} onChange={setTRef} suffix="K" unitCat="Temperature" />
                <InputBox label="σ_p" value={sigma_p} onChange={setSigmaP} suffix="1/K" />
                <div className="ui-row" style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--b-soft)" }}>
                  <span className="ui-row-label">Erosive Burning Model</span>
                  <select value={erosiveModel} onChange={e => setErosiveModel(e.target.value as 'None' | 'Lenoir-Robillard' | 'JPL')} className="ui-input ui-select">
                    <option value="None">None</option>
                    <option value="Lenoir-Robillard">Lenoir-Robillard</option>
                    <option value="JPL">JPL Linear</option>
                  </select>
                </div>
              </div>
            </div>

            {/* QGroupBox: Solver Model */}
            <div className="ui-groupbox">
              <div className="ui-groupbox-title">
                Solver Model
              </div>
              <div className="ui-fields">
                <div className="ui-row">
                  <span className="ui-row-label">Spatial Model</span>
                  <select
                    value={solverModel}
                    onChange={e => setSolverModel(e.target.value as SolverModelType)}
                    className="ui-input ui-select"
                  >
                    <option value="0D">0-D lumped chamber (fast)</option>
                    <option value="quasi1D">Quasi-1-D axial port</option>
                  </select>
                </div>
                {solverModel === 'quasi1D' && (
                  <InputBox label="Axial Stations" value={stationCount} onChange={setStationCount} suffix="" />
                )}
                <div className="ui-note is-divided">
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
            <div className="ui-groupbox">
              <div className="ui-groupbox-title">
                <span>Grain Geometry</span>
                <button onClick={() => setShowGrainEditor(true)} className="ui-link">(preview / edit)</button>
              </div>
              <div className="ui-fields">
                <label className="ui-field-label" htmlFor={fieldId('type')}>Type</label>
                <select id={fieldId('type')} value={grainType} onChange={e => setGrainType(e.target.value as GrainType)} className="ui-input ui-select">
                  <option value="BATES">BATES</option>
                  <option value="Tubular">Tubular</option>
                  <option value="Star">Star</option>
                  <option value="RodAndTube">Rod and Tube</option>
                  <option value="MoonBurner">MoonBurner</option>
                  <option value="Finocyl">Finocyl</option>
                  <option value="CustomDXF">Custom DXF Profile</option>
                </select>
                
                <InputBox label="Length" value={length} onChange={setLength} suffix="mm" unitCat="Length" issues={issuesFor.get('length')} />
                <InputBox label="Outer Rad" value={outerRadius} onChange={setOuterRadius} suffix="mm" unitCat="Length" issues={issuesFor.get('outerRadius')} />
                
                {grainType === 'CustomDXF' && (
                  <div className="ui-block is-divided">
                    {/*
                      * A heading, not a label: the real control here is the
                      * button below, since the file input itself is hidden and
                      * only ever opened through it. Marking this a <label> made
                      * screen readers look for a form field it named.
                      */}
                    <p className="ui-note" id="dxf-upload-heading">Upload DXF Cross Section</p>
                    <div className="flex items-center space-x-2">
                       <input type="file" accept=".dxf" className="hidden" ref={dxfFileInputRef} onChange={handleDXFUpload} />
                       <button type="button" aria-describedby="dxf-upload-heading" onClick={() => dxfFileInputRef.current?.click()} className="ui-btn" style={{ flex: 1 }}>
                         <Upload size={14} className="mr-1" /> Load .DXF
                       </button>
                       <span className="text-[10px] text-[var(--t-muted)] truncate max-w-[100px]">{dxfFilename || 'No file'}</span>
                    </div>
                  </div>
                )}
                
                {grainType === 'Star' && (
                  <>
                    <InputBox label="Valley Rad" value={valleyRadius} onChange={setValleyRadius} suffix="mm" unitCat="Length" issues={issuesFor.get('valleyRadius')} />
                    <InputBox label="Tip Rad" value={tipRadius} onChange={setTipRadius} suffix="mm" unitCat="Length" issues={issuesFor.get('tipRadius')} />
                    <InputBox label="Points" value={numPoints} onChange={setNumPoints} suffix="" issues={issuesFor.get('numPoints')} />
                  </>
                )}
                {(grainType === 'BATES' || grainType === 'Tubular' || grainType === 'RodAndTube' || grainType === 'MoonBurner' || grainType === 'Finocyl') && (
                  <InputBox label={grainType === 'RodAndTube' ? "Tube Inner Rad" : grainType === 'MoonBurner' ? "Core Radius" : grainType === 'Finocyl' ? "Core Radius" : "Inner Rad"} value={innerRadius} onChange={setInnerRadius} suffix="mm" unitCat="Length" issues={issuesFor.get('innerRadius')} />
                )}
                {grainType === 'BATES' && (
                  <InputBox label="Segments" value={numSegments} onChange={setNumSegments} suffix="" issues={issuesFor.get('numSegments')} />
                )}
                {grainType === 'RodAndTube' && (
                  <InputBox label="Rod Radius" value={rodRadius} onChange={setRodRadius} suffix="mm" unitCat="Length" issues={issuesFor.get('rodRadius')} />
                )}
                {grainType === 'MoonBurner' && (
                  <InputBox label="Offset" value={offset} onChange={setOffset} suffix="mm" unitCat="Length" issues={issuesFor.get('offset')} />
                )}
                {grainType === 'Finocyl' && (
                  <>
                    <InputBox label="Fin Depth" value={finDepth} onChange={setFinDepth} suffix="mm" unitCat="Length" issues={issuesFor.get('finDepth')} />
                    <InputBox label="Fin Width" value={finWidth} onChange={setFinWidth} suffix="mm" unitCat="Length" issues={issuesFor.get('finWidth')} />
                    <InputBox label="Fins" value={numPoints} onChange={setNumPoints} suffix="" issues={issuesFor.get('numPoints')} />
                  </>
                )}
                
                <div className="ui-block is-divided">
                  <button onClick={handleExportSTL} disabled={isSimulating} className="ui-btn">
                    <Download className="w-3.5 h-3.5" />
                    <span>Export 3D Solid Grain (.stl)</span>
                  </button>
                </div>
              </div>
            </div>

            {/* QGroupBox: Nozzle & Thermo */}
            <div className="ui-groupbox">
              <span className="ui-groupbox-title">Nozzle & Thermo</span>
              <div className="ui-fields">
                <InputBox label="Throat Diam" value={throatDiameter} onChange={setThroatDiameter} suffix="mm" unitCat="Length" issues={issuesFor.get('throatDiameter')} />
                <InputBox label="Exp Ratio" value={expansionRatio} onChange={setExpansionRatio} suffix="" issues={issuesFor.get('expansionRatio')} />
                <InputBox label="Gamma (γ)" value={gamma} onChange={setGamma} suffix="" issues={issuesFor.get('gamma')} />
                <InputBox label="Flame Temp" value={flameTemp} onChange={setFlameTemp} suffix="K" unitCat="Temperature" issues={issuesFor.get('flameTemp')} />
                <InputBox label="Init Temp" value={T_init} onChange={setTInit} suffix="K" unitCat="Temperature" />
                
                <InputBox label="C* Efficiency" value={cStarEff} onChange={setCStarEff} step={0.01} suffix="" />
                <InputBox label="Cf Efficiency" value={cfEff} onChange={setCfEff} step={0.01} suffix="" />

                <label className="ui-field-label" htmlFor={fieldId('material')}>Material</label>
                <select id={fieldId('material')} value={nozzleMaterial} onChange={e => setNozzleMaterial(e.target.value as NozzleMaterialName)} className="ui-input ui-select">
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
            <div className="ui-groupbox">
              <span className="ui-groupbox-title">Igniter & Casing</span>
              <div className="ui-fields">
                <InputBox label="Igniter Mass" value={igniterMass} onChange={setIgniterMass} suffix="kg" unitCat="Mass" />
                <InputBox label="Igniter Area" value={igniterSurfaceArea} onChange={setIgniterSurfaceArea} suffix="m²" unitCat="Area" />
                
                <label className="ui-field-label" htmlFor={fieldId('casing-alloy')}>Casing Alloy</label>
                <select id={fieldId('casing-alloy')} value={casingMaterial} onChange={e => handleCasingChange(e.target.value)} className="ui-input ui-select">
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
                  <div className="ui-note">
                    Thin-wall pR/t sizing at SF 1.5 asks for {(metrics.requiredThickness * 1000).toFixed(2)} mm.
                    That rule ignores the closure junction, so check the Structural tab before trusting it.
                  </div>
                )}

                <div className="ui-subhead">Bolted Closure</div>
                <InputBox label="Num Bolts" value={numBolts} onChange={setNumBolts} suffix="" />
                <InputBox label="Bolt Diam" value={boltDiameter} onChange={setBoltDiameter} suffix="mm" unitCat="Length" />
                <InputBox label="Bolt Yield" value={boltYieldStress * 1e6} onChange={(v: number) => setBoltYieldStress(v/1e6)} suffix="MPa" unitCat="Pressure" />
                <InputBox label="Edge Dist" value={caseBoltEdgeDistance} onChange={setCaseBoltEdgeDistance} suffix="mm" unitCat="Length" />
                
                <div className="ui-block is-divided">
                  <button onClick={handleExportCasingSTL} disabled={isSimulating} className="ui-btn" title="High-fidelity manufacturing STL">
                    <Download className="w-3.5 h-3.5" />
                    <span>Export Additive Assembly (.stl)</span>
                  </button>
                  <button onClick={handleExportCasingSCAD} disabled={isSimulating} className="ui-btn" title="Use FreeCAD/OpenSCAD to convert this into STEP or Parasolid.">
                    <Download className="w-3.5 h-3.5" />
                    <span>Export CAD Source (.scad)</span>
                  </button>
                </div>
              </div>
            </div>

            {/* QGroupBox: Results Summary */}
            {metrics && (
              <div className="ui-groupbox is-result">
                <span className="absolute -top-2.5 left-2 bg-[var(--s-panel)] px-1 text-[10px] font-bold text-[var(--a-accent)] uppercase">Results Summary</span>
                <div className="ui-fields">
                  <div className="ui-kv-key">Max Thrust:</div><div className="ui-kv-val">{(metrics.maxThrust/1000).toFixed(2)} kN</div>
                  <div className="ui-kv-key">Max Press:</div><div className="ui-kv-val">{(metrics.maxPc/1e6).toFixed(2)} MPa</div>
                  <div className="ui-kv-key">Total Imp:</div><div className="ui-kv-val">{(metrics.totalImpulse/1000).toFixed(1)} kNs</div>
                  <div className="ui-kv-key">Isp:</div><div className="ui-kv-val">{metrics.isp.toFixed(1)} s</div>
                  <div className="ui-kv-key">Action Time:</div><div className="ui-kv-val">{metrics.actionTime.toFixed(2)} s</div>
                  <div className="ui-kv-key">Case SF:</div>
                  <div className={`font-mono font-bold ${structural && structural.safetyFactor < 1.5 ? 'text-[var(--sem-danger)]' : 'text-[var(--s-canvas)]'}`}>
                    {structural ? `${structural.safetyFactor.toFixed(2)}x` : '--'}
                  </div>
                  <div className="ui-kv-key">Bore Growth:</div>
                  <div className="ui-kv-val">
                    {structural ? `${(structural.boreRadialGrowth * 1e6).toFixed(0)} µm` : '--'}
                  </div>
                </div>
              </div>
            )}

          </div>
        </Dock>

        {/* Central Widget: Tabbed Layout (QTabWidget) */}
        <div className="sh-center">
          
          {/*
            * Document-style tabs. The roles, roving tabindex and arrow-key
            * navigation are unchanged from the previous tablist -- that part was
            * already correct, so only the appearance moved.
            */}
          <TabStrip
            tabs={TAB_DEFS}
            active={activeTab}
            onChange={(id) => setActiveTab(id as TabId)}
            label="Analysis views"
          />

          {/* Tab Content Area */}
          <div
            id="tab-panel"
            role="tabpanel"
            aria-labelledby={`tab-${activeTab}`}
            tabIndex={0}
            className="sh-tabpanel"
          >
            
            {isSimulating && (
              <div className="absolute inset-0 z-50 bg-[var(--s-canvas)] bg-opacity-80 flex flex-col items-center justify-center font-mono">
                <svg className="animate-spin -ml-1 mr-3 h-10 w-10 text-[var(--a-accent)] mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <div className="text-[var(--a-accent)] text-sm animate-pulse tracking-widest font-bold">SOLVING MESH & THERMO MODELS...</div>
              </div>
            )}



            {/*
              * One boundary around the tab content, keyed on the active tab.
              *
              * There were no error boundaries anywhere, so a single bad value
              * reaching one chart -- a NaN axis domain, an undefined field on
              * a results row -- unmounted the whole tree and took the user's
              * unsaved design with it.
              *
              * Keyed rather than ten separate boundaries: a key change
              * remounts, so switching tabs clears a failed one automatically
              * and the user is never stuck on a broken panel with no way back.
              * The toolbar, sidebar and console live outside it and survive.
              */}
            <ErrorBoundary label={`The ${activeTab} tab`} onError={addLog} key={activeTab}>
            {/* TAB: BALLISTICS */}
            {activeTab === 'ballistics' && (
              <div className="bal-stack">
                {/*
                  * One overlaid trace, not two stacked single-series charts.
                  *
                  * Chamber pressure and thrust were previously plotted
                  * separately, which answers "what did pressure do" but not "did
                  * thrust peak before or after it" -- the question a coupled
                  * system actually raises. Channels are chosen in the right dock.
                  */}
                <BallisticsChart
                  data={chartData}
                  enabled={enabledSeries}
                  peakPc={
                    metrics && peakPcBand
                      ? { value: metrics.maxPc / 1e6, relative: peakPcBand.relative }
                      : undefined
                  }
                />

                {/*
                  * The axial profile, which only exists under the quasi-1-D
                  * model. It is the whole point of that model -- the head end
                  * and the aft end of one grain burning at different rates --
                  * and it plots against POSITION, not time, so it cannot be
                  * folded into the trace above.
                  */}
                {stations && axialData.length > 0 && (
                  <div className="bal-axial">
                    <div className="bal-axial-title">
                      Axial profile at peak pressure — head end (x=0) to nozzle
                    </div>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={axialData} margin={{ top: 24, right: 34, bottom: 16, left: 0 }}>
                        <CartesianGrid strokeDasharray="2 4" stroke="var(--c-grid)" />
                        <XAxis
                          dataKey="x"
                          type="number"
                          domain={['dataMin', 'dataMax']}
                          stroke="var(--c-axis)"
                          tick={{ fill: 'var(--t-muted)', fontSize: 10 }}
                          tickFormatter={(v: number) => v.toFixed(2)}
                          label={{ value: 'Position (m)', position: 'insideBottom', offset: -8, fill: 'var(--t-muted)', fontSize: 10 }}
                        />
                        <YAxis yAxisId="left" stroke="var(--c-1)" tick={{ fill: 'var(--c-1)', fontSize: 10 }} tickFormatter={(v: number) => v.toFixed(2)} />
                        <YAxis yAxisId="right" orientation="right" stroke="var(--c-4)" tick={{ fill: 'var(--c-4)', fontSize: 10 }} tickFormatter={(v: number) => v.toFixed(1)} />
                        <Tooltip
                          contentStyle={{
                            background: 'var(--s-raised)',
                            border: '1px solid var(--b-strong)',
                            borderRadius: 3,
                            fontSize: 11,
                            fontFamily: 'var(--font-mono)',
                          }}
                          labelFormatter={(v: number | string) => `x = ${Number(v).toFixed(3)} m`}
                        />
                        <Legend verticalAlign="top" height={20} iconType="plainline" wrapperStyle={{ fontSize: 10 }} />
                        <Line yAxisId="left" type="monotone" dataKey="Pc_MPa" name="Static Pc (MPa)" stroke="var(--c-1)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                        <Line yAxisId="right" type="monotone" dataKey="G" name="Mass flux (kg/m²s)" stroke="var(--c-4)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                        <Line yAxisId="right" type="monotone" dataKey="rb_mm_s" name="Burn rate (mm/s)" stroke="var(--c-2)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {/* TAB: EXTENDED GRAPHS (now Custom Graph) */}
            {activeTab === 'extended_graphs' && (
              <CustomGraphTab chartData={chartData} numSegments={numSegments} />
            )}

            {/* TAB: GEOMETRY */}
            {activeTab === 'geometry' && (
              <div className="chart-frame" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div className="absolute top-1 left-2 z-10 text-[var(--c-6)] text-[10px] font-mono">Grain Cross-Section Regression</div>
                <div className="w-full h-full flex items-center justify-center p-8">
                  <svg viewBox="0 0 200 200" className="w-full h-full max-w-[500px] max-h-[500px] bg-[var(--s-sunken)] rounded-full border border-[var(--b-strong)] shadow-2xl">
                    <circle cx="100" cy="100" r={(outerRadius / outerRadius) * 95} fill="var(--b-control)" />
                    {grainType === 'BATES' || grainType === 'Tubular' ? (
                      <circle cx="100" cy="100" r={Math.min(outerRadius, Math.max(0, innerRadius + currentY)) / outerRadius * 95} fill="var(--s-canvas)" />
                    ) : grainType === 'RodAndTube' ? (
                      <>
                        <circle cx="100" cy="100" r={Math.min(outerRadius, Math.max(0, innerRadius + currentY)) / outerRadius * 95} fill="var(--s-canvas)" />
                        {rodRadius - currentY > 0 && (
                          <circle cx="100" cy="100" r={Math.max(0, rodRadius - currentY) / outerRadius * 95} fill="var(--b-control)" />
                        )}
                      </>
                    ) : grainType === 'MoonBurner' ? (
                      <circle cx={100 + (offset / outerRadius) * 95} cy="100" r={Math.min(outerRadius + offset, Math.max(0, innerRadius + currentY)) / outerRadius * 95} fill="var(--s-canvas)" />
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
                      })()} fill="var(--s-canvas)" />
                    ) : grainType === 'CustomDXF' && dxfData ? (
                      <circle cx="100" cy="100" r={Math.sqrt(dxfData.areaTable[Math.min(Math.floor(currentY / dxfData.dx), dxfData.areaTable.length - 1)] / Math.PI) / outerRadius * 95} fill="var(--s-canvas)" />
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
                      })()} fill="var(--s-canvas)" />
                    )}
                  </svg>
                </div>
                <div className="absolute bottom-4 left-4 right-4 flex flex-col space-y-2 bg-[var(--s-canvas)] p-3 rounded border border-[var(--b-soft)]">
                  <div className="flex justify-between text-[var(--c-6)] text-[10px] font-mono px-2">
                    <span>Burn Area: {(results[visualizerIndex]?.Ab * 10000 || 0).toFixed(1)} cm²</span>
                    <span>Port Area: {(results[visualizerIndex]?.PortArea * 10000 || 0).toFixed(1)} cm²</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-[var(--c-6)] text-[10px] font-mono w-16">T: {results[visualizerIndex]?.Time.toFixed(2) || '0.00'}s</span>
                    <input 
                      type="range" 
                      min="0" 
                      max={Math.max(0, results.length - 1)} 
                      value={visualizerIndex} 
                      onChange={(e) => setVisualizerIndex(Number(e.target.value))}
                      className="flex-1 accent-[var(--c-6)]"
                      disabled={results.length === 0}
                    />
                    <span className="text-[var(--c-6)] text-[10px] font-mono w-16 text-right">W: {(currentY * 1000).toFixed(1)}mm</span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: THERMO */}
            {activeTab === 'thermo' && (
              <div className="tab-fill">
                <div className="chart-frame">
                  <div className="chart-caption">
                    Burn rate against chamber pressure
                    {burnRateRegimes.length > 0 && ' — measured piecewise law'}
                  </div>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={burnRateData} margin={{ top: 26, right: 24, bottom: 24, left: 12 }}>
                      <CartesianGrid strokeDasharray="2 4" stroke="var(--c-grid)" />
                      <XAxis
                        dataKey="pressure" type="number" domain={['dataMin', 'dataMax']}
                        stroke="var(--c-axis)" tick={{ fill: 'var(--t-muted)', fontSize: 10 }}
                        label={{ value: 'Chamber pressure (MPa)', position: 'insideBottom', offset: -12, fill: 'var(--t-muted)', fontSize: 10 }}
                      />
                      <YAxis
                        stroke="var(--c-axis)" tick={{ fill: 'var(--t-muted)', fontSize: 10 }}
                        label={{ value: 'Burn rate (mm/s)', angle: -90, position: 'insideLeft', fill: 'var(--t-muted)', fontSize: 10 }}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--s-raised)',
                          border: '1px solid var(--b-strong)',
                          borderRadius: 3,
                          color: 'var(--t-primary)',
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                        }}
                        labelFormatter={(v: number | string) => `${Number(v).toFixed(2)} MPa`}
                      />
                      {/*
                        * Band boundaries, when the propellant carries a measured
                        * piecewise law. The curve steps at each of these, and a
                        * reader who cannot see where the bands are would read
                        * those steps as noise rather than as the data.
                        */}
                      {burnRateRegimes.slice(1).map((r) => (
                        <ReferenceLine
                          key={r.from_pressure}
                          x={r.from_pressure / 1e6}
                          stroke="var(--b-control)"
                          strokeDasharray="2 3"
                        />
                      ))}
                      <Line type="monotone" dataKey="burnRate" name="Burn rate" stroke="var(--c-4)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <section className="sec">
                  <header className="sec-head">Burn law in force</header>
                  <div className="kv">
                    <div className="kv-row">
                      <span className="kv-key">Propellant</span>
                      <span className="kv-val">{propellantName}</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-key">Law</span>
                      <span className="kv-val">
                        {burnRateRegimes.length
                          ? `${burnRateRegimes.length} measured bands`
                          : 'Single power law'}
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-key">Coefficient a</span>
                      <span className="kv-val">{a.toExponential(3)}</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-key">Exponent n</span>
                      <span className="kv-val">{n.toFixed(4)}</span>
                    </div>
                  </div>
                  <p className="sec-note">
                    {burnRateRegimes.length
                      ? `Bands cover ${(burnRateRegimes[0].from_pressure / 1e6).toFixed(2)}–${(burnRateRegimes[burnRateRegimes.length - 1].to_pressure / 1e6).toFixed(2)} MPa. Outside that range the single a/n above is extrapolated from the nearest band. Piecewise fits do not join up, so the curve steps at each boundary.`
                      : 'A single Saint-Robert law is monotonic for n > 0, which cannot reproduce the non-monotonic burn rate measured for the sugar propellants. Selecting KNDX or KNSB from the library loads their measured bands.'}
                  </p>
                </section>
              </div>
            )}

            {/* TAB: MONTE CARLO */}
            {activeTab === 'montecarlo' && (
              <MonteCarloTab
                runs={mcRuns}
                onRunsChange={setMcRuns}
                variance={mcVariance}
                onVarianceChange={setMcVariance}
                solverModel={mcSolverModel}
                onSolverModelChange={setMcSolverModel}
                stationCount={stationCount}
                results={mcResults}
                onRun={runMonteCarlo}
              />
            )}

            {/* TAB: MATERIALS */}
            {activeTab === 'materials' && (
              <MaterialsTab
                propellantName={propellantName}
                density={density}
                a={a}
                n={n}
                molWeight={molWeight}
                flameTemp={flameTemp}
                casingMaterial={casingMaterial}
                casingYieldStress={casingYieldStress}
                casingYoungsModulus={casingYoungsModulus}
                nozzleMaterial={nozzleMaterial}
                nozzleThermalConductivity={nozzleThermalConductivity}
                nozzleSpecificHeat={nozzleSpecificHeat}
                onSaveMaterial={handleSaveMaterial}
                onLoadMaterial={handleLoadMaterialClick}
              />
            )}

            {/* TAB: STRUCTURAL */}
            {activeTab === 'structural' && (
              <StructuralTab
                structural={structural}
                metrics={metrics}
                results={results}
                caseWallThickness={caseWallThickness}
                casingMaterial={casingMaterial}
                casingYieldStress={casingYieldStress}
                outerRadius={outerRadius}
                throatDiameter={throatDiameter}
                nozzleMaterial={nozzleMaterial}
                isSimulating={isSimulating}
                onExportCasingSTL={handleExportCasingSTL}
                onExportCasingSCAD={handleExportCasingSCAD}
              />
            )}

            {/* TAB: STATISTICS */}
            {/* TAB: 3D BURN */}
            {activeTab === 'burn3d' && (
              <div className="chart-frame" style={{ overflowY: "auto", padding: "var(--gap-lg)" }}>
                <div className="absolute top-1 left-2 z-10 text-[var(--a-accent)] text-[10px] font-mono">
                  Live Grain Burn-Back
                </div>
                {grainType === 'CustomDXF' && !dxfData ? (
                  <div className="text-[var(--t-muted)] italic font-mono text-xs mt-6">
                    Load a DXF profile to view its burn-back.
                  </div>
                ) : (
                  <React.Suspense
                    fallback={<div className="text-[var(--t-muted)] italic font-mono text-xs mt-6">Loading 3D view…</div>}
                  >
                    <GrainBurn3D grain={burn3dGrain} results={results} />
                  </React.Suspense>
                )}
              </div>
            )}

            {/* TAB: SURROGATE */}
            {activeTab === 'surrogate' && (
              <div className="tab-scroll">
                {grainType === 'CustomDXF' && !dxfData ? (
                  <div className="tab-empty">
                    Load a DXF profile first — the surrogate predicts from the grain's burn-back
                    curves, and a Custom DXF grain has none until its cross-section is traced.
                  </div>
                ) : (
                  <SurrogatePanel
                    design={surrogateDesign}
                    onApplyDesign={applySurrogateDesign}
                    addLog={addLog}
                    burnRateRegimes={burnRateRegimes}
                  />
                )}
              </div>
            )}

            {activeTab === 'statistics' && (
              <StatisticsTab
                metrics={metrics}
                throatDiameter={throatDiameter}
                grainLength={length}
                grainKind={grainType}
                n={n}
                propellantName={propellantName}
                burnRateRegimes={burnRateRegimes}
                erosiveModel={erosiveModel}
                erosiveFraction={erosiveFraction}
                nozzleMaterial={nozzleMaterial}
              />
            )}
            
            </ErrorBoundary>
          </div>
        </div>

        {/*
          * Right dock: what to plot, and how much to believe it.
          *
          * openMotor puts axis checkboxes here. This keeps that -- picking
          * channels is the most frequent thing you do to a trace -- and adds
          * the thing this tool has that openMotor does not: a live uncertainty
          * budget, visible while you design rather than filed away in a tab you
          * have to remember to open.
          */}
        <Dock
          side="right"
          width={rightDockWidth}
          onWidthChange={setRightDockWidth}
          label="Trace & Confidence"
          railLabel="Trace"
          open={rightDockOpen}
          onOpenChange={setRightDockOpen}
        >
          <div className="sh-dock-scroll">
            <FieldGroup title="Channels">
              {SERIES.map((s) => (
                <Checkbox
                  key={s.key}
                  checked={enabledSeries.includes(s.key)}
                  swatch={s.color}
                  label={
                    <>
                      {s.label} <span style={{ color: 'var(--t-muted)' }}>({s.unit})</span>
                    </>
                  }
                  onChange={(on) =>
                    setEnabledSeries((prev) =>
                      on ? [...prev, s.key] : prev.filter((k) => k !== s.key)
                    )
                  }
                />
              ))}
            </FieldGroup>

            <FieldGroup title="Model uncertainty">
              {metrics ? (
                <div className="unc-list">
                  {uncertaintyBudget.map((u) => (
                    <div key={u.output} className="unc-row" title={`Dominated by: ${u.dominant}`}>
                      <span className="unc-name">{u.label}</span>
                      <span
                        className={`unc-band ${
                          u.orderOfMagnitudeOnly || u.relative >= 0.25
                            ? 'is-danger'
                            : u.relative >= 0.1
                              ? 'is-warn'
                              : 'is-ok'
                        }`}
                      >
                        {formatBand(u)}
                      </span>
                    </div>
                  ))}
                  <p className="unc-note">
                    Measured model error, propagated. A floor on the error, not a bound — batch,
                    casting and machining variation are invisible to any solver.
                  </p>
                  <Button variant="ghost" onClick={() => setActiveTab('statistics')}>
                    Full breakdown →
                  </Button>
                </div>
              ) : (
                <p className="unc-note">Run a simulation to see the error budget.</p>
              )}
            </FieldGroup>

            <FieldGroup title="Design checks" defaultOpen={validationIssues.length > 0}>
              {validationIssues.length === 0 ? (
                <p className="unc-note" style={{ color: 'var(--sem-ok)' }}>
                  No problems found.
                </p>
              ) : (
                <ul className="chk-list">
                  {validationIssues.map((v, i) => (
                    <li key={i} className={`chk-item is-${v.severity}`}>
                      {v.message}
                    </li>
                  ))}
                </ul>
              )}
            </FieldGroup>
          </div>
        </Dock>
      </div>

      {/*
        * Status strip: the handful of numbers that describe the motor, always
        * visible regardless of which tab is open.
        *
        * Peak pressure carries its band inline. That placement is the whole
        * argument -- a peak quoted to four figures beside a wall thickness
        * invites a confidence the model has not earned, and the band is only
        * useful at the moment someone reads the number.
        */}
      <StatusBar>
        {metrics ? (
          <>
            <Stat label="Designation" value={motorDesignation} />
            <Stat
              label="Total Impulse"
              value={`${metrics.totalImpulse.toFixed(0)} N·s`}
              band={impulseBand ? formatBand(impulseBand) : undefined}
            />
            <Stat
              label="Peak Pressure"
              value={`${(metrics.maxPc / 1e6).toFixed(2)} MPa`}
              band={peakPcBand ? formatBand(peakPcBand) : undefined}
              tone={
                !peakPcBand
                  ? 'default'
                  : peakPcBand.orderOfMagnitudeOnly || peakPcBand.relative >= 0.25
                    ? 'danger'
                    : peakPcBand.relative >= 0.1
                      ? 'warn'
                      : 'ok'
              }
              hint={peakPcBand ? `Dominated by: ${peakPcBand.dominant}` : undefined}
            />
            <Stat label="Max Thrust" value={`${(metrics.maxThrust / 1000).toFixed(2)} kN`} />
            <Stat
              label="Burn Time"
              value={`${metrics.actionTime.toFixed(3)} s`}
              band={burnTimeBand ? formatBand(burnTimeBand) : undefined}
            />
            <Stat label="Delivered Isp" value={`${metrics.isp.toFixed(1)} s`} />
            <Stat label="Propellant" value={`${metrics.propMass.toFixed(3)} kg`} />
            <Stat
              label="Port / Throat"
              value={metrics.portThroatRatio.toFixed(2)}
              tone={metrics.portThroatRatio < 2 ? 'warn' : 'default'}
              hint={
                metrics.portThroatRatio < 2
                  ? 'Below 2, erosive burning dominates — and that model is uncalibrated here.'
                  : undefined
              }
            />
            <Stat label="Peak Kn" value={metrics.peakKn.toFixed(0)} />
          </>
        ) : (
          <div className="sh-status-msg">
            {statusMsg || 'No results — press Run to simulate this design.'}
          </div>
        )}
      </StatusBar>

      {/*
        * Console. Collapsible, because it is essential while something is going
        * wrong and pure furniture the rest of the time.
        */}
      <div className="sh-console" style={{ height: consoleOpen ? 108 : undefined }}>
        <div className="sh-console-head">
          <button
            type="button"
            className="ui-panel-title ui-panel-toggle"
            onClick={() => setConsoleOpen(!consoleOpen)}
            aria-expanded={consoleOpen}
            aria-controls="console-body"
          >
            {consoleOpen ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
            <Terminal size={11} />
            <span>Console</span>
          </button>
          <span style={{ color: 'var(--t-muted)', textTransform: 'none', letterSpacing: 0 }}>
            {logs.length} message{logs.length === 1 ? '' : 's'}
          </span>
        </div>
        {consoleOpen && (
          <div id="console-body" className="sh-console-body selectable">
            {logs.map((log, i) => (
              <div key={i} className="sh-console-line">
                {log}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* QStatusBar */}
      <div className="h-6 flex-none bg-[var(--s-raised)] border-t border-[var(--b-strong)] flex items-center px-3 z-20">
        <span className="text-[11px] text-[var(--t-secondary)] font-medium">{statusMsg}</span>
      </div>

    </div>
    </SettingsContext.Provider>
  );
}
