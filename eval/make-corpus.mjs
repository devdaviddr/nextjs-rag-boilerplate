// Generates the evaluation corpus as real PDFs.
//
// Committed alongside the PDFs so the corpus is reproducible and reviewable as
// text rather than as opaque binaries. Minimal PDF writer — no dependency just
// to lay out three documents.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

function buildPdf(pages) {
  const objects = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  objects[1] = '<</Type/Catalog/Pages 2 0 R>>'
  objects[2] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pages.length}>>`
  objects[3] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'

  pages.forEach((lines, i) => {
    const pageId = pageIds[i]
    const contentId = pageId + 1
    objects[pageId] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
      `/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentId} 0 R>>`
    const body =
      'BT /F1 11 Tf 60 730 Td 15 TL\n' +
      lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
      '\nET'
    objects[contentId] =
      `<</Length ${body.length}>>\nstream\n${body}\nendstream`
  })

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

for (const [name, pages] of Object.entries(DOCS)) {
  writeFileSync(join(here, 'corpus', name), buildPdf(pages))
  console.log(`wrote corpus/${name} (${pages.length} pages)`)
}
