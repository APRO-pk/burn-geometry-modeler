import React from 'react';
import { useFieldIds } from './useFieldIds';
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import type { SolverModelType } from './wasmCore';

/**
 * Monte Carlo: repeat the solve with perturbed inputs and plot the spread.
 *
 * The sweep settings stay in AppDesktop rather than moving here, because
 * onRun needs them to build each config and that function depends on
 * the whole motor configuration. This view renders them and reports changes.
 */
export interface MonteCarloTabProps {
  runs: number;
  onRunsChange: (v: number) => void;
  /** Percent, applied symmetrically to a, density, throat and igniter mass. */
  variance: number;
  onVarianceChange: (v: number) => void;
  solverModel: SolverModelType;
  onSolverModelChange: (v: SolverModelType) => void;
  /** Axial stations, shown only when the quasi-1-D solver is selected. */
  stationCount: number;
  results: Array<{ run: number; maxPc: number; maxThrust: number }>;
  onRun: () => void;
}

export function MonteCarloTab({
  runs,
  onRunsChange,
  variance,
  onVarianceChange,
  solverModel,
  onSolverModelChange,
  stationCount,
  results,
  onRun,
}: MonteCarloTabProps) {
  const fieldId = useFieldIds();
  return (
            <div className="flex-1 flex flex-col space-y-1">
              <div className="flex-none bg-[var(--s-raised)] border border-[var(--t-primary)] p-2 flex items-center space-x-4">
                <div className="flex items-center space-x-2">
                  <label className="text-xs text-[var(--b-strong)] font-bold" htmlFor={fieldId('runs')}>Runs:</label>
                  <input id={fieldId('runs')} type="number" value={runs} onChange={e => onRunsChange(Number(e.target.value))} className="border border-[var(--t-primary)] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none w-16 text-xs" />
                </div>
                <div className="flex items-center space-x-2">
                  <label className="text-xs text-[var(--b-strong)] font-bold" htmlFor={fieldId('variance')}>Variance (%):</label>
                  <input id={fieldId('variance')} type="number" value={variance} onChange={e => onVarianceChange(Number(e.target.value))} className="border border-[var(--t-primary)] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none w-16 text-xs" />
                </div>
                <div className="flex items-center space-x-2">
                  <label htmlFor="mc-solver" className="text-xs text-[var(--b-strong)] font-bold">Solver:</label>
                  <select
                    id="mc-solver"
                    value={solverModel}
                    onChange={e => onSolverModelChange(e.target.value as SolverModelType)}
                    className="border border-[var(--t-primary)] px-1 py-0.5 rounded bg-white focus:border-blue-500 outline-none text-xs"
                  >
                    <option value="0D">0-D lumped (fast)</option>
                    <option value="quasi1D">Quasi-1-D axial</option>
                  </select>
                </div>
                <button onClick={onRun} className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-[var(--t-primary)] text-xs font-bold rounded shadow-sm">
                  Run Analysis
                </button>
                {solverModel === 'quasi1D' && (
                  <span className="text-[10px] text-[var(--sem-warn)] leading-snug max-w-xs">
                    {runs} axially resolved solves at {stationCount} stations each. Slower, but
                    it is the only way to see whether axial resolution changes your dispersion.
                  </span>
                )}
              </div>
              <div className="flex-1 bg-black border border-[var(--b-control)] relative flex flex-col">
                <div className="absolute top-1 left-2 z-10 text-[var(--a-accent)] text-[10px] font-mono">Monte Carlo: Max Pressure vs Max Thrust</div>
                {results.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 10 }}>
                      <CartesianGrid strokeDasharray="1 3" stroke="var(--b-soft)" />
                      <XAxis dataKey="maxPc" type="number" name="Max Pressure" unit=" MPa" stroke="var(--t-muted)" tick={{fill: 'var(--t-secondary)', fontSize: 10}} domain={['auto', 'auto']} label={{ value: 'Max Pressure (MPa)', position: 'insideBottom', offset: -10, fill: 'var(--t-secondary)', fontSize: 10 }} />
                      <YAxis dataKey="maxThrust" type="number" name="Max Thrust" unit=" kN" stroke="var(--t-muted)" tick={{fill: 'var(--t-secondary)', fontSize: 10}} domain={['auto', 'auto']} label={{ value: 'Max Thrust (kN)', angle: -90, position: 'insideLeft', fill: 'var(--t-secondary)', fontSize: 10 }} />
                      <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ backgroundColor: 'var(--s-canvas)', borderColor: 'var(--b-strong)', color: 'var(--a-accent)', fontSize: '11px', fontFamily: 'monospace' }} />
                      <Scatter name="Runs" data={results} fill="var(--a-accent)" />
                    </ScatterChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-[var(--b-control)] font-mono text-xs">
                    Run analysis to view distribution
                  </div>
                )}
              </div>
            </div>
  );
}

export default MonteCarloTab;
