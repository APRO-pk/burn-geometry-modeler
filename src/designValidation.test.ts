import { describe, it, expect } from 'vitest';
import { validateDesign, errorsOnly, byField, type DesignInputs } from './designValidation';

/*
 * ============================================================================
 * VALIDATION RULES, NOW THAT THEY ARE REACHABLE
 * ============================================================================
 *
 * These rules existed before, as a cascade of `if (...) { alert(); return; }`
 * at the top of runSimulation. They could not be tested without rendering the
 * app and clicking Run, and they reported only the first problem they found.
 * ============================================================================
 */

const VALID: DesignInputs = {
  grainType: 'BATES',
  length: 0.3,
  outerRadius: 0.05,
  innerRadius: 0.02,
  valleyRadius: 0.03,
  tipRadius: 0.01,
  numPoints: 5,
  numSegments: 1,
  offset: 0.01,
  rodRadius: 0.01,
  finDepth: 0.02,
  finWidth: 0.006,
  hasDxf: false,
  density: 1800,
  a: 3.6e-4,
  n: 0.32,
  throatDiameter: 0.015,
  expansionRatio: 7,
  flameTemp: 1600,
  gamma: 1.13,
};

const fieldsWithErrors = (d: Partial<DesignInputs>) =>
  errorsOnly(validateDesign({ ...VALID, ...d })).map((i) => i.field);

describe('a sound design raises nothing blocking', () => {
  it('passes the default BATES motor', () => {
    expect(errorsOnly(validateDesign(VALID))).toEqual([]);
  });

  it('passes every geometry when given sensible dimensions', () => {
    const cases: Array<Partial<DesignInputs>> = [
      { grainType: 'BATES' },
      { grainType: 'Tubular' },
      { grainType: 'Star', valleyRadius: 0.03, tipRadius: 0.01, numPoints: 6 },
      { grainType: 'MoonBurner', innerRadius: 0.018, offset: 0.012 },
      { grainType: 'RodAndTube', rodRadius: 0.008, innerRadius: 0.03 },
      { grainType: 'Finocyl', innerRadius: 0.015, finDepth: 0.02, numPoints: 6 },
      { grainType: 'CustomDXF', hasDxf: true },
    ];
    for (const c of cases) {
      expect(fieldsWithErrors(c), `${c.grainType} should be valid`).toEqual([]);
    }
  });
});

describe('it reports EVERY problem, not just the first', () => {
  it('collects several independent errors in one pass', () => {
    /*
     * The behaviour change that matters most for the user. The old cascade
     * returned on the first failure, so fixing a design with four mistakes
     * meant four rounds of press-Run-read-modal-fix.
     */
    const fields = fieldsWithErrors({
      length: -1,
      outerRadius: 0,
      density: 0,
      throatDiameter: -0.01,
    });
    expect(fields).toEqual(
      expect.arrayContaining(['length', 'outerRadius', 'density', 'throatDiameter'])
    );
    expect(fields.length).toBeGreaterThanOrEqual(4);
  });

  it('attaches each issue to the field that owns it', () => {
    const m = byField(validateDesign({ ...VALID, innerRadius: 0.09 }));
    expect(m.has('innerRadius')).toBe(true);
    expect(m.get('innerRadius')![0].message).toMatch(/smaller than outer radius/);
  });
});

describe('geometry relationships', () => {
  it('rejects a core larger than the casing', () => {
    expect(fieldsWithErrors({ innerRadius: 0.05 })).toContain('innerRadius');
    expect(fieldsWithErrors({ innerRadius: 0.06 })).toContain('innerRadius');
  });

  it('rejects Star radii that are not strictly nested', () => {
    expect(fieldsWithErrors({ grainType: 'Star', valleyRadius: 0.05 })).toContain('valleyRadius');
    expect(fieldsWithErrors({ grainType: 'Star', tipRadius: 0.03 })).toContain('tipRadius');
    expect(fieldsWithErrors({ grainType: 'Star', numPoints: 2 })).toContain('numPoints');
  });

  it('rejects a Moon Burner whose offset core breaks the casing', () => {
    expect(fieldsWithErrors({ grainType: 'MoonBurner', innerRadius: 0.03, offset: 0.03 })).toContain(
      'offset'
    );
  });

  it('rejects Finocyl fins that already touch the casing at ignition', () => {
    expect(
      fieldsWithErrors({ grainType: 'Finocyl', innerRadius: 0.02, finDepth: 0.031 })
    ).toContain('finDepth');
    expect(fieldsWithErrors({ grainType: 'Finocyl', finDepth: 0 })).toContain('finDepth');
  });

  it('rejects a Rod & Tube whose rod fills the bore', () => {
    expect(fieldsWithErrors({ grainType: 'RodAndTube', rodRadius: 0.02, innerRadius: 0.02 }))
      .toContain('rodRadius');
  });

  it('rejects a CustomDXF with no profile loaded', () => {
    expect(fieldsWithErrors({ grainType: 'CustomDXF', hasDxf: false })).toContain('grainType');
  });

  it('checks only the geometry actually selected', () => {
    // A nonsense Star radius must not block a BATES run -- the field is not in
    // use, and blocking on it would be baffling.
    expect(fieldsWithErrors({ grainType: 'BATES', valleyRadius: 99, tipRadius: 99 })).toEqual([]);
  });
});

