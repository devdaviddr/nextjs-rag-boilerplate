import type { Metadata } from 'next'
import Link from 'next/link'

import { docSections } from '@/lib/docs'

export const metadata: Metadata = { title: 'Docs' }

/** The documentation index (spec 0041 FR1): every doc, grouped by purpose. */
export default function DocsIndexPage() {
  const sections = docSections()
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Documentation</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        How the platform works — what it is, how to use it, and how it is built.
      </p>
      <div className="mt-8 space-y-10">
        {sections.map((section) => (
          <section key={section.title} aria-labelledby={`sec-${section.title}`}>
            <h2
              id={`sec-${section.title}`}
              className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
            >
              {section.title}
            </h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {section.docs.map((doc) => (
                <li key={doc.slug}>
                  <Link
                    href={`/docs/${doc.slug}`}
                    className="hover:bg-muted/60 block h-full rounded-lg border p-4 transition-colors"
                  >
                    <span className="font-medium">{doc.title}</span>
                    {doc.summary && (
                      <span className="text-muted-foreground mt-1 line-clamp-3 block text-sm">
                        {doc.summary}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
