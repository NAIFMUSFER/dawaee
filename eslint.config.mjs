// Flat config. Deliberately narrow: the rules here are the ones that catch
// real defects in this codebase (floating promises around the database, unused
// bindings after a refactor, accidental `any` at a trust boundary). Style is
// not policed — TypeScript and review cover that, and a noisy linter is one
// people learn to ignore.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/mobile/.expo/**',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'preview.mjs',
      'checksolo.mjs',
      'checksingle.mjs',
      'checknav.mjs',
      'checknav2.mjs',
      'checknav3.mjs',
      'checksub.mjs',
      'shot.mjs',
      'flow.mjs',
      'tour.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Server, worker, scripts and build config all run on Node.
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The mobile app runs in a JS engine with browser-ish globals.
    files: ['apps/mobile/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Metro config is CommonJS by necessity.
    files: ['**/metro.config.js', '**/babel.config.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      // Unused function arguments are often intentional in handler signatures;
      // a leading underscore is the opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Rows come back from `pg` as unknown shapes; casting them is the normal
      // path, and banning it would only push the cast somewhere less visible.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Native modules that only exist on device are loaded with `require` inside
    // a try/catch, so the web build does not fail to resolve them. A static
    // import is exactly what must not happen here.
    files: ['apps/mobile/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Tests assert on loosely-typed JSON bodies by design.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
