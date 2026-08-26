import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

/**
 * ESLint configuration.
 *
 * `npm run lint` used to be `tsc --noEmit` alone, which catches type errors and
 * nothing else -- no hook dependency checking, no unused variables, no
 * accessibility rules. This adds those, and `lint` now runs both.
 *
 * The rule selection is deliberately narrow. A large repository adopting a lint
 * config for the first time can easily surface thousands of stylistic
 * complaints, at which point everyone runs it with --quiet and it stops
 * mattering. What is enabled here is limited to rules that catch REAL DEFECTS:
 *
 *   react-hooks/*        stale closures and conditional hooks, which produce
 *                        wrong values at runtime with no type error
 *   no-unused-vars       dead code, and the specific case of a removed field
 *                        leaving an orphaned reader
 *   no-explicit-any      `any` is how a removed core field once reached the UI
 *                        as `undefined` with tsc still green
 *   jsx-a11y/*           keyboard and screen-reader access, previously not
 *                        considered at all
 *
 * Formatting is not enforced. Prettier is not installed on purpose: reformatting
 * the whole repository would bury the history of files that carry a lot of
 * explanatory comment, and nothing here has been slowed down by inconsistent
 * formatting.
 */
export default tseslint.config(
  {
    // Generated, vendored, or build output. Never linted.
    ignores: [
      'dist/**',
      'crates/**',
      'node_modules/**',
      'public/**',
      '**/*.data.json',
      'legacy-python/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      // --- hooks: wrong values at runtime, invisible to the type checker ---
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // --- dead code ---
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          // A leading underscore is the established way to say "deliberately
          // unused" -- e.g. `_a_port` in the erosive path, which documents an
          // argument the 0-D model intentionally ignores.
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // --- `any` ---
      // Warn rather than error: the remaining instances are mostly caught
      // exceptions and third-party boundaries, and turning them all into build
      // failures at once would mean suppressing them in bulk, which is worse
      // than seeing them.
      '@typescript-eslint/no-explicit-any': 'warn',

      // --- accessibility ---
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/no-redundant-roles': 'error',
      // Interactive behaviour on a non-interactive element is unreachable by
      // keyboard. Warn while the existing UI is brought up to standard.
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/label-has-associated-control': 'warn',

      // --- correctness ---
      /*
       * Bare DOM globals that read like ordinary local variables.
       *
       * StatisticsTab rendered "Propellant Length: 0.00 mm" for a while because
       * it referenced `length` without receiving it as a prop: that resolves to
       * `window.length`, the frame count, which is a real global of the right
       * type -- so TypeScript accepted it and the readout was silently zero.
       *
       * These are the globals most likely to be meant as data.
       */
      'no-restricted-globals': [
        'error',
        { name: 'length', message: 'Did you mean a prop or local? window.length is the frame count.' },
        { name: 'name', message: 'window.name is the browsing-context name. Use a prop or local.' },
        { name: 'status', message: 'window.status is the (defunct) status bar text. Use a prop or local.' },
        { name: 'origin', message: 'window.origin is the page origin. Use a prop or local.' },
        { name: 'closed', message: 'window.closed refers to the window. Use a prop or local.' },
        { name: 'event', message: 'Use the handler argument, not the deprecated global event.' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },

  {
    /*
     * Toasts pause their countdown on hover and focus.
     *
     * The rule wants an interactive role on any element carrying mouse
     * handlers. A toast is a live region -- role="status" or role="alert" --
     * and its children are the controls; labelling it "button" to satisfy the
     * linter would announce a control that does not exist, which is worse for
     * a screen-reader user than the warning is for us. Focus handlers are
     * present alongside the mouse ones, so the behaviour itself is reachable
     * without a pointer.
     */
    files: ['src/ui/notifications.tsx'],
    rules: { 'jsx-a11y/no-static-element-interactions': 'off' },
  },

  {
    // Tests reach into internals and construct deliberately malformed inputs.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    // Build and data-generation scripts run in Node and log by design.
    files: ['tools/**/*.mts', 'tools/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
