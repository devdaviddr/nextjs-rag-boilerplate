import { describe, expect, it } from 'vitest'

import { FALLBACK_TITLE, MAX_TITLE_LENGTH, deriveTitle } from '@/lib/chat/title'

describe('deriveTitle', () => {
  it('uses a short question as-is', () => {
    expect(deriveTitle('How much annual leave do I get?')).toBe(
      'How much annual leave do I get?',
    )
  })

  it('collapses newlines and repeated spaces', () => {
    expect(deriveTitle('  How much\n\n  leave?  ')).toBe('How much leave?')
  })

  it('falls back when the message is empty or whitespace', () => {
    expect(deriveTitle('')).toBe(FALLBACK_TITLE)
    expect(deriveTitle('   \n  ')).toBe(FALLBACK_TITLE)
  })

  it('truncates on a word boundary, never mid-word', () => {
    const long =
      'What does the staff handbook say about annual leave entitlement and carry over rules'
    const title = deriveTitle(long)
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH + 1) // + ellipsis
    expect(title.endsWith('…')).toBe(true)
    // The last word before the ellipsis must be whole.
    const withoutEllipsis = title.slice(0, -1)
    expect(long.startsWith(withoutEllipsis)).toBe(true)
    expect(withoutEllipsis.endsWith(' ')).toBe(false)
  })

  it('hard-cuts a single unbroken token rather than returning it over-length', () => {
    const title = deriveTitle('x'.repeat(200))
    expect(title.length).toBe(MAX_TITLE_LENGTH + 1)
  })

  it('keeps a message exactly at the limit intact', () => {
    const exact = 'a'.repeat(MAX_TITLE_LENGTH)
    expect(deriveTitle(exact)).toBe(exact)
  })
})
