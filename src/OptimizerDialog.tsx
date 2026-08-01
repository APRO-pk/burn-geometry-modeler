import React, { useState, useEffect } from 'react';
import { Play, Check, X } from 'lucide-react';
import { SolidPropellant, MotorSimulation, BATES, Star, Tubular, RodAndTube, MoonBurner, Finocyl, CustomDXF } from './engine';

interface OptimizerProps {
  currentConfig: any;
  onApply: (newConfig: any) => void;
  onClose: () => void;
  dxfData: any;
}

export function OptimizerDialog({ currentConfig, onApply, onClose, dxfData }: OptimizerProps) {
  const [paramToSweep, setParamToSweep] = useState<'throatDiameter' | 'length'>('throatDiameter');
  const [sweepMin, setSweepMin] = useState<number>(0.005);
  const [sweepMax, setSweepMax] = useState<number>(0.03);
  const [steps, setSteps] = useState<number>(10);
  const [results, setResults] = useState<any[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const runSweep = () => {
    setIsRunning(true);
    setTimeout(() => {
      const sweepResults = [];
      const stepSize = (sweepMax - sweepMin) / Math.max(1, steps - 1);
      
      for (let i = 0; i < steps; i++) {
        const val = sweepMin + i * stepSize;
        const config = { ...currentConfig, [paramToSweep]: val };
        
        try {
          const prop = new SolidPropellant(
            config.density, config.a, config.n, config.flameTemp, config.gamma, config.molWeight, config.kErosive, config.gThreshold
          );
          let grain;
          if (config.grainType === 'Star') grain = new Star(config.length, config.outerRadius, config.valleyRadius, config.tipRadius, config.numPoints);
          else if (config.grainType === 'Tubular') grain = new Tubular(config.length, config.outerRadius, config.innerRadius);
          else if (config.grainType === 'RodAndTube') grain = new RodAndTube(config.length, config.outerRadius, config.rodRadius, config.innerRadius);
          else if (config.grainType === 'MoonBurner') grain = new MoonBurner(config.length, config.outerRadius, config.innerRadius, config.offset);
          else if (config.grainType === 'Finocyl') grain = new Finocyl(config.length, config.outerRadius, config.innerRadius, config.numPoints, config.finWidth, config.finDepth);
          else if (config.grainType === 'CustomDXF' && dxfData) grain = new CustomDXF(config.length, config.outerRadius, dxfData.dx, dxfData.perimTable, dxfData.areaTable);
          else grain = new BATES(config.length, config.outerRadius, config.innerRadius);

          const sim = new MotorSimulation(prop, grain, 0.005);
          sim.set_efficiencies(0.95, 0.98); // fixed for quick sweep
          sim.set_nozzle(config.throatDiameter, config.expansionRatio, config.erosionRate, null);
          const { results: simRes, warnings: simWarnings } = sim.run();

          if (simRes.length > 0) {
            const maxPc = Math.max(...simRes.map((r:any) => r.Pc)) / 1e6;
            const maxThrust = Math.max(...simRes.map((r:any) => r.Thrust)) / 1000;
            const initialKn = simRes[0].Ab / simRes[0].ThroatArea;
            sweepResults.push({ val, maxPc, maxThrust, initialKn, warnings: simWarnings });
          }
        } catch(e) { /* ignore fails */ }
      }
      setResults(sweepResults);
      setIsRunning(false);
    }, 50);
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black bg-opacity-70 font-mono text-xs text-[#eee]">
      <div className="bg-[#111] border border-[#444] shadow-2xl rounded w-[600px] flex flex-col p-4 space-y-4">
        <div className="flex justify-between items-center text-[#ffaa00] font-bold text-sm border-b border-[#333] pb-2">
          <span>Design Optimizer / Sweep</span>
          <button onClick={onClose} className="hover:text-red-500">✕</button>
        </div>
        
        <div className="flex space-x-4 items-end">
          <div className="flex flex-col space-y-1 flex-1">
            <label className="text-[#888]">Sweep Parameter</label>
            <select value={paramToSweep} onChange={e => setParamToSweep(e.target.value as any)} className="bg-[#222] border border-[#555] px-2 py-1 outline-none focus:border-[#ffaa00]">
              <option value="throatDiameter">Throat Diameter (m)</option>
              <option value="length">Grain Length (m)</option>
            </select>
          </div>
          <div className="flex flex-col space-y-1 w-20">
            <label className="text-[#888]">Min</label>
            <input type="number" step="any" value={sweepMin} onChange={e => setSweepMin(parseFloat(e.target.value))} className="bg-[#222] border border-[#555] px-2 py-1" />
          </div>
          <div className="flex flex-col space-y-1 w-20">
            <label className="text-[#888]">Max</label>
            <input type="number" step="any" value={sweepMax} onChange={e => setSweepMax(parseFloat(e.target.value))} className="bg-[#222] border border-[#555] px-2 py-1" />
          </div>
          <div className="flex flex-col space-y-1 w-20">
            <label className="text-[#888]">Steps</label>
            <input type="number" value={steps} onChange={e => setSteps(parseFloat(e.target.value))} className="bg-[#222] border border-[#555] px-2 py-1" />
          </div>
          <button onClick={runSweep} disabled={isRunning} className="bg-[#ffaa00] text-black px-4 py-1 font-bold rounded flex items-center h-7 hover:bg-[#ffcc00] disabled:opacity-50">
            {isRunning ? 'Running...' : <><Play size={12} className="mr-1"/> Run</>}
          </button>
        </div>

        {results.length > 0 && (
          <div className="border border-[#333] rounded overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-[#222] text-[#888]">
                <tr>
                  <th className="p-1 border-b border-[#333] pl-2">{paramToSweep}</th>
                  <th className="p-1 border-b border-[#333]">Max Pc (MPa)</th>
                  <th className="p-1 border-b border-[#333]">Max Thrust (kN)</th>
                  <th className="p-1 border-b border-[#333]">Initial Kn</th>
                  <th className="p-1 border-b border-[#333]">Warnings</th>
                  <th className="p-1 border-b border-[#333]">Action</th>
                </tr>
              </thead>
              <tbody className="bg-[#1a1a1a]">
                {results.map((r, i) => (
                  <tr key={i} className="hover:bg-[#333] transition-colors border-b border-[#222]">
                    <td className="p-1 pl-2 font-bold text-[#00ffaa]">{r.val.toFixed(4)}</td>
                    <td className={`p-1 ${r.maxPc > 10 ? 'text-red-400' : 'text-[#eee]'}`}>{r.maxPc.toFixed(2)}</td>
                    <td className="p-1 text-[#eee]">{r.maxThrust.toFixed(2)}</td>
                    <td className="p-1 text-[#eee]">{r.initialKn.toFixed(0)}</td>
                    <td className="p-1 text-[10px] text-amber-500 max-w-[100px] truncate" title={r.warnings?.join('\n')}>{r.warnings?.length > 0 ? `${r.warnings.length}⚠️` : ''}</td>
                    <td className="p-1">
                      <button onClick={() => { onApply({ ...currentConfig, [paramToSweep]: r.val }); onClose(); }} className="text-[#00aaff] hover:text-[#fff] text-[10px] bg-[#222] border border-[#444] px-1 rounded">Apply</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
