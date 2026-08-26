import React from 'react';
import { Button } from './ui/primitives';

/**
 * Material Properties: a read-only summary of the propellant, casing and nozzle
 * currently applied, with save/load of individual material sets.
 *
 * The values are edited in the Motor Parameters dock; this view only displays
 * them, so it takes no setters.
 *
 * Three cards previously repeated the same markup with slightly different
 * headings, colours and grid gaps. They are one component now, which is why
 * they finally line up.
 */

export type MaterialKind = 'propellant' | 'casing' | 'nozzle';

export interface MaterialsTabProps {
  /** Library name, used to say whether the burn law has been measured. */
  propellantName: string;
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
  /** Save/load one material set at a time. */
  onSaveMaterial: (type: MaterialKind) => void;
  onLoadMaterial: (type: MaterialKind) => void;
}

interface Prop {
  key: string;
  value: string;
  /** Marks a value with no measured backing in this repository. */
  unvalidated?: boolean;
}

function MaterialCard({
  title,
  subtitle,
  kind,
  props,
  onSave,
  onLoad,
  note,
}: {
  title: string;
  subtitle?: string;
  kind: MaterialKind;
  props: Prop[];
  onSave: (k: MaterialKind) => void;
  onLoad: (k: MaterialKind) => void;
  note?: React.ReactNode;
}) {
  return (
    <section className="sec">
      <header className="sec-head">
        <span>{title}</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <Button variant="ghost" onClick={() => onSave(kind)}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => onLoad(kind)}>
            Load
          </Button>
        </span>
      </header>
      {subtitle && <div className="mat-subtitle">{subtitle}</div>}
      <div className="kv" style={{ gridTemplateColumns: '1fr' }}>
        {props.map((p) => (
          <div className="kv-row" key={p.key}>
            <span className="kv-key">{p.key}</span>
            <span className={`kv-val ${p.unvalidated ? 'is-warn' : ''}`}>
              {p.value}
              {p.unvalidated && <span className="kv-sub">unvalidated</span>}
            </span>
          </div>
        ))}
      </div>
      {note && <p className="sec-note">{note}</p>}
    </section>
  );
}

export function MaterialsTab({
  propellantName,
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
  /*
   * Only the sugar propellants have been measured against strand-burner data.
   * Same test the uncertainty budget uses, so the two cannot disagree about
   * whether a propellant is validated.
   */
  const propellantMeasured = /KNSB|KNDX|sorbitol|dextrose/i.test(propellantName);

  return (
    <div className="tab-scroll">
      <div className="tab-doc">
        <div className="mat-grid">
          <MaterialCard
            title="Propellant"
            subtitle={propellantName}
            kind="propellant"
            onSave={onSaveMaterial}
            onLoad={onLoadMaterial}
            props={[
              { key: 'Density', value: `${density} kg/m³` },
              { key: 'Burn coefficient a', value: a.toExponential(3) },
              { key: 'Pressure exponent n', value: n.toFixed(4) },
              { key: 'Molecular weight', value: `${molWeight} kg/mol` },
              { key: 'Flame temperature', value: `${flameTemp} K` },
            ]}
            note={
              propellantMeasured
                ? undefined
                : 'Burn rate for this propellant has not been checked against measurement in this repository. See MODEL_UNCERTAINTY.md.'
            }
          />

          <MaterialCard
            title="Casing alloy"
            subtitle={casingMaterial}
            kind="casing"
            onSave={onSaveMaterial}
            onLoad={onLoadMaterial}
            props={[
              { key: 'Yield strength', value: `${casingYieldStress} MPa` },
              { key: "Young's modulus", value: `${casingYoungsModulus} GPa` },
              {
                key: "Poisson's ratio",
                value: casingMaterial === 'Steel 4130' ? '0.29' : '0.33',
              },
            ]}
            note="Composite cases are analysed with isotropic relations, which a laminate is not. Treat those results as indicative."
          />

          <MaterialCard
            title="Nozzle"
            subtitle={nozzleMaterial}
            kind="nozzle"
            onSave={onSaveMaterial}
            onLoad={onLoadMaterial}
            props={[
              { key: 'Thermal conductivity', value: `${nozzleThermalConductivity} W/m·K` },
              { key: 'Specific heat', value: `${nozzleSpecificHeat} J/kg·K` },
              { key: 'Erosion model', value: 'Simplified Bartz', unvalidated: true },
            ]}
            note="The erosion coefficient is roughly 7x the real Bartz correlation and has no calibration here. Use it to compare materials, not to predict a recession depth."
          />
        </div>

        <section className="sec">
          <header className="sec-head">Where these values are edited</header>
          <p className="sec-note" style={{ borderTop: 0 }}>
            Material parameters are set in the Motor Parameters dock on the left, or loaded whole
            from a configuration file. The thermodynamic erosion model resolves the detailed
            properties behind the scenes for the named combinations, Graphite and Phenolic,
            and exposes them for editing only when the material is set to Custom.
          </p>
        </section>
      </div>
    </div>
  );
}

export default MaterialsTab;
