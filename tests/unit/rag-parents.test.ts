import { describe, expect, it } from 'vitest'

import type { ChunkBox, ChunkKind } from '@/db/schema'
import { type Chunk, chunkElements, chunkPages } from '@/lib/rag/chunk'
import { type LayoutLine, toElements } from '@/lib/rag/layout'
import { normalizePage } from '@/lib/rag/normalize'
import {
  type BoxedPageRow,
  type PageRow,
  collapseParents,
  mergeRunContent,
  pagesToLoad,
  parentRunBoxes,
  sectionKey,
  sectionRuns,
} from '@/lib/rag/parents'
import type { RetrievedChunk } from '@/lib/rag/retrieve'

/**
 * Spec 0033, 1c. Parents are assembled at query time from gated children, so
 * everything that matters about them is decided by three pure functions:
 * `sectionRuns` (what a section is), `collapseParents` (when a parent replaces
 * its children) and `mergeRunContent` (what its text is). No database, no
 * network — the retrieval query that feeds these is pinned separately in
 * rag-retrieve.test.ts.
 */

const BOX_A: ChunkBox = { xmin: 0.1, ymin: 0.1, xmax: 0.5, ymax: 0.12 }
const BOX_B: ChunkBox = { xmin: 0.1, ymin: 0.5, xmax: 0.5, ymax: 0.52 }

function row(
  id: string,
  chunkIndex: number,
  overrides: Partial<PageRow> = {},
): PageRow {
  return {
    id,
    documentId: 'doc-1',
    pageNumber: 1,
    content: `content ${id}`,
    heading: null,
    headingBbox: null,
    kind: 'text',
    chunkIndex,
    tokenCount: 50,
    ...overrides,
  }
}

function hit(
  r: PageRow,
  similarity: number,
  overrides: Partial<RetrievedChunk> = {},
): RetrievedChunk {
  return {
    chunkId: r.id,
    documentId: r.documentId,
    documentTitle: `Title ${r.documentId}`,
    content: r.content,
    pageNumber: r.pageNumber,
    similarity,
    kind: r.kind,
    ...(r.heading != null ? { heading: r.heading } : {}),
    ...(r.headingBbox != null ? { headingBbox: r.headingBbox } : {}),
    ...overrides,
  }
}

const ids = (runs: readonly { id: string }[][]) =>
  runs.map((run) => run.map((r) => r.id))

describe('sectionKey', () => {
  it('separates the same heading text at two different positions', () => {
    expect(sectionKey({ heading: 'Notes', headingBbox: BOX_A })).not.toBe(
      sectionKey({ heading: 'Notes', headingBbox: BOX_B }),
    )
  })

  it('does not depend on the key order the driver returned the jsonb in', () => {
    const reordered = { ymax: 0.12, xmax: 0.5, ymin: 0.1, xmin: 0.1 }
    expect(sectionKey({ heading: 'A', headingBbox: reordered })).toBe(
      sectionKey({ heading: 'A', headingBbox: BOX_A }),
    )
  })

  it('treats a missing heading and a missing box as the empty key', () => {
    expect(sectionKey({})).toBe(
      sectionKey({ heading: null, headingBbox: null }),
    )
  })
})

