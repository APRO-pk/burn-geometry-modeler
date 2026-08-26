import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Warning } from './ui/icons';
import {
  modelUncertainty,
  formatBand,
  geometryErrors,
  type UncertaintyInputs,
  type OutputUncertainty,
} from './modelUncertainty';

/**
 * Per-output model uncertainty for the ballistics side.
 *
 * The structural tab has always ended with FLAGS and ASSUMPTIONS panels, so a
 * user could see what the analysis took for granted. The ballistics tab had no
 * equivalent: it printed a peak pressure to four significant figures and left
 * the reader to guess whether that meant anything. This panel is the missing
 * half, and it deliberately reuses the structural tab's visual language so the
 * two read as the same idea.
 *
 * Every number shown here is measured by a test in this repository. Nothing is
 * a guess presented as data, and the cases where there IS no measurement say so
 * in those words.
 */

export interface ModelUncertaintyPanelProps extends UncertaintyInputs {
  /** Predicted values, so the band can be shown in engineering units too. */
  peakPressurePa?: number;
  totalImpulseNs?: number;
  burnTimeS?: number;
}

/** Colour by how much the number should be trusted. */
function toneFor(u: OutputUncertainty): { text: string; border: string; bg: string } {
  if (u.orderOfMagnitudeOnly || u.relative >= 0.25) {
    return { text: 'text-[var(--sem-danger)]', border: 'border-[var(--sem-danger)]', bg: 'bg-[var(--sem-danger-wash)]' };
  }
  if (u.relative >= 0.10) {
    return { text: 'text-[var(--sem-warn)]', border: 'border-[var(--sem-warn)]', bg: 'bg-[var(--sem-warn-wash)]' };
  }
  return { text: 'text-[var(--sem-ok)]', border: 'border-[var(--sem-ok)]', bg: 'bg-[var(--sem-ok-wash)]' };
}

function inUnits(u: OutputUncertainty, props: ModelUncertaintyPanelProps): string | null {
  if (u.relative >= 1) return null; // a multiple, not a band; units would mislead
  const band = (v: number, fmt: (x: number) => string) =>
    `${fmt(v * (1 - u.relative))} to ${fmt(v * (1 + u.relative))}`;
  switch (u.output) {
    case 'peak_pressure':
      return props.peakPressurePa
        ? band(props.peakPressurePa, (x) => `${(x / 1e6).toFixed(2)} MPa`)
        : null;
    case 'total_impulse':
      return props.totalImpulseNs ? band(props.totalImpulseNs, (x) => `${x.toFixed(0)} N·s`) : null;
    case 'burn_time':
      return props.burnTimeS ? band(props.burnTimeS, (x) => `${x.toFixed(3)} s`) : null;
    default:
      return null;
  }
}

