import React, { useMemo, useState } from 'react';
import { Download } from './ui/icons';
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
import { Button } from './ui/primitives';
import type { StructuralResult } from './wasmCore';
import type { MotorMetrics } from './motorMetrics';
import type { SimulationResult } from './engine';

/**
 * Casing integrity, bolted closure, and nozzle throat erosion.
 *
 * WHAT WAS WRONG WITH THE OLD ONE
 *
 * It was 500 lines that read like a report someone had pasted in: every number
 * introduced by a full sentence, four paragraphs of method notes between the
 * reader and the results, and the FLAGS panel -- "your casing yields at peak
 * pressure" -- at the very bottom, after everything else.
 *
 * The verdict now comes first, the numbers are tabulated rather than narrated,
 * and the method notes are collapsed behind a summary for the reader who wants
 * them. The flags moved to a toolbar chip, so the one thing you must not miss
 * is visible from every tab instead of below the fold on this one.
 *
 * Everything here is presentation. The analysis is done in Rust
 * (crates/burn-core/src/structural.rs) and arrives already computed.
 */

export interface StructuralTabProps {
  structural: StructuralResult | undefined;
  metrics: MotorMetrics | null;
  results: SimulationResult[];
  caseWallThickness: number;
  casingMaterial: string;
  /** MPa. */
  casingYieldStress: number;
  outerRadius: number;
  throatDiameter: number;
  nozzleMaterial: string;
  isSimulating: boolean;
  onExportCasingSTL: () => void;
  onExportCasingSCAD: () => void;
}

const MPa = (pa: number) => (pa / 1e6).toFixed(1);
const mm = (m: number) => (m * 1000).toFixed(2);

/** Safety factors below 1.5 are the reason this tab exists. */
/**
 * Stress bands for the schematic, low to high.
 *
 * Five steps rather than a continuous ramp: the underlying analysis is
 * closed-form at two locations, so a smooth fill would claim a resolution the
 * numbers do not have.
 */
const FEA_BANDS = [
  'var(--c-1)',
  'var(--c-6)',
  'var(--c-4)',
  'var(--c-5)',
  'var(--sem-danger)',
];

const sfTone = (sf: number) => (sf < 1 ? 'is-danger' : sf < 1.5 ? 'is-warn' : 'is-ok');

