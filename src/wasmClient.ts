// Main-thread client for the burn-core Web Worker.
//
// One worker is created lazily on the first run and then reused, so the wasm
// module is instantiated once per session rather than once per simulation --
// which matters for the Monte Carlo sweep, where instantiation would otherwise
// dominate the cost of a short run.

import { unpackResults } from './wasmCore';
import type { BurnConfig, BurnWorkerRequest, BurnWorkerResponse, MotorRunResult } from './wasmCore';

type Pending = {
  resolve: (value: MotorRunResult) => void;
  reject: (reason: Error) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(reason: Error) {
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL('./burnWorker.ts', import.meta.url), { type: 'module' });

  worker.addEventListener('message', (ev: MessageEvent<BurnWorkerResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);

    if (msg.ok === false) {
      p.reject(new Error(msg.error));
      return;
    }
    try {
      p.resolve({
        results: unpackResults({
          fields: msg.fields,
          rows: msg.rows,
          data: new Float64Array(msg.data),
          warnings: msg.warnings,
        }),
        warnings: msg.warnings,
        stations: msg.stations,
      });
    } catch (err) {
      p.reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  // A worker-level error kills every in-flight request; drop the instance so the
  // next call gets a fresh one rather than hanging forever on a dead worker.
  worker.addEventListener('error', (ev) => {
    const reason = new Error(`burn-core worker failed: ${ev.message || 'unknown error'}`);
    worker?.terminate();
    worker = null;
    failAll(reason);
  });

  return worker;
}

/** Run one motor in the wasm core. Rejects if the core rejects the config. */
export function runMotor(config: BurnConfig): Promise<MotorRunResult> {
  const id = nextId++;
  const req: BurnWorkerRequest = { id, config };
  return new Promise<MotorRunResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage(req);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Start the worker and instantiate the wasm module ahead of the first real run,
 * so the user does not pay for module compilation on their first click.
 * Failures are deliberately swallowed: this is an optimisation, and a genuine
 * problem will resurface with a proper error on the run itself.
 */
export function warmUpMotorCore(): void {
  try {
    getWorker();
  } catch {
    /* ignore -- runMotor will report the real error */
  }
}
