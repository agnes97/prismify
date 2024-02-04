/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  reportUnusedDisableDirectives: true,
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  overrides: [
    {
      files: ['**/*.ts'],
      excludedFiles: ['reset.d.ts'],
      plugins: ['@typescript-eslint'],
      extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/strict-type-checked',
      ],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: true,
        tsconfigRootDir: __dirname,
      },
      rules: {
        '@typescript-eslint/no-unused-vars': [
          'error',
          { args: 'all', argsIgnorePattern: '^_', ignoreRestSiblings: true },
        ],
        '@typescript-eslint/require-await': 'off',
      },
    },
  ],
  rules: {},
}
