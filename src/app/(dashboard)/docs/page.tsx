import type { Metadata } from 'next'
import Link from 'next/link'
import {
  BookOpen,
  Database,
  FileText,
  Lightbulb,
  ScanSearch,
  Server,
} from 'lucide-react'

import { DocsSearch } from '@/components/docs/docs-search'
import { docIcon } from '@/components/docs/doc-icon'
import { docSections } from '@/lib/docs'

export const metadata: Metadata = { title: 'Docs' }

/** Faint outline icons behind the header, for texture only. */
const DECORATION = [
  { Icon: BookOpen, className: 'top-2 left-[4%] size-9 -rotate-12' },
  { Icon: Lightbulb, className: 'top-24 left-0 size-7 rotate-6' },
  { Icon: Database, className: 'top-44 left-[5%] size-6 -rotate-6' },
  { Icon: ScanSearch, className: 'top-4 right-[5%] size-9 rotate-12' },
  { Icon: FileText, className: 'top-28 right-0 size-7 -rotate-6' },
  { Icon: Server, className: 'top-48 right-[5%] size-6 rotate-3' },
]

/**
 * The documentation index (spec 0041 FR1): search (FR7), then every doc,
 * grouped by purpose.
 */
export default function DocsIndexPage() {
  const sections = docSections()
  return (
    <div className="relative mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 hidden h-64 md:block"
      >
        {DECORATION.map(({ Icon, className }, i) => (
          <Icon
            key={i}
            strokeWidth={1.25}
            className={`absolute text-slate-300 dark:text-slate-700 ${className}`}
          />
        ))}
      </div>

      <header className="relative mx-auto max-w-3xl text-center">
        <h1 className="text-4xl font-bold tracking-tight">Docs</h1>
        <p className="text-muted-foreground mt-3 text-lg">
          How the platform works: what it is, how to use it, and how it is
          built.
        </p>
        <div className="mt-8 text-left">
          <DocsSearch />
        </div>
      </header>

      <div className="mt-14 space-y-14">
        {sections.map((section) => (
          <section key={section.title} aria-labelledby={`sec-${section.title}`}>
            <h2
              id={`sec-${section.title}`}
              className="text-2xl font-semibold tracking-tight"
            >
              {section.title}
            </h2>
            <p className="text-muted-foreground mt-1">{section.description}</p>
            <ul className="mt-5 grid gap-5 sm:grid-cols-2">
              {section.docs.map((doc) => {
                const Icon = docIcon(doc.slug)
                return (
                  <li key={doc.slug}>
                    <Link
                      href={`/docs/${doc.slug}`}
                      className="group bg-card block h-full overflow-hidden rounded-2xl border shadow-xs transition hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-md focus-visible:ring-4 focus-visible:ring-orange-500/20 focus-visible:outline-none dark:hover:border-orange-500/50"
                    >
                      <span className="docs-card-art flex h-32 items-center justify-center">
                        <Icon
                          aria-hidden
                          strokeWidth={1.25}
                          className="size-12 text-orange-600 transition-transform group-hover:scale-105 dark:text-orange-300"
                        />
                      </span>
                      <span className="block p-5">
                        <span className="block text-lg font-semibold">
                          {doc.title}
                        </span>
                        {doc.summary && (
                          <span className="text-muted-foreground mt-1 line-clamp-2 block text-sm">
                            {doc.summary}
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
