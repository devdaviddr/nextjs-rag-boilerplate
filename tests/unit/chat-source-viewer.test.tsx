import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SourceViewer } from '@/components/chat/source-viewer'
import type { StoredCitation } from '@/db/schema'
import type { CitationLocation } from '@/lib/citations/boxes'

/**
 * The panel's job is to be trusted (spec 0035). A box drawn in the wrong place
 * is worse than no box, so these assert the *absence* of a highlight at least
 * as hard as its presence, and they assert that a figure keeps saying it is a
 * description even while a box is drawn around it (FR5).
 */

const citation: StoredCitation = {
  index: 1,
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  documentTitle: 'Employee Handbook',
  pageNumber: 4,
  similarity: 0.81,
}

function mockLocation(location: Partial<CitationLocation> | null) {
  const fetchMock = vi.fn(async () =>
    location === null
      ? ({ ok: false, json: async () => ({}) } as Response)
      : ({
          ok: true,
          json: async () =>
            ({
              documentId: 'doc-1',
              pageNumber: 4,
              pageCount: 12,
              kind: 'text',
              boxes: [],
              ...location,
            }) satisfies CitationLocation,
        } as Response),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** jsdom never loads images, so the panel's `ready` state has to be induced. */
function loadPageImage() {
  fireEvent.load(screen.getByRole('img', { name: /^Page \d+ of / }))
}

function failPageImage() {
  fireEvent.error(screen.getByRole('img', { name: /^Page \d+ of / }))
}

describe('SourceViewer', () => {
  beforeEach(() => {
    mockLocation({})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the cited page and highlights the stored region (FR3)', async () => {
    mockLocation({
      boxes: [{ xmin: 0.1, ymin: 0.2, xmax: 0.9, ymax: 0.28 }],
    })
    const { container } = render(
      <SourceViewer citation={citation} onClose={() => {}} />,
    )

    const image = await screen.findByRole('img', {
      name: 'Page 4 of Employee Handbook',
    })
    expect(image.getAttribute('src')).toBe('/api/documents/doc-1/page?n=4')

    loadPageImage()

    await waitFor(() => {
      const box = container.querySelector<HTMLElement>('.pointer-events-none')
      expect(box).not.toBeNull()
      expect(box?.style.left).toBe('10%')
      expect(box?.style.top).toBe('20%')
      expect(box?.style.width).toBe('80%')
    })
    expect(
      screen.getByText('The cited passage is highlighted on page 4.'),
    ).toBeInTheDocument()
  })

  it('draws every box of a multi-column chunk, not one covering both (FR6)', async () => {
    mockLocation({
      boxes: [
        { xmin: 0.05, ymin: 0.1, xmax: 0.45, ymax: 0.8 },
        { xmin: 0.55, ymin: 0.1, xmax: 0.95, ymax: 0.4 },
      ],
    })
    const { container } = render(
      <SourceViewer citation={citation} onClose={() => {}} />,
    )
    await screen.findByRole('img', { name: /^Page 4 of / })
    loadPageImage()

    await waitFor(() => {
      expect(container.querySelectorAll('.pointer-events-none')).toHaveLength(2)
    })
    expect(
      screen.getByText(
        'The cited passage is highlighted on page 4 in 2 places.',
      ),
    ).toBeInTheDocument()
  })

  it('opens at the page with no box and no error when bbox is null (FR4)', async () => {
    mockLocation({ boxes: [] })
    const { container } = render(
      <SourceViewer citation={citation} onClose={() => {}} />,
    )
    const image = await screen.findByRole('img', { name: /^Page 4 of / })
    loadPageImage()

    expect(image.getAttribute('src')).toBe('/api/documents/doc-1/page?n=4')
    await waitFor(() => {
      expect(container.querySelectorAll('.pointer-events-none')).toHaveLength(0)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/highlighted/i)).not.toBeInTheDocument()
  })

  it('says nothing when the location lookup fails, and still shows the page', async () => {
    mockLocation(null)
    const { container } = render(
      <SourceViewer citation={citation} onClose={() => {}} />,
    )
    await screen.findByRole('img', { name: /^Page 4 of / })
    loadPageImage()

    await waitFor(() => {
      expect(container.querySelectorAll('.pointer-events-none')).toHaveLength(0)
    })
    expect(screen.queryByText(/could not/i)).not.toBeInTheDocument()
  })

  it('keeps a figure labelled as a description while highlighting it (FR5)', async () => {
    mockLocation({
      kind: 'figure',
      boxes: [{ xmin: 0.2, ymin: 0.3, xmax: 0.8, ymax: 0.7 }],
    })
    const { container } = render(
      <SourceViewer citation={citation} onClose={() => {}} />,
    )
    await screen.findByRole('img', { name: /^Page 4 of / })
    loadPageImage()

    expect(
      await screen.findByText(/description of a figure/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/not the document’s own words/i),
    ).toBeInTheDocument()

    await waitFor(() => {
      const box = container.querySelector<HTMLElement>('.pointer-events-none')
      // Outlined, not filled: a filled highlight reads as a quotation.
      expect(box?.className).toContain('border-dashed')
      expect(box?.className).not.toContain('bg-amber-300/35')
    })
    expect(
      screen.getByText('The described figure is outlined on page 4.'),
    ).toBeInTheDocument()
  })

  it('drops the highlight when the reader pages away from the cited page', async () => {
    mockLocation({
      boxes: [{ xmin: 0.1, ymin: 0.2, xmax: 0.9, ymax: 0.28 }],
    })
    const { container } = render(
      <SourceViewer citation={citation} onClose={() => {}} />,
    )
    await screen.findByRole('img', { name: /^Page 4 of / })
    loadPageImage()
    await waitFor(() => {
      expect(container.querySelectorAll('.pointer-events-none')).toHaveLength(1)
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }))
    loadPageImage()

    await waitFor(() => {
      expect(
        screen.getByRole('img', { name: 'Page 5 of Employee Handbook' }),
      ).toBeInTheDocument()
    })
    expect(container.querySelectorAll('.pointer-events-none')).toHaveLength(0)

    fireEvent.click(
      screen.getByRole('button', { name: /back to the cited page/i }),
    )
    loadPageImage()
    await waitFor(() => {
      expect(container.querySelectorAll('.pointer-events-none')).toHaveLength(1)
    })
  })

  it('falls back to the browser PDF viewer when the page will not render', async () => {
    render(<SourceViewer citation={citation} onClose={() => {}} />)
    await screen.findByRole('img', { name: /^Page 4 of / })

    failPageImage()

    const frame = await screen.findByTitle('Employee Handbook, page 4')
    expect(frame.getAttribute('src')).toBe('/api/documents/doc-1/source#page=4')
    expect(screen.queryByRole('img', { name: /^Page 4 of / })).toBeNull()
  })

  it('closes on Escape and on the close button', async () => {
    const onClose = vi.fn()
    render(<SourceViewer citation={citation} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close source' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('links out to the real PDF at the page being viewed', async () => {
    render(<SourceViewer citation={citation} onClose={() => {}} />)

    const link = screen.getByRole('link', { name: 'Open in new tab' })
    expect(link.getAttribute('href')).toBe('/api/documents/doc-1/source#page=4')
    expect(link.getAttribute('rel')).toContain('noopener')
  })
})
