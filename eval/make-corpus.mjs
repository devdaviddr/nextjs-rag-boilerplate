// Generates the evaluation corpus as real PDFs.
//
// Committed alongside the PDFs so the corpus is reproducible and reviewable as
// text rather than as opaque binaries. Minimal PDF writer — no dependency just
// to lay out the corpus.
//
// ## Two kinds of page
//
// A page given as an ARRAY OF STRINGS is a plain text page, laid out exactly as
// it always was. The three original documents use only these, and their bytes
// must not change: `eval/results/baseline.json` records hit@1 0.941 against
// them, and a corpus that shifts underneath a saved baseline makes every
// comparison to it meaningless.
//
// A page given as an OBJECT is a spec-0031 layout page — columns, ruled tables,
// bar charts, or a scanned image with no text layer at all. These exist to be
// documents the current pipeline demonstrably cannot index, so the gap is
// measurable before it is closed.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const PORTRAIT = [612, 792]
const LANDSCAPE = [792, 612]

const escape = (s) => String(s).replace(/([()\\])/g, '\\$1')

/** Content-stream helpers. PDF's origin is bottom-left, y grows upward. */
const draw = {
  /** One run of text at an absolute position. */
  text: (x, y, size, str) =>
    `BT /F1 ${size} Tf ${x} ${y} Td (${escape(str)}) Tj ET`,

  /** A block of lines flowing downward from `y`, for a column. */
  block: (x, y, size, leading, lines) =>
    `BT /F1 ${size} Tf ${x} ${y} Td ${leading} TL\n` +
    lines.map((l) => `(${escape(l)}) Tj T*`).join('\n') +
    '\nET',

  line: (x1, y1, x2, y2, width = 0.8) =>
    `${width} w ${x1} ${y1} m ${x2} ${y2} l S`,

  /** Filled rectangle, grey level 0 (black) to 1 (white). */
  fillRect: (x, y, w, h, grey = 0.35) =>
    `${grey} g ${x} ${y} ${w} ${h} re f 0 g`,

  /** Place a declared image XObject into a box. */
  image: (name, x, y, w, h) => `q ${w} 0 0 ${h} ${x} ${y} cm /${name} Do Q`,
}

/**
 * A ruled table with a two-level, merged header.
 *
 * The merged header is the point: flattened to plain text, "Utilisation %"
 * spanning two columns and "Site" spanning two rows lose their association with
 * the numbers underneath, which is exactly the failure spec 0031 opens with.
 */
function tableOps({ x, y, colWidths, rowHeight, header, subHeader, rows }) {
  const ops = []
  const totalWidth = colWidths.reduce((a, b) => a + b, 0)
  const bodyRows = rows.length
  const totalHeight = rowHeight * (2 + bodyRows)
  const top = y

  // Outer box and the two header rules.
  ops.push(draw.line(x, top, x + totalWidth, top))
  ops.push(
    draw.line(x, top - rowHeight * 2, x + totalWidth, top - rowHeight * 2),
  )
  ops.push(draw.line(x, top - totalHeight, x + totalWidth, top - totalHeight))
  ops.push(draw.line(x, top, x, top - totalHeight))
  ops.push(draw.line(x + totalWidth, top, x + totalWidth, top - totalHeight))

  // Column rules, skipped where the header spans.
  let cx = x
  colWidths.forEach((w, i) => {
    cx += w
    if (i < colWidths.length - 1) {
      ops.push(draw.line(cx, top - rowHeight, cx, top - totalHeight))
    }
  })

  // Header row 1: spanning labels.
  let hx = x + 4
  header.forEach(({ label, span }) => {
    const width = colWidths
      .slice(header.indexOf(header.find((h) => h.label === label)))
      .slice(0, span)
      .reduce((a, b) => a + b, 0)
    ops.push(draw.text(hx, top - rowHeight + 5, 9, label))
    hx += width
  })

  // Header row 2: the sub-columns underneath a span.
  let sx = x + 4
  colWidths.forEach((w, i) => {
    const label = subHeader[i]
    if (label) ops.push(draw.text(sx, top - rowHeight * 2 + 5, 9, label))
    sx += w
  })

  // Body.
  rows.forEach((row, r) => {
    let bx = x + 4
    const by = top - rowHeight * (3 + r) + 5
    row.forEach((cell, c) => {
      ops.push(draw.text(bx, by, 9, cell))
      bx += colWidths[c]
    })
    ops.push(
      draw.line(
        x,
        top - rowHeight * (3 + r),
        x + totalWidth,
        top - rowHeight * (3 + r),
      ),
    )
  })

  return ops
}

