import React, { useState } from 'react';
import { Close, Grain } from './ui/icons';
import { UNIT_FACTORS } from './InputBox';

const MODE_UNITS: Record<string, string[]> = {
  Length: ['m', 'cm', 'mm', 'in', 'ft'],
  Pressure: ['Pa', 'kPa', 'MPa', 'psi', 'bar', 'atm'],
  Mass: ['kg', 'g', 'lbm'],
  Temp: ['K', 'C', 'F', 'R'],
};

const MODE_DEFAULTS: Record<string, [string, string]> = {
  Length: ['in', 'mm'],
  Pressure: ['psi', 'MPa'],
  Mass: ['lbm', 'kg'],
  Temp: ['F', 'C'],
};

type UcMode = 'Length' | 'Pressure' | 'Mass' | 'Temp';

function convert(mode: UcMode, val: number, from: string, to: string): string {
  if (mode === 'Temp') {
    let tK = 0;
    if (from === 'K') tK = val;
    if (from === 'C') tK = val + 273.15;
    if (from === 'F') tK = (val - 32) * 5 / 9 + 273.15;
    if (from === 'R') tK = val * 5 / 9;
    if (to === 'K') return tK.toFixed(4);
    if (to === 'C') return (tK - 273.15).toFixed(4);
    if (to === 'F') return ((tK - 273.15) * 9 / 5 + 32).toFixed(4);
    if (to === 'R') return (tK * 9 / 5).toFixed(4);
    return '';
  }
  const rate1 = UNIT_FACTORS[mode]?.[from] || 1;
  const rate2 = UNIT_FACTORS[mode]?.[to] || 1;
  return ((val * rate1) / rate2).toPrecision(6);
}

export function UnitConverterDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<UcMode>('Length');
  const [val1, setVal1] = useState('1');
  const [unit1, setUnit1] = useState('in');
  const [unit2, setUnit2] = useState('mm');

  const handleModeChange = (m: UcMode) => {
    setMode(m);
    const [d1, d2] = MODE_DEFAULTS[m];
    setUnit1(d1);
    setUnit2(d2);
  };

  const result = convert(mode, parseFloat(val1) || 0, unit1, unit2);
  const units = MODE_UNITS[mode];

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--scrim)]">
      <div className="bg-[var(--s-canvas)] border border-[var(--b-strong)] w-80 flex flex-col text-[var(--t-primary)]">
        <div className="bg-[var(--s-sunken)] px-3 py-1.5 border-b border-[var(--b-strong)] flex justify-between items-center font-bold text-xs text-[var(--a-accent)]">
          <div className="flex items-center"><Grain size={14} className="mr-1" /> Unit Converter</div>
          <button onClick={onClose} className="hover:text-[var(--sem-danger)]"><Close size={12} /></button>
        </div>
        <div className="p-4 space-y-4 text-xs">
          <div>
            <label className="block mb-1 font-bold text-[var(--t-secondary)]">Measurement Type</label>
            <select
              value={mode}
              onChange={(e) => handleModeChange(e.target.value as UcMode)}
              className="w-full bg-[var(--s-sunken)] border border-[var(--b-strong)] text-[var(--t-primary)] px-2 py-1 outline-none focus:border-[var(--a-accent)]"
            >
              <option value="Length">Length</option>
              <option value="Pressure">Pressure</option>
              <option value="Mass">Mass</option>
              <option value="Temp">Temperature</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <input type="number" step="any" value={val1} onChange={(e) => setVal1(e.target.value)} className="w-full bg-[var(--s-canvas)] border border-[var(--b-strong)] text-[var(--t-primary)] px-2 py-1 mb-1 text-right outline-none focus:border-[var(--a-accent)]" />
              <select value={unit1} onChange={(e) => setUnit1(e.target.value)} className="w-full bg-[var(--s-sunken)] border border-[var(--b-strong)] text-[var(--t-primary)] px-2 py-1 outline-none focus:border-[var(--a-accent)]">
                {units.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <input type="text" readOnly value={result} className="w-full bg-[var(--s-canvas)] border border-[var(--b-strong)] text-[var(--a-accent)] px-2 py-1 mb-1 text-right font-bold outline-none" />
              <select value={unit2} onChange={(e) => setUnit2(e.target.value)} className="w-full bg-[var(--s-sunken)] border border-[var(--b-strong)] text-[var(--t-primary)] px-2 py-1 outline-none focus:border-[var(--a-accent)]">
                {units.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