describe('sectionRuns', () => {
  it('opens a new run when the heading changes', () => {
    const runs = sectionRuns([
      row('a', 0, { heading: 'One', headingBbox: BOX_A }),
      row('b', 1, { heading: 'One', headingBbox: BOX_A }),
      row('c', 2, { heading: 'Two', headingBbox: BOX_B }),
      row('d', 3, { heading: 'Two', headingBbox: BOX_B }),
    ])
    expect(ids(runs)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps the same heading text at a different position as two runs', () => {
    const runs = sectionRuns([
      row('a', 0, { heading: 'Notes', headingBbox: BOX_A }),
      row('b', 1, { heading: 'Notes', headingBbox: BOX_B }),
    ])
    expect(ids(runs)).toEqual([['a'], ['b']])
  })

  it('orders by chunk index, whatever order the rows arrive in', () => {
    const runs = sectionRuns([row('c', 2), row('a', 0), row('b', 1)])
    expect(ids(runs)).toEqual([['a', 'b', 'c']])
  })

  it('skips a figure without splitting the run around it (0031 FR8)', () => {
    const runs = sectionRuns([
      row('a', 0, { heading: 'One', headingBbox: BOX_A }),
      row('fig', 1, { heading: 'One', headingBbox: BOX_A, kind: 'figure' }),
      row('b', 2, { heading: 'One', headingBbox: BOX_A }),
    ])
    expect(ids(runs)).toEqual([['a', 'b']])
  })

  it('keeps a table and OCR text as members', () => {
    const runs = sectionRuns([
      row('a', 0, { heading: 'One' }),
      row('t', 1, { heading: 'One', kind: 'table' }),
      row('o', 2, { heading: 'One', kind: 'ocr' }),
    ])
    expect(ids(runs)).toEqual([['a', 't', 'o']])
  })

  it('puts rows before the first heading in a run of their own', () => {
    const runs = sectionRuns([
      row('lead-1', 0),
      row('lead-2', 1),
      row('a', 2, { heading: 'One', headingBbox: BOX_A }),
    ])
    expect(ids(runs)).toEqual([['lead-1', 'lead-2'], ['a']])
  })
})

/**
 * The three ingestion paths, run for real and then grouped. These are the
 * cases the spec's asymmetry note is about: what a "section" is depends on
 * which path read the page, and each one is pinned here rather than assumed.
 */
describe('sectionRuns over real chunker output', () => {
  const options = { chunkTokens: 512, overlapTokens: 64 }

  const asRows = (chunks: readonly Chunk[]): PageRow[] =>
    chunks.map((c) => ({
      id: `c${c.chunkIndex}`,
      documentId: 'doc-1',
      pageNumber: c.pageNumber,
      content: c.content,
      heading: c.heading,
      headingBbox: c.headingBox ?? null,
      kind: c.kind ?? 'text',
      chunkIndex: c.chunkIndex,
      tokenCount: c.tokenCount,
    }))

  const byPage = (rows: readonly PageRow[]) => {
    const pages = new Map<number, PageRow[]>()
    for (const r of rows) {
      pages.set(r.pageNumber, [...(pages.get(r.pageNumber) ?? []), r])
    }
    return pages
  }

  it('cracked path: a Section-header and the paragraphs beneath it are one run', () => {
    const elements = normalizePage([
      {
        type: 'Section-header',
        text: '4. Disposing of records',
        bbox: { xmin: 0.1, ymin: 0.1, xmax: 0.6, ymax: 0.13 },
      },
      {
        type: 'Text',
        text: 'Check the records register first.',
        bbox: { xmin: 0.1, ymin: 0.15, xmax: 0.9, ymax: 0.2 },
      },
      {
        type: 'Text',
        text: 'Obtain the custodian sign-off.',
        bbox: { xmin: 0.1, ymin: 0.22, xmax: 0.9, ymax: 0.27 },
      },
      {
        type: 'Section-header',
        text: '5. Retention periods',
        bbox: { xmin: 0.1, ymin: 0.4, xmax: 0.6, ymax: 0.43 },
      },
      {
        type: 'Text',
        text: 'Keep financial records for seven years.',
        bbox: { xmin: 0.1, ymin: 0.45, xmax: 0.9, ymax: 0.5 },
      },
    ])
    const rows = asRows(chunkElements(elements, 1, options))
    expect(rows).toHaveLength(3)
    expect(ids(sectionRuns(rows))).toEqual([['c0', 'c1'], ['c2']])
  })

  it('text-layer path (spec 0039): font-size headings group the same way', () => {
    const line = (text: string, y: number, fontSize: number): LayoutLine => ({
      text,
      fontSize,
      bbox: { xmin: 0.1, ymin: y, xmax: 0.8, ymax: y + fontSize / 792 },
    })
    const elements = normalizePage(
      toElements(
        [
          line('4. Disposing of records', 0.1, 13),
          line('Check the records register first.', 0.14, 11),
          // A blank line's worth of gap: a new paragraph, so a new chunk.
          line('Obtain the custodian sign-off.', 0.2, 11),
          line('5. Retention periods', 0.3, 13),
          line('Keep financial records for seven years.', 0.34, 11),
        ],
        { bodySize: 11, furniture: new Set() },
      ),
    )
    const rows = asRows(chunkElements(elements, 1, options))
    expect(rows.map((r) => r.heading)).toEqual([
      '4. Disposing of records',
      '4. Disposing of records',
      '5. Retention periods',
    ])
    expect(ids(sectionRuns(rows))).toEqual([['c0', 'c1'], ['c2']])
  })

  it('chunkPages fallback: every chunk of a page is one run, the whole page', () => {
    // No boxes and one detectHeading line per page, so the section IS the
    // page. Coarser than the other two paths — the asymmetry spec 0033 states.
    const para = (n: number) =>
      `Paragraph ${n} ${'of plain prose that fills the budget '.repeat(12)}`
    const text = ['POLICY OVERVIEW', ...[1, 2, 3, 4].map(para)].join('\n\n')
    const rows = asRows(
      chunkPages([{ pageNumber: 1, text }], {
        chunkTokens: 120,
        overlapTokens: 0,
      }),
    )
    expect(rows.length).toBeGreaterThan(1)
    expect(new Set(rows.map((r) => r.heading))).toEqual(
      new Set(['POLICY OVERVIEW']),
    )
    expect(sectionRuns(rows)).toHaveLength(1)
  })

  it('a section running over two pages is one run per page, and never one parent (NFR3)', () => {
    const chunks = chunkPages(
      [
        { pageNumber: 1, text: 'SECTION ONE\n\nFirst page text.' },
        { pageNumber: 2, text: 'SECTION ONE\n\nSecond page text.' },
      ],
      options,
    )
    const rows = asRows(chunks)
    const perPage = [...byPage(rows).values()].map((page) => sectionRuns(page))
    expect(perPage.map((runs) => ids(runs))).toEqual([[['c0']], [['c1']]])

    // Both admitted, same heading text, different pages: no parent.
    const out = collapseParents(
      rows.map((r) => hit(r, 0.5)),
      rows,
      { maxTokens: 1536 },
    )
    expect(out.every((c) => c.memberChunkIds === undefined)).toBe(true)
  })
})

describe('mergeRunContent', () => {
  it('joins members in order with a blank line', () => {
    expect(mergeRunContent([{ content: 'One.' }, { content: 'Two.' }])).toBe(
      'One.\n\nTwo.',
    )
  })

  it('drops the overlap tail the chunker seeded the next member with', () => {
    const merged = mergeRunContent([
      { content: 'A.\n\nB.\n\nC.' },
      { content: 'B.\n\nC.\n\nD.' },
    ])
    expect(merged).toBe('A.\n\nB.\n\nC.\n\nD.')
  })

  it('keeps a sentence the document genuinely repeats', () => {
    // Not at the junction: the next member does not START with it.
    expect(
      mergeRunContent([
        { content: 'Sign here.\n\nThen file it.' },
        { content: 'Keep a copy.\n\nSign here.' },
      ]),
    ).toBe('Sign here.\n\nThen file it.\n\nKeep a copy.\n\nSign here.')
    // The whole previous member repeated is never overlap: the chunker never
    // emits a chunk that is all tail.
    expect(
      mergeRunContent([{ content: 'Sign here.' }, { content: 'Sign here.' }]),
    ).toBe('Sign here.\n\nSign here.')
  })

  it('drops overlap produced by the real chunker, and nothing else', () => {
    const sentences = Array.from(
      { length: 30 },
      (_, i) =>
        `Sentence ${i} explains a rule of the records policy in detail.`,
    )
    const chunks = chunkPages(
      [{ pageNumber: 1, text: sentences.join('\n\n') }],
      { chunkTokens: 80, overlapTokens: 20 },
    )
    expect(chunks.length).toBeGreaterThan(2)
    expect(mergeRunContent(chunks)).toBe(sentences.join('\n\n'))
  })
})

describe('pagesToLoad', () => {
  it('asks for nothing when no page holds two admitted chunks of one section', () => {
    expect(pagesToLoad([])).toEqual([])
    expect(
      pagesToLoad([
        hit(row('a', 0, { heading: 'One' }), 0.5),
        hit(row('b', 1, { heading: 'Two' }), 0.5),
        hit(row('c', 0, { documentId: 'doc-2', heading: 'One' }), 0.5),
      ]),
    ).toEqual([])
  })

  it('ignores figures', () => {
    expect(
      pagesToLoad([
        hit(row('a', 0, { heading: 'One' }), 0.5),
        hit(row('f', 1, { heading: 'One', kind: 'figure' }), 0.5),
      ]),
    ).toEqual([])
  })

  it('names each qualifying page once', () => {
    expect(
      pagesToLoad([
        hit(row('a', 0, { heading: 'One' }), 0.5),
        hit(row('b', 1, { heading: 'One' }), 0.5),
        hit(row('c', 2, { heading: 'One' }), 0.5),
      ]),
    ).toEqual([{ documentId: 'doc-1', pageNumber: 1 }])
  })
})

describe('collapseParents', () => {
  const OPTS = { maxTokens: 1536 }
  const section = (heading: string, box: ChunkBox) => ({
    heading,
    headingBbox: box,
  })

  it('R0: nothing in, nothing out', () => {
    expect(collapseParents([], [row('a', 0), row('b', 1)], OPTS)).toEqual([])
  })

  it('returns a lone admitted child unchanged', () => {
    const rows = [row('a', 0), row('b', 1), row('c', 2)]
    const admitted = [hit(rows[1]!, 0.5)]
    expect(collapseParents(admitted, rows, OPTS)).toEqual(admitted)
  })

  it('replaces two admitted children with one parent at the best position', () => {
    const one = section('One', BOX_A)
    const rows = [
      row('a', 0, one),
      row('b', 1, one),
      row('c', 2, one),
      row('other', 3, { documentId: 'doc-2' }),
    ]
    const other = hit(rows[3]!, 0.6)
    const admitted = [other, hit(rows[2]!, 0.45), hit(rows[0]!, 0.52)]

    const out = collapseParents(admitted, rows, OPTS)

    expect(out).toHaveLength(2)
    expect(out[0]).toBe(other)
    const parent = out[1]!
    // First chunk of the run, whichever child ranked best.
    expect(parent.chunkId).toBe('a')
    expect(parent.memberChunkIds).toEqual(['a', 'b', 'c'])
    // The un-admitted sibling's text is included, in reading order.
    expect(parent.content).toBe('content a\n\ncontent b\n\ncontent c')
    // A real child cosine, the best admitted one — never a blend.
    expect(parent.similarity).toBe(0.52)
    expect(parent.assembledFrom).toBe(2)
    expect(parent.heading).toBe('One')
    expect(parent.pageNumber).toBe(1)
    expect(parent.documentId).toBe('doc-1')
  })

  it('leaves a run over the cap as separate children', () => {
    const rows = [
      row('a', 0, { tokenCount: 600 }),
      row('b', 1, { tokenCount: 600 }),
      row('c', 2, { tokenCount: 600 }),
    ]
    const admitted = [hit(rows[0]!, 0.5), hit(rows[1]!, 0.4)]
    expect(collapseParents(admitted, rows, OPTS)).toEqual(admitted)
  })

  it('never merges two runs on one page', () => {
    const rows = [
      row('a', 0, section('One', BOX_A)),
      row('b', 1, section('Two', BOX_B)),
    ]
    const admitted = [hit(rows[0]!, 0.5), hit(rows[1]!, 0.4)]
    expect(collapseParents(admitted, rows, OPTS)).toEqual(admitted)
  })

  it('makes each run its own parent when two runs on a page both qualify', () => {
    const rows = [
      row('a', 0, section('One', BOX_A)),
      row('b', 1, section('One', BOX_A)),
      row('c', 2, section('Two', BOX_B)),
      row('d', 3, section('Two', BOX_B)),
    ]
    const out = collapseParents(
      rows.map((r, i) => hit(r, 0.6 - i * 0.05)),
      rows,
      OPTS,
    )
    expect(out.map((p) => p.memberChunkIds)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('labels a parent ocr when any member is OCR text, text otherwise', () => {
    const withOcr = [row('a', 0), row('b', 1, { kind: 'ocr' })]
    const withTable = [row('a', 0), row('b', 1, { kind: 'table' })]
    const both = (rows: PageRow[]) =>
      collapseParents(
        rows.map((r) => hit(r, 0.5)),
        rows,
        OPTS,
      )[0]?.kind
    expect(both(withOcr)).toBe('ocr')
    expect(both(withTable)).toBe('text')
  })

  it('never folds a figure into a parent', () => {
    const rows = [row('a', 0), row('fig', 1, { kind: 'figure' }), row('b', 2)]
    const out = collapseParents(
      [hit(rows[1]!, 0.7), hit(rows[0]!, 0.5), hit(rows[2]!, 0.45)],
      rows,
      OPTS,
    )
    expect(out[0]?.chunkId).toBe('fig')
    expect(out[0]?.memberChunkIds).toBeUndefined()
    expect(out[1]?.memberChunkIds).toEqual(['a', 'b'])
  })

  it('is a no-op when the loader returned no rows for the page', () => {
    const rows = [row('a', 0), row('b', 1)]
    const admitted = rows.map((r) => hit(r, 0.5))
    expect(collapseParents(admitted, [], OPTS)).toEqual(admitted)
  })
})

/**
 * Randomised properties. Seeded, so a failure reproduces; each case is a
 * fresh random corpus of pages, sections and admitted lists.
 */
describe('collapseParents — properties', () => {
  function rng(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const KINDS: ChunkKind[] = ['text', 'text', 'text', 'table', 'ocr', 'figure']

  function randomCase(seed: number) {
    const random = rng(seed)
    const pick = <T>(xs: readonly T[]) =>
      xs[Math.floor(random() * xs.length)] as T
    const rows: PageRow[] = []
    let index = 0
    for (const documentId of ['d1', 'd2']) {
      for (let page = 1; page <= 3; page++) {
        const count = 1 + Math.floor(random() * 6)
        for (let i = 0; i < count; i++) {
          rows.push(
            row(`${documentId}-p${page}-${i}`, index++, {
              documentId,
              pageNumber: page,
              heading: pick([null, 'One', 'Two']),
              headingBbox: pick([null, BOX_A, BOX_B]),
              kind: pick(KINDS),
              tokenCount: 20 + Math.floor(random() * 700),
            }),
          )
        }
      }
    }
    const admitted = rows
      .filter(() => random() < 0.4)
      .map((r) => hit(r, 0.35 + random() * 0.4))
      .sort(() => random() - 0.5)
    return { rows, admitted }
  }

  const pageOf = (c: { documentId: string; pageNumber: number }) =>
    `${c.documentId}:${c.pageNumber}`

  it('holds on 300 random cases', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { rows, admitted } = randomCase(seed)
      const out = collapseParents(admitted, rows, { maxTokens: 1536 })

      // Non-empty exactly when the input is: refusal cannot flip.
      expect(out.length > 0).toBe(admitted.length > 0)

      // Nothing new appears: every (document, page) out was a (document,
      // page) in.
      const inPages = new Set(admitted.map(pageOf))
      for (const c of out) expect(inPages.has(pageOf(c))).toBe(true)

      // No page's first rank gets worse.
      for (const page of inPages) {
        const before = admitted.findIndex((c) => pageOf(c) === page)
        const after = out.findIndex((c) => pageOf(c) === page)
        expect(after).toBeGreaterThanOrEqual(0)
        expect(after).toBeLessThanOrEqual(before)
      }

      // Every parent's members share one page, and no chunk is listed twice.
      const rowById = new Map(rows.map((r) => [r.id, r]))
      const seen = new Set<string>()
      for (const c of out) {
        const members = c.memberChunkIds ?? [c.chunkId]
        const pages = new Set(members.map((id) => pageOf(rowById.get(id)!)))
        expect(pages.size).toBe(1)
        for (const id of members) {
          expect(seen.has(id)).toBe(false)
          seen.add(id)
        }
        if (c.memberChunkIds) {
          expect(c.assembledFrom).toBeGreaterThanOrEqual(2)
          const best = Math.max(
            ...admitted
              .filter((a) => c.memberChunkIds!.includes(a.chunkId))
              .map((a) => a.similarity),
          )
          expect(c.similarity).toBe(best)
        }
      }
    }
  })
})

describe('parentRunBoxes', () => {
  const boxed = (
    id: string,
    chunkIndex: number,
    heading: string,
    boxes: ChunkBox[],
    kind: ChunkKind = 'text',
  ): BoxedPageRow => ({
    id,
    kind,
    heading,
    headingBbox: heading === 'One' ? BOX_A : BOX_B,
    chunkIndex,
    boxes,
    bbox: null,
  })

  const R1: ChunkBox = { xmin: 0.1, ymin: 0.15, xmax: 0.45, ymax: 0.2 }
  const R2: ChunkBox = { xmin: 0.55, ymin: 0.15, xmax: 0.9, ymax: 0.2 }
  const R3: ChunkBox = { xmin: 0.1, ymin: 0.6, xmax: 0.9, ymax: 0.7 }
  const FIG: ChunkBox = { xmin: 0.1, ymin: 0.3, xmax: 0.9, ymax: 0.4 }

  const page = [
    boxed('a', 0, 'One', [R1]),
    boxed('fig', 1, 'One', [FIG], 'figure'),
    boxed('b', 2, 'One', [R2]),
    boxed('c', 3, 'Two', [R3]),
  ]

  it("returns exactly the run's boxes, as a list and never a union", () => {
    expect(parentRunBoxes(page, 'a')).toEqual([R1, R2])
  })

  it('returns null for a chunk in no run, so the caller keeps its own boxes', () => {
    expect(parentRunBoxes(page, 'fig')).toBeNull()
    expect(parentRunBoxes(page, 'gone')).toBeNull()
  })
})
