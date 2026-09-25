/**
 * Server-process startup hook (Next.js `register`).
 *
 * Two things start here: the log store (spec 0042 FR3), and ingestion
 * recovery (spec 0034 FR1). A document is
 * ingested by `after()`, in the same process that served the upload — so when
 * that process goes away mid-run, nothing is left holding the work. This
 * project's deploy model is a pull timer that restarts the container, which
 * makes that the normal case rather than a crash scenario.
 *
 * `register` runs once per server instance, which is exactly the granularity
 * the sweep wants: one timer per container, no new service, no worker image.
 * The real logic lives in `src/lib/rag/ingest.ts` so it stays unit-testable —
 * this file only decides *when* it is allowed to start.
 */
export async function register(): Promise<void> {
  // `instrumentation.ts` is loaded for the edge runtime too, where there is no
  // database driver and no timer worth keeping. The import has to be dynamic
  // for that reason: a top-level import of `ingest.ts` would pull `server-only`
  // and postgres-js into the edge bundle.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // `next build` boots a server to prerender. Sweeping there would mutate a
  // production database from a build machine, which is never intended.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  // Logs first, so ingestion recovery's own lines are kept (spec 0042).
  const [{ env }, { startLogStore }, { startRunStore }] = await Promise.all([
    import('@/lib/env'),
    import('@/lib/observability/log-store'),
    import('@/lib/observability/run-store'),
  ])
  startLogStore({
    persist: env.LOG_PERSIST,
    retentionDays: env.LOG_RETENTION_DAYS,
  })
  startRunStore({ retentionDays: env.TELEMETRY_RETENTION_DAYS })

  const { startIngestionRecovery } = await import('@/lib/rag/ingest')
  startIngestionRecovery()
}
