import { describe, it, expect } from 'vitest';
import {
  modelUncertainty,
  pressureAmplification,
  formatBand,
  geometryErrors,
  type UncertaintyInputs,
} from './modelUncertainty';

/*
 * ============================================================================
 * THE UNCERTAINTY BUDGET IS ITSELF A MODEL, SO IT GETS TESTED
 * ============================================================================
 *
 * An uncertainty number that is wrong is worse than none: it tells a user to
 * trust something they should not, with the authority of a figure. These tests
 * check the propagation physics, the ordering between outputs, and -- most
 * importantly -- that the budget cannot silently detach from the measurements
 * that feed it.
 * ============================================================================
 */

const BASE: UncertaintyInputs = {
  grainKind: 'BATES',
  n: 0.32,
  hasBurnRateRegimes: true,
  propellantName: 'KNSB (Sorbitol)',
  erosiveModel: 'None',
  hasNozzleMaterial: false,
};

const pick = (inp: UncertaintyInputs, output: string) =>
  modelUncertainty(inp).find((u) => u.output === output)!;

describe('pressure amplification is the physics, not a fudge', () => {
  it('is 1/(1-n), so a higher pressure exponent means a less predictable motor', () => {
    /*
     * Pc = (Kn * a * rho * c*)^(1/(1-n)). This factor is why n matters so much:
     * at n=0.32 a 10% area error becomes 15% on pressure, and at n=0.7 it
     * becomes 33%. The same reason high-n propellants are hard to fly makes
     * them hard to predict.
     */
    expect(pressureAmplification(0)).toBeCloseTo(1, 10);
    expect(pressureAmplification(0.32)).toBeCloseTo(1.4706, 3);
    expect(pressureAmplification(0.5)).toBeCloseTo(2, 10);
    expect(pressureAmplification(0.7)).toBeCloseTo(3.333, 3);
  });

  it('does not run away as n approaches 1', () => {
    // n -> 1 is a physically unstable motor and 1/(1-n) diverges. Clamping
    // keeps the UI showing a large number rather than Infinity or NaN.
    expect(Number.isFinite(pressureAmplification(0.999))).toBe(true);
    expect(Number.isFinite(pressureAmplification(1.5))).toBe(true);
    expect(pressureAmplification(1.5)).toBeGreaterThan(10);
  });

  it('shows up in the reported pressure band', () => {
    const low = pick({ ...BASE, n: 0.2 }, 'peak_pressure').relative;
    const high = pick({ ...BASE, n: 0.6 }, 'peak_pressure').relative;
    expect(high).toBeGreaterThan(low * 1.5);
  });
});

describe('outputs are ranked by how sensitive they actually are', () => {
  it('peak pressure is less certain than total impulse', () => {
    /*
     * The ordering matters more than the absolute values. Pressure carries the
     * 1/(1-n) amplification of every area and rate error; impulse is set by
     * propellant mass and efficiency and does not. A user deciding what to
     * trust should see that difference.
     */
    const u = modelUncertainty({ ...BASE, grainKind: 'Finocyl' });
    const pc = u.find((x) => x.output === 'peak_pressure')!;
    const it = u.find((x) => x.output === 'total_impulse')!;
    expect(pc.relative).toBeGreaterThan(it.relative);
  });

  it('a geometry with a measured defect is reported as less certain than an exact one', () => {
    const bates = pick({ ...BASE, grainKind: 'BATES' }, 'peak_pressure').relative;
    const fino = pick({ ...BASE, grainKind: 'Finocyl' }, 'peak_pressure').relative;
    expect(fino).toBeGreaterThan(bates);
    console.log(
      `\n    peak Pc band: BATES ${formatBand(pick({ ...BASE, grainKind: 'BATES' }, 'peak_pressure'))}` +
        `, Finocyl ${formatBand(pick({ ...BASE, grainKind: 'Finocyl' }, 'peak_pressure'))}`
    );
  });

  it('names the dominant contributor, since that is what a user can act on', () => {
    // For an exact geometry with a measured propellant, the burn law dominates.
    const bates = pick({ ...BASE, grainKind: 'BATES' }, 'peak_pressure');
    expect(bates.dominant).toMatch(/Burn-rate/);
    // For Finocyl the geometry takes over.
    const fino = pick({ ...BASE, grainKind: 'Finocyl' }, 'peak_pressure');
    expect(fino.dominant).toMatch(/geometry/i);
  });
});