function Rows({ rows }: { rows: Array<{ k: string; v: React.ReactNode; tone?: string }> }) {
  return (
    <div className="kv">
      {rows.map((r) => (
        <div className="kv-row" key={r.k}>
          <span className="kv-key">{r.k}</span>
          <span className={`kv-val ${r.tone ?? ''}`}>{r.v}</span>
        </div>
      ))}
    </div>
  );
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
  const [showFEA, setShowFEA] = useState(false);
  const [showMethod, setShowMethod] = useState(false);

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

  const throat = useMemo(() => {
    if (!results.length) return null;
    const last = results[results.length - 1];
    return { initial: throatDiameter, final: Math.sqrt((4 * last.ThroatArea) / Math.PI) };
  }, [results, throatDiameter]);

  if (!metrics || !structural || !results.length) {
    return <div className="tab-empty">Run a simulation to analyse the casing.</div>;
  }

  const s = structural;

  return (
    <div className="tab-scroll">
      <div className="tab-doc">
        {/* ---- the verdict, before anything else ---- */}
        <section className="sec">
          <header className="sec-head">
            <span>Casing integrity</span>
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <label className="ui-check">
                <input
                  type="checkbox"
                  checked={showFEA}
                  onChange={(e) => setShowFEA(e.target.checked)}
                />
                <span className="ui-check-label">Schematic</span>
              </label>
              <Button variant="ghost" icon={<Download size={11} />} onClick={onExportCasingSTL} disabled={isSimulating}>
                .stl
              </Button>
              <Button variant="ghost" icon={<Download size={11} />} onClick={onExportCasingSCAD} disabled={isSimulating}>
                .scad
              </Button>
            </span>
          </header>

          <div className={`verdict ${sfTone(s.safetyFactor)}`}>
            <div className="verdict-sf">
              <span className="verdict-num">{s.safetyFactor.toFixed(2)}×</span>
              <span className="verdict-cap">safety factor</span>
            </div>
            <div className="verdict-detail">
              <div>
                <strong>{MPa(s.maxVonMises)} MPa</strong> von Mises · {casingYieldStress} MPa yield
              </div>
              <div className="verdict-where">
                {s.whereMax} · MoS {s.marginOfSafety.toFixed(3)}
              </div>
            </div>
          </div>

          <Rows
            rows={[
              { k: 'Peak chamber pressure', v: `${MPa(metrics.maxPc)} MPa` },
              { k: 'Bore radius', v: `${mm(outerRadius)} mm` },
              { k: 'Wall thickness', v: `${mm(caseWallThickness)} mm` },
              { k: 'Material', v: `${casingMaterial}` },
              {
                k: 'Wall regime',
                v: `${s.lame.thinWallApplicable ? 'Thin' : 'Thick'}: R/t = ${s.lame.rMeanOverT.toFixed(1)}`,
              },
              {
                k: 'Bore growth at peak',
                v: `${(s.boreRadialGrowth * 1e6).toFixed(0)} µm (${(s.boreHoopStrain * 100).toFixed(3)}% strain)`,
              },
            ]}
          />
        </section>

        {showFEA && (
          <section className="sec">
            <header className="sec-head">Stress schematic</header>
            <div className="sec-body">
              <svg viewBox="0 0 700 200" className="fea-svg" role="img" aria-label="Axisymmetric stress schematic">
                {/*
                  * Discrete bands, not a gradient fill.
                  *
                  * A smooth ramp implies the stress was computed continuously
                  * along the wall, which it was not -- this is a schematic of a
                  * closed-form result at two locations. Stepped blocks are
                  * honest about being a diagram, and read at a glance.
                  */}
                <line x1="60" y1="100" x2="640" y2="100" stroke="var(--b-control)" strokeDasharray="6 4" />
                {[0, 1, 2, 3, 4].map((i) => (
                  <g key={i}>
                    <rect x={100 + i * 100} y={40} width={100} height={15} fill={FEA_BANDS[i]} />
                    <rect x={100 + i * 100} y={145} width={100} height={15} fill={FEA_BANDS[i]} />
                  </g>
                ))}
                <rect x="590" y="30" width="22" height="140" fill="var(--c-5)" />
                <rect x="88" y="30" width="22" height="140" fill="var(--c-1)" />
                <text x="350" y="30" fill="var(--t-secondary)" fontSize="11" textAnchor="middle" fontFamily="var(--font)">
                  bore hoop ≈ {MPa(s.lame.inner.hoop)} MPa
                </text>
                <text x="601" y="185" fill="var(--t-secondary)" fontSize="11" textAnchor="middle" fontFamily="var(--font)">
                  {MPa(s.maxVonMises)} MPa
                </text>
              </svg>
              <p className="sec-note" style={{ borderTop: 0, padding: '6px 0 0' }}>
                Schematic only; colours are indicative.
              </p>
            </div>
          </section>
        )}

        {/* ---- through-wall stress ---- */}
        <section className="sec">
          <header className="sec-head">Through-wall stress (Lamé)</header>
          <div className="sec-body is-flush">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Location</th>
                  <th className="is-num">Hoop</th>
                  <th className="is-num">Radial</th>
                  <th className="is-num">Axial</th>
                  <th className="is-num">von Mises</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Bore, r = {mm(outerRadius)} mm</td>
                  <td className="is-num">{MPa(s.lame.inner.hoop)}</td>
                  <td className="is-num">{MPa(s.lame.inner.radial)}</td>
                  <td className="is-num">{MPa(s.lame.inner.axial)}</td>
                  <td className="is-num" style={{ color: 'var(--a-accent)' }}>
                    {MPa(s.lame.inner.vonMises)}
                  </td>
                </tr>
                <tr>
                  <td>Outer, r = {mm(outerRadius + caseWallThickness)} mm</td>
                  <td className="is-num">{MPa(s.lame.outer.hoop)}</td>
                  <td className="is-num">{MPa(s.lame.outer.radial)}</td>
                  <td className="is-num">{MPa(s.lame.outer.axial)}</td>
                  <td className="is-num" style={{ color: 'var(--a-accent)' }}>
                    {MPa(s.lame.outer.vonMises)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="chart-frame" style={{ minHeight: 190, margin: 'var(--gap-lg)' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={lameChart} margin={{ top: 14, right: 18, bottom: 18, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--c-grid)" />
                <XAxis
                  dataKey="r_mm" type="number" domain={['dataMin', 'dataMax']}
                  stroke="var(--c-axis)" tick={{ fill: 'var(--t-muted)', fontSize: 10 }}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  label={{ value: 'radius (mm)', position: 'insideBottom', offset: -10, fill: 'var(--t-muted)', fontSize: 10 }}
                />
                <YAxis stroke="var(--c-axis)" tick={{ fill: 'var(--t-muted)', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--s-raised)', border: '1px solid var(--b-strong)',
                    borderRadius: 0, fontSize: 11, fontFamily: 'var(--font)',
                  }}
                  formatter={(v: number | string) => `${Number(v).toFixed(1)} MPa`}
                />
                <Legend verticalAlign="top" height={18} iconType="plainline" wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="hoop" name="hoop" stroke="var(--c-1)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="axial" name="axial" stroke="var(--c-2)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="radial" name="radial" stroke="var(--c-3)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="vonMises" name="von Mises" stroke="var(--c-4)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* ---- junction ---- */}
        <section className="sec">
          <header className="sec-head">Case-to-closure junction (edge bending)</header>
          <Rows
            rows={[
              { k: 'Peak combined', v: `${MPa(s.edge.peak.vonMises)} MPa`, tone: 'is-danger' },
              { k: 'Location', v: `${mm(s.edge.peakLocation)} mm from joint` },
              { k: 'Critical surface', v: s.edge.peakSurface },
              { k: 'Decay length (3/β)', v: `${mm(s.edge.decayLength)} mm` },
              { k: 'Bending / hoop', v: `${s.edge.bendingToHoop.toFixed(2)}×` },
              { k: 'Thin-wall pR/t would give', v: `${MPa(s.lame.thinWallHoop)} MPa` },
            ]}
          />
        </section>

        {/* ---- bolts ---- */}
        <section className="sec">
          <header className="sec-head">
            Bolted closure: {s.bolts.count} × ⌀{mm(s.bolts.diameter)} mm
          </header>
          <Rows
            rows={[
              { k: 'Total closure load', v: `${(s.bolts.totalForce / 1000).toFixed(1)} kN` },
              { k: 'Load per bolt', v: `${(s.bolts.forcePerBolt / 1000).toFixed(2)} kN` },
              {
                k: 'Thread stress area',
                v: `${MPa(s.bolts.stressAreaStress)} MPa (SF ${s.bolts.safetyFactorStressArea.toFixed(2)})`,
                tone: sfTone(s.bolts.safetyFactorStressArea),
              },
              {
                k: 'Shank area',
                v: `${MPa(s.bolts.nominalStress)} MPa (SF ${s.bolts.safetyFactorNominal.toFixed(2)})`,
                tone: sfTone(s.bolts.safetyFactorNominal),
              },
              {
                k: 'Flange shear-out',
                v: `${MPa(s.bolts.shearOutStress)} MPa (SF ${s.bolts.safetyFactorShearOut.toFixed(2)})`,
                tone: sfTone(s.bolts.safetyFactorShearOut),
              },
              {
                k: 'Edge distance',
                v: `${mm(s.bolts.edgeDistance)} mm (min ${mm(s.bolts.minEdgeDistance)})`,
                tone: s.bolts.edgeDistance < s.bolts.minEdgeDistance ? 'is-danger' : undefined,
              },
              {
                k: 'Min thread engagement',
                v: `${mm(s.bolts.minEngagementSteel)} steel · ${mm(s.bolts.minEngagementAluminium)} alu`,
              },
            ]}
          />
          <p className="sec-note">
            Design to thread stress area (≈74% of shank), not shank.
          </p>
        </section>

        {/* ---- nozzle ---- */}
        {throat && (
          <section className="sec">
            <header className="sec-head">Nozzle throat erosion: {nozzleMaterial}</header>
            <Rows
              rows={[
                { k: 'Initial throat', v: `${mm(throat.initial)} mm` },
                {
                  k: 'Final throat',
                  v: `${mm(throat.final)} mm`,
                  tone: throat.final > throat.initial * 1.05 ? 'is-warn' : undefined,
                },
                {
                  k: 'Growth',
                  v: `${((throat.final / throat.initial - 1) * 100).toFixed(1)} %`,
                },
              ]}
            />
            <p className="sec-note" style={{ color: 'var(--a-accent)' }}>
              Order of magnitude only. Compare materials; do not size hardware.
            </p>
          </section>
        )}

        {/* ---- method, folded away ---- */}
        <section className="sec">
          <button
            type="button"
            className="sec-head"
            style={{ width: '100%', cursor: 'pointer', border: 0, textAlign: 'left' }}
            onClick={() => setShowMethod((v) => !v)}
            aria-expanded={showMethod}
          >
            <span>Method &amp; assumptions</span>
            <span style={{ color: 'var(--t-muted)' }}>{showMethod ? '−' : '+'}</span>
          </button>
          {showMethod && (
            <ul className="assump">
              {s.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default StructuralTab;
