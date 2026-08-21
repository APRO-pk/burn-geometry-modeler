import type { GrainType } from './useMotorConfig';

/**
 * Design validation, as data rather than a cascade of `alert()` calls.
 *
 * The rules themselves already existed, buried at the top of `runSimulation`,
 * each one a `if (...) { addLog(...); alert(...); return; }`. Three problems
 * with that shape:
 *
 *   The user found out at RUN TIME. You could type a negative radius, fill in
 *   ten more fields, press Run, and only then be told -- by a modal -- that the
 *   first thing you typed was wrong.
 *
 *   Only the FIRST problem was ever reported, because each check returned. Fix
 *   it, press Run, discover the next one.
 *
 *   Nothing could test them. The rules were unreachable without rendering the
 *   whole application and clicking a button.
 *
 * As a pure function returning every issue at once, the same rules drive inline
 * field errors, the Run gate, and a test suite.
 */

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  /** Which input this belongs to, so the UI can render it in place. */
  field: string;
  severity: Severity;
  /** Written for the person who has to fix it, in their units. */
  message: string;
}

export interface DesignInputs {
  grainType: GrainType;
  length: number;
  outerRadius: number;
  innerRadius: number;
  valleyRadius: number;
  tipRadius: number;
  numPoints: number;
  numSegments: number;
  offset: number;
  rodRadius: number;
  finDepth: number;
  finWidth: number;
  hasDxf: boolean;
  density: number;
  a: number;
  n: number;
  throatDiameter: number;
  expansionRatio: number;
  flameTemp: number;
  gamma: number;
}

const mm = (m: number) => `${(m * 1000).toFixed(1)} mm`;

/**
 * Every problem with a design, not just the first.
 *
 * Errors block a run. Warnings do not: they flag designs that will simulate
 * fine but are questionable as hardware, and the user may have a reason.
 */
