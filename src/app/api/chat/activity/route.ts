import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { appLogs, messages, ragRuns, ragSpans } from '@/db/schema'
import { getCurrentSession } from '@/lib/auth/session'
import {
  type ActivityStep,
  MAX_ACTIVITY_EVENTS,
  toActivityLine,
  worthShowing,
} from '@/lib/observability/activity'

/**
 * A past answer's activity, for the chat's Agent activity drawer (spec 0042
 * FR12). Only for the person who asked, or an admin; anyone else gets a 404,
 * as if the answer did not exist. Plain lines for everyone, details for
 * admins only.
 */
export async function GET(request: Request) {
  const session = await getCurrentSession()
  if (!session?.user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const requestId = new URL(request.url).searchParams.get('requestId') ?? ''
  if (!/^[\w-]{8,100}$/.test(requestId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const isAdmin = (session.user.roles ?? []).includes('admin')

  const [message] = await db
    .select({ ownerId: messages.ownerId })
    .from(messages)
    .where(
      and(eq(messages.requestId, requestId), eq(messages.role, 'assistant')),
    )
    .limit(1)
  if (!message || (message.ownerId !== session.user.id && !isAdmin)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const [run, spans, logs] = await Promise.all([
    db
      .select({ startedAt: ragRuns.startedAt, durationMs: ragRuns.durationMs })
      .from(ragRuns)
      .where(eq(ragRuns.id, requestId))
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(ragSpans)
      .where(eq(ragSpans.runId, requestId))
      .orderBy(asc(ragSpans.key)),
    db
      .select()
      .from(appLogs)
      .where(eq(appLogs.requestId, requestId))
      .orderBy(asc(appLogs.id))
      .limit(MAX_ACTIVITY_EVENTS),
  ])

  const start = run?.startedAt.getTime() ?? 0
  const steps: ActivityStep[] = run
    ? spans.map((s) => ({
        kind: 'step',
        phase: 'end',
        key: s.key,
        parentKey: s.parentKey,
        name: s.name,
        offsetMs: Math.max(0, s.startedAt.getTime() - start),
        durationMs: s.durationMs,
        status: s.status as ActivityStep['status'],
        model: s.model,
        tokens: s.tokens,
      }))
    : []
  const lines = logs
    .filter((l) => worthShowing(l.message))
    .map((l) =>
      toActivityLine(
        {
          time: l.time.toISOString(),
          level: l.level as 'debug' | 'info' | 'warn' | 'error',
          category: l.category,
          message: l.message,
          meta: l.meta ?? {},
        },
        isAdmin,
      ),
    )

  return NextResponse.json(
    {
      startedAt: run?.startedAt.toISOString() ?? lines[0]?.time ?? null,
      totalMs: run?.durationMs ?? null,
      steps,
      lines,
      isAdmin,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
