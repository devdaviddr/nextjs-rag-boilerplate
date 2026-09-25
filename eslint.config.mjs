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
  {
    // AI settings are read through `aiSettings()`, which applies a value
    // saved from Settings over the environment (spec 0040 FR6). A direct
    // `env.RAG_*` read would silently ignore it.
    files: ['src/**/*.{ts,tsx}', 'eval/**/*.ts', 'scripts/**/*.{ts,mts}'],
    ignores: ['src/lib/ai-settings/**', 'src/lib/env.ts', 'src/lib/ai-env.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='env'][property.name=/^(RAG_|NVIDIA_API_KEY$)/]",
          message:
            'Read AI settings with aiSettings() from @/lib/ai-settings, so a value saved in Settings applies (spec 0040 FR6).',
        },
      ],
    },
  },
]

export default eslintConfig
