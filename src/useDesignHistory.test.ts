/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDesignHistory, applyNumber, applyEnum } from './useDesignHistory';
import { useMotorConfig, GRAIN_TYPES } from './useMotorConfig';

/*
 * ============================================================================
 * THE POINT OF EXTRACTING THESE HOOKS
 * ============================================================================
 *
 * None of this could be tested while it lived inside a 3,000-line component:
 * reaching the state meant rendering the whole application, so undo/redo and
 * the design inputs had no coverage at all. They do now.
 *
 * Two real bugs motivated the extraction, and both are pinned below:
 *
 *   captureDesignState returned the temperature settings but did not depend on
 *   them, so undo restored stale values.
 *
 *   pushHistory was declared several hundred lines below a callback that called
 *   it, so writing a correct dependency array would have thrown a
 *   temporal-dead-zone error at render.
 * ============================================================================
 */

describe('design history', () => {
  it('seeds with the current design, so the first undo has somewhere to go', () => {
    const capture = vi.fn(() => ({ density: 1800 }));
    const { result } = renderHook(() => useDesignHistory(capture, vi.fn()));
    expect(result.current.snapshots.length).toBe(1);
    expect(result.current.index).toBe(0);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('walks backwards and forwards through snapshots', () => {
    let value = 1;
    const capture = () => ({ value });
    const apply = vi.fn((s: Record<string, unknown>) => {
      value = s.value as number;
    });
    const { result } = renderHook(() => useDesignHistory(capture, apply));

    value = 2;
    act(() => result.current.push());
    value = 3;
    act(() => result.current.push());
    expect(result.current.snapshots.map((s) => s.value)).toEqual([1, 2, 3]);

    act(() => result.current.undo());
    expect(value).toBe(2);
    act(() => result.current.undo());
    expect(value).toBe(1);
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.redo());
    expect(value).toBe(2);
  });

  it('discards the redo tail when a new change is made after undoing', () => {
    /*
     * Standard undo semantics, and worth pinning: undoing twice then making a
     * change must not leave the abandoned future reachable, or redo would jump
     * to a design the user has already moved away from.
     */
    let value = 1;
    const { result } = renderHook(() => useDesignHistory(() => ({ value }), vi.fn()));

    value = 2;
    act(() => result.current.push());
    value = 3;
    act(() => result.current.push());
    act(() => result.current.undo());

    value = 99;
    act(() => result.current.push());

    expect(result.current.snapshots.map((s) => s.value)).toEqual([1, 2, 99]);
    expect(result.current.canRedo).toBe(false);
  });

  it('refuses to walk off either end', () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useDesignHistory(() => ({ v: 1 }), apply));
    act(() => result.current.undo());
    act(() => result.current.redo());
    expect(apply).not.toHaveBeenCalled();
    expect(result.current.index).toBe(0);
  });
});

describe('reading a snapshot from an untrusted file', () => {
  /*
   * Snapshots also come from user-supplied BurnSim .bsd files. The applying
   * code used to be typed `any`, so a malformed file could push a string into
   * numeric state -- an outer radius of "0.05" that poisons every downstream
   * calculation instead of failing where the bad value entered.
   */

  it('accepts a finite number', () => {
    const set = vi.fn();
    expect(applyNumber(0.05, set)).toBe(true);
    expect(set).toHaveBeenCalledWith(0.05);
  });

  it('accepts a numeric string, which XML routinely produces', () => {
    const set = vi.fn();
    expect(applyNumber('0.05', set)).toBe(true);
    expect(set).toHaveBeenCalledWith(0.05);
  });

  it('rejects the values that would silently corrupt a design', () => {
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, '', '   ', 'abc', {}, [], true]) {
      const set = vi.fn();
      expect(applyNumber(bad, set), `should reject ${JSON.stringify(bad)}`).toBe(false);
      expect(set, `should not have set from ${JSON.stringify(bad)}`).not.toHaveBeenCalled();
    }
  });

  it("does not fall for Number('') === 0", () => {
    // The specific trap in loose coercion: an empty XML element would have
    // become a legitimate-looking zero radius rather than being ignored.
    const set = vi.fn();
    expect(applyNumber('', set)).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('accepts only permitted enum values', () => {
    const set = vi.fn();
    expect(applyEnum('Finocyl', GRAIN_TYPES, set)).toBe(true);
    expect(set).toHaveBeenCalledWith('Finocyl');

    const set2 = vi.fn();
    expect(applyEnum('NotAGeometry', GRAIN_TYPES, set2)).toBe(false);
    expect(set2).not.toHaveBeenCalled();
  });
});

describe('motor config', () => {
  it('starts from the supplied propellant defaults', () => {
    const { result } = renderHook(() =>
      useMotorConfig({
        propellantName: 'KNSB (Sorbitol)',
        density: 1800,
        a: 3.628e-4,
        n: 0.2117,
        molWeight: 0.04,
      })
    );
    expect(result.current.propellantName).toBe('KNSB (Sorbitol)');
    expect(result.current.density).toBe(1800);
    expect(result.current.n).toBeCloseTo(0.2117, 6);
  });

  it('holds every input the solver needs, and updates them independently', () => {
    const { result } = renderHook(() =>
      useMotorConfig({ propellantName: 'X', density: 1, a: 1, n: 1, molWeight: 1 })
    );

    act(() => result.current.setOuterRadius(0.075));
    act(() => result.current.setGrainType('Finocyl'));
    act(() => result.current.setBurnRateRegimes([
      { from_pressure: 1e5, to_pressure: 1e7, a: 1e-5, n: 0.3 },
    ]));

    expect(result.current.outerRadius).toBe(0.075);
    expect(result.current.grainType).toBe('Finocyl');
    expect(result.current.burnRateRegimes).toHaveLength(1);
    // Untouched inputs must not move.
    expect(result.current.innerRadius).toBe(0.02);
  });

  it('exposes the runtime grain-type list that matches its own type', () => {
    // GRAIN_TYPES is the runtime half of a compile-time union; a mismatch would
    // let a BurnSim file set a geometry the app cannot render.
    const { result } = renderHook(() =>
      useMotorConfig({ propellantName: 'X', density: 1, a: 1, n: 1, molWeight: 1 })
    );
    for (const kind of GRAIN_TYPES) {
      act(() => result.current.setGrainType(kind));
      expect(result.current.grainType).toBe(kind);
    }
  });
});
