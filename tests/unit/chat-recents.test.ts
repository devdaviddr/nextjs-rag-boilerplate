import { describe, expect, it } from 'vitest'

import {
  groupConversations,
  groupForDate,
  type RecentConversation,
} from '@/lib/chat/recents'

// A fixed "now": Wednesday 10 September 2026, mid-afternoon.
const NOW = new Date('2026-09-10T15:00:00')
const at = (iso: string) => new Date(iso)

describe('groupForDate', () => {
  it('treats anything today as Today, including earlier this morning', () => {
    expect(groupForDate(at('2026-09-10T00:05:00'), NOW)).toBe('Today')
    expect(groupForDate(at('2026-09-10T14:59:00'), NOW)).toBe('Today')
  })

  it('uses calendar days, not a rolling 24 hours', () => {
    // 20 hours earlier, but a different calendar day → Yesterday, not Today.
    expect(groupForDate(at('2026-09-09T19:00:00'), NOW)).toBe('Yesterday')
  })

  it('buckets the last week and beyond', () => {
    expect(groupForDate(at('2026-09-05T12:00:00'), NOW)).toBe('Previous 7 days')
    expect(groupForDate(at('2026-09-03T12:00:00'), NOW)).toBe('Previous 7 days')
    expect(groupForDate(at('2026-08-20T12:00:00'), NOW)).toBe('Older')
  })

  it('shows a future timestamp as Today rather than Older', () => {
    // Clock skew should not look like data loss.
    expect(groupForDate(at('2026-09-12T12:00:00'), NOW)).toBe('Today')
  })
})

describe('groupConversations', () => {
  const c = (id: string, iso: string): RecentConversation => ({
    id,
    title: id,
    updatedAt: at(iso),
  })

  it('returns groups in display order and drops empty ones', () => {
    const grouped = groupConversations(
      [c('today', '2026-09-10T09:00:00'), c('old', '2026-07-01T09:00:00')],
      NOW,
    )
    expect(grouped.map((g) => g.group)).toEqual(['Today', 'Older'])
  })

  it('preserves input order within a group', () => {
    const grouped = groupConversations(
      [c('newer', '2026-09-10T14:00:00'), c('older', '2026-09-10T08:00:00')],
      NOW,
    )
    expect(grouped[0]?.conversations.map((x) => x.id)).toEqual([
      'newer',
      'older',
    ])
  })

  it('returns nothing for an empty list', () => {
    expect(groupConversations([], NOW)).toEqual([])
  })
})
