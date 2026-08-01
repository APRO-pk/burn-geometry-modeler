# Legacy Python Reference (Non-Authoritative)

`apro_modeler.py` and `test_apro_modeler.py` are an earlier Python twin of the
0-D internal ballistics solver. They predate, and have since diverged from,
the TypeScript implementation.

**[`src/engine.ts`](../../src/engine.ts) is the canonical engine.** Any
discrepancy between these Python files and `src/engine.ts` should be resolved
in favor of `src/engine.ts`.

These files are kept only for cross-checking historical test values during
development — they are not built, run, or imported by the app, and are not
maintained going forward.