export function ModelUncertaintyPanel(props: ModelUncertaintyPanelProps) {
  const [open, setOpen] = useState<string | null>(null);
  const budget = useMemo(
    () =>
      modelUncertainty({
        grainKind: props.grainKind,
        n: props.n,
        hasBurnRateRegimes: props.hasBurnRateRegimes,
        propellantName: props.propellantName,
        erosiveModel: props.erosiveModel,
        hasNozzleMaterial: props.hasNozzleMaterial,
        erosiveFraction: props.erosiveFraction,
      }),
    [
      props.grainKind,
      props.n,
      props.hasBurnRateRegimes,
      props.propellantName,
      props.erosiveModel,
      props.hasNozzleMaterial,
      props.erosiveFraction,
    ]
  );

  const geom = geometryErrors[props.grainKind];

  return (
    <section
      className="bg-[var(--s-canvas)] border border-[var(--b-soft)] p-5 w-full"
      aria-labelledby="model-uncertainty-heading"
    >
      <h3
        id="model-uncertainty-heading"
        className="font-mono font-bold text-[var(--a-accent)] mb-1 pb-2 border-b border-[var(--b-soft)] text-sm tracking-wide"
      >
        MODEL UNCERTAINTY
      </h3>
      {/*
        * One line, not a paragraph.
        *
        * The full reasoning is in MODEL_UNCERTAINTY.md; repeating it above the
        * numbers meant four lines of prose between the reader and the thing
        * they opened the tab for. The essential caveat -- floor, not bound --
        * is the only part that changes how you read the figures.
        */}
      <p className="mu-intro">
        Measured model error, propagated. A <strong>floor</strong> on the error, not a bound. Batch, casting and machining variation are invisible to any solver.
      </p>

      <ul className="space-y-2">
        {budget.map((u) => {
          const tone = toneFor(u);
          const isOpen = open === u.output;
          const units = inUnits(u, props);
          return (
            <li key={u.output} className={`border ${tone.border} ${tone.bg} `}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : u.output)}
                aria-expanded={isOpen}
                className="w-full flex items-center justify-between p-3 text-left hover:bg-[var(--s-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--a-accent)]"
              >
                <span className="flex items-center gap-2">
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="text-[var(--t-primary)] text-[11px] font-semibold">{u.label}</span>
                  {u.orderOfMagnitudeOnly && (
                    <Warning size={11} className="text-[var(--sem-danger)]" aria-hidden="true" />
                  )}
                </span>
                <span className={`${tone.text} font-mono text-[12px] font-bold`}>
                  {formatBand(u)}
                </span>
              </button>

              {isOpen && (
                <div className="px-3 pb-3 pt-0 space-y-2">
                  {units && (
                    <p className="text-[10px] text-[var(--t-secondary)] font-mono">
                      Predicted range: <span className="text-[var(--t-primary)]">{units}</span>
                    </p>
                  )}
                  {u.orderOfMagnitudeOnly && (
                    <p className="mu-warn">
                      <strong>Order of magnitude only</strong>: uncalibrated here. Compare designs
                      with it; do not size hardware.
                    </p>
                  )}
                  <div>
                    <p className="text-[9px] text-[var(--t-muted)] uppercase tracking-wide mb-1">
                      Contributions, largest first
                    </p>
                    <ul className="space-y-1.5">
                      {u.contributions.map((c) => (
                        <li key={c.name} className="text-[10px] leading-snug">
                          <span className="text-[var(--t-primary)]">{c.name}</span>{' '}
                          <span className="font-mono text-[var(--t-secondary)]">
                            ±{(c.relative * 100).toFixed(c.relative < 0.1 ? 1 : 0)}%
                          </span>
                          <br />
                          <span className="text-[var(--t-muted)]">{c.basis}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {geom && (
        <div className="border border-[var(--b-soft)] p-3 bg-[var(--s-canvas)] mt-4">
          <p className="text-[var(--t-secondary)] font-bold mb-2 text-[11px]">
            GRAIN MODEL: {props.grainKind.toUpperCase()}
          </p>
          <ul className="space-y-1.5 text-[10px] text-[var(--t-muted)] leading-snug">
            <li>
              • Burning area vs polygon ground truth:{' '}
              <span className="text-[var(--t-secondary)] font-mono">
                {(geom.impulseWeightedError * 100).toFixed(2)}%
              </span>{' '}
              weighted by area, {(geom.mainBurnError * 100).toFixed(2)}% through the main burn.
            </li>
            <li>
              • Total burned volume, which sets impulse:{' '}
              <span className="text-[var(--t-secondary)] font-mono">
                {geom.volumeError >= 0 ? '+' : ''}
                {(geom.volumeError * 100).toFixed(2)}%
              </span>
              .
            </li>
            {geom.maxAnalyticStep > 0.2 && (
              <li className="text-[var(--sem-warn)]">
                • Burning area steps{' '}
                <span className="font-mono">{(geom.maxAnalyticStep * 100).toFixed(0)}%</span> at{' '}
                {(geom.maxAnalyticStepAt * 100).toFixed(0)}% web, where the geometry changes
                topology. The solver integrates straight through; real hardware rounds this off.
              </li>
            )}
            {geom.burnoutOverrun > 0.02 && (
              <li className="text-[var(--sem-warn)]">
                • This model keeps burning for{' '}
                <span className="font-mono">{(geom.burnoutOverrun * 100).toFixed(0)}%</span> of the
                web after the geometry says the grain is consumed, inflating burn time and impulse.
              </li>
            )}
            {geom.signFlips && (
              <li>
                • The error changes sign through the burn, so no single correction factor can remove
                it, because one half would get worse.
              </li>
            )}
            {geom.impulseWeightedError < 0.001 && (
              <li className="text-[var(--sem-ok)]">
                • This geometry's burning-area expression is analytically exact; the residual is
                polygon discretisation, not model error.
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

export default ModelUncertaintyPanel;