/** A bar chart whose VALUES exist only as bar heights — never as text. */
function barChartOps({ x, y, width, height, bars, peakIndex }) {
  const ops = []
  const max = Math.max(...bars.map((b) => b.value))
  const barWidth = width / (bars.length * 1.8)
  ops.push(draw.line(x, y, x + width, y))
  ops.push(draw.line(x, y, x, y + height))
  bars.forEach((bar, i) => {
    const bx = x + 14 + i * (width / bars.length)
    const bh = (bar.value / max) * (height - 18)
    ops.push(draw.fillRect(bx, y, barWidth, bh, i === peakIndex ? 0.25 : 0.55))
    ops.push(draw.text(bx + 2, y - 12, 8, bar.label))
  })
  return ops
}

function buildPdf(pages) {
  const objects = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  objects[1] = '<</Type/Catalog/Pages 2 0 R>>'
  objects[2] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pages.length}>>`
  objects[3] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'

  // Image XObjects are numbered AFTER every page and content object, so a
  // document with no images produces byte-identical output to before.
  let nextId = 4 + pages.length * 2
  const imageStreams = []

  pages.forEach((page, i) => {
    const pageId = pageIds[i]
    const contentId = pageId + 1

    if (Array.isArray(page)) {
      // Legacy text page — unchanged, deliberately.
      objects[pageId] =
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
        `/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentId} 0 R>>`
      const body =
        'BT /F1 11 Tf 60 730 Td 15 TL\n' +
        page
          .map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`)
          .join('\n') +
        '\nET'
      objects[contentId] =
        `<</Length ${body.length}>>\nstream\n${body}\nendstream`
      return
    }

    const [w, h] = page.size ?? PORTRAIT
    let xobjectEntry = ''
    if (page.image) {
      const imageId = nextId++
      const data = readFileSync(join(here, 'corpus-assets', page.image.file))
      imageStreams.push({ id: imageId, data, meta: page.image })
      xobjectEntry = `/XObject<</Im0 ${imageId} 0 R>>`
    }

    objects[pageId] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]` +
      `/Resources<</Font<</F1 3 0 R>>${xobjectEntry}>>/Contents ${contentId} 0 R>>`
    const body = page.ops.join('\n')
    objects[contentId] =
      `<</Length ${body.length}>>\nstream\n${body}\nendstream`
  })

  // Emitted as latin1 alongside the rest of the file, so the binary JPEG bytes
  // survive the Buffer.from(pdf, 'latin1') at the end unchanged.
  for (const { id, data, meta } of imageStreams) {
    objects[id] =
      `<</Type/XObject/Subtype/Image/Width ${meta.width}/Height ${meta.height}` +
      `/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/DCTDecode/Length ${data.length}>>\n` +
      `stream\n${data.toString('latin1')}\nendstream`
  }

  let pdf = '%PDF-1.4\n'
  const offsets = []
  const maxId = objects.length - 1
  for (let id = 1; id <= maxId; id++) {
    if (!objects[id]) continue
    offsets[id] = pdf.length
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefStart = pdf.length
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= maxId; id++) {
    pdf +=
      offsets[id] !== undefined
        ? `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
        : `0000000000 65535 f \n`
  }
  pdf += `trailer\n<</Size ${maxId + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

// Three documents that deliberately overlap in vocabulary, so retrieval has to
// discriminate rather than match the only document that mentions "leave".
const DOCS = {
  'staff-handbook.pdf': [
    [
      'STAFF HANDBOOK - SECTION 1 - ANNUAL LEAVE',
      'Policy reference POL-HR-014.',
      'The annual leave entitlement is 20 working days per calendar year.',
      'Unused leave does not carry over into the following year.',
      'Leave must be approved by your manager at least two weeks in advance.',
      'Leave requests during the December shutdown are not accepted.',
    ],
    [
      'STAFF HANDBOOK - SECTION 2 - EXPENSES',
      'Policy reference POL-FIN-022.',
      'Reimbursement for travel must be submitted within 30 days of the trip.',
      'Original receipts must be attached to every claim.',
      'Claims over 500 dollars require director approval before payment.',
      'Mileage is reimbursed at 78 cents per kilometre.',
    ],
    [
      'STAFF HANDBOOK - SECTION 3 - WORKPLACE SAFETY',
      'The fire assembly point is the grassed area on Wellington Street.',
      'Wardens wear high visibility vests and take a roll call.',
      'Incidents must be reported to the safety officer within 24 hours.',
    ],
    [
      'STAFF HANDBOOK - SECTION 4 - INFORMATION TECHNOLOGY',
      'Passwords must be at least 14 characters and are rotated annually.',
      'Personal devices may access email but not the finance system.',
      'Report suspected phishing to the service desk immediately.',
    ],
  ],
  'employment-contract.pdf': [
    [
      'EMPLOYMENT CONTRACT - PART A - APPOINTMENT',
      'The probation period is six months from the commencement date.',
      'Either party may end the appointment during probation with one week notice.',
      'The position is offered on a full time ongoing basis.',
    ],
    [
      'EMPLOYMENT CONTRACT - PART B - NOTICE AND TERMINATION',
      'After probation the notice period is four weeks in writing.',
      'Accrued but untaken leave is paid out on termination.',
      'Summary dismissal applies only in cases of serious misconduct.',
    ],
    [
      'EMPLOYMENT CONTRACT - PART C - REMUNERATION',
      'Salary is reviewed annually in July.',
      'Superannuation is paid at the statutory rate.',
      'Overtime is compensated as time in lieu, not as payment.',
    ],
  ],
  'facilities-guide.pdf': [
    [
      'FACILITIES GUIDE - BUILDING ACCESS',
      'Access cards are issued by reception on the ground floor.',
      'The building is open from 6am to 8pm on weekdays.',
      'After hours entry requires a card and a PIN.',
    ],
    [
      'FACILITIES GUIDE - PARKING',
      'Staff parking is the car park on Wellington Street.',
      'Permits are allocated annually by ballot.',
      'Visitor bays are limited to two hours.',
    ],
    [
      'FACILITIES GUIDE - MEETING ROOMS',
      'Rooms are booked through the calendar system.',
      'The boardroom seats fourteen and has video conferencing.',
      'Catering must be ordered two business days in advance.',
    ],
  ],
}

// --- Spec 0031 layout documents -------------------------------------------
//
// Every fact below is placed where the CURRENT pipeline cannot reach it, so
// each one measures a specific gap rather than "complex documents are hard":
//
//   two columns  → a fact whose sentence is broken by column interleaving
//   merged table → a number that means nothing without its column header
//   bar chart    → a value that exists ONLY as a bar height, never as text
//   scanned page → a fact behind an image, in a document that otherwise
//                  ingests happily and reports success

const SITE_REPORT_PAGES = [
  // Page 1 — two columns, emitted ROW-MAJOR across both of them.
  //
  // That ordering is the point and it is not a trick: a PDF's content stream
  // carries no notion of a column, and plenty of real producers lay a
  // two-column page down one visual row at a time. `extractText` follows the
  // stream, so the two columns interleave into a single ruined paragraph.
  // Both sides talk about lifts and capacities, so the result is plausible and
  // wrong — the worst kind — rather than obvious nonsense.
  {
    ops: [
      draw.text(60, 740, 15, 'SITE OPERATIONS REPORT - SECTION 3'),
      draw.text(60, 716, 11, 'Lift upgrade programme'),
      ...[
        [
          'The north wing lift was upgraded in',
          'The south wing lift remains on the',
        ],
        ['February by Hartley Mechanical.', 'original controller.'],
        [
          'Its new rated capacity is 1600',
          'Its rated capacity is unchanged at',
        ],
        ['kilograms.', '1000 kilograms.'],
        [
          'The upgrade was funded from the',
          'A replacement is scheduled for the',
        ],
        ['capital reserve.', 'next financial year.'],
        [
          'The north wing lift is certified',
          'The south wing lift is certified',
        ],
        ['until 2031.', 'until 2027.'],
      ].flatMap(([leftLine, rightLine], row) => {
        const y = 686 - row * 14
        return [
          draw.text(60, y, 10, leftLine),
          draw.text(330, y, 10, rightLine),
        ]
      }),
    ],
  },
  // Page 2 — a merged-cell table. "388" is meaningless without knowing it sits
  // under Geelong, in the Unplanned column.
  {
    ops: [
      draw.text(60, 740, 13, 'Table 3.1 - Utilisation and downtime by site'),
      ...tableOps({
        x: 60,
        y: 700,
        colWidths: [130, 70, 70, 80, 80],
        rowHeight: 22,
        header: [
          { label: 'Site', span: 1 },
          { label: 'Utilisation %', span: 2 },
          { label: 'Downtime (hrs)', span: 2 },
        ],
        subHeader: ['', 'H1', 'H2', 'Planned', 'Unplanned'],
        rows: [
          ['Ballarat', '71.4', '88.2', '140', '96'],
          ['Geelong', '63.0', '61.5', '210', '388'],
          ['Bendigo', '84.9', '86.1', '95', '41'],
        ],
      }),
      draw.text(
        60,
        560,
        9,
        'Utilisation is measured against nameplate capacity.',
      ),
    ],
  },
  // Page 3 — landscape, with a chart. The caption names the spike quarter, so
  // "which quarter" is answerable from text; the HOURS are only bar heights.
  {
    size: LANDSCAPE,
    ops: [
      draw.text(50, 560, 13, 'Figure 3.2 - Unplanned downtime trend'),
      ...barChartOps({
        x: 70,
        y: 200,
        width: 420,
        height: 300,
        peakIndex: 2,
        bars: [
          { label: 'Q1', value: 215 },
          { label: 'Q2', value: 308 },
          { label: 'Q3', value: 363 },
          { label: 'Q4', value: 138 },
          { label: 'Q5', value: 92 },
        ],
      }),
      draw.block(70, 160, 9, 13, [
        'Figure 3.2: Unplanned downtime by quarter across all sites.',
        'The Q3 spike corresponds to the Geelong furnace outage.',
        'Quarterly totals are held in the operations data warehouse.',
      ]),
    ],
  },
]

const MAINTENANCE_LOG_PAGES = [
  // A perfectly ordinary text page. It is what makes the document as a whole
  // pass today's document-wide isImageOnly average — and therefore what makes
  // the scanned page that follows disappear silently instead of loudly.
  [
    'MAINTENANCE LOG - SUMMARY',
    'This log records plant replacements for the current year.',
    'Routine servicing is recorded separately in the asset system.',
    'Appendix B is a scan of the site logbook.',
    'All plant work is coordinated by the facilities team.',
  ],
  {
    image: { file: 'appendix-b-scan.jpg', width: 1240, height: 1754 },
    ops: [draw.image('Im0', 0, 0, 612, 792)],
  },
]

DOCS['site-operations-report.pdf'] = SITE_REPORT_PAGES
DOCS['maintenance-log.pdf'] = MAINTENANCE_LOG_PAGES

for (const [name, pages] of Object.entries(DOCS)) {
  writeFileSync(join(here, 'corpus', name), buildPdf(pages))
  console.log(`wrote corpus/${name} (${pages.length} pages)`)
}
