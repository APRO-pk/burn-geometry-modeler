# APRO Burn & Geometry Modeler

Solid rocket motor internal ballistics, grain geometry, and case structural
analysis, in the browser.

Given a propellant, a grain geometry and a nozzle, it integrates the chamber
pressure and thrust history, sizes and stresses the case, and exports the result
as `.eng`, CSV, BurnSim XML, STL or OpenSCAD.

## What makes it different

Most hobby internal-ballistics tools are 0-D: one chamber pressure, one mass
flux, one burn rate for the whole motor. That is a good approximation for short,
fat grains and a poor one for long, thin ones, where the gas accelerates from
rest at the head end to a large fraction of the speed of sound at the nozzle.

This one also has a **quasi-1-D** solver that resolves the port axially — local
pressure, local mass flux, and per-station erosive burning, with one web per
station — so the aft end burns faster than the head and cones the port out over
the burn. On a long thin grain the two models disagree by 20% on head-to-nozzle
pressure drop; on a short fat one they agree to 0.02%.

## The three layers, and which one to trust

| Layer | Role |
| --- | --- |
| `crates/burn-core` (Rust → WASM) | **Ground truth.** Every number the app reports comes from here. |
| `src/engine.ts` | **Deprecated reference.** The original TypeScript solver, kept frozen so the Rust port can be diffed against it. Still used for grain geometry in the editor and volume maths. |
| `src/surrogate/` | **Fast approximation.** A Gaussian process *trained on* the Rust core. Never authoritative — every surrogate number carries a 95% band and a one-click "verify with full solve". |

That ordering is enforced by tests, not convention:
`src/wasm.parity.test.ts` pins the Rust core against the TypeScript reference,
and `src/surrogate.test.ts` validates the shipped surrogate against fresh solves
from the *current* core — so a stale surrogate fails CI rather than quietly
misleading someone.

## Getting started

Prerequisites: Node.js. No API keys, no backend, no accounts — it runs entirely
in the browser.

```bash
npm install
npm run dev
```

The compiled WASM core (`crates/burn-core/pkg-node`, `pkg-web`) is committed, so
a normal checkout builds and tests without a Rust toolchain.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Production build |
| `npm run test` | Full suite (200 tests) |
| `npm run lint` | `tsc --noEmit` |
| `npm run wasm:build` | Rebuild the Rust core — **see below** |
| `npm run surrogate:rebuild` | Re-sample and retrain the surrogate |

## Rebuilding the Rust core

Only needed if you change anything under `crates/burn-core/src/`.

```bash
npm run wasm:build
```

**This must run from WSL or another Linux shell, not a Windows shell.** Smart App
Control on Windows blocks execution of freshly compiled Rust build scripts (os
error 4551), which stops cargo before it starts; the block is reputation-based,
so relocating the target directory does not help. The script refuses to run from
a Windows shell rather than failing confusingly halfway through.

```bash
wsl
cd /mnt/c/Users/<you>/Downloads/burn-geometry-modeler
bash scripts/build-wasm.sh
```

It installs rustup and wasm-pack if missing, and writes both `pkg-node` (for
Vitest) and `pkg-web` (for the browser Worker). On a fresh Ubuntu you will also
need a C compiler for the host proc-macro crates:
`sudo apt install build-essential`.

After rebuilding, **retrain the surrogate** (`npm run surrogate:rebuild`) — it is
fitted to a specific version of the core, and if the solver's answers move its
error bars become fiction.

## Retraining the surrogate

See [`tools/README.md`](tools/README.md) for the sampling design, the model, the
current held-out metrics, and why the design space is parameterised the way it
is.

## Layout

```
crates/burn-core/src/     Rust physics core
  sim.rs                  0-D and quasi-1-D solvers, RK4
  port.rs                 axial port march (quasi-1-D)
  grain.rs                all 7 grain geometries
  structural.rs           Lamé thick-wall + shell edge bending
  nozzle.rs, igniter.rs, propellant.rs

src/
  AppDesktop.tsx          the application
  engine.ts               deprecated TS reference solver + grain geometry
  wasmClient.ts           main-thread client for the ballistics Worker
  burnWorker.ts           Web Worker hosting the WASM core
  structuralClient.ts     main-thread structural analysis (closed-form, cheap)
  surrogate/              GP inference, feature expansion, inverse design
  dxfProcessor.ts         DXF → burn regression tables (ClipperLib)

tools/                    surrogate sampling and training
reference/legacy-python/  the original Python model this was ported from
```

## Testing

```bash
npm run test
```

200 tests across five files. One is an intentional `it.fails` in
`engine.test.ts` that tracks a known residual defect in the Star grain's
post-transition burning-area model — when that model is fixed properly, the test
will start failing and should become a normal passing test.

## Scope and limits

- Grain geometries: BATES, Star, Tubular, Rod & Tube, MoonBurner, Finocyl,
  Custom DXF.
- The quasi-1-D model assumes subsonic, quasi-steady port flow; it warns when a
  port spends a meaningful fraction of the burn near choking.
- Structural analysis is closed-form and static: no thermal stress, fatigue,
  stress concentrations or buckling. Composite cases are computed with isotropic
  relations and say so.
- The surrogate covers BATES grains only, with fixed propellant
  thermochemistry. The tab disables itself for other geometries; the full solver
  handles all seven.
