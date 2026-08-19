// ============================================================================
// Lint config, added after a temporal-dead-zone bug reached production and
// blanked the Start/Sit tab.
//
// The bug: a useMemo's DEPENDENCY ARRAY named a `const` declared twelve lines
// further down. Dependency arrays are evaluated at the useMemo call, so it
// threw "Cannot access 'mine' before initialization" on first render. 122
// passing unit tests never saw it, because they test pure functions and this
// only exists once a component renders.
//
// `no-use-before-define` is the rule that catches exactly that, and it is an
// error here rather than a warning. react-hooks/rules-of-hooks and
// exhaustive-deps are on for the same reason: the broken line was carrying an
// `eslint-disable-next-line react-hooks/exhaustive-deps` comment, which is
// only meaningful if the linter actually runs.
// ============================================================================

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**", ".vercel/**"] },

  // Browser + React source
  {
    files: ["src/**/*.{js,jsx}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks, react },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // Without these, every component and every imported JSX symbol reads as
      // an unused variable and the real warnings drown in the noise.
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",

      // A non-breaking space is load-bearing in the paste parsers — they strip
      // it out of copied HTML on purpose — so flag the invisible ones that
      // aren't inside a string or regex, not the deliberate ones.
      "no-irregular-whitespace": ["error", { skipStrings: true, skipRegExps: true, skipComments: true }],

      // THE one that would have caught the crash. `variables: true` is the
      // part that matters — it flags a const referenced above its declaration
      // even inside a nested arrow, which is where the dep array lives.
      "no-use-before-define": [
        "error",
        { functions: false, classes: true, variables: true, allowNamedExports: false },
      ],

      // A hook order violation is a crash, not a style opinion.
      "react-hooks/rules-of-hooks": "error",
      // Stale-closure bugs are real but numerous in this codebase and several
      // suppressions are deliberate (narrowed memo keys, measured). Warn so
      // they stay visible without blocking the build.
      "react-hooks/exhaustive-deps": "warn",

      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-console": "off",
    },
  },

  // Serverless routes: node globals, no JSX
  {
    files: ["api/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, fetch: "readonly", AbortSignal: "readonly", Buffer: "readonly" },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-use-before-define": ["error", { functions: false, variables: true }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },

  // Test and tooling scripts
  {
    files: ["scripts/**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, "no-unused-vars": "off" },
  },
];
