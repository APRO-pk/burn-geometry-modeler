import React, { useState } from 'react';
import { useFieldIds } from './useFieldIds';
import { Settings, Plus, Trash2, Check } from 'lucide-react';
import type { BurnRateRegime } from './wasmCore';

export interface PropellantData {
  id: string;
  name: string;
  density: number;
  a: number;
  n: number;
  molWeight: number;
  kErosive: number;
  gThreshold: number;
  flameTemp: number;
  gamma: number;
  T_ref?: number;
  sigma_p?: number;
  /**
   * Optional measured piecewise burn-rate law. When present it governs burn
   * rate inside its pressure range and `a`/`n` above are only the fallback
   * outside it, so the editor says so rather than letting the a/n fields look
   * like they are in charge.
   */
  burnRateRegimes?: BurnRateRegime[];
}

interface PropellantEditorProps {
  propellants: PropellantData[];
  onChange: (props: PropellantData[]) => void;
  onApply: (prop: PropellantData) => void;
  onClose: () => void;
}

export function PropellantEditor({ propellants, onChange, onApply, onClose }: PropellantEditorProps) {
  const fieldId = useFieldIds();
  const [selectedId, setSelectedId] = useState<string>(propellants[0]?.id || '');

  const selectedIdx = propellants.findIndex(p => p.id === selectedId);
  const selectedProp = propellants[selectedIdx];

  const handleAdd = () => {
    const newProp: PropellantData = {
      id: Math.random().toString(36).substring(7),
      name: 'New Propellant',
      density: 1500,
      a: 7.9e-5, // SI burn-rate coeff (r_b = a * Pc^n, Pc in Pa, r_b in m/s)
      n: 0.3,
      molWeight: 0.030,
      kErosive: 0.001,
      gThreshold: 500,
      flameTemp: 2500,
      gamma: 1.2,
      T_ref: 294.0,
      sigma_p: 0.001
    };
    onChange([...propellants, newProp]);
    setSelectedId(newProp.id);
  };

  const handleDelete = (id: string) => {
    if (propellants.length <= 1) return;
    const next = propellants.filter(p => p.id !== id);
    onChange(next);
    if (selectedId === id) setSelectedId(next[0].id);
  };

  const updateSelected = (key: keyof PropellantData, value: string | number) => {
    if (selectedIdx === -1) return;
    const next = [...propellants];
    next[selectedIdx] = { ...next[selectedIdx], [key]: value };
    onChange(next);
  };

  const handleNumChange = (key: keyof PropellantData, val: string) => {
    const n = parseFloat(val);
    if (!isNaN(n)) updateSelected(key, n);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-60 font-mono text-xs text-[#eee]">
      <div className="bg-[#111] border border-[#444] shadow-2xl rounded w-[600px] flex flex-col max-h-[90vh]">
        <div className="bg-[#222] px-3 py-2 border-b border-[#444] flex justify-between items-center font-bold text-[#00ffaa]">
          <div className="flex items-center"><Settings size={14} className="mr-1" /> Propellant Editor</div>
          <button onClick={onClose} className="hover:text-red-500">✕</button>
        </div>
        
        <div className="flex flex-1 overflow-hidden">
          {/* List Sidebar */}
          <div className="w-1/3 border-r border-[#444] flex flex-col bg-[#1a1a1a]">
             <div className="overflow-y-auto flex-1 p-2 space-y-1">
               {propellants.map(p => (
                 /*
                  * The row is a plain container; the NAME is the button that
                  * selects it.
                  *
                  * It used to be a clickable <div> with the delete button
                  * nested inside, which is unreachable by keyboard -- and could
                  * not simply be promoted to a <button>, because a button
                  * inside a button is invalid HTML and browsers do not nest
                  * them. Splitting the row into two sibling buttons is both
                  * valid and fully operable without a mouse.
                  */
                 <div
                   key={p.id}
                   className={`p-2 rounded flex justify-between items-center group ${selectedId === p.id ? 'bg-[#333] border border-[#555]' : 'hover:bg-[#222] border border-transparent'}`}
                 >
                   <button
                     type="button"
                     onClick={() => setSelectedId(p.id)}
                     aria-current={selectedId === p.id}
                     className="truncate pr-2 flex-1 text-left cursor-pointer bg-transparent border-0 p-0 text-inherit focus:outline-none focus-visible:ring-1 focus-visible:ring-[#00ffaa] rounded"
                   >
                     {p.name || 'Unnamed'}
                   </button>
                   {propellants.length > 1 && (
                     <button
                       type="button"
                       onClick={() => handleDelete(p.id)}
                       aria-label={`Delete ${p.name || 'Unnamed'}`}
                       className="text-[#666] hover:text-red-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500 rounded"
                     >
                       <Trash2 size={12} />
                     </button>
                   )}
                 </div>
               ))}
             </div>
             <div className="p-2 border-t border-[#444]">
               <button onClick={handleAdd} className="w-full flex items-center justify-center py-1.5 bg-[#222] hover:bg-[#333] border border-[#555] rounded text-[#00ffaa]">
                 <Plus size={14} className="mr-1" /> Add Propellant
               </button>
             </div>
          </div>
          
          {/* Editor Details */}
          <div className="w-2/3 p-4 overflow-y-auto space-y-3">
             {selectedProp ? (
               <>
                 <div className="space-y-1">
                   <label className="text-[#888]" htmlFor={fieldId('name')}>Name</label>
                   <input id={fieldId('name')} type="text" value={selectedProp.name} onChange={e => updateSelected('name', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white" />
                 </div>
                 
                 <div className="grid grid-cols-2 gap-3">
                   <div className="space-y-1">
                     <label className="text-[#888]" htmlFor={fieldId('density-kg-m')}>Density (kg/m³)</label>
                     <input id={fieldId('density-kg-m')} type="number" step="any" value={selectedProp.density} onChange={e => handleNumChange('density', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white text-right" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]" htmlFor={fieldId('burn-coeff-a-m-s-pa-n')}>Burn Coeff 'a' (m/s/Pa^n)</label>
                     <input id={fieldId('burn-coeff-a-m-s-pa-n')} type="number" step="any" value={selectedProp.a} onChange={e => handleNumChange('a', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white text-right" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]" htmlFor={fieldId('pressure-exp-n')}>Pressure Exp 'n'</label>
                     <input id={fieldId('pressure-exp-n')} type="number" step="any" value={selectedProp.n} onChange={e => handleNumChange('n', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white text-right" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]" htmlFor={fieldId('mol-wt-kg-mol')}>Mol Wt (kg/mol)</label>
                     <input id={fieldId('mol-wt-kg-mol')} type="number" step="any" value={selectedProp.molWeight} onChange={e => handleNumChange('molWeight', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white text-right" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]" htmlFor={fieldId('linear-k-erosive')}>Linear k_erosive</label>
                     <input id={fieldId('linear-k-erosive')} type="number" step="any" value={selectedProp.kErosive} onChange={e => handleNumChange('kErosive', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white text-right" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]" htmlFor={fieldId('g-threshold-kg-m-s')}>G Threshold (kg/m²s)</label>
                     <input id={fieldId('g-threshold-kg-m-s')} type="number" step="any" value={selectedProp.gThreshold} onChange={e => handleNumChange('gThreshold', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white text-right" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]" htmlFor={fieldId('flame-temp-k')}>Flame Temp (K)</label>
                     <input id={fieldId('flame-temp-k')} type="number" step="any" value={selectedProp.flameTemp} onChange={e => handleNumChange('flameTemp', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white text-right" />
                   </div>
                   <div className="space-y-1">
                     <label className="text-[#888]" htmlFor={fieldId('gamma-ratio-of-specific-heats')}>Gamma (ratio of specific heats)</label>
                     <input id={fieldId('gamma-ratio-of-specific-heats')} type="number" step="any" value={selectedProp.gamma} onChange={e => handleNumChange('gamma', e.target.value)} className="w-full bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#00ffaa] text-white text-right" />
                   </div>
                 </div>
               </>
             ) : (
               <div className="flex flex-col items-center justify-center h-full text-[#666]">
                 Select a propellant to edit
               </div>
             )}
          </div>
        </div>
        
        <div className="p-3 border-t border-[#444] flex justify-end space-x-2 bg-[#1a1a1a]">
          <button onClick={onClose} className="px-4 py-1.5 rounded border border-[#555] text-[#aaa] hover:bg-[#333] hover:text-white transition-colors">
            Close
          </button>
          <button 
            disabled={!selectedProp}
            onClick={() => { if(selectedProp) onApply(selectedProp); }} 
            className="px-4 py-1.5 rounded bg-[#00ffaa] text-black font-bold hover:bg-[#00cc88] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
          >
            <Check size={14} className="mr-1" /> Apply to Engine
          </button>
        </div>
      </div>
    </div>
  );
}
