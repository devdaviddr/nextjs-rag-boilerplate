import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { DocMarkdown } from '@/components/docs/doc-markdown'
import { getDoc, neighbours } from '@/lib/docs'
import { env } from '@/lib/env'

type Params = Promise<{ slug: string }>

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const doc = getDoc((await params).slug)
  return { title: doc ? `${doc.title} · Docs` : 'Docs' }
}

/** Links leaving docs/ go to GitHub at the commit that is running. */
function gitRef(): string {
  const sha = env.APP_GIT_SHA
  return sha && sha !== 'unknown' ? sha : 'main'
}

/** One page of the docs (spec 0041 FR2–FR4). */
export default async function DocPage({ params }: { params: Params }) {
  const { slug } = await params
  const doc = getDoc(slug)
  if (!doc) notFound()
  const { prev, next } = neighbours(slug)
  const toc = doc.headings.filter((h) => h.depth === 2 || h.depth === 3)

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-10 px-4 py-8 sm:px-6">
      <article className="min-w-0 flex-1">
        <Link
          href="/docs"
          className="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" />
          Docs · {doc.section}
        </Link>
        <DocMarkdown gitRef={gitRef()}>{doc.body}</DocMarkdown>
        <nav
          aria-label="Previous and next"
          className="mt-12 flex justify-between gap-4 border-t pt-6 text-sm"
        >
          {prev ? (
            <Link
              href={`/docs/${prev.slug}`}
              className="hover:underline"
              rel="prev"
            >
              <ChevronLeft className="mr-1 inline size-4" />
              {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link
              href={`/docs/${next.slug}`}
              className="text-right hover:underline"
              rel="next"
            >
              {next.title}
              <ChevronRight className="ml-1 inline size-4" />
            </Link>
          )}
        </nav>
      </article>
      {toc.length > 1 && (
        <aside
          className="hidden w-56 shrink-0 lg:block"
          aria-label="On this page"
        >
          <div className="sticky top-8 max-h-[calc(100vh-4rem)] overflow-y-auto text-sm">
            <p className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
              On this page
            </p>
            <ul className="space-y-1.5">
              {toc.map((h) => (
                <li key={h.id} className={h.depth === 3 ? 'pl-3' : undefined}>
                  <a
                    href={`#${h.id}`}
                    className="text-muted-foreground hover:text-foreground line-clamp-2"
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  )
}