export function validateDesign(d: DesignInputs): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (field: string, message: string) =>
    issues.push({ field, severity: 'error', message });
  const warn = (field: string, message: string) =>
    issues.push({ field, severity: 'warning', message });

  // ---- dimensions must be physical --------------------------------------
  if (!(d.length > 0)) err('length', 'Grain length must be greater than zero.');
  if (!(d.outerRadius > 0)) err('outerRadius', 'Outer radius must be greater than zero.');
  if (d.innerRadius < 0) err('innerRadius', 'Core radius cannot be negative.');
  if (!(d.throatDiameter > 0)) err('throatDiameter', 'Throat diameter must be greater than zero.');
  if (!(d.density > 0)) err('density', 'Density must be greater than zero.');
  if (!(d.a > 0)) err('a', 'Burn-rate coefficient a must be greater than zero.');

  /*
   * n >= 1 is not a typo the user will spot from a burn-time error: it makes
   * the motor unconditionally unstable, since chamber pressure goes as
   * Pc ~ Kn^(1/(1-n)) and that exponent changes sign. Worth blocking outright.
   */
  if (d.n >= 1) {
    err('n', 'Pressure exponent n must be below 1 — at n >= 1 chamber pressure runs away.');
  } else if (d.n > 0.8) {
    warn('n', `n = ${d.n} is very high; such motors are difficult to control and to predict.`);
  }
  if (d.n < 0) {
    warn('n', 'A negative pressure exponent is unusual outside a measured piecewise band.');
  }

  if (!(d.expansionRatio >= 1)) {
    err('expansionRatio', 'Expansion ratio must be at least 1 (a throat with no bell).');
  }
  if (!(d.flameTemp > 0)) err('flameTemp', 'Flame temperature must be greater than zero.');
  if (!(d.gamma > 1)) err('gamma', 'Ratio of specific heats must be greater than 1.');

  // ---- per-geometry relationships ---------------------------------------
  const coreInsideCasing = () => {
    if (d.innerRadius >= d.outerRadius) {
      err(
        'innerRadius',
        `Core radius (${mm(d.innerRadius)}) must be smaller than outer radius (${mm(d.outerRadius)}).`
      );
    }
  };

  switch (d.grainType) {
    case 'BATES':
    case 'Tubular':
      coreInsideCasing();
      if (d.grainType === 'BATES' && !(d.numSegments >= 1)) {
        err('numSegments', 'A BATES grain needs at least one segment.');
      }
      break;

    case 'MoonBurner':
      coreInsideCasing();
      if (d.innerRadius + d.offset > d.outerRadius) {
        err(
          'offset',
          `Offset core breaks through the casing: ${mm(d.innerRadius)} core + ${mm(d.offset)} offset ` +
            `exceeds the ${mm(d.outerRadius)} outer radius.`
        );
      }
      break;

    case 'Finocyl':
      coreInsideCasing();
      if (!(d.finDepth > 0)) {
        err('finDepth', 'Fin depth must be greater than zero.');
      } else if (d.innerRadius + d.finDepth >= d.outerRadius) {
        err(
          'finDepth',
          `Fins reach the casing at ignition: ${mm(d.innerRadius)} core + ${mm(d.finDepth)} fin ` +
            `is not less than the ${mm(d.outerRadius)} outer radius.`
        );
      }
      if (!(d.finWidth > 0)) err('finWidth', 'Fin width must be greater than zero.');
      if (!(d.numPoints >= 1)) err('numPoints', 'A Finocyl grain needs at least one fin.');
      /*
       * Not an error, but the user deserves to know: this is the least accurate
       * geometry in the tool, and the number is measured rather than guessed.
       * See MODEL_UNCERTAINTY.md.
       */
      warn(
        'grainType',
        'Finocyl burning area is modelled to about 8% (impulse-weighted), the weakest ' +
          'grain model here. It also burns past geometric burnout by ~10% of web.'
      );
      break;

    case 'RodAndTube':
      if (!(d.rodRadius > 0)) err('rodRadius', 'Rod radius must be greater than zero.');
      if (d.rodRadius >= d.innerRadius) {
        err(
          'rodRadius',
          `Rod (${mm(d.rodRadius)}) must be smaller than the tube bore (${mm(d.innerRadius)}).`
        );
      }
      coreInsideCasing();
      break;

    case 'Star':
      if (d.valleyRadius >= d.outerRadius) {
        err(
          'valleyRadius',
          `Valley radius (${mm(d.valleyRadius)}) must be smaller than outer radius ` +
            `(${mm(d.outerRadius)}).`
        );
      }
      if (d.tipRadius >= d.valleyRadius) {
        err(
          'tipRadius',
          `Tip radius (${mm(d.tipRadius)}) must be smaller than valley radius ` +
            `(${mm(d.valleyRadius)}).`
        );
      }
      if (!(d.numPoints >= 3)) err('numPoints', 'A star grain needs at least three points.');
      break;

    case 'CustomDXF':
      if (!d.hasDxf) err('grainType', 'No DXF loaded. Import a profile before running.');
      break;
  }

  // ---- design-quality warnings ------------------------------------------
  /*
   * Port-to-throat area ratio. Below about 2 the port chokes the flow and
   * erosive burning becomes significant -- and the erosive model here is
   * uncalibrated, so a prediction in that regime is worth little. Flagging it
   * is more useful than silently producing a confident-looking answer.
   */
  if (d.throatDiameter > 0 && d.innerRadius > 0 && d.grainType !== 'CustomDXF') {
    const portArea = Math.PI * d.innerRadius * d.innerRadius;
    const throatArea = Math.PI * (d.throatDiameter / 2) ** 2;
    const ratio = portArea / throatArea;
    if (ratio < 2) {
      warn(
        'throatDiameter',
        `Port/throat area ratio is ${ratio.toFixed(2)}. Below 2 erosive burning dominates, ` +
          'and this tool models it with an uncalibrated coefficient.'
      );
    }
  }

  if (d.outerRadius > 0 && d.length / (2 * d.outerRadius) > 15) {
    warn(
      'length',
      'Grain is very long relative to its diameter; the 0-D model assumes one ' +
        'chamber pressure. Consider the quasi-1-D solver.'
    );
  }

  return issues;
}

/** Just the blocking issues. */
export function errorsOnly(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

/** Index by field, for rendering an error under the input it belongs to. */
export function byField(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const m = new Map<string, ValidationIssue[]>();
  for (const i of issues) {
    const list = m.get(i.field);
    if (list) list.push(i);
    else m.set(i.field, [i]);
  }
  return m;
}
