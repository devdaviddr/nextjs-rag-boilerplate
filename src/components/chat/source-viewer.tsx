'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { StoredCitation } from '@/db/schema'
import { type CitationLocation, boxPercentStyle } from '@/lib/citations/boxes'
import { cn } from '@/lib/utils'

/**
 * The citation panel (spec 0026 FR13, spec 0035 FR3–FR6).
 *
 * ## What it shows and why it is a picture
 *
 * Opening a citation used to frame `/api/documents/[id]/source` and let the
 * browser's own PDF viewer render it. That put the reader on the right page
 * and stopped there — on a dense page, finding the sentence is most of the
 * work the citation was supposed to save, and a framed native viewer takes
 * `#page=N` and nothing else, so there is no way to draw on it.
 *
 * So the panel shows a server-rendered PNG of the page with the cited
 * rectangles drawn over it. The security reasoning behind rendering on the
 * server rather than running pdf.js here is in
 * `src/app/api/documents/[id]/page/route.ts`, and it is the substantive
 * decision in spec 0035 — read it before changing this.
 *
 * The trade the reader sees is that the page is an image: no text selection,
 * no in-document search. "Open in new tab" still serves the real PDF to the
 * browser's own viewer, at the current page, exactly as before.
 *
 * ## The failure modes, all of which degrade to today's behaviour
 *
 * A highlight is a stronger claim than a page number: a page says "the answer
 * is around here", a box says "this text, exactly". A box in the wrong place
 * is therefore worse than no box, so every uncertainty resolves downwards:
 *
 * - No stored box (every document ingested before spec 0031) — the location
 *   lookup returns an empty list, the page is shown with nothing drawn on it.
 *   Silent, and identical to the old page-level citation (FR4).
 * - The lookup fails or the chunk is gone — same as above. Never an error the
 *   reader has to read, because there is nothing they could do about it.
 * - The page will not render — the panel falls back to framing the source
 *   route, which is precisely what it did before this spec.
 * - The reader pages away from the cited page — the boxes are not drawn.
 *   Repeating them on a page the citation never pointed at would be the exact
 *   confidently-wrong claim this whole design is arranged to avoid.
 */

type RenderState = 'loading' | 'ready' | 'failed'

