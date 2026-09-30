import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

// Tauri sets these while running `beforeBuildCommand` / `beforeDevCommand`, so
// they are only present when Vite is invoked by the desktop shell. A plain
// `npm run dev` / `npm run build` for the web target leaves them undefined and
// the config below falls back to browser-friendly defaults.
const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
const tauriDebug = !!process.env.TAURI_ENV_DEBUG;

// Only tune the build for the desktop target when Vite is actually invoked by
// Tauri. The plain web `npm run build` keeps Vite's defaults untouched, so the
// browser artifact is unchanged by this file.
const build = tauriPlatform
  ? {
      // Match the webview engine Tauri ships against so esbuild does not down-
      // level past what the desktop runtime needs. WebView2 (Windows) tracks
      // Chromium; the WebKit fallback covers macOS/Linux dev builds.
      target: tauriPlatform === 'windows' ? 'chrome110' : 'safari15',
      minify: (tauriDebug ? false : 'esbuild') as false | 'esbuild',
      sourcemap: tauriDebug,
    }
  : undefined;

export default defineConfig(() => {
  return {
    build,
    plugins: [react(), tailwindcss()],
    // Tauri runs its own progress UI; let its output through rather than having
    // Vite wipe the terminal on every rebuild.
    clearScreen: false,
    // Expose TAURI_* to the client the same way VITE_* is exposed.
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    // Any future AI feature must call a backend proxy for API calls — never
    // `define` a secret key into the client bundle, as it would ship to the browser.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    test: {
      /*
       * 30s headroom, not vitest's 5s default.
       *
       * This is DEFENCE IN DEPTH, not the fix -- and the distinction matters,
       * because raising it was originally mistaken for a fix.
       *
       * The suite began failing in a different test on each run. Two tests that
       * run real WASM physics in sweeps were crossing 5s, so this went up and
       * everything went green. Profiling afterwards showed why they were slow:
       * three surrogate tests were re-solving the same 315 held-out designs
       * five times over -- about 1,575 solves to do 315 designs worth of work
       * -- and were saturating the CPU for roughly 116 of the suite's 127
       * seconds. The tests that tripped their timeouts were never slow. They
       * were starved.
       *
       * Memoising that solve (see src/surrogate.test.ts) took the suite from
       * ~126s to ~57s, and those two tests from 6.8s and 5.2s to 2.3s and 2.8s,
       * comfortably back inside the default.
       *
       * The larger timeout stays anyway: a CI runner can be far slower than a
       * developer machine, and these are physics tests rather than unit tests.
       * A genuinely hung test still fails, just at 30s. But if a test starts
       * approaching this limit, the answer is to profile it, not to raise the
       * number again.
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
      // Tauri's devUrl points at a fixed port, so fail loudly instead of
      // silently hopping to another port the desktop shell will not find.
      port: 3000,
      strictPort: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
