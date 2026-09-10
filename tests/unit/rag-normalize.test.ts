import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BBox, ParsedElement } from '@/lib/rag/parse-types'
import {
  boxIou,
  dedupe,
  isTruncatedTable,
  isUsableBox,
  normalizePage,
  readingOrder,
  repairTableMarkup,
} from '@/lib/rag/normalize'

/**
 * These fixtures are REAL `nvidia/nemotron-parse` responses captured on
 * 2026-09-10, defects and all — not hand-written examples of what the parser
 * ought to return. Spec 0031 lists the three defects; the tests below pin each
 * one to the fixture that exhibits it, so a future parser change that silently
 * fixes or worsens them shows up here.
 */
function fixture(name: string): ParsedElement[] {
  const path = join(process.cwd(), 'tests/fixtures/parse', `${name}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as ParsedElement[]
}

const PORTRAIT = fixture('portrait-report-page')
const LANDSCAPE = fixture('landscape-schedule-page')

function box(xmin: number, ymin: number, xmax: number, ymax: number): BBox {
  return { xmin, ymin, xmax, ymax }
}

function element(
  type: string,
  text: string,
  bbox: BBox = box(0, 0, 0.5, 0.1),
): ParsedElement {
  return { type, text, bbox }
}

describe('isUsableBox', () => {
  it('rejects the inverted box the parser actually returned', () => {
    // Defect 2, from the portrait fixture: xmin 0.031 > xmax 0.022.
    const inverted = PORTRAIT.find((e) => e.bbox.xmin > e.bbox.xmax)
    expect(inverted).toBeDefined()
    expect(isUsableBox((inverted as ParsedElement).bbox)).toBe(false)
  })

  it('rejects zero-area boxes and non-finite coordinates', () => {
    expect(isUsableBox(box(0.2, 0.2, 0.2, 0.4))).toBe(false)
    expect(isUsableBox(box(0.2, 0.2, 0.4, 0.2))).toBe(false)
    expect(isUsableBox(box(Number.NaN, 0, 1, 1))).toBe(false)
  })

  it('tolerates a hair outside the page but not a wild box', () => {
    expect(isUsableBox(box(-0.01, 0, 1.01, 0.5))).toBe(true)
    expect(isUsableBox(box(-0.5, 0, 1, 0.5))).toBe(false)
  })
})

describe('boxIou', () => {
  it('is 1 for identical boxes and 0 for disjoint ones', () => {
    expect(boxIou(box(0, 0, 1, 1), box(0, 0, 1, 1))).toBe(1)
    expect(boxIou(box(0, 0, 0.2, 0.2), box(0.5, 0.5, 0.8, 0.8))).toBe(0)
  })

  it('is between 0 and 1 for partial overlap', () => {
    const iou = boxIou(box(0, 0, 0.4, 0.4), box(0.2, 0.2, 0.6, 0.6))
    expect(iou).toBeGreaterThan(0)
    expect(iou).toBeLessThan(1)
  })
})

describe('repairTableMarkup', () => {
  it('leaves the recorded tables alone, because both close correctly', () => {
    // Guards against "repairing" well-formed markup. Truncation is a case this
    // defends against, not one the fixtures exhibit.
    for (const fixtureElements of [PORTRAIT, LANDSCAPE]) {
      const table = fixtureElements.find((e) => e.type === 'Table')
      expect(table).toBeDefined()
      const text = (table as ParsedElement).text
      expect(isTruncatedTable(text)).toBe(false)
      expect(repairTableMarkup(text)).toBe(text.trimEnd())
    }
  })

  it('closes a table cut off mid-markup', () => {
    const cut = '\\begin{tabular}{cc}\na & b\\\\\nc & d\\\\\n\\end{'
    expect(isTruncatedTable(cut)).toBe(true)
    const repaired = repairTableMarkup(cut)
    expect(isTruncatedTable(repaired)).toBe(false)
    expect(repaired).toMatch(/\\end\{tabular\}$/)
    expect(repaired).toContain('c & d')
  })

  it('preserves the merged-cell structure that makes the markup worth keeping', () => {
    const table = LANDSCAPE.find((e) => e.type === 'Table') as ParsedElement
    const repaired = repairTableMarkup(table.text)
    expect(repaired).toContain('Wave 1 — internal')
    expect(repaired).toContain('Wave 3 — general')
    // The merged headers are the reason we keep the markup rather than
    // flattening to Markdown, which cannot express them.
    expect(repaired).toContain('\\multirow')
    expect(repaired).toContain('\\multicolumn')
  })

  it('leaves an already-closed table alone', () => {
    const good = '\\begin{tabular}{cc}\na & b\\\\\n\\end{tabular}'
    expect(repairTableMarkup(good)).toBe(good)
  })

  it('ignores text that is not a table', () => {
    expect(repairTableMarkup('Just a paragraph.')).toBe('Just a paragraph.')
  })
})

describe('readingOrder', () => {
  it('puts the footer after the table it was returned before', () => {
    // Defect 1: in the raw response the Page-footer (ymin 0.485) precedes the
    // Table (ymin 0.164). Array order is not reading order.
    const rawFooter = PORTRAIT.findIndex((e) => e.type === 'Page-footer')
    const rawTable = PORTRAIT.findIndex((e) => e.type === 'Table')
    expect(rawFooter).toBeLessThan(rawTable)

    const ordered = readingOrder(PORTRAIT.filter((e) => isUsableBox(e.bbox)))
    const footer = ordered.findIndex((e) => e.type === 'Page-footer')
    const table = ordered.findIndex((e) => e.type === 'Table')
    expect(table).toBeLessThan(footer)
  })

  it('reads a two-column page down one column then the other', () => {
    const left = element('Text', 'left top', box(0.05, 0.3, 0.45, 0.4))
    const leftLower = element('Text', 'left bottom', box(0.05, 0.5, 0.45, 0.6))
    const right = element('Text', 'right top', box(0.55, 0.28, 0.95, 0.38))
    const ordered = readingOrder([right, leftLower, left])
    expect(ordered.map((e) => e.text)).toEqual([
      'left top',
      'left bottom',
      'right top',
    ])
  })

  it('keeps a full-width element in y order rather than in a column', () => {
    const banner = element('Text', 'banner', box(0.02, 0.45, 0.98, 0.5))
    const left = element('Text', 'left', box(0.05, 0.2, 0.45, 0.3))
    const right = element('Text', 'right', box(0.55, 0.2, 0.95, 0.3))
    const ordered = readingOrder([banner, right, left])
    expect(ordered.map((e) => e.text)).toEqual(['left', 'right', 'banner'])
  })

  it('is a plain top-to-bottom sort for a single column', () => {
    const a = element('Text', 'a', box(0.1, 0.1, 0.9, 0.2))
    const b = element('Text', 'b', box(0.1, 0.3, 0.9, 0.4))
    expect(readingOrder([b, a]).map((e) => e.text)).toEqual(['a', 'b'])
  })

  it('handles zero and one element', () => {
    expect(readingOrder([])).toEqual([])
    const only = element('Text', 'only')
    expect(readingOrder([only])).toEqual([only])
  })
})

describe('dedupe', () => {
  it('collapses the caption the parser returned three times', () => {
    // Defect 3.
    const captions = PORTRAIT.filter(
      (e) => e.type === 'Caption' && e.text.includes('Figure 7.2:'),
    )
    expect(captions.length).toBeGreaterThan(1)
    const deduped = dedupe(captions)
    expect(deduped).toHaveLength(1)
  })

  it('prefers the copy with a usable box', () => {
    const broken = element('Caption', 'Figure 1', box(0.4, 0.2, 0.1, 0.3))
    const good = element('Caption', 'Figure 1', box(0.1, 0.2, 0.4, 0.3))
    const deduped = dedupe([broken, good])
    expect(deduped).toHaveLength(1)
    expect(isUsableBox((deduped[0] as ParsedElement).bbox)).toBe(true)
  })

  it('keeps identical text that sits in genuinely different places', () => {
    const first = element('Text', 'continued', box(0.05, 0.1, 0.2, 0.14))
    const second = element('Text', 'continued', box(0.75, 0.9, 0.9, 0.94))
    expect(dedupe([first, second])).toHaveLength(2)
  })

  it('matches across trivial markup and spacing differences', () => {
    const plain = element(
      'Caption',
      'Figure 1 — Trend',
      box(0.1, 0.2, 0.5, 0.3),
    )
    const marked = element(
      'Caption',
      '**Figure  1 — Trend**',
      box(0.1, 0.2, 0.5, 0.3),
    )
    expect(dedupe([plain, marked])).toHaveLength(1)
  })
})

describe('normalizePage', () => {
  it('drops page furniture entirely', () => {
    const out = normalizePage(PORTRAIT)
    expect(out.some((e) => e.type === 'Page-header')).toBe(false)
    expect(out.some((e) => e.type === 'Page-footer')).toBe(false)
    // The footer's text must not survive inside another element either.
    expect(out.some((e) => e.text.includes('Rev 3'))).toBe(false)
  })

  it('attaches the heading that precedes an element in reading order', () => {
    // FR5. The landscape fixture is the one that exercises this, because the
    // parser gave it a real `Section-header`; on the portrait page it labelled
    // both the table and the figure as `Caption` instead, so the only heading
    // available there is the page Title.
    const out = normalizePage(LANDSCAPE)
    const table = out.find((e) => e.type === 'Table')
    expect(table?.heading).toBe('D.1 Ingestion flow and cutover schedule')
  })

  it('carries the section label as a caption when the parser types it so', () => {
    // The portrait page's "Table 7.1 — …" label came back as a `Caption`, not a
    // `Section-header`. It must still reach the table rather than being lost.
    const table = normalizePage(PORTRAIT).find((e) => e.type === 'Table')
    expect(table?.caption).toContain('Utilisation and downtime by plant')
  })

  it('marks tables and pictures atomic and everything else not', () => {
    const out = normalizePage(PORTRAIT)
    expect(out.find((e) => e.type === 'Table')?.atomic).toBe(true)
    expect(out.find((e) => e.type === 'Picture')?.atomic).toBe(true)
    expect(out.find((e) => e.type === 'Text')?.atomic).toBe(false)
  })

  it('binds a caption to the picture it sits against, not the nearer table', () => {
    // Centre distance would bind this caption to the table (0.082) over the
    // picture (0.103). Vertical adjacency is what gets it right.
    const out = normalizePage(PORTRAIT)
    const picture = out.find((e) => e.type === 'Picture')
    expect(picture?.caption).toContain('Figure 7.2')
  })

  it('never emits a bound caption a second time as loose text', () => {
    const out = normalizePage(PORTRAIT)
    const bound = out
      .map((e) => e.caption)
      .filter((caption): caption is string => Boolean(caption))
    expect(bound.length).toBeGreaterThan(0)
    for (const caption of bound) {
      expect(out.some((e) => e.type === 'Caption' && e.text === caption)).toBe(
        false,
      )
    }
  })

  it('keeps a second, different caption as content rather than discarding it', () => {
    // The page carries both a bold figure label and a descriptive sentence.
    // One binds; the other must survive as text, because it is a sentence the
    // document actually contains.
    const out = normalizePage(PORTRAIT)
    expect(
      out.some((e) => e.text.includes('corresponds to the Geelong furnace')),
    ).toBe(true)
  })

  it('repairs the truncated table on the way through', () => {
    const table = normalizePage(LANDSCAPE).find((e) => e.type === 'Table')
    expect(table).toBeDefined()
    expect(isTruncatedTable((table as { text: string }).text)).toBe(false)
  })

  it('normalises a landscape page as readily as a portrait one', () => {
    // Orientation is not a special case: boxes are page-relative, so a
    // landscape page differs only in aspect ratio.
    const out = normalizePage(LANDSCAPE)
    expect(out.length).toBeGreaterThan(0)
    expect(out.some((e) => e.type === 'Table')).toBe(true)
    expect(out.some((e) => e.type === 'Picture')).toBe(true)
    expect(out.some((e) => e.type === 'Page-header')).toBe(false)
  })

  it('drops empty elements and unusable boxes', () => {
    const out = normalizePage([
      element('Text', '   ', box(0.1, 0.1, 0.5, 0.2)),
      element('Text', 'kept', box(0.1, 0.3, 0.5, 0.4)),
      element('Text', 'bad box', box(0.5, 0.1, 0.2, 0.2)),
    ])
    expect(out.map((e) => e.text)).toEqual(['kept'])
  })

  it('returns nothing for no input', () => {
    expect(normalizePage([])).toEqual([])
  })
})
