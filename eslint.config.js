import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/', '.data/', '.planifikateur/', 'playwright-report/', 'test-results/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Le JSX compilé par Vite appelle React.createElement : l’import React reste nécessaire.
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^React$' },
      ],
      // Les validations rejettent volontairement les caractères de contrôle (\x00-\x1f).
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      // src/lib est partagé avec le serveur.
      globals: { ...globals.browser, ...globals.node, __PLANIFIKATEUR_BUILD_INFO__: 'readonly' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  { files: ['tests/browser/**/*.js'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
];