describe('the budget is honest about what has not been validated', () => {
  it('an unvalidated propellant is reported as LESS certain than a measured one', () => {
    /*
     * The temptation is to give APCP a small number because it is the "normal"
     * propellant. There is no strand-burner data for it in this repository, so
     * a small number would be fiction. It must come out worse than KNSB, which
     * has actually been measured.
     */
    const apcp = pick({ ...BASE, propellantName: 'APCP (Typical)' }, 'peak_pressure');
    const knsb = pick(BASE, 'peak_pressure');
    expect(apcp.relative).toBeGreaterThan(knsb.relative);
    expect(apcp.dominant).toMatch(/unvalidated/i);
  });

  it('a piecewise burn law is reported as more certain than a single power law', () => {
    const piecewise = pick({ ...BASE, hasBurnRateRegimes: true }, 'peak_pressure').relative;
    const single = pick({ ...BASE, hasBurnRateRegimes: false }, 'peak_pressure').relative;
    expect(piecewise).toBeLessThan(single);
  });

  it('flags erosive burning as order-of-magnitude rather than quoting a tidy band', () => {
    const off = pick({ ...BASE, erosiveModel: 'None' }, 'peak_pressure');
    const on = pick({ ...BASE, erosiveModel: 'Lenoir-Robillard' }, 'peak_pressure');
    expect(off.orderOfMagnitudeOnly).toBe(false);
    expect(on.orderOfMagnitudeOnly).toBe(true);
    expect(on.relative).toBeGreaterThan(off.relative * 3);
  });

  it('flags nozzle erosion, which is the weakest model in the tool', () => {
    const none = modelUncertainty(BASE).find((u) => u.output === 'throat_erosion');
    expect(none, 'no nozzle material means no erosion output').toBeUndefined();

    const withMat = pick({ ...BASE, hasNozzleMaterial: true }, 'throat_erosion');
    expect(withMat.orderOfMagnitudeOnly).toBe(true);
    // ~7x off the real Bartz correlation is not a "±%" situation.
    expect(withMat.relative).toBeGreaterThan(1);
    expect(formatBand(withMat)).toMatch(/x$/);
  });
});

describe('burn time gets its own treatment, not a copy of the pressure band', () => {
  it('damps geometry error rather than amplifying it', () => {
    /*
     * Burn time is web/r_b. Area error reaches it only through pressure, so it
     * enters with n/(1-n) -- 0.47x at n=0.32 -- instead of the 1/(1-n) = 1.47x
     * that hits pressure. Reusing the pressure band here would overstate the
     * uncertainty by a factor of three.
     */
    const pc = pick({ ...BASE, grainKind: 'Finocyl' }, 'peak_pressure');
    const tb = pick({ ...BASE, grainKind: 'Finocyl' }, 'burn_time');
    const pcGeom = pc.contributions.find((c) => /geometry/i.test(c.name))!;
    const tbGeom = tb.contributions.find((c) => /geometry/i.test(c.name))!;
    expect(tbGeom.relative).toBeLessThan(pcGeom.relative);
  });

  it('adds the late-burnout defect only for the geometry that has one', () => {
    const fino = pick({ ...BASE, grainKind: 'Finocyl' }, 'burn_time');
    const bates = pick({ ...BASE, grainKind: 'BATES' }, 'burn_time');
    expect(fino.contributions.some((c) => /burnout/i.test(c.name))).toBe(true);
    expect(bates.contributions.some((c) => /burnout/i.test(c.name))).toBe(false);
  });
});

describe('the budget cannot detach from the measurements that feed it', () => {
  it('reads the geometry error from the generated data file, not a copy', () => {
    /*
     * The failure this prevents: someone improves the Finocyl model, the
     * measured error drops, and the UI keeps quoting the old figure because it
     * was hardcoded. The number below comes from the same JSON that
     * src/geometryError.test.ts regenerates and pins.
     */
    const fino = pick({ ...BASE, grainKind: 'Finocyl' }, 'peak_pressure');
    const fromData = geometryErrors['Finocyl'].impulseWeightedError;
    const contribution = fino.contributions.find((c) => /geometry/i.test(c.name))!;
    expect(contribution.relative).toBeCloseTo(fromData * pressureAmplification(0.32), 12);
  });

  it('every contribution cites where it was measured', () => {
    // A number without a basis is an assertion. All of these have to be
    // traceable to a file someone can go read.
    for (const u of modelUncertainty({
      ...BASE,
      grainKind: 'Finocyl',
      erosiveModel: 'JPL',
      hasNozzleMaterial: true,
    })) {
      for (const c of u.contributions) {
        expect(c.basis.length, `${u.label} / ${c.name} has no basis`).toBeGreaterThan(15);
      }
    }
  });

  it('covers every geometry the app can simulate', () => {
    for (const kind of ['BATES', 'Tubular', 'Star', 'MoonBurner', 'RodAndTube', 'Finocyl']) {
      const u = pick({ ...BASE, grainKind: kind }, 'peak_pressure');
      const c = u.contributions.find((x) => /geometry/i.test(x.name))!;
      expect(c, `${kind} has no geometry contribution`).toBeTruthy();
      expect(c.basis).not.toMatch(/stated estimate/);
    }
  });

  it('an unknown geometry is flagged rather than silently given a small number', () => {
    const u = pick({ ...BASE, grainKind: 'SomethingNew' }, 'peak_pressure');
    const c = u.contributions.find((x) => /geometry/i.test(x.name))!;
    expect(c.name).toMatch(/unmeasured/);
    expect(c.basis).toMatch(/stated estimate/);
  });
});

describe('formatting', () => {
  it('uses a percentage for normal bands and a multiple for wide ones', () => {
    expect(formatBand({ relative: 0.045 } as never)).toBe('±4.5%');
    expect(formatBand({ relative: 0.23 } as never)).toBe('±23%');
    expect(formatBand({ relative: 6 } as never)).toBe('>7x');
  });
});
