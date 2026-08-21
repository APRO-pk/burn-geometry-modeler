# Changelog

Notable changes to the APRO Burn & Geometry Modeler.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates are
the date the work landed on `master`. The project is pre-1.0 and unreleased, so
entries are grouped by date rather than version.

---

## Unreleased

### Added

- **Model uncertainty, per output.** Motor Statistics now reports how much to
  trust each number, with the contributions ranked and every figure citing the
  test that measured it. Pressure carries the `1/(1-n)` amplification that
  impulse does not, so outputs are ranked by real sensitivity rather than given
  one blanket band. Anything unmeasured says so — APCP is reported as *less*
  certain than KNSB precisely because it has never been validated here.
  See `MODEL_UNCERTAINTY.md`.
- **Measured error budget for every grain geometry**, against ClipperLib
  polygon offsetting. Regenerated and pinned on every test run, so the figures
  the app quotes cannot drift from the code.
- **Piecewise burn-rate laws.** Propellants may carry pressure bands, each with
  its own `a` and `n`. Needed because measured burn rate for both sugar
  propellants is non-monotonic in pressure, which a single Saint-Robert law
  cannot represent at any coefficients.
- **ESLint**, covering what `tsc` cannot: hook dependency arrays, dead code, and
  accessibility. `npm run lint` now runs both.
- `LICENSE` (MIT, matching `Cargo.toml`), `CONTRIBUTING.md`, this file.

### Changed

- **KNSB re-fitted to measurement**: `a=6.01e-5, n=0.32` → `a=3.628e-4,
  n=0.2117`, plus Nakka's five measured bands. The old coefficients read low at
  essentially every measured point above 0.75 MPa, worst −28.5%. That bias ran
  the unsafe way: burn rate too slow means chamber pressure predicted too
  **low**. Mean error 13.8% → 1.8%.
- **KNDX** likewise re-fitted and banded: 6.2% → 1.2%.
- `metrics` is typed instead of `any`. It is read by every tab, and `any` is how
  a removed core field once reached the UI as `undefined` with `tsc` green.

### Fixed

- **The Lenoir-Robillard constants were declared twice**, in `sim.rs` and
  `port.rs`. Tuning one and not the other would have made the 0-D and quasi-1-D
  solvers disagree about the same propellant, silently, with both still
  producing plausible traces. Now one shared module, with a test that fails if
  the implementations diverge again.
- **Four hook staleness bugs** found by ESLint on its first run, including
  `captureDesignState` omitting the temperature settings it returns — so undo
  and redo restored the wrong values.
- Editing burn coefficient `a` or `n` by hand did nothing across the banded
  pressure range. Those edits now drop the piecewise law and say so.
- A test hook that exceeded vitest's 10 s default, which failed the whole file
  and reported it as *13 skipped tests* with no assertion error.

### Documented, not fixed

Both are quantified in `MODEL_UNCERTAINTY.md` and surfaced in the app.

- **`C_BARTZ = 0.005`** drives the whole nozzle erosion model and had no stated
  provenance. Compared against the real Bartz correlation over 20,000 sampled
  motors: the `Pc^0.8` and `D^-0.2` exponents are genuinely Bartz and the ratio
  is *constant* across every motor size and pressure — so the scaling is right —
  but the magnitude is ~7x high. Deliberately not re-tuned: that would swap one
  unvalidated number for another, and there is no recession measurement here to
  say which is closer.
- **Finocyl is the weakest grain model**, with three separate defects: +16%
  slot-shape drift through the main burn, a 51% discontinuity at fin burnout,
  and it keeps burning for 10% more web after the geometry says the grain is
  consumed. The error changes sign mid-burn, so no single correction factor can
  remove it.

---

## 2026-08-21

- Validated burn rate against Nakka's measured strand-burner data (27 points,
  parsed from source rather than transcribed).
- Validated the model against 790 certified static-fire motors from
  ThrustCurve.org.
- Added GitHub Actions CI: types, tests, build, a WASM staleness check, and a
  surrogate-freshness check.
- Fixed the WASM build script, broken by CRLF line endings — found by mutation
  testing a guard that turned out not to fire.

---

## Earlier

- Live 3-D grain burn-back view.
- Surrogate model extended to every grain geometry with one curve-based model;
  rebuild made 14x faster and the artifact halved.
- Physics-trained surrogate with instant prediction, inverse design, and
  real-time Monte Carlo.
- Real thick-wall (Lamé) and edge-bending structural analysis, replacing a
  visual proxy.
- Quasi-1-D internal ballistics with per-station erosive burning.
- Rust core compiled to WebAssembly, with a parity suite against the frozen
  TypeScript reference implementation.
