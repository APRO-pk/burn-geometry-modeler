import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    // Any future AI feature must call a backend proxy for API calls — never
    // `define` a secret key into the client bundle, as it would ship to the browser.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    test: {
      /*
       * 30s, not vitest's 5s default.
       *
       * These are not unit tests. Several run real WASM physics in sweeps --
       * 27 motor solves to constrain a distribution, or a 10/20/40/80-station
       * grid-convergence study -- and take a second or two alone. Under the
       * parallel file execution the suite uses, on a loaded machine, they
       * crossed 5s and failed.
       *
       * That produced the worst kind of failure: load-dependent, so re-running
       * turned it green and taught everyone to ignore it. The sweeps are the
       * point of those tests -- a single design would not constrain anything --
       * so the honest fix is a timeout matched to what they actually do. A
       * genuinely hung test still fails, just at 30s.
       */
      testTimeout: 30_000,
      // jsdom only for the React hook tests. Everything else -- the physics
      // parity suite, the surrogate, the validation fixtures -- is plain Node
      // and would only be slowed down by a DOM, so the environment is chosen
      // per file with a /** @vitest-environment jsdom */ docblock rather than
      // globally.
      environment: "node",
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
