import React from 'react';
import { ModelUncertaintyPanel } from './ModelUncertaintyPanel';
import type { MotorMetrics } from './motorMetrics';
import type { BurnRateRegime } from './wasmCore';

/**
 * Motor Statistics: the summary table, and the model-uncertainty budget that
 * says how much of it to believe.
 *
 * Read-only. Every value derives from the last run, so this component owns no
 * state and needs no callbacks.
 *
 * The rows are DATA rather than hand-written markup. Fourteen near-identical
 * blocks of JSX had already drifted -- different separators, one row missing
 * its bottom rule, imperial units on some and not others -- and a list makes
 * adding a metric a one-line change instead of a copy-paste.
 */

export interface StatisticsTabProps {
  metrics: MotorMetrics | null;
  throatDiameter: number;
  /**
   * Grain length, metres.
   *
   * Explicitly a prop because it was previously a bare `length`, which
   * TypeScript happily resolved to the DOM global `window.length` -- the frame
   * count, always 0. The readout showed "0.00 in / 0.0 mm" and nothing
   * complained, because it is a legitimate global of the right type.
   */
  grainLength: number;
  /** Inputs to the uncertainty budget -- see src/modelUncertainty.ts. */
  grainKind: string;
  n: number;
  propellantName: string;
  burnRateRegimes: BurnRateRegime[];
  erosiveModel: string;
  /** Peak erosive augmentation as a fraction of base burn rate, if recoverable. */
  erosiveFraction: number | undefined;
  nozzleMaterial: string;
}

interface Row {
  key: string;
  value: string;
  /** A converted or secondary reading, shown smaller beside the value. */
  sub?: string;
  tone?: 'ok' | 'warn' | 'danger';
  hint?: string;
}

/**
 * NAR/TRA impulse class. Each class doubles from 2.5 N·s at A, so the letter is
 * log2 of the ratio; clamped at Z rather than running off the alphabet.
 */
function designation(totalImpulse: number): string {
  if (!(totalImpulse > 0)) return '—';
  const i = Math.floor(Math.log2(totalImpulse / 2.5));
  return String.fromCharCode(65 + Math.max(0, Math.min(25, i)));
}

export function StatisticsTab({
  metrics,
  throatDiameter,
  grainLength,
  grainKind,
  n,
  propellantName,
  burnRateRegimes,
  erosiveModel,
  erosiveFraction,
  nozzleMaterial,
}: StatisticsTabProps) {
  if (!metrics) {
    return <div className="tab-empty">Run a simulation to view motor statistics.</div>;
  }

  const throatArea = Math.PI * (throatDiameter / 2) ** 2;
  const cf = metrics.maxThrust / (metrics.maxPc * throatArea);

  const performance: Row[] = [
    {
      key: 'Motor designation',
      value: `${designation(metrics.totalImpulse)} (${(metrics.volumeLoading * 100).toFixed(0)}%)`,
      hint: 'NAR/TRA impulse class, and volume loading',
    },
    { key: 'Total impulse', value: `${metrics.totalImpulse.toFixed(0)} N·s` },
    { key: 'Delivered Isp', value: `${metrics.isp.toFixed(1)} s` },
    { key: 'Burn time', value: `${metrics.actionTime.toFixed(3)} s` },
    {
      key: 'Peak thrust',
      value: `${(metrics.maxThrust / 1000).toFixed(2)} kN`,
      sub: `${(metrics.maxThrust * 0.224809).toFixed(0)} lbf`,
    },
    { key: 'Average thrust', value: `${(metrics.avgThrust / 1000).toFixed(2)} kN` },
  ];

  const pressure: Row[] = [
    {
      key: 'Peak pressure',
      value: `${(metrics.maxPc / 1e6).toFixed(2)} MPa`,
      sub: `${(metrics.maxPc / 6894.76).toFixed(0)} psi`,
    },
    {
      key: 'Average pressure',
      value: `${(metrics.avgPc / 1e6).toFixed(2)} MPa`,
      sub: `${(metrics.avgPc / 6894.76).toFixed(0)} psi`,
    },
    { key: 'Initial Kn', value: metrics.initialKn.toFixed(1) },
    {
      key: 'Peak Kn',
      value: metrics.peakKn.toFixed(1),
      // Above ~400 the chamber is running far from where these models were
      // calibrated, and the solver raises a stability warning of its own.
      tone: metrics.peakKn > 400 ? 'warn' : undefined,
      hint: metrics.peakKn > 400 ? 'Very high; risk of over-pressure' : undefined,
    },
    {
      key: 'Port / throat ratio',
      value: metrics.portThroatRatio.toFixed(2),
      tone: metrics.portThroatRatio < 2 ? 'warn' : undefined,
      hint:
        metrics.portThroatRatio < 2
          ? 'Below 2, erosive burning dominates — and that model is uncalibrated here'
          : undefined,
    },
    {
      key: 'Peak mass flux',
      value: `${metrics.peakMassFlux.toFixed(1)} kg/m²s`,
    },
  ];

  const geometry: Row[] = [
    {
      key: 'Propellant mass',
      value: `${metrics.propMass.toFixed(3)} kg`,
      sub: `${(metrics.propMass * 2.20462).toFixed(2)} lb`,
    },
    {
      key: 'Propellant length',
      value: `${(grainLength * 1000).toFixed(1)} mm`,
      sub: `${(grainLength * 39.3701).toFixed(2)} in`,
    },
    { key: 'Volume loading', value: `${(metrics.volumeLoading * 100).toFixed(2)} %` },
    {
      key: 'Throat diameter',
      value: `${(throatDiameter * 1000).toFixed(2)} mm`,
      sub: `${(throatDiameter * 39.3701).toFixed(3)} in`,
    },
    { key: 'Thrust coefficient', value: cf.toFixed(3) },
    {
      key: 'Required wall',
      value: `${(metrics.requiredThickness * 1000).toFixed(2)} mm`,
      hint: 'Thin-wall sizing rule; see the Structural tab for the real stress state',
    },
  ];

  const section = (title: string, rows: Row[]) => (
    <section className="sec">
      <header className="sec-head">{title}</header>
      <div className="kv">
        {rows.map((r) => (
          <div className="kv-row" key={r.key} title={r.hint}>
            <span className="kv-key">{r.key}</span>
            <span className={`kv-val ${r.tone ? `is-${r.tone}` : ''}`}>
              {r.value}
              {r.sub && <span className="kv-sub">{r.sub}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div className="tab-scroll">
      <div className="tab-doc">
        {section('Performance', performance)}
        {section('Chamber & flow', pressure)}
        {section('Geometry & mass', geometry)}

        {/*
          * Every number above is printed to several significant figures. This
          * says how many of them mean anything.
          */}
        <ModelUncertaintyPanel
          grainKind={grainKind}
          n={n}
          hasBurnRateRegimes={burnRateRegimes.length > 0}
          propellantName={propellantName}
          erosiveModel={erosiveModel}
          erosiveFraction={erosiveFraction}
          hasNozzleMaterial={!!nozzleMaterial}
          peakPressurePa={metrics.maxPc}
          totalImpulseNs={metrics.totalImpulse}
          burnTimeS={metrics.actionTime}
        />
      </div>
    </div>
  );
}

export default StatisticsTab;
