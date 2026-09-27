import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {} }))

import { hasDocumentListIntent } from '@/lib/rag/list-intent'
import type { ListedDocument } from '@/lib/rag/retrieval-store'
import { formatDocumentList } from '@/lib/rag/tools/list-documents'

/** Asking which documents the agent can see (#168). */

describe('hasDocumentListIntent', () => {
  it.each([
    'What documents do you have?',
    'which files can you see',
    'What docs are there?',
    'list my documents',
    'Show me all the files',
    'Can you list the documents?',
    'How many documents are there?',
    'What do you have access to?',
    'What have I uploaded?',
    "What's in my knowledge base?",
    'What documents do I have access to?',
    'Which PDFs have I uploaded?',
    'What sources do you have?',
    'what documents are available',
  ])('lists for %j', (q) => expect(hasDocumentListIntent(q)).toBe(true))

  it.each([
    'Which documents mention overtime?',
    'What documents cover parental leave?',
    'How many days of annual leave do I get?',
    'What does the handbook say about leave?',
    'Show me the leave policy',
    'Summarise the staff handbook',
    'Which document says the notice period?',
    'What files do I need to submit for a claim?',
    'list the steps to request leave',
    'Which documents talk about fire safety?',
  ])('searches for %j', (q) => expect(hasDocumentListIntent(q)).toBe(false))
})

const doc = (over: Partial<ListedDocument>): ListedDocument => ({
  title: 'Doc',
  knowledgeBase: 'HR',
  mimeType: 'application/pdf',
  pageCount: 3,
  sourceUrl: null,
  ...over,
})

describe('formatDocumentList', () => {
  it('groups by knowledge base with type and size', () => {
    expect(
      formatDocumentList(
        [
          doc({ title: 'Staff handbook', pageCount: 12 }),
          doc({
            title: 'Leave policy',
            mimeType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            pageCount: 1,
          }),
          doc({
            title: 'Example Domain',
            knowledgeBase: 'Web',
            mimeType: 'text/html',
            pageCount: 2,
            sourceUrl: 'https://example.com/',
          }),
        ],
        6000,
      ),
    ).toBe(
      [
        '3 documents in 2 knowledge bases:',
        '',
        'HR:',
        '- Staff handbook (PDF, 12 pages)',
        '- Leave policy (Word, 1 section)',
        '',
        'Web:',
        '- Example Domain (web page, 2 sections)',
      ].join('\n'),
    )
  })

  it('says so when there is nothing, and when it had to cut the list', () => {
    expect(formatDocumentList([], 100)).toMatch(/no ready documents/)
    const many = Array.from({ length: 50 }, (_, i) =>
      doc({ title: `Document number ${i}` }),
    )
    const text = formatDocumentList(many, 300)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text).toMatch(/^50 documents in 1 knowledge base:/)
    expect(text).toMatch(/\(and \d+ more not listed\)$/)
  })
})
