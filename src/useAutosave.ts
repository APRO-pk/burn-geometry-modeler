import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesignSnapshot } from './useDesignHistory';

/**
 * Keep the current design in localStorage so closing the tab does not lose it.
 *
 * There was no persistence of any kind: close the tab, or reload, and an
 * afternoon of work was gone unless you had remembered to export JSON. For a
 * tool where a single design is the entire artifact, that is the highest-cost
 * gap in the product, and the cheapest to close.
 *
 * WHAT THIS IS NOT
 *
 * Not a document store, and not a substitute for exporting. It keeps exactly
 * ONE design -- the one you were last editing -- and restores it on load. Named
 * designs, versions and sharing all still go through the existing
 * save/load/export paths.
 *
 * DESIGN NOTES
 *
 * Writes are debounced, because the design changes on every keystroke and
 * localStorage writes are synchronous on the main thread.
 *
 * Restore is OFFERED, not applied. Silently replacing the editor contents on
 * load would be startling, and would make it impossible to deliberately start
 * from the defaults. The user gets a banner and chooses.
 *
 * Every failure is swallowed. localStorage throws in private browsing and when
 * the quota is exhausted, and autosave failing must never take the app with it
 * -- the whole point is to be a safety net.
 */

const KEY = 'apro-burn-modeler:autosave:v1';
const DEBOUNCE_MS = 1500;

export interface AutosaveRecord {
  savedAt: number;
  design: DesignSnapshot;
}

export interface Autosave {
  /** A design found in storage at startup, if any, awaiting the user's choice. */
  recovered: AutosaveRecord | null;
  /** Apply the recovered design and clear the offer. */
  acceptRecovery: () => void;
  /** Decline it; the banner goes away and the current design is kept. */
  dismissRecovery: () => void;
  /** Unix ms of the last successful write, for a "saved" indicator. */
  lastSavedAt: number | null;
  /** True when storage is unavailable, so the UI can say so rather than lie. */
  unavailable: boolean;
}

function read(): AutosaveRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutosaveRecord;
    if (!parsed || typeof parsed.savedAt !== 'number' || typeof parsed.design !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt or unreadable. Treat it as absent rather than crashing on load.
    return null;
  }
}

export function useAutosave(
  capture: () => DesignSnapshot,
  apply: (d: DesignSnapshot) => void,
  /** Values that mean the design changed. */
  deps: readonly unknown[],
  options: { enabled?: boolean } = {}
): Autosave {
  const enabled = options.enabled !== false;
  const [recovered, setRecovered] = useState<AutosaveRecord | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  /*
   * Read once, before the first write can overwrite it.
   *
   * Ordering matters: the debounced writer below fires shortly after mount, so
   * a restore offer read later would find this session's own blank design
   * rather than the previous session's work.
   */
  const readOnce = useRef(false);
  useEffect(() => {
    if (readOnce.current) return;
    readOnce.current = true;
    try {
      // Probe writability up front so the UI can be honest about it.
      localStorage.setItem(`${KEY}:probe`, '1');
      localStorage.removeItem(`${KEY}:probe`);
    } catch {
      setUnavailable(true);
      return;
    }
    setRecovered(read());
  }, []);

  // Debounced write.
  useEffect(() => {
    if (!enabled || unavailable) return;
    const timer = setTimeout(() => {
      try {
        const record: AutosaveRecord = { savedAt: Date.now(), design: capture() };
        localStorage.setItem(KEY, JSON.stringify(record));
        setLastSavedAt(record.savedAt);
      } catch {
        // Quota exceeded, or storage disabled mid-session. A failed autosave
        // must not interrupt the user; the indicator simply stops updating.
        setUnavailable(true);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `capture` is intentionally excluded: it is rebuilt on every design change
    // and would retrigger this effect immediately, defeating the debounce. The
    // dependency list passed in is what defines "the design changed".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, unavailable, ...deps]);

  const acceptRecovery = useCallback(() => {
    if (recovered) apply(recovered.design);
    setRecovered(null);
  }, [recovered, apply]);

  const dismissRecovery = useCallback(() => setRecovered(null), []);

  return { recovered, acceptRecovery, dismissRecovery, lastSavedAt, unavailable };
}
