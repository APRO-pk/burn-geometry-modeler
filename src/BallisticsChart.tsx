import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';

/**
 * The main trace view: any combination of channels against time.
 *
 * WHAT CHANGED AND WHY
 *
 * This was two fixed charts stacked vertically -- chamber pressure in one,
 * thrust in the other -- each showing exactly one series with no way to change
 * it. That layout answers "what did pressure do" but not "did thrust peak
 * before or after pressure", which is the question a coupled system actually
 * raises, and the one you cannot answer by looking back and forth between two
 * plots with different time axes.
 *
 * AXES
 *
 * The channels here span wildly different magnitudes: chamber pressure is
 * single-digit MPa, thrust is tens of kN, Kn is in the hundreds. Plotting them
 * on one axis would flatten all but the largest into a line along the bottom.
 *
 * So series are grouped by unit and given at most two axes, left and right.
 * That covers the comparison people actually want -- two quantities against
 * each other -- and when a third unit is selected the chart says so plainly
 * rather than silently mis-scaling it. Inventing a third axis would be worse:
 * three unlabelled scales on one plot is a chart nobody can read.
 */

export interface SeriesDef {
  key: string;
  label: string;
  /** Series sharing a unit share an axis. */
  unit: string;
  color: string;
}

/**
 * Every channel the solver records, in the order they belong in a legend.
 *
 * Pressure and thrust first because they are what a motor is judged on; the
 * diagnostics that explain them follow.
 */
export const SERIES: readonly SeriesDef[] = [
  { key: 'Pc_MPa', label: 'Chamber Pressure', unit: 'MPa', color: 'var(--c-1)' },
  { key: 'Thrust_kN', label: 'Thrust', unit: 'kN', color: 'var(--c-3)' },
  { key: 'Kn', label: 'Kn', unit: 'Kn', color: 'var(--c-2)' },
  { key: 'PortMassFlux_kg_sm2', label: 'Port Mass Flux', unit: 'kg/m²s', color: 'var(--c-4)' },
  { key: 'MassFlow_kg_s', label: 'Mass Flow', unit: 'kg/s', color: 'var(--c-5)' },
  { key: 'Regression_mm', label: 'Regression Depth', unit: 'mm', color: 'var(--c-6)' },
  { key: 'Web_mm', label: 'Web Remaining', unit: 'mm', color: 'var(--c-6)' },
  { key: 'PropellantMass_kg', label: 'Propellant Mass', unit: 'kg', color: 'var(--c-5)' },
  { key: 'VolumeLoading_pct', label: 'Volume Loading', unit: '%', color: 'var(--c-4)' },
  { key: 'NozzleExitPressure_MPa', label: 'Nozzle Exit Pressure', unit: 'MPa', color: 'var(--c-1)' },
  { key: 'ChangeInThroatDiameter_mm', label: 'Throat Erosion', unit: 'mm', color: 'var(--c-6)' },
  { key: 'CoreMachNumber', label: 'Core Mach', unit: 'M', color: 'var(--c-2)' },
];

export interface BallisticsChartProps {
  data: Array<Record<string, number>>;
  /** Keys from SERIES that should be drawn. */
  enabled: string[];
  /**
   * Peak chamber pressure and its uncertainty band, in MPa.
   *
   * Drawn as a reference line with a shaded band, so the number in the status
   * bar and the trace agree about how much is actually known.
   */
  peakPc?: { value: number; relative: number };
}

/** Resolve a CSS custom property to a literal, which SVG attributes require. */
function cssVar(name: string): string {
  if (typeof window === 'undefined') return 'var(--t-secondary)';
  const raw = name.startsWith('var(') ? name.slice(4, -1) : name;
  const v = getComputedStyle(document.documentElement).getPropertyValue(raw).trim();
  return v || 'var(--t-secondary)';
}

