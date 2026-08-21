# Model uncertainty

Every number this tool prints is the output of an approximation. This document
says how good each approximation is, in numbers, and points at the test that
measures it.

Nothing here is an estimate written from memory. If a figure appears below, a
test in this repository computes it, and that test fails if the figure changes.

> **This is a floor on the error, not a bound.** These are *model-form*
> uncertainties — the known error of the equations being solved. Real hardware
> also varies by propellant batch, mixing and casting quality, grain cracks,
> nozzle machining and ambient temperature. None of that is visible to a solver.

---

## Per-output summary

The app shows this live, under **Motor Statistics → Model Uncertainty**, with the
contributions for the motor actually on screen. The table below is the general
picture.

| Output | Typical band | Dominated by |
| --- | --- | --- |
| Total impulse | ±8% | Delivered Isp efficiency |
| Burn time | ±5–15% | Burn-rate law |
| Peak chamber pressure | ±3% to >3x | Erosive burning, if enabled |
| Throat erosion | >7x | Simplified Bartz coefficient |

Peak pressure spans two orders of magnitude of trustworthiness because it
depends almost entirely on whether erosive burning is switched on. See below.

---

## Why pressure is the least certain output

Equilibrium chamber pressure follows

```
Pc = (Kn · a · ρ · c*)^(1/(1-n))
```

so **any** fractional error in burning area or burn-rate coefficient is
amplified by `1/(1-n)` before it reaches pressure:

| n | amplification |
| --- | --- |
| 0.30 | 1.43x |
| 0.32 | 1.47x |
| 0.50 | 2.00x |
| 0.70 | 3.33x |

A 10% burning-area error becomes 15% on pressure for KNSB, and 33% for a
high-exponent propellant. The same property that makes high-`n` propellants
hard to fly makes them hard to predict.

Total impulse does **not** carry this factor — it is set by how much propellant
there is and how efficiently it leaves, not by the instantaneous burning area.
Burn time carries `n/(1-n)`, so area error is *damped* there rather than
amplified.

Measured by `src/modelUncertainty.test.ts`.

---

## Grain geometry

Burning area is computed from a closed-form expression per grain type. Those are
compared against ClipperLib polygon offsetting — geometrically what burn-back
*is*, and code that shares nothing with the analytic models.

Regenerated and pinned on every test run by `src/geometryError.test.ts`, into
`src/modelUncertainty.data.json`.

| Geometry | Impulse-weighted | Main burn | Raw max | Burned volume | Notes |
| --- | --- | --- | --- | --- | --- |
| BATES | 0.00% | 0.00% | 0.00% | 0.00% | analytically exact |
| Tubular | 0.01% | 0.01% | 0.01% | 0.01% | analytically exact |
| Rod & Tube | 0.01% | 0.01% | 0.01% | 0.01% | |
| Star | 0.33% | 0.29% | 3.5% | −0.31% | |
| Moon Burner | 0.52% | 0.65% | 6.9% | −0.51% | 28% step mid-burn |
| **Finocyl** | **8.45%** | **5.68%** | 280% | +5.9% | see below |

**Read the impulse-weighted column, not the raw max.** The raw maximum is the
error at the single worst sample, which for every approximate geometry lands in
the burnout tail where the surviving surface is a few percent of the original
and contributes almost no impulse. Finocyl's 280% is real and almost
meaningless; its 8.45% is real and matters.

BATES and Tubular are analytically exact, so their residual **is** the polygon's
own discretisation — 0.007%. That is the noise floor every other row is read
against, and it is more than 100x smaller than the smallest defect measured, so
these numbers are about the models rather than the measurement.

### Finocyl has three separate defects

The rectangular-slot approximation is the weakest model in the tool:

1. **Slot shape.** Error grows through the main burn to about +16%, because
   real fin slots round off as they burn while the model keeps them
   rectangular.
2. **A 51% discontinuity at 56% web**, where the fins reach the casing and the
   closed form switches branches. The solver integrates straight through it;
   real hardware rounds this corner.
3. **Late burnout.** Past fin burnout the model decays linearly to zero over
   about **10% more web** than the geometry actually has. It is inventing
   propellant, which inflates burn time and total impulse.

The error also **changes sign** partway through the burn, which constrains any
fix: a model that is uniformly 10% high can be rescaled, but one whose error
reverses cannot — any single correction factor makes one half worse. That is
why these are reported rather than silently compensated.

Star, Moon Burner and Rod & Tube also flip sign, but at magnitudes where it does
not matter.

---

## Burn rate

Measured against Richard Nakka's published strand-burner data by
`src/burnRate.validation.test.ts`. See the README for the full treatment.

