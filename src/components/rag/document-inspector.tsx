'use client'

import { useState } from 'react'
import { AlertTriangle, FileWarning } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { boxPercentStyle } from '@/lib/citations/boxes'
import {
  type InspectedDocument,
  describeKind,
  describePage,
} from '@/lib/rag/inspect'
import { cn } from '@/lib/utils'

/**
 * What the system actually indexed from one document (spec 0037).
 *
 * ## The one rule
 *
 * This view must never make the index look better than it is. A user opens it
 * to find out what is *missing*, so every ambiguity resolves towards saying so:
 * a page that produced nothing gets a row of its own and says it is not
 * searchable, a `figure` chunk is labelled as a search key rather than shown as
 * a quotation, and an absent extraction record is stated rather than papered
 * over. An inspection tool that rounds up is worse than none — it turns a
 * silent gap into one the user has been actively reassured about.
 *
 * ## Why one page at a time
 *
 * NFR2: a 200-page document must not fetch 200 page images. Only the selected
 * page's `<img>` is mounted, so the render cost is one page no matter how long
 * the document is. The page *list* is cheap — it comes from the extraction
 * record, not from the images.
 */
export function DocumentInspector({
  documentId,
  title,
  inspection,
}: {
  documentId: string
  title: string
  inspection: InspectedDocument
}) {
  const { pages, extraction, partial, partialReasons } = inspection
  const [selectedPage, setSelectedPage] = useState(pages[0]?.page ?? 1)
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null)
  const [render, setRender] = useState<'loading' | 'ready' | 'failed'>(
    'loading',
  )

  const page = pages.find((p) => p.page === selectedPage) ?? pages[0]
  if (!page) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing has been indexed from this document yet.
      </p>
    )
  }

  const description = describePage(page)

  const select = (n: number) => {
    if (n === selectedPage) return
    setRender('loading')
    setSelectedChunk(null)
    setSelectedPage(n)
  }

  return (
    <div className="space-y-4">
      {partial && (
        <div className="flex gap-3 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">
              Some of this document is not searchable
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
              {partialReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* FR8. Saying the record is absent is the whole point — the alternative
          is a per-page story this document never produced. */}
      {!extraction && (
        <p className="text-muted-foreground rounded-md border border-dashed p-3 text-xs">
          How each page was read was not recorded for this document. It was
          indexed before the app kept a per-page record, or with page-by-page
          reading turned off. The pages below list what was stored; the routing
          detail is genuinely unknown, not omitted.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <nav aria-label="Pages" className="max-h-[70vh] overflow-auto pr-1">
          <ul className="space-y-1">
            {pages.map((p) => {
              const d = describePage(p)
              return (
                <li key={p.page}>
                  <button
                    type="button"
                    onClick={() => select(p.page)}
                    aria-current={p.page === selectedPage ? 'true' : undefined}
                    className={cn(
                      'hover:bg-muted flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                      p.page === selectedPage && 'bg-muted',
                    )}
                  >
                    <span className="tabular-nums">{p.page}</span>
                    <span className="min-w-0 flex-1">
                      {/* Not truncated: "Read page by page — it has columns
                          or a table" and "…it has figures" differ only at the
                          end, so an ellipsis makes every page look alike. */}
                      <span className="text-muted-foreground block text-xs">
                        {d.headline}
                      </span>
                      {/* FR6: an empty page is called out in the list too, not
                          only once you have thought to click it. */}
                      {p.empty && (
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                          <FileWarning className="size-3" />
                          Not searchable
                        </span>
                      )}
                    </span>
                    {p.chunks.length > 0 && (
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {p.chunks.length}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="min-w-0 space-y-3">
          <div>
            <h2 className="text-sm font-medium">
              Page {page.page}
              <span className="text-muted-foreground font-normal">
                {' '}
                — {description.headline}
              </span>
            </h2>
            {description.detail && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {description.detail}
              </p>
            )}
          </div>

          {/* FR6, placed BEFORE the page image: an empty page has nothing
              to overlay, and putting the finding under a full-height render of
              the page is how it ends up below the fold on the one page a user
              opened this view to find. */}
          {page.chunks.length === 0 && (
            <div className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              <p className="font-medium">Nothing was indexed from this page</p>
              <p className="mt-1 text-xs">
                {description.detail ??
                  'It produced no text, so nothing on it can be found by search.'}{' '}
                The page is shown below as it was read.
              </p>
            </div>
          )}

          {render === 'ready' && page.chunks.length > 0 && (
            <ul className="text-muted-foreground mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block size-3 rounded-[2px] ring-2 ring-amber-500/60"
                />
                Indexed as a passage
              </li>
              {page.annotations.some((a) => a.kind === 'heading') && (
                <li className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block size-3 rounded-[2px] border border-sky-600"
                  />
                  Heading — searched with the chunks under it
                </li>
              )}
              {page.annotations.some((a) => a.kind === 'caption') && (
                <li className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block size-3 rounded-[2px] border-2 border-dashed border-teal-600"
                  />
                  Caption — what makes the figure findable
                </li>
              )}
            </ul>
          )}
          <div className="bg-muted/40 rounded-md p-3">
            <div className="relative mx-auto w-full max-w-[720px]">
              {/* eslint-disable-next-line @next/next/no-img-element --
                  Same reasoning as the citation panel: a private, `no-store`
                  render of one page, which the image optimiser would both cache
                  and resample out from under the boxes positioned over it. */}
              <img
                key={page.page}
                src={`/api/documents/${documentId}/page?n=${page.page}`}
                alt={`Page ${page.page} of ${title}`}
                onLoad={() => setRender('ready')}
                onError={() => setRender('failed')}
                className={cn(
                  'block h-auto w-full bg-white shadow-sm',
                  render !== 'ready' && 'invisible',
                )}
              />
              {render === 'loading' && (
                <div
                  className="bg-muted absolute inset-0 animate-pulse rounded"
                  aria-hidden="true"
                />
              )}
              {render === 'failed' && (
                <p className="text-muted-foreground absolute inset-0 flex items-center justify-center p-4 text-center text-xs">
                  This page couldn&rsquo;t be rendered. What was indexed from it
                  is listed below regardless.
                </p>
              )}
              {/* Spec 0038 FR4. Drawn UNDER the chunk regions so a chunk is
                  never obscured by the context around it, and in different
                  weights because they are different claims: a chunk is a
                  passage retrieval can return, a heading or caption is text
                  indexed to make that passage findable. */}
              {render === 'ready' &&
                page.annotations.map((a) => (
                  <div
                    key={`${a.kind}:${a.box.xmin}:${a.box.ymin}`}
                    aria-hidden="true"
                    style={boxPercentStyle(a.box)}
                    className={cn(
                      'pointer-events-none absolute rounded-[2px]',
                      a.kind === 'heading'
                        ? 'border border-sky-600'
                        : 'border-2 border-dashed border-teal-600',
                    )}
                  />
                ))}
              {render === 'ready' &&
                page.chunks.map((chunk) =>
                  chunk.boxes.map((box, i) => (
                    <div
                      key={`${chunk.id}:${i}`}
                      aria-hidden="true"
                      style={boxPercentStyle(box)}
                      className={cn(
                        'pointer-events-none absolute rounded-[2px]',
                        // Amber against the page rather than a theme token: the
                        // rendered page is white in dark mode too.
                        chunk.kind === 'figure'
                          ? 'border-2 border-dashed border-amber-500'
                          : 'ring-2 ring-amber-500/60',
                        selectedChunk === chunk.id && 'bg-amber-300/40',
                      )}
                    />
                  )),
                )}
            </div>
          </div>

          {page.chunks.length > 0 && (
            <ul className="space-y-2">
              {page.chunks.map((chunk) => {
                const kind = describeKind(chunk.kind)
                const open = selectedChunk === chunk.id
                return (
                  <li key={chunk.id} className="rounded-md border">
                    <Button
                      type="button"
                      variant="ghost"
                      aria-expanded={open}
                      onClick={() => setSelectedChunk(open ? null : chunk.id)}
                      className="h-auto w-full justify-start gap-2 px-3 py-2 text-left"
                    >
                      <Badge
                        variant={
                          chunk.kind === 'text' ? 'secondary' : 'outline'
                        }
                      >
                        {kind.label}
                      </Badge>
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-normal">
                        {chunk.content.slice(0, 120)}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {chunk.tokenCount} tok
                      </span>
                    </Button>
                    {open && (
                      <div className="space-y-2 border-t px-3 py-2">
                        {/* FR5. The label above is not enough on its own for a
                            figure: the text below LOOKS like a quotation, and
                            saying otherwise beside it is the only thing that
                            stops it being read as one. */}
                        {kind.note && (
                          <p className="text-xs text-amber-700 dark:text-amber-300">
                            {kind.note}
                          </p>
                        )}
                        {/* A heading is never a chunk of its own — ingestion
                            attaches it to the chunks beneath it — so it has no
                            box and nothing on the page marks it. Without this
                            line the view says a document's title and section
                            headings were not indexed, when in fact they are
                            prepended to what gets embedded. */}
                        {chunk.heading && (
                          <p className="text-muted-foreground text-xs">
                            Indexed under{' '}
                            <span className="text-foreground font-medium">
                              {chunk.heading}
                            </span>{' '}
                            — the heading is searched with this chunk rather
                            than on its own, so it is not marked on the page.
                          </p>
                        )}
                        {/* FR4: the STORED text, which is what retrieval
                            matches against — not a tidied rendering of it.
                            Untrusted document content: displayed, never
                            interpreted. */}
                        <p className="text-sm whitespace-pre-wrap">
                          {chunk.content}
                        </p>
                        {/* FR5. The caption is the thing this chunk is FOUND
                            by — for a caption-less figure it is a sentence a
                            model wrote, and it reaches the index either way.
                            Showing it beside the content is what lets a reader
                            judge whether the key is any good. */}
                        {chunk.caption && (
                          <p className="rounded-md border border-teal-600/40 bg-teal-50 px-2 py-1.5 text-xs text-teal-900 dark:bg-teal-950/40 dark:text-teal-100">
                            <span className="font-medium">Found by:</span>{' '}
                            {chunk.caption}
                          </p>
                        )}
                        <p className="text-muted-foreground text-xs">
                          Page {page.page} · {chunk.tokenCount} tokens ·{' '}
                          {chunk.boxes.length > 0
                            ? `${chunk.boxes.length} region${chunk.boxes.length === 1 ? '' : 's'} on the page`
                            : 'no recorded position on the page'}
                        </p>
                        {/* FR6. The stored record, verbatim. A view that says
                            "this is what was indexed" should be checkable
                            against the row rather than taken on trust. */}
                        <details className="text-xs">
                          <summary className="text-muted-foreground cursor-pointer select-none">
                            Raw chunk
                          </summary>
                          <div className="mt-2 space-y-2">
                            <div>
                              <p className="text-muted-foreground mb-1">
                                Stored record
                              </p>
                              <pre className="bg-muted overflow-x-auto rounded-md p-2 text-[11px] leading-relaxed">
                                {JSON.stringify(
                                  {
                                    id: chunk.id,
                                    chunkIndex: chunk.chunkIndex,
                                    pageNumber: page.page,
                                    kind: chunk.kind,
                                    tokenCount: chunk.tokenCount,
                                    heading: chunk.heading,
                                    caption: chunk.caption,
                                    boxes: chunk.boxes,
                                    headingBox: chunk.headingBox,
                                    captionBox: chunk.captionBox,
                                    content: chunk.content,
                                  },
                                  null,
                                  2,
                                )}
                              </pre>
                            </div>
                            <div>
                              <p className="text-muted-foreground mb-1">
                                Text composed for embedding —{' '}
                                <strong>recomputed now</strong>, not read back
                                from the vector. If the document has been
                                renamed since it was indexed, the title here
                                differs from the one that was embedded.
                              </p>
                              <pre className="bg-muted overflow-x-auto rounded-md p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                                {chunk.embeddedText}
                              </pre>
                            </div>
                          </div>
                        </details>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