export function SourceViewer({
  citation,
  onClose,
}: {
  citation: StoredCitation
  onClose: () => void
}) {
  const [location, setLocation] = useState<CitationLocation | null>(null)
  const [page, setPage] = useState(citation.pageNumber)
  const [render, setRender] = useState<RenderState>('loading')

  // Escape closes the panel. Owned here rather than by the transcript, so the
  // shortcut cannot outlive the thing it closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Where the chunk actually sits on the page. Deliberately fetched when the
  // panel opens rather than carried on the citation: `messages.citations` is
  // persisted, so every conversation answered before this shipped would
  // otherwise be permanently un-highlightable (NFR3 also wants this off the
  // answer's path — nothing here runs until a citation is clicked).
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/citations/${encodeURIComponent(citation.chunkId)}`, {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: CitationLocation | null) => {
        if (data) setLocation(data)
      })
      .catch(() => {
        // Aborted, offline, or a chunk that no longer exists. No highlight is
        // a supported outcome, so there is nothing to report.
      })
    return () => controller.abort()
  }, [citation.chunkId])

  const goTo = useCallback((next: number) => {
    setRender('loading')
    setPage(next)
  }, [])

  const pageCount = location?.pageCount ?? null
  const isFigure = location?.kind === 'figure'
  // Boxes belong to ONE page. `location.pageNumber` is the authority, not the
  // page number copied into the citation when the answer was written — if the
  // two ever disagree, nothing is drawn, which is the safe direction.
  const boxes = location && location.pageNumber === page ? location.boxes : []
  const canPage = render !== 'failed' && pageCount !== null && pageCount > 1

  const sourceHref = `/api/documents/${citation.documentId}/source#page=${page}`

  return (
    <aside
      aria-label={`Source: ${citation.documentTitle}, page ${citation.pageNumber}`}
      className={cn(
        'bg-background flex w-full max-w-full flex-col border-l',
        'fixed inset-0 z-40 md:static md:z-auto md:w-[45%] md:max-w-[720px]',
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {citation.documentTitle}{' '}
          <span className="text-muted-foreground font-normal">
            — page {page}
          </span>
        </p>
        <Button asChild size="icon" variant="ghost" className="size-8">
          <a
            href={sourceHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in new tab"
          >
            <ExternalLink className="size-4" />
          </a>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Close source"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      {/*
        Spec 0035 FR5, and spec 0031 FR10 before it: a `figure` chunk's text is
        a search key written to make the figure findable, NOT the document's
        own words. Drawing a box around it makes it look more like a quotation
        than a page number ever did, so this says so in words as well as with a
        dashed outline — the labelling matters more here, not less.
      */}
      {isFigure && (
        <p className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          This source is a <strong>description of a figure</strong>, written so
          the figure could be found — not the document&rsquo;s own words. The
          dashed outline marks the figure being described.
        </p>
      )}

      {render === 'failed' ? (
        /* The pre-0035 panel, unchanged, as the floor this can fall back to.
           No `sandbox` attribute: a fully-restrictive sandbox prevents the
           browser's PDF viewer from initialising, and the permissive
           combination that does work (`allow-scripts allow-same-origin`)
           provides no protection at all. The route hardens the response
           instead — see its comment for the threat model. */
        <iframe
          key={`${citation.documentId}#${page}`}
          title={`${citation.documentTitle}, page ${page}`}
          src={sourceHref}
          className="min-h-0 flex-1 border-0"
        />
      ) : (
        <div className="bg-muted/40 min-h-0 flex-1 overflow-auto p-3">
          <div className="relative mx-auto w-full max-w-[900px]">
            {/* eslint-disable-next-line @next/next/no-img-element --
                Not a `next/image`: this is a private, `no-store` render of one
                page whose intrinsic size is not known until it arrives, and
                putting it through the image optimiser would both cache a
                document page and rewrite the very pixels the boxes are
                positioned against. */}
            <img
              key={page}
              src={`/api/documents/${citation.documentId}/page?n=${page}`}
              alt={`Page ${page} of ${citation.documentTitle}`}
              onLoad={() => setRender('ready')}
              onError={() => setRender('failed')}
              className={cn(
                'block h-auto w-full bg-white shadow-sm',
                render !== 'ready' && 'invisible',
              )}
            />
            {render !== 'ready' && (
              <div
                className="bg-muted absolute inset-0 animate-pulse rounded"
                aria-hidden="true"
              />
            )}
            {render === 'ready' &&
              boxes.map((box, i) => (
                <div
                  key={`${box.xmin}:${box.ymin}:${box.xmax}:${box.ymax}:${i}`}
                  aria-hidden="true"
                  style={boxPercentStyle(box)}
                  className={cn(
                    'pointer-events-none absolute rounded-[2px]',
                    // Amber against the page, not against the app's theme: the
                    // rendered page is white in dark mode too, so a themed
                    // token would vanish on one of them.
                    isFigure
                      ? 'border-2 border-dashed border-amber-500'
                      : 'bg-amber-300/35 ring-2 ring-amber-500/70',
                  )}
                />
              ))}
          </div>
          {/* The highlight is visual; this is the same claim for a screen
              reader, and it is deliberately absent when there is no box. */}
          {render === 'ready' && boxes.length > 0 && (
            <p className="sr-only" role="status">
              {isFigure
                ? `The described figure is outlined on page ${page}.`
                : `The cited passage is highlighted on page ${page}${
                    boxes.length > 1 ? ` in ${boxes.length} places` : ''
                  }.`}
            </p>
          )}
        </div>
      )}

      {canPage && (
        <div className="flex items-center justify-center gap-2 border-t px-3 py-2">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => goTo(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            Page {page} of {pageCount}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Next page"
            disabled={pageCount !== null && page >= pageCount}
            onClick={() => goTo(page + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
          {location !== null && page !== location.pageNumber && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs"
              onClick={() => goTo(location.pageNumber)}
            >
              Back to the cited page
            </Button>
          )}
        </div>
      )}
    </aside>
  )
}
