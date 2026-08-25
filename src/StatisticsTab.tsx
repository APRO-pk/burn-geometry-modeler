import React from 'react';
import { ModelUncertaintyPanel } from './ModelUncertaintyPanel';
import type { MotorMetrics } from './motorMetrics';
import type { BurnRateRegime } from './wasmCore';

/**
 * Motor Statistics: the summary table, and the model-uncertainty budget that
 * says how much of it to believe.
 *
 * Read-only. Every value is derived from the last run, so this component owns
 * no state and needs no callbacks.
 */
export interface StatisticsTabProps {
  metrics: MotorMetrics | null;
  throatDiameter: number;
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

export function StatisticsTab({
  metrics,
  throatDiameter,
  grainKind,
  n,
  propellantName,
  burnRateRegimes,
  erosiveModel,
  erosiveFraction,
  nozzleMaterial,
}: StatisticsTabProps) {
  return (
            <div className="flex-1 bg-black border border-[var(--b-control)] relative flex flex-col items-center justify-start overflow-y-auto custom-scrollbar p-6">
              <div className="absolute top-1 left-2 z-10 text-[var(--sem-ok)] text-[10px] font-mono">Motor Statistics & Summary</div>
              
              {metrics ? (
                <div className="w-full max-w-4xl space-y-4 mt-6">
                  <div className="bg-[var(--s-canvas)] border border-[var(--b-soft)] p-5 rounded-md shadow-lg text-[var(--t-primary)]">
                    <div className="text-[12px] uppercase font-bold text-[var(--t-secondary)] border-b border-[var(--b-control)] pb-2 mb-4 tracking-wider">Comprehensive Performance Data</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8 text-sm font-mono">
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Motor Designation:</span>
                        <span className="text-white">{(metrics.totalImpulse > 0 && metrics.totalImpulse < 100000) ? 
                          String.fromCharCode(65 + Math.min(25, Math.floor(Math.log2(metrics.totalImpulse / 2.5)))) : 'M'} ({(metrics.volumeLoading * 100).toFixed(0)}%)</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Average Pressure:</span>
                        <span className="text-white">{(metrics.avgPc / 6894.76).toFixed(2)} psi / {(metrics.avgPc / 1e6).toFixed(2)} MPa</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Propellant Mass:</span>
                        <span className="text-white">{(metrics.propMass * 2.20462).toFixed(2)} lb / {metrics.propMass.toFixed(2)} kg</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Impulse:</span>
                        <span className="text-white">{metrics.totalImpulse.toFixed(2)} Ns</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Peak Pressure:</span>
                        <span className="text-white">{(metrics.maxPc / 6894.76).toFixed(2)} psi / {(metrics.maxPc / 1e6).toFixed(2)} MPa</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Propellant Length:</span>
                        <span className="text-white">{(length * 39.3701).toFixed(2)} in / {(length * 1000).toFixed(1)} mm</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Delivered ISP:</span>
                        <span className="text-white">{metrics.isp.toFixed(2)} s</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Initial Kn:</span>
                        <span className="text-white">{metrics.initialKn.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Port/Throat Ratio:</span>
                        <span className="text-white">{metrics.portThroatRatio.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Burn Time:</span>
                        <span className="text-white">{metrics.actionTime.toFixed(2)} s</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Peak Kn:</span>
                        <span className="text-white">{metrics.peakKn.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Peak Mass Flux:</span>
                        <span className="text-white">{(metrics.peakMassFlux * 0.00142233).toFixed(2)} lb/(in²·s)</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Volume Loading:</span>
                        <span className="text-white">{(metrics.volumeLoading * 100).toFixed(2)}%</span>
                      </div>
                      <div className="flex justify-between border-b border-[var(--b-strong)] pb-1">
                        <span className="text-[var(--t-secondary)]">Thrust Coefficient:</span>
                        <span className="text-white">{(metrics.maxThrust / (metrics.maxPc * Math.PI * Math.pow(throatDiameter/2, 2))).toFixed(2)}</span>
                      </div>
                    </div>
                  </div>

                  {/*
                    * Every number above is printed to several significant
                    * figures. This says how many of them mean anything.
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
              ) : (
                <div className="text-[var(--t-muted)] italic font-mono text-xs">Run a simulation to view motor statistics.</div>
              )}
            </div>
  );
}

export default StatisticsTab;
