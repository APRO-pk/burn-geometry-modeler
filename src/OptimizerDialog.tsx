import React, { useState } from 'react';
import { Close, Play} from './ui/icons';
import { useFieldIds } from './useFieldIds';
import { runMotor } from './wasmClient';
import { grainConfigFromUi } from './wasmCore';
import type { DesignSnapshot } from './useDesignHistory';
import type { DXFRegressionResults } from './dxfProcessor';
import type { GrainUiParams } from './engine';
import type { BurnRateRegime } from './wasmCore';

/** Which design input the sweep varies. */
type SweepParam = 'throatDiameter' | 'length';

/** One evaluated point of the sweep. */
interface SweepPoint {
  /** Value of the swept parameter, SI. */
  val: number;
  /** Peak chamber pressure, MPa. */
  maxPc: number;
  /** Peak thrust, kN. */
  maxThrust: number;
  initialKn: number;
  warnings: string[];
}

interface OptimizerProps {
  /**
   * The design to sweep around, as a snapshot.
   *
   * DesignSnapshot rather than a strict type because it comes from
   * captureDesignState and may legitimately be missing fields -- the sweep
   * reads what it needs and the core supplies its own defaults.
   */
  currentConfig: DesignSnapshot;
  onApply: (newConfig: DesignSnapshot) => void;
  onClose: () => void;
  dxfData: DXFRegressionResults | null;
}

