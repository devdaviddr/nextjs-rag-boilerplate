import 'server-only'

import { z } from 'zod'

import { type ListedDocument, listedDocuments } from '../retrieval-store'
import { defineTool } from './types'

/**
 * The built-in `list_documents` tool (#168): which documents this
 * conversation can read. Built in rather than registered, so offering it
 * does not send every question through the planner (spec 0044 FR2), and a
 * plain "what documents do you have?" is answered with it directly
 * (`list-intent.ts`).
 *
 * It takes no arguments. The user and the knowledge bases come from
 * `context`, bound on the server, so the model cannot ask about anyone
 * else's documents.
 */

const KIND: Record<string, string> = {
  'application/pdf': 'PDF',
  'text/html': 'HTML',
  'text/markdown': 'Markdown',
  'text/plain': 'text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'Word',
}

function describe(doc: ListedDocument): string {
  const kind = doc.sourceUrl
    ? 'web page'
    : (KIND[doc.mimeType ?? ''] ?? 'document')
  const unit = doc.mimeType === 'application/pdf' ? 'page' : 'section'
  const size =
    doc.pageCount !== null
      ? `, ${doc.pageCount} ${unit}${doc.pageCount === 1 ? '' : 's'}`
      : ''
  return `- ${doc.title} (${kind}${size})`
}

/**
 * The list as text, grouped by knowledge base, at most `maxChars` long; a
 * list cut short says how many were left out.
 */
export function formatDocumentList(
  docs: readonly ListedDocument[],
  maxChars: number,
): string {
  if (docs.length === 0) {
    return 'There are no ready documents in the knowledge bases this conversation can search.'
  }
  const bases = new Set(docs.map((d) => d.knowledgeBase))
  const lines = [
    `${docs.length} document${docs.length === 1 ? '' : 's'} in ${bases.size} knowledge base${bases.size === 1 ? '' : 's'}:`,
  ]
  let current: string | null = null
  let shown = 0
  for (const doc of docs) {
    const next: string[] = []
    if (doc.knowledgeBase !== current) {
      next.push('', `${doc.knowledgeBase}:`)
    }
    next.push(describe(doc))
    const tail = `\n(and ${docs.length - shown} more not listed)`
    if ([...lines, ...next].join('\n').length + tail.length > maxChars) {
      lines.push(tail.trim())
      return lines.join('\n')
    }
    lines.push(...next)
    current = doc.knowledgeBase
    shown++
  }
  return lines.join('\n')
}

/**
 * The list for a direct answer (#168): longer than a planner step may see,
 * since here it is the whole of the evidence.
 */
export async function listDocumentsText(
  userId: string,
  permittedKbIds: readonly string[],
): Promise<string> {
  if (permittedKbIds.length === 0) return formatDocumentList([], 0)
  return formatDocumentList(
    await listedDocuments(userId, permittedKbIds),
    DIRECT_LIST_CHARS,
  )
}

const DIRECT_LIST_CHARS = 6000

/** Most of the list a planner step is shown, as for any tool result. */
const PLANNER_LIST_CHARS = 2000

export const listDocumentsTool = defineTool({
  name: 'list_documents',
  description:
    'List the documents the user can ask about in this conversation: title, ' +
    'type, size and knowledge base. Call this when the question is about ' +
    'which documents exist, not about what they say.',
  schema: z.object({}).strict(),
  async run(_args, context) {
    if (context.permittedKbIds.length === 0) return formatDocumentList([], 0)
    return formatDocumentList(
      await listedDocuments(context.userId, context.permittedKbIds),
      PLANNER_LIST_CHARS,
    )
  },
})
