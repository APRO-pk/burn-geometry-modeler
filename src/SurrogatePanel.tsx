import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Zap, Play, Check, AlertTriangle } from 'lucide-react';
import {
  checkEnvelope,
  loadSurrogate,
  predict,
  surrogateInfo,
  surrogateMetrics,
  surrogateMetricsByKind,
} from './surrogate/predict';
import type { SurrogateTarget } from './surrogate/predict';
import { describeGrain } from './surrogate/features';
import type { RawDesign, SurrogateGrain } from './surrogate/features';
import { GRAIN_SHAPE_PARAMS } from './surrogate/shape';
import { dispersionSweep, histogram, inverseDesign } from './surrogate/optimize';
import type { Candidate } from './surrogate/optimize';
import { runMotor } from './wasmClient';
import type { BurnConfig, BurnRateRegime } from './wasmCore';

/*
 * The surrogate UI.
 *
 * One rule runs through all three panels: a surrogate number is never shown
 * bare. Every figure carries its 95% band, and every panel has a button that
 * runs the real solver and shows the delta. The surrogate is a way to explore
 * quickly, not a source of answers.
 */

const TARGETS: SurrogateTarget[] = ['peak_pc', 'total_impulse', 'isp', 'max_kn', 'burn_time'];

const LABEL: Record<SurrogateTarget, string> = {
  peak_pc: 'Peak Chamber Pressure',
  total_impulse: 'Total Impulse',
  isp: 'Specific Impulse',
  max_kn: 'Peak Kn',
  burn_time: 'Burn Time',
};

const SHORT: Record<SurrogateTarget, string> = {
  peak_pc: 'Pc',
  total_impulse: 'It',
  isp: 'Isp',
  max_kn: 'Kn',
  burn_time: 'tb',
};

const FORMAT: Record<SurrogateTarget, (v: number) => string> = {
  peak_pc: (v) => `${(v / 1e6).toFixed(2)} MPa`,
  total_impulse: (v) => `${v.toFixed(0)} N·s`,
  isp: (v) => `${v.toFixed(1)} s`,
  max_kn: (v) => v.toFixed(0),
  burn_time: (v) => `${v.toFixed(3)} s`,
};

export interface SurrogatePanelProps {
  /** The design currently in the main editor, in the surrogate's own shape. */
  design: RawDesign;
  /** Apply a design found by inverse search back into the main editor. */
  onApplyDesign: (d: RawDesign) => void;
  addLog: (msg: string) => void;
  /**
   * The live propellant's piecewise burn-rate bands, empty for a plain power
   * law.
   *
   * The surrogate reads `log_a` and `n` as two of its features and was trained
   * on single-law solves, so when bands are active its inputs no longer describe
   * the burn law actually being integrated. The panel has to say so; silently
   * predicting a different motor than the Run button simulates is the one
   * failure mode a surrogate must not have.
   */
  burnRateRegimes?: BurnRateRegime[];
}

/** A one-line summary of a grain's shape, for the candidate table. */
function describeShape(g: SurrogateGrain): string {
  const mm = (v: number) => (v * 1000).toFixed(0);
  switch (g.kind) {
    case 'BATES':
    case 'Tubular':
      return `⌀${mm(g.outer_radius * 2)}/${mm(g.inner_radius * 2)}`;
    case 'Star':
      return `⌀${mm(g.outer_radius * 2)} · ${g.num_points}pt · v${mm(g.valley_radius)}/t${mm(g.tip_radius)}`;
    case 'RodAndTube':
      return `⌀${mm(g.outer_radius * 2)} · rod ${mm(g.rod_radius * 2)} · bore ${mm(g.tube_inner_radius * 2)}`;
    case 'MoonBurner':
      return `⌀${mm(g.outer_radius * 2)} · core ${mm(g.core_radius * 2)} · off ${mm(g.offset)}`;
    case 'Finocyl':
      return `⌀${mm(g.outer_radius * 2)} · ${g.num_fins} fins × ${mm(g.h_fin)}mm`;
    case 'CustomDXF':
      return `⌀${mm(g.outer_radius * 2)} · traced profile`;
  }
}

