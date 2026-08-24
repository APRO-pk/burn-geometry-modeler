import React from 'react';

/**
 * Material Properties: a read-only summary of the propellant, casing and nozzle
 * materials currently applied, plus save/load of material sets.
 *
 * The values are edited in the Motor Parameters dock on the left; this view
 * only displays them, so it takes no setters.
 */
export type MaterialKind = 'propellant' | 'casing' | 'nozzle';

export interface MaterialsTabProps {
  density: number;
  a: number;
  n: number;
  molWeight: number;
  flameTemp: number;
  casingMaterial: string;
  /** MPa. */
  casingYieldStress: number;
  /** GPa. */
  casingYoungsModulus: number;
  nozzleMaterial: string;
  nozzleThermalConductivity: number;
  nozzleSpecificHeat: number;
  /** Save/load one material set at a time -- propellant, casing or nozzle. */
  onSaveMaterial: (type: MaterialKind) => void;
  onLoadMaterial: (type: MaterialKind) => void;
}

export function MaterialsTab({
  density,
  a,
  n,
  molWeight,
  flameTemp,
  casingMaterial,
  casingYieldStress,
  casingYoungsModulus,
  nozzleMaterial,
  nozzleThermalConductivity,
  nozzleSpecificHeat,
  onSaveMaterial,
  onLoadMaterial,
}: MaterialsTabProps) {
  return (
            <div className="flex-1 bg-black border border-[#555] relative flex flex-col items-center justify-start overflow-y-auto custom-scrollbar p-6">
              <div className="absolute top-1 left-2 z-10 text-[#00aaff] text-[10px] font-mono">Material Properties Library</div>

              <div className="w-full max-w-4xl space-y-6 mt-6">
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {/* Casing Overview Card */}
                  <div className="bg-[#111] border border-[#333] p-4 rounded-md shadow-lg relative">
                    <h3 className="font-mono font-bold text-[#00aaff] mb-4 pb-2 border-b border-[#333] text-sm tracking-wide">CASING ALLOY</h3>
                    <p className="font-mono text-[#eee] font-bold mb-4">{casingMaterial}</p>
                    <div className="grid grid-cols-2 gap-y-2 text-xs font-mono">
                      <div className="text-[#888]">Yield Str:</div>
                      <div className="text-[#00ff00] font-bold">{casingYieldStress} MPa</div>
                      <div className="text-[#888]">Young's Mod:</div>
                      <div className="text-[#00ff00] font-bold">{casingYoungsModulus} GPa</div>
                    </div>
                    <div className="absolute top-2 right-2 flex space-x-1">
                      <button onClick={() => onSaveMaterial('casing')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Save</button>
                      <button onClick={() => onLoadMaterial('casing')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Load</button>
                    </div>
                  </div>
                  
                  {/* Propellant Overview Card */}
                  <div className="bg-[#111] border border-[#333] p-4 rounded-md shadow-lg relative">
                    <h3 className="font-mono font-bold text-[#00ffff] mb-4 pb-2 border-b border-[#333] text-sm tracking-wide">PROPELLANT</h3>
                    <div className="grid grid-cols-2 gap-y-2 text-xs font-mono">
                      <div className="text-[#888]">Density:</div>
                      <div className="text-[#00ff00] font-bold">{density} kg/m³</div>
                      <div className="text-[#888]">Burn Coeff(a):</div>
                      <div className="text-[#00ff00] font-bold">{a}</div>
                      <div className="text-[#888]">Burn Exp(n):</div>
                      <div className="text-[#00ff00] font-bold">{n}</div>
                      <div className="text-[#888]">Flame Temp:</div>
                      <div className="text-[#00ff00] font-bold">{flameTemp} K</div>
                      <div className="text-[#888]">Mol Wt:</div>
                      <div className="text-[#00ff00] font-bold">{molWeight} kg/mol</div>
                    </div>
                    <div className="absolute top-2 right-2 flex space-x-1">
                      <button onClick={() => onSaveMaterial('propellant')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Save</button>
                      <button onClick={() => onLoadMaterial('propellant')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Load</button>
                    </div>
                  </div>

                  {/* Nozzle Overview Card */}
                  <div className="bg-[#111] border border-[#333] p-4 rounded-md shadow-lg relative">
                    <h3 className="font-mono font-bold text-[#ffaa00] mb-4 pb-2 border-b border-[#333] text-sm tracking-wide">NOZZLE RESIN</h3>
                    <p className="font-mono text-[#eee] font-bold mb-4">{nozzleMaterial}</p>
                    <div className="grid grid-cols-2 gap-y-2 text-xs font-mono">
                      <div className="text-[#888]">Thermal Cond:</div>
                      <div className="text-[#00ff00] font-bold">{nozzleMaterial === 'Custom' ? nozzleThermalConductivity : (nozzleMaterial === 'Graphite' ? 100 : 1.2)} W/m-K</div>
                      <div className="text-[#888]">Specific Heat:</div>
                      <div className="text-[#00ff00] font-bold">{nozzleMaterial === 'Custom' ? nozzleSpecificHeat : (nozzleMaterial === 'Graphite' ? 710 : 1300)} J/kg-K</div>
                      <div className="col-span-2 mt-4 text-[9px] text-[#555] leading-tight">
                        Advanced properties (Phase Change Enthalpy, Oxidation Temps) are mapped internally based on selection.
                      </div>
                    </div>
                    <div className="absolute top-2 right-2 flex space-x-1">
                      <button onClick={() => onSaveMaterial('nozzle')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Save</button>
                      <button onClick={() => onLoadMaterial('nozzle')} className="text-[10px] bg-[#222] text-[#aaa] border border-[#444] px-1 hover:bg-[#333] hover:text-[#fff] rounded">Load</button>
                    </div>
                  </div>
                </div>
                
                <div className="mt-8 text-[11px] text-[#888] font-mono p-4 border border-[#333] rounded bg-[#0a0a0a]">
                  <span className="font-bold text-[#aaa]">SYSTEM LOG:</span> Material parameters are currently modified directly via the main Motor Parameters dock on the left, or loaded via entire Config '.json' files. The application's thermodynamic erosion models automatically resolve advanced material properties behind-the-scenes when defined combinations (e.g., Graphite, Phenolic) are requested.
                </div>

              </div>
            </div>
  );
}

export default MaterialsTab;
