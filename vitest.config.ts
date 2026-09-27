import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      // The real `server-only` guard throws outside an RSC bundle.
      'server-only': fileURLToPath(
        new URL('./tests/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Playwright specs live in tests/e2e and run with their own runner.
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'tests/e2e'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/app/**/layout.tsx',
        'src/db/migrate.ts',
        'src/db/seed.ts',
      ],
      // A floor, not a goal (#134): just under the measured numbers, so a
      // change that drops coverage fails `pnpm test:coverage` in CI. Raise it
      // when coverage rises; never lower it to make a change pass.
      thresholds: {
        statements: 51,
        branches: 44,
        functions: 44,
        lines: 51,
      },
    },
  },
})
