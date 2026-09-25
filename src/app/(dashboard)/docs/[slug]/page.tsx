import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'

import { DocMarkdown } from '@/components/docs/doc-markdown'
import { DocToc } from '@/components/docs/doc-toc'
import { Button } from '@/components/ui/button'
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

  const titleId = doc.headings.find((h) => h.depth === 1)?.id

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex justify-end">
        <Button asChild variant="outline" size="sm" className="rounded-lg">
          <Link href="/docs">
            <ArrowLeft />
            Back to Docs
          </Link>
        </Button>
      </div>
      <div className="flex gap-10">
        <article className="min-w-0 flex-1">
          <header className="mb-8">
            <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
              {doc.section}
            </p>
            <h1
              id={titleId}
              className="mt-2 scroll-mt-6 text-4xl font-bold tracking-tight"
            >
              {doc.title}
            </h1>
          </header>
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
        {toc.length > 1 && <DocToc items={toc} />}
      </div>
    </div>
  )
}
