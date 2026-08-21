# Contributing

## The one rule that matters

**People build hardware from this tool's output.** A wrong number here can end
up as a motor that fails on a stand with someone near it.

That leads to one non-negotiable practice: **never invent a number.** Not a
burn-rate coefficient, not a "typical" material property, not a plausible-looking
validation figure. If a value is not measured, derived, or cited, it does not go
in — and if you must ship an uncalibrated value, say so where the user will see
it, not only in a comment.

The corollary: when you write a guard, **check that it can fail.** Break the
thing on purpose and confirm the test goes red. A test that cannot fail is worse
than no test, because it looks like coverage. This has caught real problems here
more than once, including a build script that had silently stopped working.

## Getting set up

```bash
npm install
npm test
```

The Rust core ships as committed WebAssembly, so you do **not** need a Rust
toolchain to run the app or the tests.

You do need one to change the physics:

```bash
npm run wasm:build
```

On Windows this must run from WSL — Smart App Control blocks freshly compiled
Rust build scripts. The script says so if you get it wrong.

**Commit the rebuilt `pkg-node` and `pkg-web`.** CI rebuilds them and fails if
the committed bytes differ. That check exists because the tests all load the
committed binary: without it, you could change the Rust source, forget to
rebuild, and have every test keep passing against the old physics.

## Before you push

```bash
npm run lint    # tsc --noEmit, then ESLint
npm test
npm run build
```

CI runs exactly these, plus a WASM rebuild and a staleness check on generated
data.

## Layout

| Path | What it is |
| --- | --- |
| `crates/burn-core/` | The physics. Rust, compiled to WASM. |
| `src/engine.ts` | **Frozen** TypeScript reference implementation. |
| `src/AppDesktop.tsx` | The application shell. |
| `src/surrogate/` | Gaussian-process emulator over the core. |
| `tools/` | Data fetching, fitting, and calibration scripts. |
| `legacy-python/` | Historical. Not built, not run. |

### `src/engine.ts` is frozen on purpose

It is the independent reference `src/wasm.parity.test.ts` checks the Rust core
against. It contains a third copy of the Lenoir-Robillard constants, and that
copy must **not** be unified with the shared ones — a reference that moves when
the thing it validates moves is not a reference. There is a comment saying so at
the site.

## Where numbers are allowed to come from

Every empirical figure traces to a fixture, and every fixture is *parsed* from
its source rather than typed by hand:

| Data | Source | Parser |
| --- | --- | --- |
| Burn rate | Nakka 1999 strand burner | `tools/extractNakkaBurnRate.mts` |
| Motor performance | ThrustCurve.org, 400+ certified | `tools/fetchMotorData.mts` |
| Geometry error | ClipperLib polygon offsetting | `src/modelUncertainty.measure.ts` |
| Bartz comparison | Bartz 1957 correlation | `tools/calibrateBartz.mts` |

Hand-transcription is banned because it is unreviewable — nobody can check 27
numbers against a PDF in code review, but anyone can read a parser.

If you add a propellant, geometry, or correlation, add the measurement with it.
`MODEL_UNCERTAINTY.md` must stay true.

## Changing the physics

1. Change the Rust.
2. `cargo test` in `crates/burn-core`.
3. `npm run wasm:build`, and commit the artifacts.
4. `npm test` — the parity suite will tell you if you moved something you did
   not mean to move.
5. If the 0-D solver changed, **retrain the surrogate**: `npm run
   surrogate:rebuild`. It is fitted to a specific version of the core, and a
   stale model reports confidence bands that are fiction.
6. Update `MODEL_UNCERTAINTY.md` if you changed how wrong something is.

### Adding a grain geometry

The solver only ever asks a grain for `burning_area(y)`, `port_area(y)` and
`length()`. That is why one surrogate covers every geometry and one burn-back
path draws them all — so a new geometry needs no solver changes, but it does
need:

- an entry in `src/modelUncertainty.measure.ts`, so its error is measured
  against polygon ground truth like every other geometry;
- `src/geometryError.test.ts` will then pin it automatically.

An unmeasured geometry is reported to the user as unmeasured. That is
deliberate — do not paper over it with an estimate.

## Style

Matching the surrounding code matters more than any rule below.

- **Comments explain why, not what.** Much of this codebase is subtle physics
  and hard-won bug history; that context is the most valuable thing in the file.
- Prettier is deliberately **not** installed. Reformatting would bury the
  history of files that carry a lot of explanation.
- `any` is a warning, not an error. Do not add more: a removed core field once
  reached the UI as `undefined` with `tsc` green, precisely because a central
  object was typed `any`.

## Commit messages

Explain the reasoning, not just the change. What was wrong, why it mattered, and
how you know the fix works. If you measured something, put the number in.

The history here is used as documentation. Write it that way.