/**
 * Ground truth for one design, via the same worker the Run button uses.
 *
 * `regimes` is passed separately rather than living on RawDesign because
 * RawDesign is the surrogate's FEATURE domain, and the feature vector
 * deliberately does not describe a piecewise law. Keeping it out of that type
 * stops a future reader assuming the model accounts for it. Ground truth is a
 * real solve, so it can and must honour the bands.
 */
async function solveTruth(
  d: RawDesign,
  regimes: BurnRateRegime[] = []
): Promise<Record<SurrogateTarget, number>> {
  const config: BurnConfig = {
    propellant: {
      density: d.density,
      a: d.a,
      n: d.n,
      ...(regimes.length ? { burn_rate_regimes: regimes } : {}),
      flame_temp: 1720,
      gamma: 1.13,
      molecular_weight: 0.042,
    },
    grain: d.grain as BurnConfig['grain'],
    nozzle: {
      throat_diameter: d.throat_diameter,
      expansion_ratio: d.expansion_ratio,
      material: null,
    },
    igniter: null,
    options: { model: '0D' },
  };
  const { results } = await runMotor(config);
  let peak_pc = -Infinity;
  let max_kn = -Infinity;
  let total_impulse = 0;
  for (let i = 0; i < results.length; i++) {
    peak_pc = Math.max(peak_pc, results[i].Pc);
    max_kn = Math.max(max_kn, results[i].Ab / results[i].ThroatArea);
    if (i > 0) {
      total_impulse +=
        ((results[i].Thrust + results[i - 1].Thrust) / 2) *
        (results[i].Time - results[i - 1].Time);
    }
  }
  // Propellant mass comes from the same descriptor the features use, so Isp is
  // computed the way the model was trained rather than by a parallel formula.
  const propMass = describeGrain(d.grain, d.density, d.n).propMass;
  return {
    peak_pc,
    total_impulse,
    isp: total_impulse / (Math.max(propMass, 1e-9) * 9.80665),
    max_kn,
    burn_time: results[results.length - 1].Time,
  };
}

/** Warning strip shown whenever the design leaves the training envelope. */
function EnvelopeWarning({ design }: { design: RawDesign }) {
  const env = checkEnvelope(design);
  if (env.inside) return null;
  return (
    <div className="border border-[#663333] bg-[#1a0d0d] rounded p-2 text-[10px] text-[#ffaaaa] leading-snug">
      <div className="flex items-center space-x-1 font-bold mb-1">
        <AlertTriangle className="w-3 h-3" />
        <span>OUTSIDE TRAINING ENVELOPE — surrogate values are extrapolation</span>
      </div>
      {env.violations.slice(0, 4).map((v) => (
        <div key={v.feature}>
          {v.feature} = {v.value.toPrecision(4)} is outside the sampled range [
          {v.min.toPrecision(4)}, {v.max.toPrecision(4)}]
        </div>
      ))}
      {env.violations.length > 4 && (
        <div>…and {env.violations.length - 4} more.</div>
      )}
      <div className="mt-1 text-[#ff8888]">
        Use “Verify with full solve” — do not trust the prediction here.
      </div>
    </div>
  );
}

