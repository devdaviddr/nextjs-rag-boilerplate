import coreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import prettier from 'eslint-config-prettier'

// Next.js 16 ships eslint-config-next as native flat-config arrays, so we
// spread them directly rather than going through FlatCompat.
const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      // Agent worktrees are full checkouts of this repo, node_modules and all.
      // They live here only while an agent is running and are never committed
      // (see .gitignore) — linting them scans the whole dependency tree.
      '.claude/worktrees/**',
      'drizzle/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]

export default eslintConfig
