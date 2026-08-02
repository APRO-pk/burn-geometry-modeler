/// <reference lib="webworker" />
//
// Web Worker host for the Rust/WASM ballistics core.
//
// A full run is ~1200-4000 RK4 steps and the Monte Carlo path repeats that tens
// of times, so it runs here rather than on the main thread: the UI stays
// responsive and no longer needs the setTimeout(0) yielding the old in-thread
// TypeScript solver depended on.
//
// The wasm module is instantiated once, lazily, and reused for every request.
// The result buffer is transferred (not copied) back to the main thread.

import init, { simulate } from '../crates/burn-core/pkg-web/burn_core.js';
import wasmUrl from '../crates/burn-core/pkg-web/burn_core_bg.wasm?url';
import type { BurnWorkerRequest, BurnWorkerResponse, StationProfiles } from './wasmCore';

// Vite rewrites `wasmUrl` to the emitted asset path, so the module is fetched
// explicitly rather than through wasm-pack's `import.meta.url` guess, which
// does not survive bundling.
let ready: Promise<unknown> | null = null;
function ensureReady() {
  if (!ready) ready = init({ module_or_path: wasmUrl });
  return ready;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// Start instantiating as soon as the worker spins up, so a warm-up that only
// creates the worker still overlaps module compilation with the user's typing.
// The catch only suppresses the unhandled rejection; `ready` itself stays
// rejected, so the failure is still reported against the request that needs it.
void ensureReady().catch(() => {});

ctx.addEventListener('message', async (ev: MessageEvent<BurnWorkerRequest>) => {
  const { id, config } = ev.data;
  try {
    await ensureReady();
    const out = simulate(config) as {
      fields: string[];
      rows: number;
      data: Float64Array;
      warnings: string[];
      stations?: StationProfiles;
    };

    // `data` is already a JS-owned copy (see to_js in lib.rs), so its buffer can
    // be handed over without detaching anything the wasm side still reads.
    const buffer = out.data.buffer as ArrayBuffer;
    const msg: BurnWorkerResponse = {
      id,
      ok: true,
      fields: out.fields,
      rows: out.rows,
      data: buffer,
      warnings: out.warnings,
      stations: out.stations,
    };
    ctx.postMessage(msg, [buffer]);
  } catch (err) {
    const msg: BurnWorkerResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(msg);
  }
});