export function SurrogatePanel({
  design,
  onApplyDesign,
  addLog,
  burnRateRegimes = [],
}: SurrogatePanelProps) {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadSurrogate()
      .then(() => live && setReady(true))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  // --- a. instant prediction ---------------------------------------------

  const [predictMs, setPredictMs] = useState(0);
  const prediction = useMemo(() => {
    if (!ready) return null;
    const t0 = performance.now();
    const p = predict(design);
    setPredictMs(performance.now() - t0);
    return p;
  }, [ready, design]);

  const [verify, setVerify] = useState<{
    truth: Record<SurrogateTarget, number>;
    predicted: Record<SurrogateTarget, number>;
    ms: number;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const runVerify = useCallback(async () => {
    if (!prediction) return;
    setVerifying(true);
    const t0 = performance.now();
    try {
      const truth = await solveTruth(design, burnRateRegimes);
      setVerify({ truth, predicted: prediction.mean, ms: performance.now() - t0 });
      addLog(
        `Surrogate verified against full solve: peak Pc ${(truth.peak_pc / 1e6).toFixed(2)} MPa ` +
          `vs predicted ${(prediction.mean.peak_pc / 1e6).toFixed(2)} MPa ` +
          `(${(((prediction.mean.peak_pc - truth.peak_pc) / truth.peak_pc) * 100).toFixed(2)}%).`
      );
    } catch (e) {
      addLog(`Verification failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerifying(false);
    }
  }, [design, prediction, addLog, burnRateRegimes]);

  useEffect(() => {
    setVerify(null);
  }, [design]);

  // --- b. inverse design --------------------------------------------------

  const [targetImpulse, setTargetImpulse] = useState(2000);
  const [targetMaxPc, setTargetMaxPc] = useState(7);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [searchMs, setSearchMs] = useState(0);
  const [candidateTruth, setCandidateTruth] = useState<Record<SurrogateTarget, number> | null>(null);
  const [searching, setSearching] = useState(false);

  const kind = design.grain.kind;
  const shapeSpec = GRAIN_SHAPE_PARAMS[kind];

  const runSearch = useCallback(async () => {
    if (!ready) return;
    setSearching(true);
    setCandidateTruth(null);
    const t0 = performance.now();
    const found = inverseDesign(
      {
        length: [0.08, 1.1],
        outer_radius: [0.018, 0.09],
        throat_diameter: [0.003, 0.09],
        expansion_ratio: [1.0, 12.0],
      },
      { maxImpulse: targetImpulse, minImpulse: targetImpulse * 0.9, maxPeakPc: targetMaxPc * 1e6 },
      {
        fixed: { a: design.a, n: design.n, density: design.density },
        kind,
        seedGrain: design.grain,
        restarts: 10,
      }
    );
    setSearchMs(performance.now() - t0);
    setCandidates(found);

    // Auto-verify the winner: the point of the exercise. An unverified
    // optimisation result over an approximate model is exactly the kind of
    // number that gets built.
    if (found.length) {
      try {
        const truth = await solveTruth(found[0].design, burnRateRegimes);
        setCandidateTruth(truth);
        addLog(
          `Inverse design (${kind}): best candidate verified — impulse ` +
            `${truth.total_impulse.toFixed(0)} N·s (target ≤ ${targetImpulse}), peak Pc ` +
            `${(truth.peak_pc / 1e6).toFixed(2)} MPa (limit ${targetMaxPc}).`
        );
      } catch (e) {
        addLog(`Candidate verification failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setSearching(false);
  }, [ready, targetImpulse, targetMaxPc, design, kind, addLog, burnRateRegimes]);

  // --- c. real-time Monte Carlo -------------------------------------------

  const [mcSigma, setMcSigma] = useState(3);
  const [mcSamples, setMcSamples] = useState(5000);
  const [mcTarget, setMcTarget] = useState<SurrogateTarget>('peak_pc');
  const [mcResult, setMcResult] = useState<ReturnType<typeof dispersionSweep> | null>(null);
  const [mcMs, setMcMs] = useState(0);
  const [mcConfirm, setMcConfirm] = useState<{ n: number; values: number[]; ms: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const runMonteCarlo = useCallback(() => {
    if (!ready) return;
    const t0 = performance.now();
    const res = dispersionSweep(design, { sigma: mcSigma / 100, samples: mcSamples }, TARGETS);
    setMcMs(performance.now() - t0);
    setMcResult(res);
    setMcConfirm(null);
  }, [ready, design, mcSigma, mcSamples]);

  const confirmMonteCarlo = useCallback(async () => {
    setConfirming(true);
    const N = 40;
    const t0 = performance.now();
    let s = 4242 >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let r = Math.imul(s ^ (s >>> 15), 1 | s);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => {
      let u = 0;
      let v = 0;
      let q = 0;
      do {
        u = 2 * rnd() - 1;
        v = 2 * rnd() - 1;
        q = u * u + v * v;
      } while (q === 0 || q >= 1);
      return u * Math.sqrt((-2 * Math.log(q)) / q);
    };
    const values: number[] = [];
    try {
      for (let i = 0; i < N; i++) {
        const sig = mcSigma / 100;
        // One draw for the burn coefficient, applied to whichever law governs.
        // With bands active, perturbing d.a alone would do NOTHING inside their
        // pressure range, and the sweep would silently under-report dispersion.
        // Batch-to-batch variation scales the whole curve, so every band moves
        // together by the same factor.
        const aScale = 1 + sig * gauss();
        const truth = await solveTruth(
          {
            ...design,
            a: design.a * aScale,
            throat_diameter: design.throat_diameter * (1 + sig * gauss()),
            density: design.density * (1 + sig * gauss()),
          },
          burnRateRegimes.map((r) => ({ ...r, a: r.a * aScale }))
        );
        values.push(truth[mcTarget]);
      }
      setMcConfirm({ n: N, values, ms: performance.now() - t0 });
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      addLog(`Monte Carlo confirmed with ${N} full solves: mean ${LABEL[mcTarget]} ${FORMAT[mcTarget](mean)}.`);
    } catch (e) {
      addLog(`Confirmation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConfirming(false);
    }
  }, [design, mcSigma, mcTarget, addLog, burnRateRegimes]);

  // --- render -------------------------------------------------------------

  if (loadError) {
    return (
      <div className="text-[#ff6666] font-mono text-xs p-6">
        Surrogate model failed to load: {loadError}
        <div className="text-[#888] mt-2">Rebuild it with: npm run surrogate:rebuild</div>
      </div>
    );
  }
  if (!ready || !prediction) {
    return <div className="text-[#666] italic font-mono text-xs p-6">Loading surrogate model…</div>;
  }

  const info = surrogateInfo()!;
  const metrics = surrogateMetrics()!;
  const byKind = surrogateMetricsByKind();
  const kindMetrics = byKind?.[kind];
  const mcHist = mcResult ? histogram(mcResult[mcTarget].values, 44) : [];

  return (
    <div className="w-full max-w-5xl space-y-6 mt-6 text-xs font-mono">
      {/* ---- provenance ---- */}
      <div className="bg-[#111] border border-[#333] rounded p-3 text-[10px] text-[#888] leading-snug">
        <span className="text-[#00aaff] font-bold">SURROGATE MODEL</span> — one Gaussian process
        covering all {info.grainKinds.length} grain geometries, trained on {String(info.dataset.trainRows)}{' '}
        solves of the same Rust core the Run button uses ({String(info.dataset.totalRows)} sampled,{' '}
        {String(info.dataset.testRows)} held out). It predicts from the grain's burn-back CURVES
        rather than its parameters, which is why one model covers every geometry.
        <div className="mt-1">
          Held-out, all geometries:{' '}
          {TARGETS.map((t) => `${SHORT[t]} R²=${metrics[t].r2.toFixed(4)}`).join(', ')}.
          {kindMetrics && (
            <>
              {' '}For <span className="text-[#00aaff]">{kind}</span> specifically: Pc R²=
              {kindMetrics.peak_pc.r2.toFixed(4)} / {kindMetrics.peak_pc.mape.toFixed(2)}% MAPE,
              It R²={kindMetrics.total_impulse.r2.toFixed(4)}, tb R²=
              {kindMetrics.burn_time.r2.toFixed(4)}.
            </>
          )}
        </div>
      </div>

      {burnRateRegimes.length > 0 && (
        <div className="bg-[#2a1a00] border border-[#886600] rounded p-3 text-[10px] text-[#ffcc66] leading-snug">
          <span className="font-bold">PIECEWISE BURN LAW — predictions below are approximate.</span>
          <div className="mt-1 text-[#ddbb88]">
            This propellant uses a measured {burnRateRegimes.length}-band burn-rate law, but the
            surrogate is trained on single power-law solves and takes a={design.a.toExponential(3)},
            n={design.n.toFixed(4)} as its inputs. Those are the propellant's fallback coefficients,
            not the law the solver integrates, so everything on this tab — prediction, inverse
            design and Monte Carlo — describes a slightly different motor. Press{' '}
            <span className="text-[#00ffaa]">Verify</span> against the real core, or run the full
            simulation, for a number you can size hardware from.
          </div>
        </div>
      )}

      <EnvelopeWarning design={design} />

      {/* ---- a. instant prediction ---- */}
      <div className="bg-[#111] border border-[#333] p-4 rounded">
        <div className="flex justify-between items-center border-b border-[#333] pb-2 mb-3">
          <h3 className="font-bold text-[#00aaff] text-sm flex items-center space-x-2">
            <Zap className="w-4 h-4" />
            <span>INSTANT PREDICTION — {kind}</span>
          </h3>
          <div className="flex items-center space-x-3">
            <span className="text-[#666] text-[10px]">{predictMs.toFixed(2)} ms</span>
            <button
              onClick={runVerify}
              disabled={verifying}
              className="border border-[#00aaff] text-[#00aaff] px-3 py-1 rounded hover:bg-[#00aaff] hover:text-black transition-colors disabled:opacity-50"
            >
              {verifying ? 'Solving…' : 'Verify with full solve'}
            </button>
          </div>
        </div>

        <table className="w-full text-[11px]">
          <thead className="text-[#888]">
            <tr>
              <th className="text-left py-1">Output</th>
              <th className="text-right py-1">Surrogate</th>
              <th className="text-right py-1">95% band</th>
              {verify && <th className="text-right py-1">Full solve</th>}
              {verify && <th className="text-right py-1">Δ</th>}
            </tr>
          </thead>
          <tbody className="text-[#eee]">
            {TARGETS.map((t) => {
              const delta = verify ? (verify.predicted[t] - verify.truth[t]) / verify.truth[t] : 0;
              const covered =
                verify &&
                verify.truth[t] >= prediction.lower[t] &&
                verify.truth[t] <= prediction.upper[t];
              return (
                <tr key={t} className="border-t border-[#222]">
                  <td className="py-1">{LABEL[t]}</td>
                  <td className="text-right text-[#ffaa00]">{FORMAT[t](prediction.mean[t])}</td>
                  <td className="text-right text-[#888]">
                    {FORMAT[t](prediction.lower[t])} – {FORMAT[t](prediction.upper[t])}
                  </td>
                  {verify && <td className="text-right text-[#00ff88]">{FORMAT[t](verify.truth[t])}</td>}
                  {verify && (
                    <td className={`text-right ${Math.abs(delta) < 0.05 ? 'text-[#00ff88]' : 'text-[#ffaa00]'}`}>
                      {(delta * 100).toFixed(2)}%{covered ? ' ✓' : ' !'}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {verify && (
          <p className="text-[#666] text-[10px] mt-2">
            Full solve took {verify.ms.toFixed(0)} ms versus {predictMs.toFixed(2)} ms for the
            surrogate — a {(verify.ms / Math.max(predictMs, 1e-6)).toFixed(0)}× speedup. “✓” means
            the true value fell inside the predicted band.
          </p>
        )}
      </div>

      {/* ---- b. inverse design ---- */}
      <div className="bg-[#111] border border-[#333] p-4 rounded">
        <h3 className="font-bold text-[#00aaff] text-sm border-b border-[#333] pb-2 mb-3">
          INVERSE DESIGN — searching {kind} geometry
        </h3>
        <div className="flex flex-wrap items-end gap-4 mb-3">
          <label className="flex flex-col space-y-1">
            <span className="text-[#888] text-[10px]">Total impulse ≤ (N·s)</span>
            <input
              type="number"
              value={targetImpulse}
              onChange={(e) => setTargetImpulse(parseFloat(e.target.value) || 0)}
              className="bg-[#222] border border-[#555] px-2 py-1 w-28 text-[#eee]"
            />
          </label>
          <label className="flex flex-col space-y-1">
            <span className="text-[#888] text-[10px]">Peak Pc ≤ (MPa)</span>
            <input
              type="number"
              value={targetMaxPc}
              onChange={(e) => setTargetMaxPc(parseFloat(e.target.value) || 0)}
              className="bg-[#222] border border-[#555] px-2 py-1 w-24 text-[#eee]"
            />
          </label>
          <button
            onClick={runSearch}
            disabled={searching}
            className="bg-[#ffaa00] text-black px-4 py-1.5 font-bold rounded flex items-center hover:bg-[#ffcc00] disabled:opacity-50"
          >
            <Play className="w-3 h-3 mr-1" /> {searching ? 'Searching…' : 'Find design'}
          </button>
          {candidates && (
            <span className="text-[#666] text-[10px]">
              {candidates.length} distinct candidates in {searchMs.toFixed(0)} ms
            </span>
          )}
        </div>

        <p className="text-[#666] text-[10px] mb-2 leading-snug">
          {shapeSpec.length > 0 ? (
            <>
              Free variables: length, casing radius, throat, expansion ratio, and this geometry's
              shape — {shapeSpec.map((p) => p.label.toLowerCase()).join(', ')}. Propellant is held
              fixed.
            </>
          ) : (
            <>
              A Custom DXF cross-section comes from a traced file, so there is no shape to optimise:
              the search moves length, casing radius, throat and expansion ratio only, keeping your
              profile.
            </>
          )}
        </p>

        {candidates && candidates.length > 0 && (
          <>
            <table className="w-full text-[11px]">
              <thead className="text-[#888]">
                <tr>
                  <th className="text-left py-1">#</th>
                  <th className="text-right py-1">Length</th>
                  <th className="text-left py-1 pl-3">Grain</th>
                  <th className="text-right py-1">Throat</th>
                  <th className="text-right py-1">ε</th>
                  <th className="text-right py-1">Impulse</th>
                  <th className="text-right py-1">Peak Pc</th>
                  <th className="text-right py-1">±band</th>
                  <th className="text-right py-1"></th>
                </tr>
              </thead>
              <tbody className="text-[#eee]">
                {candidates.slice(0, 5).map((c, i) => (
                  <tr key={i} className="border-t border-[#222] hover:bg-[#1a1a1a]">
                    <td className="py-1">{i + 1}</td>
                    <td className="text-right">{(c.design.grain.length * 1000).toFixed(0)} mm</td>
                    <td className="pl-3 text-[10px] text-[#bbb]">{describeShape(c.design.grain)}</td>
                    <td className="text-right">{(c.design.throat_diameter * 1000).toFixed(1)} mm</td>
                    <td className="text-right">{c.design.expansion_ratio.toFixed(1)}</td>
                    <td className="text-right text-[#ffaa00]">{c.predicted.total_impulse.toFixed(0)}</td>
                    <td className="text-right text-[#ffaa00]">{(c.predicted.peak_pc / 1e6).toFixed(2)}</td>
                    <td className={`text-right ${c.band > 0.1 ? 'text-[#ff6666]' : 'text-[#888]'}`}>
                      {(c.band * 100).toFixed(1)}%
                    </td>
                    <td className="text-right">
                      <button
                        onClick={() => {
                          onApplyDesign(c.design);
                          addLog(`Applied surrogate candidate ${i + 1} (${kind}) to the design inputs.`);
                        }}
                        className="text-[#00aaff] hover:text-white border border-[#444] px-1 rounded text-[10px]"
                      >
                        Apply
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {candidateTruth ? (
              <div className="mt-3 border border-[#334433] bg-[#0d1a0d] rounded p-2 text-[10px]">
                <div className="flex items-center space-x-1 text-[#00ff88] font-bold mb-1">
                  <Check className="w-3 h-3" />
                  <span>CANDIDATE 1 VERIFIED AGAINST THE PHYSICS CORE</span>
                </div>
                <div className="text-[#aaddaa]">
                  Impulse {candidateTruth.total_impulse.toFixed(0)} N·s (surrogate said{' '}
                  {candidates[0].predicted.total_impulse.toFixed(0)},{' '}
                  {(((candidates[0].predicted.total_impulse - candidateTruth.total_impulse) /
                    candidateTruth.total_impulse) * 100).toFixed(2)}
                  % off) · Peak Pc {(candidateTruth.peak_pc / 1e6).toFixed(2)} MPa (surrogate said{' '}
                  {(candidates[0].predicted.peak_pc / 1e6).toFixed(2)},{' '}
                  {(((candidates[0].predicted.peak_pc - candidateTruth.peak_pc) / candidateTruth.peak_pc) * 100).toFixed(2)}
                  % off)
                </div>
                {(() => {
                  // A design that produces no thrust trivially satisfies
                  // "impulse <= X", so usefulness is checked before compliance.
                  const useless = !(candidateTruth.total_impulse > 0.5 * targetImpulse);
                  const meets =
                    candidateTruth.total_impulse <= targetImpulse &&
                    candidateTruth.peak_pc <= targetMaxPc * 1e6;
                  if (useless) {
                    return (
                      <div className="mt-1 text-[#ff8888]">
                        REJECT: the verified design delivers only{' '}
                        {candidateTruth.total_impulse.toFixed(0)} N·s. It satisfies the ceiling by
                        not working. Widen the bounds or relax the pressure limit.
                      </div>
                    );
                  }
                  return (
                    <div className={`mt-1 ${meets ? 'text-[#88bb88]' : 'text-[#ff8888]'}`}>
                      {meets
                        ? 'The verified design meets both constraints.'
                        : 'WARNING: the verified design misses a constraint the surrogate thought it met. Trust this row, not the one above.'}
                    </div>
                  );
                })()}
              </div>
            ) : (
              <p className="text-[#666] text-[10px] mt-2">Verifying candidate 1 against the full solver…</p>
            )}
          </>
        )}
        {candidates && candidates.length === 0 && (
          <p className="text-[#ff6666] text-[10px]">
            No feasible {kind} design found inside the training envelope. Try relaxing the pressure
            limit or the impulse target.
          </p>
        )}
      </div>

      {/* ---- c. real-time Monte Carlo ---- */}
      <div className="bg-[#111] border border-[#333] p-4 rounded">
        <h3 className="font-bold text-[#00aaff] text-sm border-b border-[#333] pb-2 mb-3">
          REAL-TIME MONTE CARLO
        </h3>
        <div className="flex flex-wrap items-end gap-4 mb-3">
          <label className="flex flex-col space-y-1">
            <span className="text-[#888] text-[10px]">1σ dispersion (%)</span>
            <input type="number" value={mcSigma} onChange={(e) => setMcSigma(parseFloat(e.target.value) || 0)}
              className="bg-[#222] border border-[#555] px-2 py-1 w-20 text-[#eee]" />
          </label>
          <label className="flex flex-col space-y-1">
            <span className="text-[#888] text-[10px]">Samples</span>
            <input type="number" value={mcSamples} onChange={(e) => setMcSamples(parseInt(e.target.value, 10) || 0)}
              className="bg-[#222] border border-[#555] px-2 py-1 w-24 text-[#eee]" />
          </label>
          <label className="flex flex-col space-y-1">
            <span className="text-[#888] text-[10px]">Output</span>
            <select value={mcTarget} onChange={(e) => setMcTarget(e.target.value as SurrogateTarget)}
              className="bg-[#222] border border-[#555] px-2 py-1 text-[#eee]">
              {TARGETS.map((t) => <option key={t} value={t}>{LABEL[t]}</option>)}
            </select>
          </label>
          <button onClick={runMonteCarlo}
            className="bg-[#ffaa00] text-black px-4 py-1.5 font-bold rounded flex items-center hover:bg-[#ffcc00]">
            <Play className="w-3 h-3 mr-1" /> Run
          </button>
          {mcResult && (
            <>
              <span className="text-[#666] text-[10px]">
                {mcSamples.toLocaleString()} samples in {mcMs.toFixed(0)} ms
              </span>
              <button onClick={confirmMonteCarlo} disabled={confirming}
                className="border border-[#00aaff] text-[#00aaff] px-3 py-1 rounded hover:bg-[#00aaff] hover:text-black disabled:opacity-50">
                {confirming ? 'Solving 40…' : 'Confirm with 40 full solves'}
              </button>
            </>
          )}
        </div>

        {mcResult && (
          <>
            <div className="h-48 border border-[#333] rounded bg-[#0c0c0c]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={mcHist} margin={{ top: 10, right: 20, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="1 3" stroke="#333" />
                  <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} stroke="#666"
                    tick={{ fill: '#888', fontSize: 9 }}
                    tickFormatter={(v) => (mcTarget === 'peak_pc' ? (v / 1e6).toFixed(1) : v.toFixed(0))} />
                  <YAxis stroke="#666" tick={{ fill: '#888', fontSize: 9 }} />
                  <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#444', fontSize: '10px' }}
                    labelFormatter={(v: any) => FORMAT[mcTarget](Number(v))} />
                  <Bar dataKey="count" fill="#00aaff" isAnimationActive={false} />
                  <ReferenceLine x={mcResult[mcTarget].p05} stroke="#ffaa00" strokeDasharray="3 3" />
                  <ReferenceLine x={mcResult[mcTarget].p95} stroke="#ffaa00" strokeDasharray="3 3" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3 text-[11px]">
              {([['Mean', 'mean'], ['Std dev', 'sd'], ['5th pct', 'p05'], ['Median', 'p50'], ['95th pct', 'p95']] as const).map(
                ([label, key]) => (
                  <div key={key}>
                    <p className="text-[#888] text-[10px]">{label}</p>
                    <p className="text-[#eee]">{FORMAT[mcTarget](mcResult[mcTarget][key])}</p>
                  </div>
                )
              )}
            </div>
            <p className="text-[#666] text-[10px] mt-2 leading-snug">
              The spread here is manufacturing dispersion, not model error — the surrogate's own
              uncertainty on this design is ±{(prediction.relativeBand[mcTarget] * 100).toFixed(1)}%
              and is reported separately above, so a wide distribution is never confused with an
              unsure model.
            </p>

            {mcConfirm && (
              <div className="mt-3 border border-[#334433] bg-[#0d1a0d] rounded p-2 text-[10px]">
                <div className="flex items-center space-x-1 text-[#00ff88] font-bold mb-1">
                  <Check className="w-3 h-3" />
                  <span>CONFIRMED WITH {mcConfirm.n} FULL SOLVES ({mcConfirm.ms.toFixed(0)} ms)</span>
                </div>
                {(() => {
                  const mean = mcConfirm.values.reduce((a, b) => a + b, 0) / mcConfirm.values.length;
                  const sd = Math.sqrt(
                    mcConfirm.values.reduce((s, v) => s + (v - mean) ** 2, 0) / mcConfirm.values.length
                  );
                  const dMean = ((mcResult[mcTarget].mean - mean) / mean) * 100;
                  const dSd = sd > 0 ? ((mcResult[mcTarget].sd - sd) / sd) * 100 : 0;
                  return (
                    <div className="text-[#aaddaa]">
                      Physics mean {FORMAT[mcTarget](mean)} (surrogate {dMean >= 0 ? '+' : ''}
                      {dMean.toFixed(2)}%), physics σ {FORMAT[mcTarget](sd)} (surrogate{' '}
                      {dSd >= 0 ? '+' : ''}{dSd.toFixed(1)}%). The subsample uses the same
                      perturbations as the surrogate sweep, so these are like-for-like.
                    </div>
                  );
                })()}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
