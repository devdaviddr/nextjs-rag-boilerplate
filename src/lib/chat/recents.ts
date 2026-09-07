/**
 * Grouping for the Recents sidebar (spec 0026 FR7).
 *
 * Pure, and takes `now` as an argument rather than reading the clock, so the
 * boundaries are testable — "yesterday" is a calendar question, not a
 * 24-hours-ago question, and getting that wrong is the usual bug here.
 */

/**
 * How many conversations the sidebar loads. Lives here rather than in
 * `actions.ts` because a `'use server'` module may only export async
 * functions — exporting a constant from one is a build error.
 */
export const RECENTS_LIMIT = 50

export interface RecentConversation {
  id: string
  title: string
  updatedAt: Date
}

export const RECENT_GROUPS = [
  'Today',
  'Yesterday',
  'Previous 7 days',
  'Older',
] as const
export type RecentGroup = (typeof RECENT_GROUPS)[number]

export interface GroupedConversations {
  group: RecentGroup
  conversations: RecentConversation[]
}

/** Midnight local time for the calendar day containing `date`. */
function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

const DAY_MS = 24 * 60 * 60 * 1000

export function groupForDate(updatedAt: Date, now: Date): RecentGroup {
  const today = startOfDay(now).getTime()
  const stamp = startOfDay(updatedAt).getTime()

  // Anything dated in the future (clock skew) reads as Today rather than
  // falling through to Older, which would look like data loss.
  if (stamp >= today) return 'Today'
  if (stamp >= today - DAY_MS) return 'Yesterday'
  if (stamp >= today - 7 * DAY_MS) return 'Previous 7 days'
  return 'Older'
}

/**
 * Bucket conversations into display groups, preserving the input order within
 * each group and dropping empty groups so the sidebar has no bare headings.
 */
export function groupConversations(
  conversations: readonly RecentConversation[],
  now: Date = new Date(),
): GroupedConversations[] {
  const buckets = new Map<RecentGroup, RecentConversation[]>()
  for (const conversation of conversations) {
    const group = groupForDate(conversation.updatedAt, now)
    const existing = buckets.get(group)
    if (existing) existing.push(conversation)
    else buckets.set(group, [conversation])
  }

  return RECENT_GROUPS.filter((g) => buckets.get(g)?.length).map((group) => ({
    group,
    conversations: buckets.get(group) ?? [],
  }))
}
