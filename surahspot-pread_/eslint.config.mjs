import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Flat ESLint config.
 *
 * Built on typescript-eslint directly rather than on eslint-config-next. That
 * package is legacy-format only and loads a compatibility patch that throws on
 * current ESLint 9 releases, so depending on it would mean pinning ESLint to
 * whatever version the patch happens to recognise. The rules that actually
 * catch bugs here — exhaustive hook dependencies, unused symbols, unsafe
 * TypeScript escapes — are configured without that constraint.
 *
 * `next lint` is deprecated in 15 and removed in 16; the npm script calls
 * eslint directly, so this is already past that migration.
 */
export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      // The app spans both runtimes: route handlers and lib/ run in Node, the
      // component runs in the browser, and several modules are shared.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // The rule that matters most in this component: a stale dependency array
      // is how an animation loop ends up holding an old round.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // Upstream JSON arrives untyped; narrowing happens in the revive and
      // normalize helpers, which are covered by tests.
      "@typescript-eslint/no-explicit-any": "off",

      // A leading underscore is the deliberate "unused on purpose" signal.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      eqeqeq: ["error", "smart"],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },

  {
    // Scripts are standalone Node CLIs, not part of the app bundle.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },

  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
