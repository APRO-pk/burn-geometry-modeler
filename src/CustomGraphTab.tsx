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

/**
 * Custom Graph: plot any recorded channel against any other.
 *
 * The axis selection is state that ONLY this view uses, so it lives here rather
 * than in AppDesktop -- it was two more entries in a component that had 88.
 * The data itself is computed once upstream and shared with the other charts.
 */
export interface CustomGraphTabProps {
  /** One row per timestep, with every plottable channel already in display units. */
  chartData: Array<Record<string, number>>;
  /** BATES segment count, shown alongside the trace. */
  numSegments: number;
}

export function CustomGraphTab({ chartData, numSegments }: CustomGraphTabProps) {
  const [customXAxis, setCustomXAxis] = useState<string>('Time');
  const [customYAxes, setCustomYAxes] = useState<string[]>(['Kn', 'Pc_MPa', 'Thrust_N']);

  return (
            <div className="flex-1 flex bg-[#222]">
              {/* Graph Controls Sidebar */}
              <div className="w-48 bg-[#2a2a2a] border-r border-[#111] px-2 py-3 flex flex-col space-y-4 overflow-y-auto">
                
                {/* X Axis Selector */}
                <div className="border border-[#444] rounded p-2 bg-[#252525]">
                  <div className="text-[#aaa] text-[10px] font-bold mb-2 uppercase border-b border-[#555] pb-1">X Axis</div>
                  <div className="flex flex-col space-y-1 text-[11px] text-[#ddd]">
                    {['Time', 'Regression Depth', 'Web'].map(opt => (
                      <label key={opt} className="flex items-center space-x-2 cursor-pointer hover:text-[#fff]">
                        <input type="radio" checked={customXAxis === opt} onChange={() => setCustomXAxis(opt)} className="accent-[#00aaff]" />
                        <span>{opt}</span>
                      </label>
                    ))}
                  </div>
                </div>
                
                {/* Y Axis Selector */}
                <div className="border border-[#444] rounded p-2 flex-1 bg-[#252525] flex flex-col overflow-hidden">
                  <div className="text-[#aaa] text-[10px] font-bold mb-2 uppercase border-b border-[#555] pb-1 flex-none">Y Axis</div>
                  <div className="flex flex-col space-y-1 text-[11px] text-[#ddd] overflow-y-auto pr-1 flex-1">
                    {[
                      { label: 'Kn', key: 'Kn', color: '#ffff00' },
                      { label: 'Chamber Pressure', key: 'Pc_MPa', color: '#00ff00' },
                      { label: 'Thrust', key: 'Thrust_N', color: '#ff00ff' },
                      { label: 'Propellant Mass', key: 'PropellantMass_kg', color: '#ff5555' },
                      { label: 'Volume Loading', key: 'VolumeLoading_pct', color: '#5555ff' },
                      { label: 'Mass Flow', key: 'MassFlow_kg_s', color: '#55ff55' },
                      { label: 'Mass Flux', key: 'PortMassFlux_kg_sm2', color: '#00ffff' },
                      { label: 'Regression Depth', key: 'Regression_mm', color: '#ffaa00' },
                      { label: 'Web', key: 'Web_mm', color: '#aaffaa' },
                      { label: 'Nozzle Exit Pressure', key: 'NozzleExitPressure_MPa', color: '#aaaaff' },
                      { label: 'Change in Throat Diameter', key: 'ChangeInThroatDiameter_mm', color: '#ffaaff' },
                      { label: 'Core Mach Number', key: 'CoreMachNumber', color: '#ffffff' },
                    ].map(opt => (
                      <label key={opt.key} className="flex items-center space-x-2 cursor-pointer hover:text-[#fff]">
                        <input type="checkbox" checked={customYAxes.includes(opt.key)} onChange={(e) => {
                          if (e.target.checked) setCustomYAxes([...customYAxes, opt.key]);
                          else setCustomYAxes(customYAxes.filter(k => k !== opt.key));
                        }} className="accent-[#00aaff]" />
                        <div className="w-2 h-2 rounded-full flex-none" style={{ backgroundColor: opt.color }}></div>
                        <span className="truncate" title={opt.label}>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                
                {/* Grains Selector */}
                <div className="border border-[#444] rounded p-2 bg-[#252525]">
                  <div className="text-[#aaa] text-[10px] font-bold mb-2 uppercase border-b border-[#555] pb-1">Grains</div>
                  <div className="flex flex-col space-y-1 text-[11px] text-[#ddd]">
                    <label className="flex items-center space-x-2 cursor-pointer hover:text-[#fff]">
                      <input type="checkbox" checked={true} readOnly className="accent-[#00aaff]" />
                      <span>Grain 1..{numSegments}</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Main Graph View */}
              <div className="flex-1 bg-black relative p-2 flex flex-col border border-[#555]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: -20 }}>
                    <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                    <XAxis 
                      dataKey={customXAxis === 'Time' ? 'Time' : customXAxis === 'Regression Depth' ? 'Regression_mm' : 'Web_mm'} 
                      type="number" 
                      domain={['dataMin', 'dataMax']} 
                      stroke="#666" 
                      tick={{fill: '#888', fontSize: 10}} 
                      tickFormatter={(v) => v.toFixed(2)} 
                      label={{ value: customXAxis, position: 'insideBottom', offset: -15, fill: '#888', fontSize: 12 }} 
                    />
                    
                    <YAxis stroke="#666" tick={{fill: '#888', fontSize: 10}} domain={['auto', 'auto']} tickFormatter={(v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(1)} />
                    
                    <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', fontSize: '11px', fontFamily: 'monospace' }} />
                    
                    {/* Lines */}
                    {[
                      { label: 'Kn', key: 'Kn', color: '#ffff00' },
                      { label: 'Chamber Pressure', key: 'Pc_MPa', color: '#00ff00' },
                      { label: 'Thrust', key: 'Thrust_N', color: '#ff00ff' },
                      { label: 'Propellant Mass', key: 'PropellantMass_kg', color: '#ff5555' },
                      { label: 'Volume Loading', key: 'VolumeLoading_pct', color: '#5555ff' },
                      { label: 'Mass Flow', key: 'MassFlow_kg_s', color: '#55ff55' },
                      { label: 'Mass Flux', key: 'PortMassFlux_kg_sm2', color: '#00ffff' },
                      { label: 'Regression Depth', key: 'Regression_mm', color: '#ffaa00' },
                      { label: 'Web', key: 'Web_mm', color: '#aaffaa' },
                      { label: 'Nozzle Exit Pressure', key: 'NozzleExitPressure_MPa', color: '#aaaaff' },
                      { label: 'Change in Throat Diameter', key: 'ChangeInThroatDiameter_mm', color: '#ffaaff' },
                      { label: 'Core Mach Number', key: 'CoreMachNumber', color: '#ffffff' },
                    ]
                      .filter(opt => customYAxes.includes(opt.key))
                      .map(opt => (
                        <Line key={opt.key} name={opt.label} type="stepAfter" dataKey={opt.key} stroke={opt.color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      ))
                    }
                    <Legend verticalAlign="top" height={36} wrapperStyle={{ fontSize: '10px', fontFamily: 'monospace', color: '#ccc' }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
  );
}

export default CustomGraphTab;
