import React, { useState, useMemo } from 'react';
import {
  SolidPropellant,
  BATES,
  Star,
  MotorSimulation,
  Igniter,
  calculate_casing_thickness,
  calculate_casing_strain,
  export_to_eng,
  SimulationResult
} from './engine';
import {
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { Rocket, Download, Play, Settings, Activity } from 'lucide-react';

export default function App() {
  // Propellant inputs
  const [density, setDensity] = useState<number>(1700);
  const [a, setA] = useState<number>(5e-5);
  const [n, setN] = useState<number>(0.35);
  const [flameTemp, setFlameTemp] = useState<number>(3000);
  const [gamma, setGamma] = useState<number>(1.2);
  const [molWeight, setMolWeight] = useState<number>(0.024);
  const [kErosive, setKErosive] = useState<number>(0.001);
  const [gThreshold, setGThreshold] = useState<number>(500.0);

  // Grain inputs
  const [grainType, setGrainType] = useState<'Star' | 'BATES'>('Star');
  const [length, setLength] = useState<number>(0.5);
  const [outerRadius, setOuterRadius] = useState<number>(0.05);
  const [innerRadius, setInnerRadius] = useState<number>(0.02); // for BATES
  const [valleyRadius, setValleyRadius] = useState<number>(0.03); // for Star
  const [tipRadius, setTipRadius] = useState<number>(0.01); // for Star
  const [numPoints, setNumPoints] = useState<number>(5); // for Star

  // Nozzle inputs
  const [throatDiameter, setThroatDiameter] = useState<number>(0.015);
  const [expansionRatio, setExpansionRatio] = useState<number>(7.0);
  const [erosionRate, setErosionRate] = useState<number>(0.0001);

  // Igniter & Casing inputs
  const [igniterMass, setIgniterMass] = useState<number>(0.05);
  const [igniterSurfaceArea, setIgniterSurfaceArea] = useState<number>(0.01);
  const [igniterDensity, setIgniterDensity] = useState<number>(1900);
  const [igniterA, setIgniterA] = useState<number>(1e-4);
  const [igniterN, setIgniterN] = useState<number>(0.4);
  const [casingYieldStress, setCasingYieldStress] = useState<number>(276); // MPa
  const [casingYoungsModulus, setCasingYoungsModulus] = useState<number>(69); // GPa
  
  // Nozzle Material
  const [nozzleMaterial, setNozzleMaterial] = useState<'Graphite' | 'Phenolic' | 'Custom'>('Graphite');

  // Monte Carlo & Visualizer
  const [mcRuns, setMcRuns] = useState<number>(50);
  const [mcVariance, setMcVariance] = useState<number>(5);
  const [mcResults, setMcResults] = useState<any[]>([]);
  const [visualizerIndex, setVisualizerIndex] = useState<number>(0);

  // Results
  const [results, setResults] = useState<SimulationResult[]>([]);
  const [stabilityWarnings, setStabilityWarnings] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<any>(null);

  const runSimulation = () => {
    const prop = new SolidPropellant(
      density,
      a,
      n,
      flameTemp,
      gamma,
      molWeight,
      kErosive,
      gThreshold
    );

    let grain;
    if (grainType === 'Star') {
      grain = new Star(length, outerRadius, valleyRadius, tipRadius, numPoints);
    } else {
      grain = new BATES(length, outerRadius, innerRadius);
    }

    const sim = new MotorSimulation(prop, grain, 0.001);
    const igniter = new Igniter(igniterMass, igniterSurfaceArea, igniterDensity, igniterA, igniterN);
    sim.set_igniter(igniter);
    
    let actualErosionRate = erosionRate;
    if (nozzleMaterial === 'Graphite') actualErosionRate = 1e-11;
    else if (nozzleMaterial === 'Phenolic') actualErosionRate = 5e-11;
    
    sim.set_nozzle(throatDiameter, expansionRatio, actualErosionRate);

    const { results: simResults, warnings: simWarnings } = sim.run();
    setResults(simResults);
    setStabilityWarnings(simWarnings);
    setVisualizerIndex(0);

    if (simResults.length > 0) {
      const maxThrust = Math.max(...simResults.map((r) => r.Thrust));
      const maxPc = Math.max(...simResults.map((r) => r.Pc));
      const avgThrust = simResults.reduce((sum, r) => sum + r.Thrust, 0) / simResults.length;
      
      let totalImpulse = 0;
      for (let i = 1; i < simResults.length; i++) {
        const dt = simResults[i].Time - simResults[i - 1].Time;
        totalImpulse += ((simResults[i].Thrust + simResults[i - 1].Thrust) / 2) * dt;
      }
      
      const actionTime = simResults[simResults.length - 1].Time;

      let propVol = 0;
      if (grainType === 'Star') {
        propVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(valleyRadius, 2)) * length;
      } else {
        propVol = Math.PI * (Math.pow(outerRadius, 2) - Math.pow(innerRadius, 2)) * length;
      }
      const propMass = propVol * density;
      const isp = totalImpulse / (propMass * 9.80665);
      const casingThickness = calculate_casing_thickness(maxPc, outerRadius, 1.5, casingYieldStress * 1e6);
      const casingStrain = calculate_casing_strain(maxPc, outerRadius, casingThickness, casingYoungsModulus * 1e9);

      setMetrics({
        maxThrust,
        avgThrust,
        maxPc,
        totalImpulse,
        isp,
        actionTime,
        casingThickness,
        casingStrain,
        propMass
      });
    }
  };

  const handleDownload = () => {
    if (!results.length || !metrics) return;
    const content = export_to_eng(results, metrics.propMass + 1.0, metrics.propMass, `APRO-${grainType}-1`);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `APRO-${grainType}-1.eng`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runMonteCarlo = () => {
    const runs = [];
    for (let i = 0; i < mcRuns; i++) {
      const varFactor = () => 1 + (Math.random() * 2 - 1) * (mcVariance / 100);
      const randA = a * varFactor();
      const randDt = throatDiameter * varFactor();
      const randDens = density * varFactor();

      const prop = new SolidPropellant(randDens, randA, n, flameTemp, gamma, molWeight, kErosive, gThreshold);
      const grain = grainType === 'Star' ? new Star(length, outerRadius, valleyRadius, tipRadius, numPoints) : new BATES(length, outerRadius, innerRadius);
      const sim = new MotorSimulation(prop, grain, 0.005); // coarser dt for speed
      const igniter = new Igniter(igniterMass * varFactor(), igniterSurfaceArea, igniterDensity, igniterA, igniterN);
      sim.set_igniter(igniter);
      
      let actualErosionRate = erosionRate;
      if (nozzleMaterial === 'Graphite') actualErosionRate = 1e-11;
      else if (nozzleMaterial === 'Phenolic') actualErosionRate = 5e-11;
      
      sim.set_nozzle(randDt, expansionRatio, actualErosionRate);
      
      const { results: res, warnings: simWarnings } = sim.run();
      if (res.length > 0) {
        const maxPc = Math.max(...res.map(r => r.Pc)) / 1e6;
        const maxThrust = Math.max(...res.map(r => r.Thrust)) / 1000;
        runs.push({ run: i + 1, maxPc, maxThrust });
      }
    }
    setMcResults(runs);
  };

  const burnRateData = useMemo(() => {
    const data = [];
    for (let p = 1; p <= 20; p += 0.5) {
      const rb_m_s = a * Math.pow(p * 1e6, n);
      data.push({ pressure: p, burnRate: rb_m_s * 1000 });
    }
    return data;
  }, [a, n]);

  const currentY = results.length > 0 && visualizerIndex < results.length 
    ? results[visualizerIndex].y 
    : 0;

  // Downsample results for charting to improve performance
  const chartData = useMemo(() => {
    if (results.length === 0) return [];
    const step = Math.max(1, Math.floor(results.length / 200));
    return results.filter((_, i) => i % step === 0).map(r => ({
      ...r,
      Pc_MPa: r.Pc / 1e6,
      Thrust_kN: r.Thrust / 1000
    }));
  }, [results]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex items-center justify-between bg-white p-6 rounded-xl shadow-sm border border-slate-100">
          <div className="flex items-center space-x-4">
            <div className="p-3 bg-blue-600 rounded-lg text-white">
              <Rocket size={28} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-800 tracking-tight">APRO Burn & Geometry Modeler</h1>
              <p className="text-sm text-slate-500 font-medium">Solid Rocket Motor Internal Ballistics Engine</p>
            </div>
          </div>
          <div className="flex space-x-3">
            <button
              onClick={runSimulation}
              className="flex items-center px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors shadow-sm"
            >
              <Play size={18} className="mr-2" />
              Run Simulation
            </button>
            {results.length > 0 && (
              <button
                onClick={handleDownload}
                className="flex items-center px-5 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-semibold rounded-lg transition-colors shadow-sm"
              >
                <Download size={18} className="mr-2" />
                Export .eng
              </button>
            )}
          </div>
        </div>

        {stabilityWarnings.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl shadow-sm">
            <h3 className="text-amber-800 font-bold text-sm mb-2 flex items-center">
              <Activity size={16} className="mr-2" />
              STABILITY WARNINGS
            </h3>
            <ul className="list-disc list-inside text-amber-700 text-xs space-y-1">
              {stabilityWarnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Configuration Panel */}
          <div className="lg:col-span-1 space-y-6">
            
            {/* Propellant Parameters */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
              <div className="flex items-center space-x-2 mb-4 text-slate-800">
                <Settings size={20} className="text-blue-600" />
                <h2 className="text-lg font-bold">Propellant</h2>
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Density (kg/m³)</label>
                    <input type="number" value={density} onChange={e => setDensity(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Burn Coeff (a)</label>
                    <input type="number" value={a} onChange={e => setA(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Pressure Exp (n)</label>
                    <input type="number" value={n} onChange={e => setN(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Flame Temp (K)</label>
                    <input type="number" value={flameTemp} onChange={e => setFlameTemp(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Gamma (γ)</label>
                    <input type="number" value={gamma} onChange={e => setGamma(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Mol Weight (kg/mol)</label>
                    <input type="number" value={molWeight} onChange={e => setMolWeight(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                </div>
              </div>
            </div>

            {/* Grain Geometry */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-2 text-slate-800">
                  <Activity size={20} className="text-blue-600" />
                  <h2 className="text-lg font-bold">Grain Geometry</h2>
                </div>
                <select 
                  value={grainType} 
                  onChange={e => setGrainType(e.target.value as any)}
                  className="p-1.5 bg-slate-100 border border-slate-200 rounded-md text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="Star">Star Grain</option>
                  <option value="BATES">BATES Grain</option>
                </select>
              </div>
              
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Length (m)</label>
                    <input type="number" value={length} onChange={e => setLength(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Outer Radius (m)</label>
                    <input type="number" value={outerRadius} onChange={e => setOuterRadius(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  
                  {grainType === 'Star' ? (
                    <>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">Valley Radius (m)</label>
                        <input type="number" value={valleyRadius} onChange={e => setValleyRadius(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">Tip Radius (m)</label>
                        <input type="number" value={tipRadius} onChange={e => setTipRadius(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">Points (N)</label>
                        <input type="number" value={numPoints} onChange={e => setNumPoints(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                      </div>
                    </>
                  ) : (
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 mb-1">Inner Radius (m)</label>
                      <input type="number" value={innerRadius} onChange={e => setInnerRadius(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Nozzle Parameters */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
              <div className="flex items-center space-x-2 mb-4 text-slate-800">
                <Settings size={20} className="text-blue-600" />
                <h2 className="text-lg font-bold">Nozzle</h2>
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Throat Diam (m)</label>
                    <input type="number" value={throatDiameter} onChange={e => setThroatDiameter(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Expansion Ratio</label>
                    <input type="number" value={expansionRatio} onChange={e => setExpansionRatio(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Material</label>
                    <select 
                      value={nozzleMaterial} 
                      onChange={e => setNozzleMaterial(e.target.value as any)}
                      className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value="Graphite">Graphite (Low)</option>
                      <option value="Phenolic">Phenolic (Med)</option>
                      <option value="Custom">Custom</option>
                    </select>
                  </div>
                  {nozzleMaterial === 'Custom' && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 mb-1">Erosion Coeff (m/s/Pa)</label>
                      <input type="number" value={erosionRate} onChange={e => setErosionRate(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Igniter & Casing */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
              <div className="flex items-center space-x-2 mb-4 text-slate-800">
                <Settings size={20} className="text-blue-600" />
                <h2 className="text-lg font-bold">Igniter & Casing</h2>
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Igniter Mass (kg)</label>
                    <input type="number" value={igniterMass} onChange={e => setIgniterMass(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Igniter Area (m²)</label>
                    <input type="number" value={igniterSurfaceArea} onChange={e => setIgniterSurfaceArea(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Casing Yield (MPa)</label>
                    <input type="number" value={casingYieldStress} onChange={e => setCasingYieldStress(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Casing Modulus (GPa)</label>
                    <input type="number" value={casingYoungsModulus} onChange={e => setCasingYoungsModulus(Number(e.target.value))} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* Results Panel */}
          <div className="lg:col-span-2 space-y-6">
            
            {/* Metrics Grid */}
            {metrics ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Max Thrust</p>
                  <p className="text-xl font-bold text-slate-800">{(metrics.maxThrust / 1000).toFixed(2)} <span className="text-sm font-medium text-slate-500">kN</span></p>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Max Pressure</p>
                  <p className="text-xl font-bold text-slate-800">{(metrics.maxPc / 1e6).toFixed(2)} <span className="text-sm font-medium text-slate-500">MPa</span></p>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Total Impulse</p>
                  <p className="text-xl font-bold text-slate-800">{(metrics.totalImpulse / 1000).toFixed(2)} <span className="text-sm font-medium text-slate-500">kNs</span></p>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Specific Impulse</p>
                  <p className="text-xl font-bold text-slate-800">{metrics.isp.toFixed(1)} <span className="text-sm font-medium text-slate-500">s</span></p>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Action Time</p>
                  <p className="text-xl font-bold text-slate-800">{metrics.actionTime.toFixed(2)} <span className="text-sm font-medium text-slate-500">s</span></p>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Avg Thrust</p>
                  <p className="text-xl font-bold text-slate-800">{(metrics.avgThrust / 1000).toFixed(2)} <span className="text-sm font-medium text-slate-500">kN</span></p>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Propellant Mass</p>
                  <p className="text-xl font-bold text-slate-800">{metrics.propMass.toFixed(2)} <span className="text-sm font-medium text-slate-500">kg</span></p>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Req. Casing (Al)</p>
                  <p className="text-xl font-bold text-slate-800">{(metrics.casingThickness * 1000).toFixed(2)} <span className="text-sm font-medium text-slate-500">mm</span></p>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wider">Casing Strain</p>
                  <p className="text-xl font-bold text-slate-800">{(metrics.casingStrain * 100).toFixed(3)} <span className="text-sm font-medium text-slate-500">%</span></p>
                </div>
              </div>
            ) : (
              <div className="bg-white p-8 rounded-xl shadow-sm border border-slate-100 flex flex-col items-center justify-center text-slate-400 h-32">
                <p>Run simulation to see performance metrics</p>
              </div>
            )}

            {/* Charts */}
            {results.length > 0 && (
              <div className="space-y-6">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                  <h3 className="text-sm font-bold text-slate-800 mb-4 uppercase tracking-wider">Thrust Profile</h3>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis 
                          dataKey="Time" 
                          type="number" 
                          domain={['dataMin', 'dataMax']} 
                          tickFormatter={(val) => val.toFixed(1)}
                          stroke="#94a3b8"
                          fontSize={12}
                        />
                        <YAxis 
                          stroke="#94a3b8"
                          fontSize={12}
                          tickFormatter={(val) => val.toFixed(1)}
                        />
                        <Tooltip 
                          formatter={(value: number) => [value.toFixed(2) + ' kN', 'Thrust']}
                          labelFormatter={(label: number) => `Time: ${label.toFixed(3)} s`}
                          contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        />
                        <Line type="monotone" dataKey="Thrust_kN" stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                  <h3 className="text-sm font-bold text-slate-800 mb-4 uppercase tracking-wider">Chamber Pressure</h3>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis 
                          dataKey="Time" 
                          type="number" 
                          domain={['dataMin', 'dataMax']} 
                          tickFormatter={(val) => val.toFixed(1)}
                          stroke="#94a3b8"
                          fontSize={12}
                        />
                        <YAxis 
                          stroke="#94a3b8"
                          fontSize={12}
                          tickFormatter={(val) => val.toFixed(1)}
                        />
                        <Tooltip 
                          formatter={(value: number) => [value.toFixed(2) + ' MPa', 'Pressure']}
                          labelFormatter={(label: number) => `Time: ${label.toFixed(3)} s`}
                          contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        />
                        <Line type="monotone" dataKey="Pc_MPa" stroke="#ef4444" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Geometry Visualizer */}
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                  <h3 className="text-sm font-bold text-slate-800 mb-4 uppercase tracking-wider">Grain Geometry Regression</h3>
                  <div className="flex flex-col items-center space-y-4">
                    <svg width="200" height="200" viewBox="0 0 200 200" className="bg-slate-800 rounded-full shadow-inner">
                      <circle cx="100" cy="100" r={(outerRadius / outerRadius) * 95} fill="#cbd5e1" />
                      {grainType === 'BATES' ? (
                        <circle cx="100" cy="100" r={Math.min(outerRadius, innerRadius + currentY) / outerRadius * 95} fill="#1e293b" />
                      ) : (
                        <path d={(() => {
                          const scale = 95 / outerRadius;
                          const r_outer = Math.min(outerRadius, valleyRadius + currentY) * scale;
                          const r_inner = Math.min(outerRadius, tipRadius + currentY) * scale;
                          let path = "";
                          for(let i=0; i<numPoints*2; i++) {
                            const radius = i % 2 === 0 ? r_inner : r_outer;
                            const angle = (i * Math.PI) / numPoints;
                            const px = 100 + radius * Math.sin(angle);
                            const py = 100 - radius * Math.cos(angle);
                            path += (i === 0 ? `M ${px} ${py} ` : `L ${px} ${py} `);
                          }
                          return path + "Z";
                        })()} fill="#1e293b" />
                      )}
                    </svg>
                    <div className="w-full max-w-md flex flex-col space-y-2 mt-4">
                      <div className="flex justify-between w-full text-xs font-semibold text-slate-500">
                        <span>Burn Area: {(results[visualizerIndex]?.Ab * 10000).toFixed(1)} cm²</span>
                        <span>Port Area: {(results[visualizerIndex]?.PortArea * 10000).toFixed(1)} cm²</span>
                      </div>
                      <div className="flex items-center space-x-4">
                        <span className="text-xs font-semibold text-slate-500">Time: {results[visualizerIndex]?.Time.toFixed(2)}s</span>
                        <input 
                          type="range" 
                          min="0" 
                          max={results.length - 1} 
                          value={visualizerIndex} 
                          onChange={(e) => setVisualizerIndex(Number(e.target.value))}
                          className="flex-1"
                        />
                        <span className="text-xs font-semibold text-slate-500">Web: {(currentY * 1000).toFixed(1)}mm</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Burn Rate vs Pressure */}
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                  <h3 className="text-sm font-bold text-slate-800 mb-4 uppercase tracking-wider">Burn Rate vs Pressure</h3>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={burnRateData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis 
                          dataKey="pressure" 
                          type="number" 
                          domain={['dataMin', 'dataMax']} 
                          stroke="#94a3b8"
                          fontSize={12}
                          label={{ value: 'Pressure (MPa)', position: 'insideBottom', offset: -5, fontSize: 12, fill: '#94a3b8' }}
                        />
                        <YAxis 
                          stroke="#94a3b8"
                          fontSize={12}
                          label={{ value: 'Burn Rate (mm/s)', angle: -90, position: 'insideLeft', fontSize: 12, fill: '#94a3b8' }}
                        />
                        <Tooltip 
                          formatter={(value: number) => [value.toFixed(2) + ' mm/s', 'Burn Rate']}
                          labelFormatter={(label: number) => `Pressure: ${label.toFixed(1)} MPa`}
                          contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        />
                        <Line type="monotone" dataKey="burnRate" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Monte Carlo */}
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Monte Carlo Analysis</h3>
                    <button onClick={runMonteCarlo} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-md transition-colors">
                      Run Analysis
                    </button>
                  </div>
                  <div className="flex space-x-4 mb-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 mb-1">Runs</label>
                      <input type="number" value={mcRuns} onChange={e => setMcRuns(Number(e.target.value))} className="w-24 p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 mb-1">Variance (%)</label>
                      <input type="number" value={mcVariance} onChange={e => setMcVariance(Number(e.target.value))} className="w-24 p-2 bg-slate-50 border border-slate-200 rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
                    </div>
                  </div>
                  {mcResults.length > 0 && (
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                          <XAxis dataKey="run" type="number" name="Run" stroke="#94a3b8" fontSize={12} label={{ value: 'Simulation Run', position: 'insideBottom', offset: -5, fontSize: 12, fill: '#94a3b8' }} />
                          <YAxis yAxisId="left" dataKey="maxPc" type="number" name="Max Pressure" stroke="#ef4444" fontSize={12} />
                          <YAxis yAxisId="right" dataKey="maxThrust" type="number" name="Max Thrust" orientation="right" stroke="#2563eb" fontSize={12} />
                          <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                          <Legend />
                          <Scatter yAxisId="left" name="Max Pressure (MPa)" data={mcResults} fill="#ef4444" />
                          <Scatter yAxisId="right" name="Max Thrust (kN)" data={mcResults} fill="#2563eb" />
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