describe('the pressure exponent', () => {
  it('blocks n >= 1, which is an unconditionally unstable motor', () => {
    /*
     * Pc ~ Kn^(1/(1-n)). At n = 1 that exponent is infinite and beyond it the
     * sign flips, so the motor has no stable operating point. This is not a
     * design to warn about, it is one that cannot be simulated meaningfully.
     */
    expect(fieldsWithErrors({ n: 1 })).toContain('n');
    expect(fieldsWithErrors({ n: 1.2 })).toContain('n');
  });

  it('warns about a high but usable exponent instead of blocking', () => {
    const issues = validateDesign({ ...VALID, n: 0.85 });
    expect(errorsOnly(issues)).toEqual([]);
    expect(issues.some((i) => i.field === 'n' && i.severity === 'warning')).toBe(true);
  });
});

describe('warnings flag questionable hardware without blocking it', () => {
  it('flags a port that will choke, since the erosive model is uncalibrated', () => {
    const issues = validateDesign({ ...VALID, innerRadius: 0.009, throatDiameter: 0.015 });
    expect(errorsOnly(issues)).toEqual([]);
    const w = issues.find((i) => i.field === 'throatDiameter' && i.severity === 'warning');
    expect(w?.message).toMatch(/Port\/throat/);
  });

  it('flags a very long grain, where one lumped pressure is a poor assumption', () => {
    const issues = validateDesign({ ...VALID, length: 2.0, outerRadius: 0.05 });
    expect(issues.some((i) => i.field === 'length' && i.severity === 'warning')).toBe(true);
    expect(errorsOnly(issues)).toEqual([]);
  });

  it('tells the user Finocyl is the least accurate geometry', () => {
    // The measured figure from MODEL_UNCERTAINTY.md, surfaced where the choice
    // is actually made rather than buried in a document.
    const issues = validateDesign({ ...VALID, grainType: 'Finocyl', innerRadius: 0.015 });
    const w = issues.find((i) => i.field === 'grainType');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toMatch(/8%/);
  });

  it('never lets a warning block a run', () => {
    const issues = validateDesign({
      ...VALID,
      grainType: 'Finocyl',
      innerRadius: 0.015,
      length: 2.0,
    });
    expect(issues.length).toBeGreaterThan(1);
    expect(errorsOnly(issues)).toEqual([]);
  });
});

describe('messages are written for someone who has to fix them', () => {
  it('quotes the offending values in millimetres', () => {
    const issues = validateDesign({ ...VALID, innerRadius: 0.06, outerRadius: 0.05 });
    const m = issues.find((i) => i.field === 'innerRadius')!.message;
    expect(m).toMatch(/60\.0 mm/);
    expect(m).toMatch(/50\.0 mm/);
  });

  it('names a unit or a bound in every message', () => {
    // A message like "invalid geometry" tells the user nothing. Each one should
    // say what is wrong or what the limit is.
    const all = [
      ...validateDesign({ ...VALID, length: -1, outerRadius: 0, n: 2 }),
      ...validateDesign({ ...VALID, grainType: 'Star', tipRadius: 0.04 }),
      ...validateDesign({ ...VALID, grainType: 'Finocyl', finDepth: 0.9 }),
    ];
    for (const i of all) {
      expect(i.message.length, i.message).toBeGreaterThan(20);
      expect(i.message, i.message).toMatch(/mm|zero|than|least|below|%/);
    }
  });
});
