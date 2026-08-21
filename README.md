# APRO Burn & Geometry Modeler

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
<!-- Relative on purpose: resolves against whatever repo this ends up in,
     so it survives a rename, transfer or fork with no edit. -->

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

## Validation against real motors

Most of the test suite checks the code against itself — the Rust core against
the TypeScript reference, the surrogate against the core, burn-back against
ClipperLib. That proves internal consistency, not correctness.

`src/validation.test.ts` checks the model against **790 motors certified by
NAR, TRA and CAR**, fetched from ThrustCurve.org and committed as a fixture so
the suite runs offline (`npm run validation:fetch` to refresh).

| Quantity | This model | 758 real composite motors |
| --- | --- | --- |
| Delivered Isp, shipped APCP at ε=6 | 222.9 s | p05 142 · median 190 · p95 227 |
| Delivered Isp, shipped KNDX | 135.3 s | sugar sits below composites ✓ |
| Isp with no efficiency losses | 240.6 s | above p95 — correctly unattainable |
| **Peak/average thrust, median** | **1.37** | **1.37** (p05 1.13, p95 2.47) |

The peak-to-average thrust ratio is the load-bearing one. It is dimensionless
and set by how *progressive* the grain burns, so matching the real distribution
means the burn-back model produces traces shaped like real hardware — the only
place certified data constrains the geometry side of the model.

### Burn rate against measured strand-burner data

The certified-motor data above constrains model *outputs*. Richard Nakka
measured burn rate directly against chamber pressure and published the raw
points, which constrains the most important *input*:

> "Effect of Chamber Pressure on Burning Rate for the Potassium Nitrate -
> Dextrose and Potassium Nitrate - Sorbitol Rocket Propellants",
> R. Nakka, June 1999, Tables 2–5. 65/35 O/F, strand burner.

`src/burnRate.validation.test.ts` checks the shipped propellant library against
those 27 measured points. The fixture is *parsed* from the source by
`tools/extractNakkaBurnRate.mts`, never hand-typed, and the shipped coefficients
are *parsed back out of* `DEFAULT_PROPELLANTS` so the tests cannot drift from
what the app actually uses.

#### A single power law cannot fit this data

Measured burn rate for both sugar propellants is **non-monotonic in pressure**.
KN-Sorbitol rises to 9.37 mm/s at 0.81 MPa, falls to 7.65 at 3.79, then climbs
to 11.29 at 10.67. Nakka’s own fits carry **negative pressure exponents** over
two of five bands each.

Saint-Robert, `r = a·Pc^n`, is monotonic for n > 0, so it cannot reproduce that
shape at *any* coefficients. Roughly 4 percentage points of accuracy are lost to
the model form itself — not to calibration.

#### What the solver now does

The core accepts an optional **piecewise burn-rate law**: a list of pressure
bands, each with its own `a` and `n`. Both sugar propellants ship with Nakka’s
five measured bands, and the single `a`/`n` pair remains the fallback outside the
banded range. Mean error against measurement, over points at or above 1 MPa:

| Propellant | Previously shipped | Best single power law | **Now shipped: 5 measured bands** |
| --- | --- | --- | --- |
| KNDX | 6.2% (a=4.77e-5, n=0.35) | 6.1% | **1.2%** |
| KNSB | 13.8% (a=6.01e-5, n=0.32) | 5.4% | **1.8%** |

Over the full pressure range a representative KNDX BATES motor sweeps through,
ignition to burnout, mean burn-rate error falls from **13.0% to 1.1%**, and
predicted burn time shifts by 5.7%.

The old KNSB coefficients were the more serious of the two: they read low at
essentially *every* measured point above 0.75 MPa, worst −28.5%. That bias has a
direction — burn rate too slow means chamber pressure predicted too **low**,
which is the unsafe direction when the number sizes a pressure vessel. Both
propellants’ fallback pairs are now least-squares fits to this data.

Caveats worth knowing:

- Nakka’s data is **one formulation at 65/35** with a specific preparation. It is
  not a universal KNSB/KNDX calibration.
- Piecewise fits **do not join up**. The largest step is 3.3% for KNSB at 3.79
  MPa; the solver integrates through it, and a test pins that no future edit
  introduces a larger cliff.
- Piecewise is better **on average**, not at every pressure. At one motor’s 7.98
  MPa operating point the single law happened to land marginally closer.
- Propellants with no bands configured behave **exactly** as before — asserted
  bit-for-bit, not approximately.
- The **surrogate** is trained on single-law solves and reads `log_a`/`n` as
  features, so it cannot represent a banded law. Its tab warns when one is
  active; Verify and the Monte Carlo confirmation run the real core with the
  bands applied.

### What this does not validate

A certification stand measures outputs: total impulse, burn time, thrust,
propellant mass. It does **not** publish the solver’s inputs — grain geometry,
St. Robert coefficients, throat diameter, expansion ratio. Those are trade
secrets, so **a predicted pressure trace cannot be compared against a certified
motor**, and nothing here pretends otherwise. A test asserts that the fixture
still lacks those fields, so if ThrustCurve ever publishes them the suite fails
and asks for the stronger validation to be written.

These are distribution checks, not point comparisons. They will not catch a 5%
error. They will catch a model that is wrong in kind.

### One finding worth knowing

The shipped `APCP (Typical)` default delivers 222.9 s against a real 95th
percentile of 226.5 s — a *good* motor, not an impossible one, but close enough
to the ceiling that the default should not be read as conservative.

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
| `npm run validation:fetch` | Refresh the certified-motor fixture |

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

## Continuous integration

`.github/workflows/ci.yml` runs three jobs on every push and pull request.

**Types, tests, build** — runs against the *committed* WASM, which is what the
app ships and what a contributor without a Rust toolchain will be running.

**Committed WASM matches Rust source** — the check this repository specifically
needs. Because `pkg-node` and `pkg-web` are committed, editing the Rust and
forgetting to rebuild leaves the binary shipping the old physics while the
source claims otherwise, and *no test would notice* — they all load the
committed binary. CI rebuilds and diffs.

That diff is only trustworthy because `crates/burn-core/rust-toolchain.toml`
pins the compiler: a different rustc can emit different bytes from identical
source. Verified that the pinned toolchain reproduces the committed artifacts
byte for byte, and that changing a single constant in the Rust makes the check
fail.

**Surrogate matches the current physics** — the surrogate is fitted to one
version of the core; if the core moves and the model is not retrained, its
uncertainty bands become fiction.

### Line endings

The repository is developed on Windows with `core.autocrlf=true` but its build
script runs under WSL. Without `.gitattributes`, git hands the working copy a
CRLF `build-wasm.sh`, bash reads `set -euo pipefail\r` as an option named
"pipefail\r", and the build fails with an error that mentions nothing about
line endings. `npm run wasm:build` was broken this way and is now pinned to LF.

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