| Propellant | Model | Mean error ≥1 MPa |
| --- | --- | --- |
| KNDX | 5 measured bands | **1.2%** |
| KNSB | 5 measured bands | **1.8%** |
| KNDX / KNSB | best single power law | 6.1% / 5.4% |
| APCP | — | **unvalidated** |

**APCP has no measurement in this repository.** It is reported with a wide band
(15%) and labelled as unvalidated, deliberately worse than the propellants that
have been measured. An unvalidated propellant must not look more certain than a
measured one just because it is the more common choice.

---

## Erosive burning — the biggest single uncertainty

`LR_ALPHA = 0.00003` and `LR_BETA = 50.0` in `crates/burn-core/src/erosive.rs`
have **no calibration in this repository**. Lenoir and Robillard fit alpha per
propellant from firing data; there is no universal value. These are the numbers
the original TypeScript implementation shipped, retained so the Rust core
reproduces it.

This matters more than it sounds. On the app's default Star motor, switching
erosive burning off drops peak thrust from **18.4 kN to 9.5 kN** — erosion is
supplying roughly half the motor's output, on the authority of an uncalibrated
coefficient.

The app therefore recovers how much erosion each motor actually has, from
`dy/dt` against the pressure-only law, and scales the reported uncertainty to
it. A motor with 2% erosive augmentation gets a small contribution; one with
100% gets flagged as order-of-magnitude. This avoids both failure modes —
quoting a blanket ±75% on a motor that barely erodes, and quoting a tidy ±5% on
one whose answer is mostly an uncalibrated correlation.

If erosive burning contributes materially to your motor, **treat peak pressure
as a design-comparison number, not a hardware-sizing number.**

---

## Nozzle throat erosion — the weakest model

The solver uses

```
h_g = C_BARTZ · Pc^0.8 · D_t^-0.2 · sqrt(T_flame),   C_BARTZ = 0.005
```

Compared against the real Bartz correlation by `tools/calibrateBartz.mts` over
20,000 sampled motors and gas property sets:

| | result |
| --- | --- |
| Pressure and diameter scaling | **exact** — ratio constant to 3 figures |
| Magnitude | **~7x high** (median 6.99x, 5–95th percentile 4.5–10.9x) |
| `C_BARTZ` implied by real Bartz | 7.2e-4, vs 5.0e-3 shipped |
| `sqrt(T_flame)` shape error | 5.3x at 1600 K → 7.3x at 3000 K |

So the good news and the bad news are separable. The `Pc^0.8` and `D_t^-0.2`
exponents are genuinely Bartz, and the ratio to real Bartz is *constant* across
every motor size and chamber pressure sampled — meaning **the way erosion scales
with the motor is right**. The magnitude is not, and the `sqrt(T_flame)` factor
(which is not part of Bartz at all) adds a further 1.4x spread.

**`C_BARTZ` has deliberately not been changed.** Substituting 7.2e-4 would be
swapping one unvalidated number for another: the 0.005 may be compensating for
the crude semi-infinite-solid conduction model downstream of it, and there is no
throat-recession measurement here to say which is closer. Quantifying it and
saying so is the honest position; silently re-tuning it is not.

Use throat erosion to compare materials and to see the trend, never to predict
a recession depth.

---

## Delivered specific impulse

Checked against 400+ certified motors from ThrustCurve.org by
`src/validation.test.ts`. The shipped APCP predicts 222.9 s at ε=6 against a
real distribution with median 189.9 s and p95 226.5 s — near the top of the real
range, which is expected for a model that assumes a well-made motor. The ±8%
figure captures the spread of real hardware around any such prediction.

---

## What is not covered at all

- **Ignition transient.** Modelled crudely; the first few milliseconds of any
  trace should not be read quantitatively.
- **Two-phase flow losses.** Not modelled. Metallised propellants will
  under-perform these predictions.
- **Grain structural failure**, cracks, debonds, or slumping.
- **Nozzle throat entry rounding**, submergence, and misalignment.
- **Ambient temperature** beyond the linear `sigma_p` coefficient.
- **The quasi-1-D port model's** own discretisation error, which has not been
  measured against a higher-fidelity reference.

---

## Reproducing every number here

```bash
npm test
```

`src/geometryError.test.ts` regenerates the geometry table,
`src/burnRate.validation.test.ts` the burn-rate table,
`src/validation.test.ts` the Isp figures, and `src/modelUncertainty.test.ts` the
propagation. The Bartz comparison is a standalone script:

```bash
npx tsx tools/calibrateBartz.mts
```
