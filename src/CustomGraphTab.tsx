import React, { useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { Checkbox, FieldGroup } from './ui/primitives';
import { SERIES } from './BallisticsChart';

/**
 * Custom Graph: plot any channel against any x-axis.
 *
 * The distinction from the Ballistics trace is the X AXIS. That view is always
 * against time, which is what you want for a thrust curve; this one plots
 * against regression depth or remaining web, which is how you see whether a
 * grain is progressive independently of how fast it happens to be burning.
 *
 * Channels come from the same SERIES list the main trace uses, so a channel is
 * the same name and the same colour wherever it appears. This file previously
 * kept its own parallel list with its own palette, which meant chamber pressure
 * was blue in one tab and something else in the other.
 *
 * The axis selection is state only this view uses, so it lives here.
 */

/** What the horizontal axis can be, and the column each reads from. */
const X_AXES = [
  { label: 'Time', key: 'Time', unit: 's' },
  { label: 'Regression depth', key: 'Regression_mm', unit: 'mm' },
  { label: 'Web remaining', key: 'Web_mm', unit: 'mm' },
] as const;

type XAxisKey = (typeof X_AXES)[number]['label'];

export interface CustomGraphTabProps {
  /** One row per timestep, with every plottable channel in display units. */
  chartData: Array<Record<string, number>>;
  /** BATES segment count, shown alongside the trace. */
  numSegments: number;
}

export function CustomGraphTab({ chartData, numSegments }: CustomGraphTabProps) {
  const [xAxis, setXAxis] = useState<XAxisKey>('Time');
  const [enabled, setEnabled] = useState<string[]>(['Kn', 'Pc_MPa', 'Thrust_kN']);

  const x = X_AXES.find((a) => a.label === xAxis) ?? X_AXES[0];
  const active = SERIES.filter((s) => enabled.includes(s.key));

  return (
    <div className="cg-split">
      <aside className="cg-side" aria-label="Graph controls">
        <FieldGroup title="X axis">
          {/*
            * A fieldset, because these are one choice among several -- a bare
            * stack of radios gives a screen reader no idea what they belong to.
            */}
          <fieldset className="cg-fieldset">
            <legend className="cg-legend">Plot against</legend>
            {X_AXES.map((a) => (
              <label key={a.label} className="ui-check">
                <input
                  type="radio"
                  name="cg-x-axis"
                  value={a.label}
                  checked={xAxis === a.label}
                  onChange={() => setXAxis(a.label)}
                />
                <span className="ui-check-label">
                  {a.label} <span style={{ color: 'var(--t-muted)' }}>({a.unit})</span>
                </span>
              </label>
            ))}
          </fieldset>
        </FieldGroup>

        <FieldGroup title="Channels">
          {SERIES.map((s) => (
            <Checkbox
              key={s.key}
              checked={enabled.includes(s.key)}
              swatch={s.color}
              label={
                <>
                  {s.label}{' '}
                  <span style={{ color: 'var(--t-muted)' }}>
                    {s.unit === s.label ? '' : `(${s.unit})`}
                  </span>
                </>
              }
              onChange={(on) =>
                setEnabled((prev) => (on ? [...prev, s.key] : prev.filter((k) => k !== s.key)))
              }
            />
          ))}
        </FieldGroup>

        <FieldGroup title="Grains" defaultOpen={false}>
          <p className="unc-note">
            All {numSegments} segment{numSegments === 1 ? '' : 's'} are plotted together. The
            solver treats a BATES stack as one burning surface, so there is no per-segment trace
            to separate.
          </p>
        </FieldGroup>
      </aside>

      <div className="chart-frame">
        <div className="chart-caption">
          {active.length
            ? `${active.length} channel${active.length === 1 ? '' : 's'} against ${x.label.toLowerCase()}`
            : 'No channels selected'}
        </div>
        {!chartData.length ? (
          <div className="tab-empty">Run a simulation to plot a trace.</div>
        ) : !active.length ? (
          <div className="tab-empty">Select at least one channel from the left.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 24, right: 22, bottom: 22, left: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--c-grid)" />
              <XAxis
                dataKey={x.key}
                type="number"
                domain={['dataMin', 'dataMax']}
                stroke="var(--c-axis)"
                tick={{ fill: 'var(--t-muted)', fontSize: 10 }}
                tickFormatter={(v: number) => v.toFixed(2)}
                label={{
                  value: `${x.label} (${x.unit})`,
                  position: 'insideBottom',
                  offset: -14,
                  fill: 'var(--t-muted)',
                  fontSize: 10,
                }}
              />
              <YAxis
                stroke="var(--c-axis)"
                tick={{ fill: 'var(--t-muted)', fontSize: 10 }}
                domain={['auto', 'auto']}
                tickFormatter={(v: number) =>
                  Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(1)
                }
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--s-raised)',
                  border: '1px solid var(--b-strong)',
                  borderRadius: 0,
                  color: 'var(--t-primary)',
                  fontSize: 11,
                  fontFamily: 'var(--font)',
                }}
              />
              <Legend
                verticalAlign="top"
                height={20}
                iconType="plainline"
                wrapperStyle={{ fontSize: 11 }}
              />
              {active.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.unit === s.label ? s.label : `${s.label} (${s.unit})`}
                  stroke={s.color}
                  strokeWidth={1.6}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

export default CustomGraphTab;
