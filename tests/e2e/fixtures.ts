import { test as base, expect } from '@playwright/test'

// Every test gets a UNIQUE client IP via X-Forwarded-For. The app derives the
// rate-limit key from that header (`clientIpFromHeaders`), and registration is
// keyed by IP alone — so without this, every test shares one `register:::1`
// bucket that accumulates across the suite and trips under CI retries (the
// historical source of e2e flakiness). A distinct IP per test = an isolated
// bucket, so rate limits only fire within a test that deliberately provokes
// them (see auth-errors.spec.ts). The worker index is folded in so parallel
// workers can't collide.
let seq = 0

export const test = base.extend({
  extraHTTPHeaders: async ({}, use, testInfo) => {
    const n = ++seq
    const ip = `10.${testInfo.workerIndex & 255}.${(n >> 8) & 255}.${n & 255}`
    // `use` here is Playwright's fixture callback, not React's `use` hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use({ 'x-forwarded-for': ip })
  },
})

/**
 * True when the test process has an inference key: `LLM_API_KEY`, or the
 * deprecated `NVIDIA_API_KEY` (#136). The RAG suites skip without one.
 */
export const hasInferenceKey = Boolean(
  process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY,
)

export { expect }
