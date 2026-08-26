import React, { useMemo } from 'react';
import { Play } from './ui/icons';
import { Button } from './ui/primitives';
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

  /*
   * What the sweep actually told you.
   *
   * A scatter plot shows the shape of the spread but not its size, and "how
   * much does peak pressure move" is the question a dispersion sweep exists to
   * answer. Both are cheap to compute from the same rows.
   */
  const summary = useMemo(() => {
    if (results.length < 2) return null;
    const stat = (pick: (r: (typeof results)[number]) => number) => {
      const xs = results.map(pick).sort((a, b) => a - b);
      const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length - 1));
      return { mean, sd, min: xs[0], max: xs[xs.length - 1] };
    };
    return { pc: stat((r) => r.maxPc), thrust: stat((r) => r.maxThrust) };
  }, [results]);

  return (
    <div className="tab-fill">
      <div className="mc-bar">
        <div className="mc-ctl">
          <label className="mc-label" htmlFor={fieldId('runs')}>Runs</label>
          <input
            id={fieldId('runs')}
            type="number"
            value={runs}
            onChange={(e) => onRunsChange(Number(e.target.value))}
            className="ui-input ui-input-num"
            style={{ width: 64 }}
          />
        </div>
        <div className="mc-ctl">
          <label className="mc-label" htmlFor={fieldId('variance')}>Variance</label>
          <input
            id={fieldId('variance')}
            type="number"
            value={variance}
            onChange={(e) => onVarianceChange(Number(e.target.value))}
            className="ui-input ui-input-num"
            style={{ width: 58 }}
          />
          <span className="mc-unit">%</span>
        </div>
        <div className="mc-ctl">
          <label className="mc-label" htmlFor={fieldId('solver')}>Solver</label>
          <select
            id={fieldId('solver')}
            value={solverModel}
            onChange={(e) => onSolverModelChange(e.target.value as SolverModelType)}
            className="ui-input ui-select"
          >
            <option value="0D">0-D lumped (fast)</option>
            <option value="quasi1D">Quasi-1-D axial</option>
          </select>
        </div>
        <Button variant="primary" icon={<Play size={12} />} onClick={onRun}>
          Run Analysis
        </Button>
        {solverModel === 'quasi1D' && (
          <span className="mc-warn">
            {runs} axially resolved solves at {stationCount} stations each. Slower, but the only
            way to see whether axial resolution changes your dispersion.
          </span>
        )}
      </div>

      {summary && (
        <section className="sec">
          <header className="sec-head">
            Dispersion over {results.length} runs, ±{variance}% on a, density, throat and igniter
          </header>
          <div className="kv">
            <div className="kv-row">
              <span className="kv-key">Peak pressure, mean</span>
              <span className="kv-val">
                {summary.pc.mean.toFixed(2)} MPa
                <span className="kv-sub">σ {summary.pc.sd.toFixed(2)}</span>
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-key">Peak pressure, range</span>
              <span className="kv-val">
                {summary.pc.min.toFixed(2)} to {summary.pc.max.toFixed(2)} MPa
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-key">Peak thrust, mean</span>
              <span className="kv-val">
                {summary.thrust.mean.toFixed(2)} kN
                <span className="kv-sub">σ {summary.thrust.sd.toFixed(2)}</span>
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-key">Peak thrust, range</span>
              <span className="kv-val">
                {summary.thrust.min.toFixed(2)} to {summary.thrust.max.toFixed(2)} kN
              </span>
            </div>
          </div>
          <p className="sec-note">
            Input variation only. This is what the perturbations you specified do to the model. It does not include the model&apos;s own error, which the Statistics tab reports
            separately and which is usually larger.
          </p>
        </section>
      )}

      <div className="chart-frame">
        <div className="chart-caption">Peak pressure against peak thrust, one point per run</div>
        {results.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 24, right: 24, bottom: 24, left: 10 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--c-grid)" />
              <XAxis
                dataKey="maxPc" type="number" name="Max Pressure" unit=" MPa"
                stroke="var(--c-axis)" tick={{ fill: 'var(--t-muted)', fontSize: 10 }}
                domain={['auto', 'auto']}
                label={{ value: 'Peak pressure (MPa)', position: 'insideBottom', offset: -12, fill: 'var(--t-muted)', fontSize: 10 }}
              />
              <YAxis
                dataKey="maxThrust" type="number" name="Max Thrust" unit=" kN"
                stroke="var(--c-axis)" tick={{ fill: 'var(--t-muted)', fontSize: 10 }}
                domain={['auto', 'auto']}
                label={{ value: 'Peak thrust (kN)', angle: -90, position: 'insideLeft', fill: 'var(--t-muted)', fontSize: 10 }}
              />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{
                  background: 'var(--s-raised)',
                  border: '1px solid var(--b-strong)',
                  borderRadius: 0,
                  color: 'var(--t-primary)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <Scatter name="Runs" data={results} fill="var(--c-1)" fillOpacity={0.75} />
            </ScatterChart>
          </ResponsiveContainer>
        ) : (
          <div className="tab-empty">Run the analysis to view the distribution.</div>
        )}
      </div>
    </div>
  );
}

export default MonteCarloTab;
