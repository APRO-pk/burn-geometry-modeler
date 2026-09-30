import React, { useState } from 'react';
import type { ValidationIssue } from './designValidation';

export const UNIT_FACTORS: Record<string, Record<string, number>> = {
  Length: { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 },
  Pressure: { Pa: 1, kPa: 1000, MPa: 1e6, GPa: 1e9, psi: 6894.76, bar: 1e5, atm: 101325 },
  Mass: { kg: 1, g: 0.001, lbm: 0.453592 },
  Density: { 'kg/m³': 1, 'g/cm³': 1000, 'lb/in³': 27679.9 },
  Area: { 'm²': 1, 'cm²': 0.0001, 'mm²': 1e-6, 'in²': 0.00064516 },
  Temperature: { K: 1 },
};

export interface UnitSettings {
  unitSystem: 'Metric' | 'Imperial';
  imperialPrefs: Record<string, string>;
  setUnitSystem: React.Dispatch<React.SetStateAction<'Metric' | 'Imperial'>>;
  setImperialPrefs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

export const SettingsContext = React.createContext<UnitSettings | null>(null);

export const DEFAULT_METRIC_PREFS: Record<string, string> = {
  Length: 'mm',
  Pressure: 'MPa',
  Mass: 'kg',
  Density: 'kg/m³',
  Area: 'mm²',
};

export const DEFAULT_IMPERIAL_PREFS: Record<string, string> = {
  Length: 'in',
  Pressure: 'psi',
  Mass: 'lbm',
  Density: 'lb/in³',
  Area: 'in²',
};

export const IMPERIAL_OPTIONS: Record<string, string[]> = {
  Length: ['in', 'ft'],
  Pressure: ['psi', 'atm'],
  Mass: ['lbm'],
  Density: ['lb/in³'],
  Area: ['in²'],
};

interface InputBoxProps {
  label: string;
  value: number | string;
  onChange: (v: never) => void;
  suffix?: string;
  step?: string | number;
  type?: string;
  unitCat?: string | null;
  issues?: ValidationIssue[];
}

export const InputBox = ({
  label,
  value,
  onChange,
  suffix,
  step = 'any',
  type = 'number',
  unitCat = null,
  issues = [],
}: InputBoxProps) => {
  const settings = React.useContext(SettingsContext);
  const inputId = React.useId();
  const issueId = `${inputId}-issues`;

  const defaultLocalUnit = React.useMemo(() => {
    if (!unitCat || !UNIT_FACTORS[unitCat]) return suffix || '';
    if (settings) {
      if (settings.unitSystem === 'Imperial' && settings.imperialPrefs[unitCat]) {
        return settings.imperialPrefs[unitCat];
      } else if (settings.unitSystem === 'Metric' && DEFAULT_METRIC_PREFS[unitCat]) {
        return DEFAULT_METRIC_PREFS[unitCat];
      }
    }
    return Object.keys(UNIT_FACTORS[unitCat])[0];
  }, [unitCat, suffix, settings]);

  const [localUnit, setLocalUnit] = useState<string>('');

  React.useEffect(() => {
    setLocalUnit(defaultLocalUnit);
  }, [defaultLocalUnit]);

  const displayVal = React.useMemo(() => {
    if (type !== 'number' || !unitCat || !UNIT_FACTORS[unitCat]) return value;
    const factor = UNIT_FACTORS[unitCat][localUnit];
    if (!factor) return value;
    const res = Number(value) / factor;
    return Number.isInteger(res) ? res.toString() : parseFloat(res.toPrecision(6)).toString();
  }, [value, unitCat, localUnit, type]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (type !== 'number') return onChange(raw as never);
    const num = parseFloat(raw);
    if (isNaN(num)) return;

    if (unitCat && UNIT_FACTORS[unitCat] && UNIT_FACTORS[unitCat][localUnit]) {
      const factor = UNIT_FACTORS[unitCat][localUnit];
      onChange((num * factor) as never);
    } else {
      onChange(num as never);
    }
  };

  const errors = issues.filter((i) => i.severity === 'error');
  const worst = errors.length ? 'error' : issues.length ? 'warning' : null;

  return (
    <div className={`ui-field ${worst ? `is-${worst}` : ''}`}>
      <label className="ui-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="ui-field-control">
        <input
          id={inputId}
          type={type}
          step={step}
          value={displayVal}
          onChange={handleChange}
          aria-invalid={errors.length > 0 || undefined}
          aria-describedby={issues.length ? issueId : undefined}
          className="ui-input ui-input-num"
        />
        <div className="ui-field-suffix">
          {unitCat && UNIT_FACTORS[unitCat] ? (
            <select
              value={localUnit}
              onChange={(e) => setLocalUnit(e.target.value)}
              aria-label={`Unit for ${label}`}
            >
              {Object.keys(UNIT_FACTORS[unitCat]).map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          ) : (
            <span>{suffix}</span>
          )}
        </div>
      </div>
      {issues.length > 0 && (
        <div id={issueId} className="ui-field-msgs">
          {issues.map((i, idx) => (
            <p
              key={idx}
              role={i.severity === 'error' ? 'alert' : undefined}
              className={`ui-field-msg is-${i.severity}`}
            >
              {i.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
};
