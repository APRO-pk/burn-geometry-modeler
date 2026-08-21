import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
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
    return { text: 'text-[#ff8866]', border: 'border-[#663322]', bg: 'bg-[#1a0d08]' };
  }
  if (u.relative >= 0.10) {
    return { text: 'text-[#ffcc66]', border: 'border-[#665522]', bg: 'bg-[#1a1508]' };
  }
  return { text: 'text-[#00ffaa]', border: 'border-[#225544]', bg: 'bg-[#081a14]' };
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
      className="bg-[#111] border border-[#333] p-5 rounded-md shadow-lg w-full"
      aria-labelledby="model-uncertainty-heading"
    >
      <h3
        id="model-uncertainty-heading"
        className="font-mono font-bold text-[#00aaff] mb-1 pb-2 border-b border-[#333] text-sm tracking-wide"
      >
        MODEL UNCERTAINTY
      </h3>
      <p className="text-[10px] text-[#777] leading-snug mb-4 mt-2">
        Known error of the approximations this solver makes, propagated to each output. These are
        measured against independent references, not fitted to firings — so treat them as a{' '}
        <span className="text-[#999]">floor</span> on the error, not a bound. Real hardware also
        varies by propellant batch, grain defects and machining, which no model here can see.
      </p>

      <ul className="space-y-2">
        {budget.map((u) => {
          const tone = toneFor(u);
          const isOpen = open === u.output;
          const units = inUnits(u, props);
          return (
            <li key={u.output} className={`border ${tone.border} ${tone.bg} rounded`}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : u.output)}
                aria-expanded={isOpen}
                className="w-full flex items-center justify-between p-3 text-left hover:bg-[#ffffff08] focus:outline-none focus-visible:ring-1 focus-visible:ring-[#00aaff] rounded"
              >
                <span className="flex items-center gap-2">
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="text-[#ddd] text-[11px] font-semibold">{u.label}</span>
                  {u.orderOfMagnitudeOnly && (
                    <AlertTriangle size={11} className="text-[#ff8866]" aria-hidden="true" />
                  )}
                </span>
                <span className={`${tone.text} font-mono text-[12px] font-bold`}>
                  {formatBand(u)}
                </span>
              </button>

              {isOpen && (
                <div className="px-3 pb-3 pt-0 space-y-2">
                  {units && (
                    <p className="text-[10px] text-[#999] font-mono">
                      Predicted range: <span className="text-[#ccc]">{units}</span>
                    </p>
                  )}
                  {u.orderOfMagnitudeOnly && (
                    <p className="text-[10px] text-[#ff8866] leading-snug">
                      This output is <strong>order-of-magnitude only</strong>. The model behind it is
                      uncalibrated in this repository — use it to compare designs, not to size
                      hardware.
                    </p>
                  )}
                  <div>
                    <p className="text-[9px] text-[#666] uppercase tracking-wide mb-1">
                      Contributions, largest first
                    </p>
                    <ul className="space-y-1.5">
                      {u.contributions.map((c) => (
                        <li key={c.name} className="text-[10px] leading-snug">
                          <span className="text-[#bbb]">{c.name}</span>{' '}
                          <span className="font-mono text-[#888]">
                            ±{(c.relative * 100).toFixed(c.relative < 0.1 ? 1 : 0)}%
                          </span>
                          <br />
                          <span className="text-[#666]">{c.basis}</span>
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
        <div className="border border-[#333] rounded p-3 bg-[#0c0c0c] mt-4">
          <p className="text-[#888] font-bold mb-2 text-[11px]">
            GRAIN MODEL: {props.grainKind.toUpperCase()}
          </p>
          <ul className="space-y-1.5 text-[10px] text-[#777] leading-snug">
            <li>
              • Burning area vs polygon ground truth:{' '}
              <span className="text-[#aaa] font-mono">
                {(geom.impulseWeightedError * 100).toFixed(2)}%
              </span>{' '}
              weighted by area, {(geom.mainBurnError * 100).toFixed(2)}% through the main burn.
            </li>
            <li>
              • Total burned volume, which sets impulse:{' '}
              <span className="text-[#aaa] font-mono">
                {geom.volumeError >= 0 ? '+' : ''}
                {(geom.volumeError * 100).toFixed(2)}%
              </span>
              .
            </li>
            {geom.maxAnalyticStep > 0.2 && (
              <li className="text-[#ffcc66]">
                • Burning area steps{' '}
                <span className="font-mono">{(geom.maxAnalyticStep * 100).toFixed(0)}%</span> at{' '}
                {(geom.maxAnalyticStepAt * 100).toFixed(0)}% web, where the geometry changes
                topology. The solver integrates straight through; real hardware rounds this off.
              </li>
            )}
            {geom.burnoutOverrun > 0.02 && (
              <li className="text-[#ffcc66]">
                • This model keeps burning for{' '}
                <span className="font-mono">{(geom.burnoutOverrun * 100).toFixed(0)}%</span> of the
                web after the geometry says the grain is consumed, inflating burn time and impulse.
              </li>
            )}
            {geom.signFlips && (
              <li>
                • The error changes sign through the burn, so no single correction factor can remove
                it — one half would get worse.
              </li>
            )}
            {geom.impulseWeightedError < 0.001 && (
              <li className="text-[#00ffaa]">
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
