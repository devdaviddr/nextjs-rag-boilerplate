/**
 * Conversation titles, derived from the first user message.
 *
 * Deliberately not model-generated: a title is not worth an inference call
 * against a rate-limited endpoint, and the user can rename it. Pure so the
 * edge cases are testable without a database.
 */

export const MAX_TITLE_LENGTH = 60
export const FALLBACK_TITLE = 'New chat'

/**
 * Trim, collapse internal whitespace, and truncate on a word boundary.
 *
 * Truncation prefers the last space so a title never ends mid-word; if the
 * first "word" is itself longer than the limit (a pasted URL, say) it is cut
 * hard rather than returned over-length.
 */
export function deriveTitle(firstMessage: string): string {
  const cleaned = firstMessage.replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return FALLBACK_TITLE
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned

  const clipped = cleaned.slice(0, MAX_TITLE_LENGTH)
  const lastSpace = clipped.lastIndexOf(' ')
  // Only break on a space if it leaves something worth reading.
  const base =
    lastSpace > MAX_TITLE_LENGTH * 0.5 ? clipped.slice(0, lastSpace) : clipped
  return `${base.trimEnd()}…`
}
