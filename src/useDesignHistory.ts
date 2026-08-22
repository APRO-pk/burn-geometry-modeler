import { useCallback, useEffect, useState } from 'react';

/**
 * Undo/redo over design snapshots.
 *
 * Extracted from AppDesktop for two reasons. The obvious one is that a
 * 3,000-line component holding its own history stack is untestable. The
 * specific one is an ordering bug: `pushHistory` was declared several hundred
 * lines BELOW a callback that called it, so adding it to that callback's
 * dependency array -- which ESLint correctly asked for -- would have evaluated
 * the identifier during render, before its `const` was initialised, and thrown
 * a temporal-dead-zone ReferenceError.
 *
 * That is not hypothetical: the same mistake crashed this app earlier in
 * development, and the symptom (a blank screen with a "not defined" error for
 * something plainly defined a few lines away) is genuinely confusing.
 *
 * A hook can be called at the top of the component, so everything it returns is
 * in scope for the whole body and the dependency array can be honest.
 */

/**
 * A captured design.
 *
 * Deliberately a permissive record rather than a strict interface: BurnSim
 * import produces one of these from a foreign file, so fields may legitimately
 * be missing, and `applyDesignState` already checks each one for `undefined`.
 * Being explicit that the SHAPE is unknown is more honest than `any`, which
 * would also silence typos on the reading side.
 */
export type DesignSnapshot = Record<string, unknown>;

export interface DesignHistory {
  snapshots: DesignSnapshot[];
  index: number;
  /** Record the current design as a new entry, discarding any redo tail. */
  push: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useDesignHistory(
  capture: () => DesignSnapshot,
  apply: (snapshot: DesignSnapshot) => void
): DesignHistory {
  const [snapshots, setSnapshots] = useState<DesignSnapshot[]>([]);
  const [index, setIndex] = useState<number>(-1);

  // Seed with the initial design, so the first undo has somewhere to go back to.
  useEffect(() => {
    if (snapshots.length === 0) {
      setSnapshots([capture()]);
      setIndex(0);
    }
  }, [snapshots.length, capture]);

  const push = useCallback(() => {
    /*
     * Both updates are functional so this stays correct when several pushes
     * land in one React batch -- reading `index` directly would make the second
     * push in a batch overwrite the first.
     */
    setSnapshots((prev) => {
      const next = prev.slice(0, index + 1);
      next.push(capture());
      return next;
    });
    setIndex((i) => i + 1);
  }, [capture, index]);

  const undo = useCallback(() => {
    if (index <= 0) return;
    const target = index - 1;
    setIndex(target);
    apply(snapshots[target]);
  }, [index, snapshots, apply]);

  const redo = useCallback(() => {
    if (index >= snapshots.length - 1) return;
    const target = index + 1;
    setIndex(target);
    apply(snapshots[target]);
  }, [index, snapshots, apply]);

  return {
    snapshots,
    index,
    push,
    undo,
    redo,
    canUndo: index > 0,
    canRedo: index < snapshots.length - 1,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Reading a snapshot safely
 * ---------------------------------------------------------------------------
 *
 * Snapshots do not all come from this application. `parseBurnsimXML` builds one
 * from a user-supplied .bsd file, so any field may be missing, or a string
 * where a number belongs, or NaN.
 *
 * Before these helpers existed the applying code was typed `any`, and a
 * malformed file would push a string straight into numeric state -- producing a
 * grain radius of "0.05" that silently poisons every downstream calculation
 * rather than failing where the bad value entered.
 *
 * `applySnapshot` below only calls the setter when the value is genuinely of
 * the expected type, so a bad field leaves the current value alone.
 */

/** Call `set` only if `value` is a usable finite number. */
export function applyNumber(value: unknown, set: (v: number) => void): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) {
    set(value);
    return true;
  }
  // A number written as a string is common in XML, and worth accepting -- but
  // only when it parses cleanly, not via the loose coercion `Number('')` = 0.
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      set(n);
      return true;
    }
  }
  return false;
}

/** Call `set` only if `value` is one of the permitted string options. */
export function applyEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  // NoInfer so T is fixed by `allowed` alone. Without it TypeScript also
  // infers from the setter -- which is a Dispatch<SetStateAction<...>> -- and
  // settles on plain `string`, defeating the whole point of the check.
  set: (v: NoInfer<T>) => void
): boolean {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    set(value as T);
    return true;
  }
  return false;
}

/**
 * Call `set` only if `value` is an array whose entries all pass `isItem`.
 *
 * Used for the piecewise burn-rate bands, which are structured data rather than
 * a scalar. A partially valid array is rejected outright: half a burn law is
 * more dangerous than none, because the missing bands fall back to
 * extrapolating whichever neighbour survived.
 */
export function applyArray<T>(
  value: unknown,
  isItem: (v: unknown) => v is T,
  set: (v: T[]) => void
): boolean {
  if (!Array.isArray(value)) return false;
  if (!value.every(isItem)) return false;
  set(value as T[]);
  return true;
}

/** Shape check for one piecewise burn-rate band. */
export function isBurnRateRegime(v: unknown): v is {
  from_pressure: number;
  to_pressure: number;
  a: number;
  n: number;
} {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.from_pressure === 'number' &&
    typeof r.to_pressure === 'number' &&
    typeof r.a === 'number' &&
    typeof r.n === 'number' &&
    Number.isFinite(r.from_pressure) &&
    Number.isFinite(r.to_pressure) &&
    Number.isFinite(r.a) &&
    Number.isFinite(r.n) &&
    r.to_pressure > r.from_pressure
  );
}
