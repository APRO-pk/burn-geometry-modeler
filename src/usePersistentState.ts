import { useEffect, useState } from 'react';

/**
 * `useState` that survives a reload.
 *
 * Used for display preferences -- unit system, imperial unit choices -- which
 * were reset to Metric on every load. Someone working in inches had to set that
 * again each time they opened the app, which is a small annoyance repeated
 * indefinitely.
 *
 * Deliberately separate from `useAutosave`. That keeps the DESIGN, which is
 * offered for recovery and can be declined; this keeps PREFERENCES, which
 * should just be silently remembered. Conflating them would mean either
 * prompting to restore a unit setting or silently restoring a design.
 *
 * `validate` guards against a stored value that is no longer valid -- a unit
 * that has since been removed, or a hand-edited localStorage entry. An invalid
 * stored value falls back to the initial one rather than propagating.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate: (v: unknown) => v is T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return validate(parsed) ? parsed : initial;
    } catch {
      // Private browsing, disabled storage, or corrupt JSON. A preference that
      // cannot be read is not worth failing a render over.
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota or storage disabled. Preferences silently stop persisting, which
      // is the correct failure mode -- the app still works.
    }
  }, [key, value]);

  return [value, setValue];
}

/** True for one of a fixed set of strings. */
export function isOneOf<T extends string>(allowed: readonly T[]) {
  return (v: unknown): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

/** True for a flat string-to-string record, as the imperial unit choices are. */
export function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}
