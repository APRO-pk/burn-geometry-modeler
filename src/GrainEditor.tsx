import React, { useState, useMemo, useEffect } from 'react';
import { Settings, Check } from 'lucide-react';
import { grainFromUi } from './engine';
import { DXFRegressionResults } from './dxfProcessor';

interface GrainEditorProps {
  initialParams: {
    grainType: 'Star' | 'BATES' | 'Tubular' | 'RodAndTube' | 'MoonBurner' | 'Finocyl' | 'CustomDXF';
    length: number;
    outerRadius: number;
    innerRadius: number;
    valleyRadius: number;
    tipRadius: number;
    numPoints: number;
    numSegments: number;
    offset: number;
    rodRadius: number;
    finDepth: number;
    finWidth: number;
  };
  dxfData: DXFRegressionResults | null;
  onApply: (params: any) => void;
  onClose: () => void;
}

export function GrainEditor({ initialParams, dxfData, onApply, onClose }: GrainEditorProps) {
  const [params, setParams] = useState(initialParams);
  const [currentY, setCurrentY] = useState(0);

  const updateParam = (key: keyof typeof params, value: any) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const handleNumChange = (key: keyof typeof params, val: string) => {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      updateParam(key, num);
    }
  };

  // Create grain geometry instance
  const grain = useMemo(() => {
    try {
      return grainFromUi(params, dxfData);
    } catch {
      return null;
    }
  }, [params, dxfData]);

  const maxWeb = useMemo(() => {
    const { grainType, outerRadius, innerRadius, valleyRadius, rodRadius, finDepth } = params;
    if (grainType === 'Star') return Math.max(0, outerRadius - valleyRadius);
    if (grainType === 'RodAndTube') return Math.max(0, innerRadius - rodRadius); 
    if (grainType === 'Finocyl') return Math.max(0, outerRadius - finDepth);
    return Math.max(0, outerRadius - innerRadius);
  }, [params]);

  useEffect(() => {
    if (currentY > maxWeb) setCurrentY(maxWeb);
  }, [maxWeb, currentY]);

  const stats = useMemo(() => {
    if (!grain) return { portArea: 0, burnArea: 0 };
    return {
      portArea: grain.get_port_area(currentY),
      burnArea: grain.get_burning_area(currentY) * (params.grainType === 'BATES' ? params.numSegments : 1)
    };
  }, [grain, currentY, params.grainType, params.numSegments]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-70 font-mono text-xs text-[#eee]">
      <div className="bg-[#111] border border-[#444] shadow-2xl rounded w-[800px] flex flex-col max-h-[90vh]">
        <div className="bg-[#222] px-3 py-2 border-b border-[#444] flex justify-between items-center font-bold text-[#00aaff]">
          <div className="flex items-center"><Settings size={14} className="mr-1" /> Grain Geometry Editor & Previewer</div>
          <button onClick={onClose} className="hover:text-red-500">✕</button>
        </div>
        
        <div className="flex flex-1 overflow-hidden min-h-[500px]">
          {/* Left: Inputs */}
          <div className="w-1/3 border-r border-[#444] p-4 space-y-4 overflow-y-auto bg-[#1a1a1a]">
             
             <div className="space-y-1">
               <label className="text-[#888]">Type</label>
               <select value={params.grainType} onChange={e => updateParam('grainType', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white">
                  <option value="BATES">BATES</option>
                  <option value="Tubular">Tubular</option>
                  <option value="Star">Star</option>
                  <option value="RodAndTube">Rod and Tube</option>
                  <option value="MoonBurner">MoonBurner</option>
                  <option value="Finocyl">Finocyl</option>
                  <option value="CustomDXF">Custom DXF Profile</option>
               </select>
             </div>

             <div className="space-y-1">
               <label className="text-[#888]">Length (m)</label>
               <input type="number" step="any" value={params.length} onChange={e => handleNumChange('length', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
             </div>

             <div className="space-y-1">
               <label className="text-[#888]">Outer Radius (m)</label>
               <input type="number" step="any" value={params.outerRadius} onChange={e => handleNumChange('outerRadius', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
             </div>

             {['Star'].includes(params.grainType) && (
               <>
                 <div className="space-y-1">
                   <label className="text-[#888]">Valley Radius (m)</label>
                   <input type="number" step="any" value={params.valleyRadius} onChange={e => handleNumChange('valleyRadius', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                 </div>
                 <div className="space-y-1">
                   <label className="text-[#888]">Tip Radius (m)</label>
                   <input type="number" step="any" value={params.tipRadius} onChange={e => handleNumChange('tipRadius', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                 </div>
                 <div className="space-y-1">
                   <label className="text-[#888]">Points</label>
                   <input type="number" step="1" value={params.numPoints} onChange={e => handleNumChange('numPoints', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                 </div>
               </>
             )}

             {['BATES', 'Tubular', 'RodAndTube', 'MoonBurner', 'Finocyl'].includes(params.grainType) && (
                 <div className="space-y-1">
                   <label className="text-[#888]">Inner Radius (m)</label>
                   <input type="number" step="any" value={params.innerRadius} onChange={e => handleNumChange('innerRadius', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                 </div>
             )}

             {['BATES'].includes(params.grainType) && (
                 <div className="space-y-1">
                   <label className="text-[#888]">Segments</label>
                   <input type="number" step="1" value={params.numSegments} onChange={e => handleNumChange('numSegments', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                 </div>
             )}

             {['RodAndTube'].includes(params.grainType) && (
                 <div className="space-y-1">
                   <label className="text-[#888]">Rod Radius (m)</label>
                   <input type="number" step="any" value={params.rodRadius} onChange={e => handleNumChange('rodRadius', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                 </div>
             )}

             {['MoonBurner'].includes(params.grainType) && (
                 <div className="space-y-1">
                   <label className="text-[#888]">Offset (m)</label>
                   <input type="number" step="any" value={params.offset} onChange={e => handleNumChange('offset', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                 </div>
             )}

             {['Finocyl'].includes(params.grainType) && (
                 <>
                   <div className="space-y-1">
                     <label className="text-[#888]">Fin Depth (m)</label>
                     <input type="number" step="any" value={params.finDepth} onChange={e => handleNumChange('finDepth', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]">Fin Width (m)</label>
                     <input type="number" step="any" value={params.finWidth} onChange={e => handleNumChange('finWidth', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]">Fins</label>
                     <input type="number" step="1" value={params.numPoints} onChange={e => handleNumChange('numPoints', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00aaff] text-white" />
                   </div>
                 </>
             )}
             
             {params.grainType === 'CustomDXF' && !dxfData && (
                <div className="text-red-400 text-xs">DXF Data must be loaded in the main window.</div>
             )}

          </div>
          
          {/* Right: Preview */}
          <div className="w-2/3 flex flex-col bg-[#222]">
            <div className="flex-1 flex items-center justify-center p-8 relative">
               <svg viewBox="0 0 200 200" className="w-full h-full max-w-[400px] max-h-[400px]">
                 <circle cx="100" cy="100" r="95" fill="#333" />
                  {params.grainType === 'BATES' || params.grainType === 'Tubular' ? (
                    <circle cx="100" cy="100" r={Math.min(params.outerRadius, Math.max(0, params.innerRadius + currentY)) / params.outerRadius * 95} fill="#111" />
                  ) : params.grainType === 'RodAndTube' ? (
                    <>
                      <circle cx="100" cy="100" r={Math.min(params.outerRadius, Math.max(0, params.innerRadius + currentY)) / params.outerRadius * 95} fill="#111" />
                      {params.rodRadius - currentY > 0 && (
                        <circle cx="100" cy="100" r={Math.max(0, params.rodRadius - currentY) / params.outerRadius * 95} fill="#555" />
                      )}
                    </>
                  ) : params.grainType === 'MoonBurner' ? (
                    <circle cx={100 + (params.offset / params.outerRadius) * 95} cy="100" r={Math.min(params.outerRadius + params.offset, Math.max(0, params.innerRadius + currentY)) / params.outerRadius * 95} fill="#111" />
                  ) : params.grainType === 'Finocyl' ? (
                    <path d={(() => {
                      const scale = 95 / params.outerRadius;
                      const rc = Math.min(params.outerRadius * scale, (params.innerRadius + currentY) * scale);
                      const hw = (params.finWidth / 2.0 + currentY) * scale;
                      const td = (params.finDepth - params.finWidth / 2.0) * scale;
                      if (rc >= params.outerRadius * scale) return `M 5,100 A 95,95 0 1,1 195,100 A 95,95 0 1,1 5,100 Z`;
                      
                      let path = "";
                      for(let i=0; i<params.numPoints; i++) {
                         const angle = (i * 2 * Math.PI) / params.numPoints;
                         const nx = Math.sin(angle);
                         const ny = -Math.cos(angle);
                         const tx = -ny;
                         const ty = nx;
                         
                         const cx = 100 + nx * td;
                         const cy = 100 + ny * td;
                         
                         const p1x = 100 + nx * rc + tx * hw;
                         const p1y = 100 + ny * rc + ty * hw;
                         const p2x = cx + tx * hw;
                         const p2y = cy + ty * hw;
                         const p3x = cx - tx * hw;
                         const p3y = cy - ty * hw;
                         const p4x = 100 + nx * rc - tx * hw;
                         const p4y = 100 + ny * rc - ty * hw;

                         if (i === 0) path += `M ${p1x} ${p1y} `;
                         else path += `L ${p1x} ${p1y} `;
                         path += `L ${p2x} ${p2y} `;
                         path += `A ${hw} ${hw} 0 0 1 ${p3x} ${p3y} `;
                         path += `L ${p4x} ${p4y} `;
                         
                         const next_angle = ((i + 1) * 2 * Math.PI) / params.numPoints;
                         const next_nx = Math.sin(next_angle);
                         const next_ny = -Math.cos(next_angle);
                         const next_tx = -next_ny;
                         const next_ty = next_nx;
                         const next_p1x = 100 + next_nx * rc + next_tx * hw;
                         const next_p1y = 100 + next_ny * rc + next_ty * hw;
                         
                         path += `A ${rc} ${rc} 0 0 1 ${next_p1x} ${next_p1y} `;
                      }
                      return path + "Z";
                    })()} fill="#111" />
                  ) : params.grainType === 'CustomDXF' && dxfData ? (
                    <circle cx="100" cy="100" r={Math.sqrt(dxfData.areaTable[Math.min(Math.floor(currentY / dxfData.dx), dxfData.areaTable.length - 1)] / Math.PI) / params.outerRadius * 95} fill="#111" />
                  ) : (
                    <path d={(() => {
                      const scale = 95 / params.outerRadius;
                      const r_outer = Math.min(params.outerRadius, params.valleyRadius + currentY) * scale;
                      const r_inner = Math.min(params.outerRadius, params.tipRadius + currentY) * scale;
                      let path = "";
                      for(let i=0; i<params.numPoints*2; i++) {
                        const radius = i % 2 === 0 ? r_inner : r_outer;
                        const angle = (i * Math.PI) / params.numPoints;
                        const px = 100 + radius * Math.sin(angle);
                        const py = 100 - radius * Math.cos(angle);
                        path += (i === 0 ? `M ${px} ${py} ` : `L ${px} ${py} `);
                      }
                      return path + "Z";
                    })()} fill="#111" />
                  )}
               </svg>
            </div>
            <div className="bg-[#111] p-4 border-t border-[#444] space-y-4">
              <div className="flex justify-between text-[#00aaff]">
                 <span>Current Web Regressed: {(currentY * 1000).toFixed(2)} mm</span>
                 <span>Max Web: {(maxWeb * 1000).toFixed(2)} mm</span>
              </div>
              <input 
                type="range" 
                min="0" 
                max={maxWeb} 
                step={maxWeb / 200 || 0.001}
                value={currentY} 
                onChange={(e) => setCurrentY(Number(e.target.value))}
                className="w-full accent-[#00aaff]"
              />
              <div className="grid grid-cols-2 gap-4 text-sm mt-4">
                 <div className="flex flex-col bg-[#222] p-2 rounded border border-[#333]">
                   <span className="text-[#888]">Port Area</span>
                   <span className="text-white text-lg font-bold">{(stats.portArea * 10000).toFixed(2)} cm²</span>
                 </div>
                 <div className="flex flex-col bg-[#222] p-2 rounded border border-[#333]">
                   <span className="text-[#888]">Burning Area</span>
                   <span className="text-[#00ff00] text-lg font-bold">{(stats.burnArea * 10000).toFixed(2)} cm²</span>
                 </div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="p-3 border-t border-[#444] flex justify-end space-x-2 bg-[#1a1a1a]">
          <button onClick={onClose} className="px-4 py-1.5 rounded border border-[#555] text-[#aaa] hover:bg-[#333] hover:text-white transition-colors">
            Cancel
          </button>
          <button 
            onClick={() => onApply(params)} 
            className="px-4 py-1.5 rounded bg-[#00aaff] text-black font-bold hover:bg-[#0088cc] transition-colors flex items-center"
          >
            <Check size={14} className="mr-1" /> Apply Settings
          </button>
        </div>
      </div>
    </div>
  );
}