export function OptimizerDialog({ currentConfig, onApply, onClose, dxfData }: OptimizerProps) {
  const fieldId = useFieldIds();
  const [paramToSweep, setParamToSweep] = useState<SweepParam>('throatDiameter');
  const [sweepMin, setSweepMin] = useState<number>(0.005);
  const [sweepMax, setSweepMax] = useState<number>(0.03);
  const [steps, setSteps] = useState<number>(10);
  const [results, setResults] = useState<SweepPoint[]>([]);
  /**
   * Spatial model for the sweep. Defaults to whatever the main editor is set
   * to, so the sweep and the Run button agree unless the user says otherwise.
   */
  const [sweepModel, setSweepModel] = useState<'0D' | 'quasi1D'>(
    currentConfig?.solverModel === 'quasi1D' ? 'quasi1D' : '0D'
  );
  const [isRunning, setIsRunning] = useState(false);

  const runSweep = async () => {
    setIsRunning(true);
    const sweepResults: SweepPoint[] = [];
    const stepSize = (sweepMax - sweepMin) / Math.max(1, steps - 1);

    for (let i = 0; i < steps; i++) {
      const val = sweepMin + i * stepSize;
      const config = { ...currentConfig, [paramToSweep]: val };

      /*
       * Read a snapshot field as a number, with an explicit fallback.
       *
       * The snapshot is a permissive record, so every field is `unknown` until
       * checked. Before this, a missing field was passed to the solver as
       * `undefined` and became NaN somewhere inside it -- which surfaced as an
       * empty sweep with no explanation rather than as a bad input.
       */
      const num = (v: unknown, fallback: number): number => {
        const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        return Number.isFinite(x) ? x : fallback;
      };

      try {
        // Same wasm core as the nominal run, so a swept point can be applied and
        // re-run without the numbers moving. The two deliberate simplifications
        // below are what makes this a "quick" sweep, and they are the only
        // differences from the main simulation.
        const { results: simRes, warnings: simWarnings } = await runMotor({
          propellant: {
            density: num(config.density, 1800),
            a: num(config.a, 1e-5),
            n: num(config.n, 0.3),
            flame_temp: num(config.flameTemp, 2500),
            gamma: num(config.gamma, 1.2),
            molecular_weight: num(config.molWeight, 0.025),
            k_erosive: num(config.kErosive, 0),
            g_threshold: num(config.gThreshold, 500),
            /*
             * The measured piecewise law, if the propellant has one.
             *
             * Omitting it made the sweep evaluate a DIFFERENT propellant from
             * the one the Run button simulates -- silently, since the fallback
             * a/n are still plausible coefficients. A sweep whose optimum is
             * computed under a different burn law is worse than no sweep.
             */
            ...(Array.isArray(config.burnRateRegimes) && config.burnRateRegimes.length
              ? { burn_rate_regimes: config.burnRateRegimes as BurnRateRegime[] }
              : {}),
          },
          grain: grainConfigFromUi(config as unknown as GrainUiParams, dxfData),
          nozzle: {
            throat_diameter: num(config.throatDiameter, 0.015),
            expansion_ratio: num(config.expansionRatio, 6),
            // Idealized, non-eroding throat.
            material: null,
          },
          // No igniter: the sweep compares steady-state behaviour, not ignition.
          igniter: null,
          // Fixed efficiencies for a quick sweep. The spatial model follows
          // the user's choice: a sweep that silently drops to 0-D would rank
          // designs by a different physics from the one they are checking.
          options: {
            c_star_eff: 0.95,
            cf_eff: 0.98,
            model: sweepModel,
            ...(sweepModel === 'quasi1D' ? { stations: num(config.stationCount, 20) } : {}),
          },
        });

        if (simRes.length > 0) {
          const maxPc = Math.max(...simRes.map((r) => r.Pc)) / 1e6;
          const maxThrust = Math.max(...simRes.map((r) => r.Thrust)) / 1000;
          const initialKn = simRes[0].Ab / simRes[0].ThroatArea;
          sweepResults.push({ val, maxPc, maxThrust, initialKn, warnings: simWarnings });
        }
      } catch { /* ignore fails */ }
    }

    setResults(sweepResults);
    setIsRunning(false);
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-[var(--scrim)] text-xs text-[var(--t-primary)]">
      <div className="bg-[var(--s-canvas)] border border-[var(--b-strong)] w-[600px] flex flex-col p-4 space-y-4">
        <div className="flex justify-between items-center text-[var(--sem-warn)] font-bold text-sm border-b border-[var(--b-soft)] pb-2">
          <span>Design Optimizer / Sweep</span>
          <button onClick={onClose} className="hover:text-[var(--sem-danger)]"><Close size={12} /></button>
        </div>
        
        <div className="flex space-x-4 items-end">
          <div className="flex flex-col space-y-1 flex-1">
            <label className="text-[var(--t-secondary)]" htmlFor={fieldId('sweep-parameter')}>Sweep Parameter</label>
            <select id={fieldId('sweep-parameter')} value={paramToSweep} onChange={e => setParamToSweep(e.target.value as SweepParam)} className="bg-[var(--s-sunken)] border border-[var(--b-control)] px-2 py-1 outline-none focus:border-[var(--sem-warn)]">
              <option value="throatDiameter">Throat Diameter (m)</option>
              <option value="length">Grain Length (m)</option>
            </select>
          </div>
          <div className="flex flex-col space-y-1 w-20">
            <label className="text-[var(--t-secondary)]" htmlFor={fieldId('min')}>Min</label>
            <input id={fieldId('min')} type="number" step="any" value={sweepMin} onChange={e => setSweepMin(parseFloat(e.target.value))} className="bg-[var(--s-sunken)] border border-[var(--b-control)] px-2 py-1" />
          </div>
          <div className="flex flex-col space-y-1 w-20">
            <label className="text-[var(--t-secondary)]" htmlFor={fieldId('max')}>Max</label>
            <input id={fieldId('max')} type="number" step="any" value={sweepMax} onChange={e => setSweepMax(parseFloat(e.target.value))} className="bg-[var(--s-sunken)] border border-[var(--b-control)] px-2 py-1" />
          </div>
          <div className="flex flex-col space-y-1 w-20">
            <label className="text-[var(--t-secondary)]" htmlFor={fieldId('steps')}>Steps</label>
            <input id={fieldId('steps')} type="number" value={steps} onChange={e => setSteps(parseFloat(e.target.value))} className="bg-[var(--s-sunken)] border border-[var(--b-control)] px-2 py-1" />
          </div>
          <div className="flex flex-col space-y-1 w-36">
            <label className="text-[var(--t-secondary)]" htmlFor="sweep-model">Solver</label>
            <select
              id="sweep-model"
              value={sweepModel}
              onChange={e => setSweepModel(e.target.value as "0D" | "quasi1D")}
              className="bg-[var(--s-sunken)] border border-[var(--b-control)] px-2 py-1"
            >
              <option value="0D">0-D lumped</option>
              <option value="quasi1D">Quasi-1-D axial</option>
            </select>
          </div>
          <button onClick={runSweep} disabled={isRunning} className="bg-[var(--sem-warn)] text-[var(--t-inverse)] px-4 py-1 font-bold flex items-center h-7 hover:brightness-110 disabled:opacity-50">
            {isRunning ? 'Running...' : <><Play size={12} className="mr-1"/> Run</>}
          </button>
        </div>

        {results.length > 0 && (
          <div className="border border-[var(--b-soft)] overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-[var(--s-sunken)] text-[var(--t-secondary)]">
                <tr>
                  <th className="p-1 border-b border-[var(--b-soft)] pl-2">{paramToSweep}</th>
                  <th className="p-1 border-b border-[var(--b-soft)]">Max Pc (MPa)</th>
                  <th className="p-1 border-b border-[var(--b-soft)]">Max Thrust (kN)</th>
                  <th className="p-1 border-b border-[var(--b-soft)]">Initial Kn</th>
                  <th className="p-1 border-b border-[var(--b-soft)]">Warnings</th>
                  <th className="p-1 border-b border-[var(--b-soft)]">Action</th>
                </tr>
              </thead>
              <tbody className="bg-[var(--s-sunken)]">
                {results.map((r, i) => (
                  <tr key={i} className="hover:bg-[var(--s-raised)] transition-colors border-b border-[var(--b-soft)]">
                    <td className="p-1 pl-2 font-bold text-[var(--sem-ok)]">{r.val.toFixed(4)}</td>
                    <td className={`p-1 ${r.maxPc > 10 ? 'text-[var(--sem-danger)]' : 'text-[var(--t-primary)]'}`}>{r.maxPc.toFixed(2)}</td>
                    <td className="p-1 text-[var(--t-primary)]">{r.maxThrust.toFixed(2)}</td>
                    <td className="p-1 text-[var(--t-primary)]">{r.initialKn.toFixed(0)}</td>
                    <td className="p-1 text-[10px] text-[var(--sem-warn)] max-w-[100px] truncate" title={r.warnings?.join('\n')}>{r.warnings?.length > 0 ? `${r.warnings.length}⚠️` : ''}</td>
                    <td className="p-1">
                      <button onClick={() => { onApply({ ...currentConfig, [paramToSweep]: r.val }); onClose(); }} className="text-[var(--a-accent)] hover:text-[var(--t-primary)] text-[10px] bg-[var(--s-sunken)] border border-[var(--b-strong)] px-1">Apply</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
