import React, { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
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
import type { StructuralResult } from './wasmCore';
import type { MotorMetrics } from './motorMetrics';
import type { SimulationResult } from './engine';

/**
 * The Structural & Erosion Analysis view.
 *
 * Lifted out of AppDesktop, where it was 406 lines of inline JSX inside a
 * component that was already 3,400 lines long. It is the largest single tab and
 * the easiest to move, because it is READ-ONLY: it renders results and owns no
 * state, so extracting it needs nine props and no callbacks. The inputs it
 * displays results for live in the Material Properties tab.
 *
 * Everything here is presentation. The analysis itself is done in Rust
 * (crates/burn-core/src/structural.rs) and reaches this component already
 * computed, so there is no physics in this file to get wrong.
 */
export interface StructuralTabProps {
  /** Lamé, edge-bending and bolt results, or undefined before a run. */
  structural: StructuralResult | undefined;
  /** Summary numbers from the last simulation. */
  metrics: MotorMetrics | null;
  /** Full trace, for the erosion history chart. */
  results: SimulationResult[];
  /** Case geometry and material, echoed alongside the results. */
  caseWallThickness: number;
  casingMaterial: string;
  casingYieldStress: number;
  outerRadius: number;
  throatDiameter: number;
  nozzleMaterial: string;
  /** Disables the export buttons while a solve is in flight. */
  isSimulating: boolean;
  onExportCasingSTL: () => void;
  onExportCasingSCAD: () => void;
}

export function StructuralTab({
  structural,
  metrics,
  results,
  caseWallThickness,
  casingMaterial,
  casingYieldStress,
  outerRadius,
  throatDiameter,
  nozzleMaterial,
  isSimulating,
  onExportCasingSTL,
  onExportCasingSCAD,
}: StructuralTabProps) {
  /*
   * State and derived data that only this tab uses.
   *
   * All three lived in AppDesktop purely because the JSX did. Nothing outside
   * this view reads them, and both charts are pure functions of `structural`,
   * so they belong here -- that is three fewer things in a component that had
   * too many.
   */
  const [showFEA, setShowFEA] = useState(false);

  const lameChart = useMemo(() => {
    if (!structural) return [];
    const p = structural.lame.profile;
    return Array.from({ length: p.position.length }, (_, i) => ({
      r_mm: p.position[i] * 1000,
      hoop: p.hoop[i] / 1e6,
      radial: p.radial[i] / 1e6,
      axial: p.axial[i] / 1e6,
      vonMises: p.vonMises[i] / 1e6,
    }));
  }, [structural]);

  const edgeChart = useMemo(() => {
    if (!structural) return [];
    const p = structural.edge.profile;
    return Array.from({ length: p.position.length }, (_, i) => ({
      x_mm: p.position[i] * 1000,
      hoop: p.hoop[i] / 1e6,
      axial: p.axial[i] / 1e6,
      vonMises: p.vonMises[i] / 1e6,
    }));
  }, [structural]);

  return (
            <div className="flex-1 bg-black border border-[#555] relative flex flex-col items-center justify-start overflow-y-auto custom-scrollbar p-6">
              <div className="absolute top-1 left-2 z-10 flex items-center space-x-4">
                <span className="text-[#00aaff] text-[10px] font-mono">Structural & Erosion Analysis</span>
                <label className="flex items-center space-x-1 cursor-pointer">
                  <input type="checkbox" checked={showFEA} onChange={e => setShowFEA(e.target.checked)} className="accent-[#00aaff]" />
                  <span className="text-[10px] text-[#eee] font-mono">2D FEA Visualization Mode</span>
                </label>
              </div>

              {metrics && structural && results.length > 0 ? (
                <div className="w-full max-w-4xl space-y-6 mt-6">
                  {/* Casing Integrity Panel */}
                  <div className="bg-[#111] border border-[#333] p-5 rounded-md shadow-lg w-full">
                    <div className="flex justify-between items-end border-b border-[#333] pb-2 mb-4">
                      <h3 className="font-mono font-bold text-[#00aaff] text-sm tracking-wide">CASING INTEGRITY & BOLTED CLOSURE</h3>
                      {metrics && (
                        <div className="flex space-x-2">
                          <button onClick={onExportCasingSTL} disabled={isSimulating} className="flex items-center space-x-1 border border-[#666] rounded px-2 py-1 text-xs bg-[#222] text-[#eee] hover:bg-[#333] hover:text-[#fff] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Export .stl format for additive manufacturing">
                            <Download className="w-3 h-3" />
                            <span>AM (.stl)</span>
                          </button>
                          <button onClick={onExportCasingSCAD} disabled={isSimulating} className="flex items-center space-x-1 border border-[#666] rounded px-2 py-1 text-xs bg-[#222] text-[#eee] hover:bg-[#333] hover:text-[#fff] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Export .scad format. OpenSCAD or FreeCAD can export this to STEP or Parasolid.">
                            <Download className="w-3 h-3" />
                            <span>CAD Base (.scad)</span>
                          </button>
                        </div>
                      )}
                    </div>
                    
                    {showFEA ? (
                      <div className="flex flex-col items-center space-y-4">
                        <p className="text-xs text-[#888] font-mono self-start">2D Axisymmetric FEA (von Mises Stress Distribution)</p>
                        {/* Advanced SVG FEA Visualizer */}
                        <div className="relative w-full h-40 border border-[#444] bg-[#222] rounded overflow-hidden flex flex-col items-center justify-center">
                          
                          {/* Color logic: Map vonMises / yieldStress to a color hue mapping */}
                          {(() => {
                            const vMises = structural.maxVonMises;
                            const yieldStress = casingYieldStress * 1e6;
                            const stressRatio = Math.min(1.2, vMises / yieldStress); // capping at 1.2
                            
                            // Hues: Blue (240) -> Green (120) -> Yellow (60) -> Red (0)
                            const hueMain = 240 - (stressRatio * 0.8 * 240); // cylinder largely uniform hoop
                            const hueEdge = 240 - (Math.min(1.0, stressRatio * 1.5) * 240); // higher stress near closures
                            // stress logic check here, keeping original code
                            return (
                              <svg viewBox="0 0 800 200" className="w-full h-full drop-shadow-lg">
                                <defs>
                                  <linearGradient id="feaGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                                    <stop offset="0%" stopColor={`hsl(${hueEdge}, 100%, 50%)`} />
                                    <stop offset="10%" stopColor={`hsl(${hueEdge}, 100%, 50%)`} />
                                    <stop offset="25%" stopColor={`hsl(${hueMain}, 100%, 50%)`} />
                                    <stop offset="75%" stopColor={`hsl(${hueMain}, 100%, 50%)`} />
                                    <stop offset="90%" stopColor={`hsl(${hueEdge}, 100%, 50%)`} />
                                    <stop offset="100%" stopColor={`hsl(${hueEdge}, 100%, 50%)`} />
                                  </linearGradient>
                                  <linearGradient id="nozzleGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                                    <stop offset="0%" stopColor={`hsl(${hueEdge}, 100%, 40%)`} />
                                    <stop offset="100%" stopColor="hsl(240, 50%, 30%)" />
                                  </linearGradient>
                                </defs>

                                {/* Centerline */}
                                <line x1="0" y1="100" x2="800" y2="100" stroke="#555" strokeDasharray="10 5" strokeWidth="1" />

                                {/* Motor Casing Top Half */}
                                <rect x="100" y="40" width="500" height="15" fill="url(#feaGradient)" stroke="#111" strokeWidth="1" />
                                
                                {/* Motor Casing Bottom Half */}
                                <rect x="100" y="145" width="500" height="15" fill="url(#feaGradient)" stroke="#111" strokeWidth="1" />

                                {/* Forward Closure */}
                                <path d="M 100 40 Q 50 40 50 100 Q 50 160 100 160 Z" fill={`hsl(${hueEdge - 20}, 90%, 45%)`} stroke="#111" strokeWidth="1" />

                                {/* Aft Closure & Nozzle block */}
                                <rect x="600" y="30" width="30" height="140" fill={`hsl(${hueEdge}, 90%, 45%)`} stroke="#111" strokeWidth="1" />
                                <path d="M 630 80 L 700 60 L 750 20 L 750 35 L 700 85 L 630 95 Z" fill="url(#nozzleGradient)" stroke="#111" strokeWidth="1" />
                                <path d="M 630 120 L 700 140 L 750 180 L 750 165 L 700 115 L 630 105 Z" fill="url(#nozzleGradient)" stroke="#111" strokeWidth="1" />
                                
                                {/* Overlay Grid lines to indicate FEA mesh */}
                                <pattern id="mesh" width="20" height="20" patternUnits="userSpaceOnUse">
                                  <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
                                </pattern>
                                <rect x="100" y="40" width="500" height="15" fill="url(#mesh)" />
                                <rect x="100" y="145" width="500" height="15" fill="url(#mesh)" />
                                <rect x="600" y="30" width="30" height="140" fill="url(#mesh)" />

                                {/* Labels */}
                                <text x="350" y="30" fill="white" fontSize="11" fontFamily="monospace" textAnchor="middle">Bore Hoop (Lamé) ≈ {(structural.lame.inner.hoop / 1e6).toFixed(1)} MPa</text>
                                <text x="100" y="25" fill="#ff4444" fontSize="11" fontFamily="monospace" textAnchor="end">Peak von Mises ≈ {(structural.maxVonMises / 1e6).toFixed(1)} MPa</text>
                                <text x="640" y="20" fill="#ffff00" fontSize="11" fontFamily="monospace">Aft Closure Bending Moment</text>
                              </svg>
                            );
                          })()}
                        </div>
                        {/* Legend */}
                        <div className="flex items-center space-x-2 text-[10px] font-mono w-full justify-between">
                          <span className="text-[#888]">
                            Safety factor {structural.safetyFactor.toFixed(2)}x at the {structural.whereMax}.
                            Colours are indicative only &mdash; this is a schematic, not a mesh.
                          </span>
                          <div className="flex items-center space-x-2">
                            <span className="text-blue-400">Low</span>
                            <div className="w-32 h-3 bg-gradient-to-r from-blue-500 via-green-500 via-yellow-500 to-red-500 rounded border border-[#555]"></div>
                            <span className="text-red-500">Yield</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-5 text-xs font-mono">
                        {/* --- inputs governing the analysis --- */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div>
                            <p className="text-[#888] mb-1">Peak Chamber Pressure:</p>
                            <p className="text-[#ff4444] font-bold">{(metrics.maxPc / 1e6).toFixed(2)} MPa</p>
                          </div>
                          <div>
                            <p className="text-[#888] mb-1">Case Bore Radius:</p>
                            <p className="text-[#eee]">{(outerRadius * 1000).toFixed(1)} mm</p>
                          </div>
                          <div>
                            <p className="text-[#888] mb-1">Wall Thickness (analysed):</p>
                            <p className="text-[#eee]">{(caseWallThickness * 1000).toFixed(2)} mm</p>
                          </div>
                          <div>
                            <p className="text-[#888] mb-1">Material:</p>
                            <p className="text-[#eee]">{casingMaterial} &middot; {casingYieldStress} MPa yield</p>
                          </div>
                        </div>

                        {/* --- headline result --- */}
                        <div className="border border-[#333] rounded p-3 bg-[#0c0c0c] grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div>
                            <p className="text-[#888] mb-1">Peak von Mises:</p>
                            <p className="text-xl text-[#ffaa00] font-bold">{(structural.maxVonMises / 1e6).toFixed(1)} MPa</p>
                          </div>
                          <div>
                            <p className="text-[#888] mb-1">Governing Location:</p>
                            <p className="text-[#eee] leading-tight">{structural.whereMax}</p>
                          </div>
                          <div>
                            <p className="text-[#888] mb-1">Safety Factor:</p>
                            <p className={`text-xl font-bold ${structural.safetyFactor < 1 ? 'text-[#ff4444]' : structural.safetyFactor < 1.5 ? 'text-[#ffaa00]' : 'text-[#00ff00]'}`}>
                              {structural.safetyFactor.toFixed(2)}x
                            </p>
                          </div>
                          <div>
                            <p className="text-[#888] mb-1">Margin of Safety:</p>
                            <p className={`text-xl font-bold ${structural.marginOfSafety < 0 ? 'text-[#ff4444]' : 'text-[#00ff00]'}`}>
                              {structural.marginOfSafety >= 0 ? '+' : ''}{structural.marginOfSafety.toFixed(3)}
                            </p>
                          </div>
                        </div>

                        {/* --- Lame through-wall distribution --- */}
                        <div>
                          <p className="text-[#00aaff] font-bold mb-2 border-b border-[#333] pb-1">
                            THICK-WALL (LAMÉ) STRESS DISTRIBUTION
                          </p>
                          <div className="overflow-x-auto">
                            <table className="w-full text-[11px]">
                              <thead className="text-[#888]">
                                <tr>
                                  <th className="text-left py-1">Location</th>
                                  <th className="text-right py-1">Hoop σθ</th>
                                  <th className="text-right py-1">Radial σr</th>
                                  <th className="text-right py-1">Axial σz</th>
                                  <th className="text-right py-1">von Mises</th>
                                </tr>
                              </thead>
                              <tbody className="text-[#eee]">
                                <tr className="border-t border-[#222]">
                                  <td className="py-1">Inner wall (bore, r = {(outerRadius * 1000).toFixed(1)} mm)</td>
                                  <td className="text-right">{(structural.lame.inner.hoop / 1e6).toFixed(1)}</td>
                                  <td className="text-right">{(structural.lame.inner.radial / 1e6).toFixed(1)}</td>
                                  <td className="text-right">{(structural.lame.inner.axial / 1e6).toFixed(1)}</td>
                                  <td className="text-right text-[#ffaa00]">{(structural.lame.inner.vonMises / 1e6).toFixed(1)}</td>
                                </tr>
                                <tr className="border-t border-[#222]">
                                  <td className="py-1">Outer wall (r = {((outerRadius + caseWallThickness) * 1000).toFixed(1)} mm)</td>
                                  <td className="text-right">{(structural.lame.outer.hoop / 1e6).toFixed(1)}</td>
                                  <td className="text-right">{(structural.lame.outer.radial / 1e6).toFixed(1)}</td>
                                  <td className="text-right">{(structural.lame.outer.axial / 1e6).toFixed(1)}</td>
                                  <td className="text-right text-[#ffaa00]">{(structural.lame.outer.vonMises / 1e6).toFixed(1)}</td>
                                </tr>
                              </tbody>
                            </table>
                            <p className="text-[#666] text-[10px] mt-1">All values MPa. Hoop stress peaks at the bore and falls through the wall.</p>
                          </div>

                          {lameChart.length > 0 && (
                            <div className="h-40 mt-3 border border-[#333] rounded bg-[#0c0c0c]">
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={lameChart} margin={{ top: 12, right: 20, bottom: 4, left: 0 }}>
                                  <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                                  <XAxis dataKey="r_mm" type="number" domain={['dataMin', 'dataMax']} stroke="#666" tick={{ fill: '#888', fontSize: 9 }} tickFormatter={(v) => v.toFixed(1)} label={{ value: 'radius (mm)', position: 'insideBottom', offset: -2, fill: '#666', fontSize: 9 }} />
                                  <YAxis stroke="#666" tick={{ fill: '#888', fontSize: 9 }} tickFormatter={(v) => v.toFixed(0)} />
                                  <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', fontSize: '10px', fontFamily: 'monospace' }} formatter={(v: any) => `${Number(v).toFixed(1)} MPa`} />
                                  <Legend wrapperStyle={{ fontSize: '9px' }} />
                                  <Line type="monotone" dataKey="hoop" name="hoop" stroke="#00aaff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                  <Line type="monotone" dataKey="radial" name="radial" stroke="#ff00ff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                  <Line type="monotone" dataKey="axial" name="axial" stroke="#00ff88" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                  <Line type="monotone" dataKey="vonMises" name="von Mises" stroke="#ffaa00" strokeWidth={2} dot={false} isAnimationActive={false} />
                                </LineChart>
                              </ResponsiveContainer>
                            </div>
                          )}

                          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-3">
                            <div>
                              <p className="text-[#888] mb-1">Wall Regime:</p>
                              <p className={structural.lame.thinWallApplicable ? 'text-[#00ff00]' : 'text-[#ffaa00]'}>
                                {structural.lame.thinWallApplicable ? 'Thin' : 'THICK'} &mdash; R_mean/t = {structural.lame.rMeanOverT.toFixed(1)}
                              </p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Thin-wall pR/t would give:</p>
                              <p className="text-[#eee]">
                                {(structural.lame.thinWallHoop / 1e6).toFixed(1)} MPa ({(structural.lame.thinWallError * 100).toFixed(1)}% error)
                              </p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Bore Growth at Peak P:</p>
                              <p className="text-[#eee]">
                                {(structural.boreRadialGrowth * 1e6).toFixed(1)} µm ({(structural.boreHoopStrain * 100).toFixed(4)}% strain)
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* --- edge bending --- */}
                        <div>
                          <p className="text-[#00aaff] font-bold mb-2 border-b border-[#333] pb-1">
                            DISCONTINUITY STRESS AT THE CASE-TO-CLOSURE JUNCTION
                          </p>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <p className="text-[#888] mb-1">Peak Combined (von Mises):</p>
                              <p className="text-xl text-[#ffaa00] font-bold">{(structural.edge.peak.vonMises / 1e6).toFixed(1)} MPa</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Axial Location:</p>
                              <p className="text-[#eee]">
                                {(structural.edge.peakLocation * 1000).toFixed(2)} mm from joint
                                <span className="text-[#666]"> ({structural.edge.peakLocationOverChar.toFixed(2)}/β)</span>
                              </p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Critical Surface:</p>
                              <p className="text-[#eee]">{structural.edge.peakSurface === 'bore' ? 'Bore (inner)' : 'Outer'}</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Decay Length (3/β):</p>
                              <p className="text-[#eee]">{(structural.edge.decayLength * 1000).toFixed(1)} mm</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">β = [3(1&minus;ν²)/(R²t²)]<sup>1/4</sup>:</p>
                              <p className="text-[#eee]">{structural.edge.beta.toFixed(1)} m⁻¹</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Edge Moment M₀ = p/2β²:</p>
                              <p className="text-[#eee]">{structural.edge.m0.toFixed(1)} N·m/m</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Edge Shear Q₀ = &minus;p/β:</p>
                              <p className="text-[#eee]">{(structural.edge.q0 / 1000).toFixed(1)} kN/m</p>
                            </div>
                            <div>
                              <p className="text-[#888] mb-1">Bending / Membrane Hoop:</p>
                              <p className="text-[#eee]">{structural.edge.bendingToHoop.toFixed(2)}x</p>
                            </div>
                          </div>

                          {edgeChart.length > 0 && (
                            <div className="h-40 mt-3 border border-[#333] rounded bg-[#0c0c0c]">
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={edgeChart} margin={{ top: 12, right: 20, bottom: 4, left: 0 }}>
                                  <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                                  <XAxis dataKey="x_mm" type="number" domain={['dataMin', 'dataMax']} stroke="#666" tick={{ fill: '#888', fontSize: 9 }} tickFormatter={(v) => v.toFixed(0)} label={{ value: 'distance from joint (mm)', position: 'insideBottom', offset: -2, fill: '#666', fontSize: 9 }} />
                                  <YAxis stroke="#666" tick={{ fill: '#888', fontSize: 9 }} tickFormatter={(v) => v.toFixed(0)} />
                                  <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', fontSize: '10px', fontFamily: 'monospace' }} formatter={(v: any) => `${Number(v).toFixed(1)} MPa`} />
                                  <Legend wrapperStyle={{ fontSize: '9px' }} />
                                  <Line type="monotone" dataKey="hoop" name="hoop" stroke="#00aaff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                  <Line type="monotone" dataKey="axial" name="axial" stroke="#00ff88" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                  <Line type="monotone" dataKey="vonMises" name="von Mises" stroke="#ffaa00" strokeWidth={2} dot={false} isAnimationActive={false} />
                                </LineChart>
                              </ResponsiveContainer>
                            </div>
                          )}
                          <p className="text-[#666] text-[10px] mt-1">
                            Cylindrical-shell edge bending for a clamped junction. Membrane hoop stress is suppressed to
                            zero at the joint (the closure holds the radius) and recovers over ~{(structural.edge.decayLength * 1000).toFixed(0)} mm.
                          </p>
                        </div>

                        {/* --- bolted closure --- */}
                        {structural.bolts && (
                          <div>
                            <p className="text-[#00aaff] font-bold mb-2 border-b border-[#333] pb-1">
                              BOLTED CLOSURE &mdash; {structural.bolts.count} × ⌀{(structural.bolts.diameter * 1000).toFixed(1)} mm
                            </p>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                              <div>
                                <p className="text-[#888] mb-1">Total Closure Load:</p>
                                <p className="text-[#eee]">{(structural.bolts.totalForce / 1000).toFixed(2)} kN</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Load per Bolt:</p>
                                <p className="text-[#eee]">{(structural.bolts.forcePerBolt / 1000).toFixed(2)} kN</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Stress on Shank Area:</p>
                                <p className="text-[#eee]">{(structural.bolts.nominalStress / 1e6).toFixed(1)} MPa (SF {structural.bolts.safetyFactorNominal.toFixed(2)})</p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Stress on Thread Area:</p>
                                <p className={`font-bold ${structural.bolts.safetyFactorStressArea < 1.5 ? 'text-[#ff4444]' : 'text-[#00ff00]'}`}>
                                  {(structural.bolts.stressAreaStress / 1e6).toFixed(1)} MPa (SF {structural.bolts.safetyFactorStressArea.toFixed(2)})
                                </p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Flange Shear-Out:</p>
                                <p className={`${structural.bolts.safetyFactorShearOut < 1.5 ? 'text-[#ff4444]' : 'text-[#00ff00]'}`}>
                                  {(structural.bolts.shearOutStress / 1e6).toFixed(1)} MPa (SF {structural.bolts.safetyFactorShearOut.toFixed(2)})
                                </p>
                              </div>
                              <div>
                                <p className="text-[#888] mb-1">Bolt Edge Distance:</p>
                                <p className="text-[#eee]">
                                  {(structural.bolts.edgeDistance * 1000).toFixed(1)} mm
                                  <span className="text-[#666]"> (min {(structural.bolts.minEdgeDistance * 1000).toFixed(1)})</span>
                                </p>
                              </div>
                              <div className="col-span-2">
                                <p className="text-[#888] mb-1">Min Thread Engagement:</p>
                                <p className="text-[#eee]">
                                  {(structural.bolts.minEngagementSteel * 1000).toFixed(1)} mm into steel,
                                  {' '}{(structural.bolts.minEngagementAluminium * 1000).toFixed(1)} mm into aluminium
                                </p>
                              </div>
                            </div>
                            <p className="text-[#666] text-[10px] mt-2 leading-snug">
                              Design to the THREAD tensile-stress area (≈74% of the shank), not the shank. Engagement
                              shorter than the values above lets the threads strip before the bolt yields, which is the
                              failure the tension numbers do not cover. Shear-out assumes two tear planes per bolt
                              through the wall at the stated edge distance, against 0.577·σ_yield of the case material.
                            </p>
                          </div>
                        )}

                        {/* --- assumptions and warnings: the point of the exercise --- */}
                        {structural.warnings.length > 0 && (
                          <div className="border border-[#663333] bg-[#1a0d0d] rounded p-3">
                            <p className="text-[#ff6666] font-bold mb-2 text-[11px]">FLAGS</p>
                            <ul className="space-y-1.5">
                              {structural.warnings.map((w, i) => (
                                <li key={i} className="text-[#ffaaaa] text-[10px] leading-snug">• {w}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <div className="border border-[#333] rounded p-3 bg-[#0c0c0c]">
                          <p className="text-[#888] font-bold mb-2 text-[11px]">ASSUMPTIONS</p>
                          <ul className="space-y-1.5">
                            {structural.assumptions.map((a, i) => (
                              <li key={i} className="text-[#777] text-[10px] leading-snug">• {a}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {/* Nozzle Erosion Panel */}
                  <div className="bg-[#111] border border-[#333] p-5 rounded-md shadow-lg w-full">
                    <h3 className="font-mono font-bold text-[#00aaff] mb-4 pb-2 border-b border-[#333] text-sm tracking-wide">NOZZLE EROSION (CONVECTIVE MODEL)</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-xs font-mono">
                      <div>
                        <p className="text-[#888] mb-1">Throat Material:</p>
                        <p className="text-[#eee]">{nozzleMaterial}</p>
                      </div>
                      <div className="col-span-2 md:col-span-3 text-[#888] text-[10px] leading-tight flex items-center">
                        Note: Convective ablation model driven by the selected throat material's thermal properties. Bartz heat-transfer coefficient scales as Pc^0.8 * Tf^0.5 * Dt^-0.2; recession begins once the surface reaches the material's oxidation temperature.
                      </div>
                      
                      <div className="col-span-2 border-t border-[#333] pt-4 mt-2">
                        <p className="text-[#888] mb-1">Initial Throat Diameter:</p>
                        <p className="text-lg text-[#eee]">{(throatDiameter * 1000).toFixed(2)} mm</p>
                      </div>
                      <div className="col-span-2 border-t border-[#333] pt-4 mt-2">
                        <p className="text-[#888] mb-1">Final Throat Diameter:</p>
                        <p className="text-xl text-[#ffaa00] font-bold">
                          {(Math.sqrt(4 * results[results.length - 1].ThroatArea / Math.PI) * 1000).toFixed(3)} mm
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-[#666] italic font-mono text-xs mt-6">
                  {metrics && results.length > 0
                    ? 'Loading the structural core...'
                    : 'Run a simulation to view structural analysis.'}
                </div>
              )}
            </div>
  );
}

export default StructuralTab;