export function BallisticsChart({ data, enabled, peakPc }: BallisticsChartProps) {
  const active = useMemo(() => SERIES.filter((s) => enabled.includes(s.key)), [enabled]);

  // Units in the order they were selected, capped at the two the chart can show.
  const units = useMemo(() => {
    const seen: string[] = [];
    for (const s of active) if (!seen.includes(s.unit)) seen.push(s.unit);
    return seen;
  }, [active]);

  const leftUnit = units[0];
  const rightUnit = units[1];
  const unplotted = units.slice(2);

  const axisFor = (s: SeriesDef) => (s.unit === leftUnit ? 'left' : 'right');
  const drawable = active.filter((s) => s.unit === leftUnit || s.unit === rightUnit);

  if (!data.length) {
    return <div className="bc-empty">Run a simulation to plot a trace.</div>;
  }
  if (!drawable.length) {
    return <div className="bc-empty">Select at least one channel to plot.</div>;
  }

  const grid = cssVar('--c-grid');
  const axis = cssVar('--c-axis');
  const muted = cssVar('--t-muted');

  return (
    <div className="bc-wrap">
      {unplotted.length > 0 && (
        <div className="bc-note" role="status">
          {unplotted.join(', ')} not plotted — a chart carries two scales legibly, and these
          would need a third. Deselect another channel to see them.
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 18, left: 4 }}>
          <CartesianGrid stroke={grid} strokeDasharray="2 4" />
          <XAxis
            dataKey="Time"
            type="number"
            domain={['dataMin', 'dataMax']}
            stroke={axis}
            tick={{ fill: muted, fontSize: 10 }}
            tickFormatter={(v: number) => v.toFixed(2)}
            label={{ value: 'Time (s)', position: 'insideBottom', offset: -10, fill: muted, fontSize: 10 }}
          />
          <YAxis
            yAxisId="left"
            stroke={axis}
            tick={{ fill: muted, fontSize: 10 }}
            tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))}
            label={{ value: leftUnit, angle: -90, position: 'insideLeft', fill: muted, fontSize: 10 }}
          />
          {rightUnit && (
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={axis}
              tick={{ fill: muted, fontSize: 10 }}
              tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))}
              label={{ value: rightUnit, angle: 90, position: 'insideRight', fill: muted, fontSize: 10 }}
            />
          )}
          <Tooltip
            contentStyle={{
              background: cssVar('--s-raised'),
              border: `1px solid ${cssVar('--b-strong')}`,
              borderRadius: 3,
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: cssVar('--t-primary'),
            }}
            labelFormatter={(v: number | string) => `t = ${Number(v).toFixed(3)} s`}
          />
          <Legend
            verticalAlign="top"
            height={22}
            iconType="plainline"
            wrapperStyle={{ fontSize: 11, color: muted }}
          />

          {/*
            * Peak pressure with its uncertainty band.
            *
            * The band is the whole argument of this tool: a peak drawn as one
            * crisp line implies a precision the model does not have.
            */}
          {peakPc && leftUnit === 'MPa' && (
            <>
              <ReferenceLine
                yAxisId="left"
                y={peakPc.value * (1 + peakPc.relative)}
                stroke={cssVar('--sem-warn')}
                strokeDasharray="2 3"
                strokeOpacity={0.5}
              />
              <ReferenceLine
                yAxisId="left"
                y={peakPc.value * (1 - peakPc.relative)}
                stroke={cssVar('--sem-warn')}
                strokeDasharray="2 3"
                strokeOpacity={0.5}
                label={{
                  value: `peak ±${(peakPc.relative * 100).toFixed(0)}%`,
                  position: 'insideBottomRight',
                  fill: cssVar('--sem-warn'),
                  fontSize: 9,
                }}
              />
            </>
          )}

          {drawable.map((s) => (
            <Line
              key={s.key}
              yAxisId={axisFor(s)}
              type="monotone"
              dataKey={s.key}
              // "Kn (Kn)" reads badly: a few channels are their own unit,
              // so the unit is only appended when it adds something.
              name={s.unit === s.label ? s.label : `${s.label} (${s.unit})`}
              stroke={cssVar(s.color)}
              strokeWidth={1.6}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default BallisticsChart;
