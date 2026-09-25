import Link from 'next/link'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'

import { MermaidDiagram } from '@/components/docs/mermaid-diagram'

import { resolveDocHref } from '../../../scripts/docs-lib.mjs'

/**
 * A page of the repo's docs, rendered in the app (spec 0041 FR2–FR4).
 *
 * Same safety posture as the chat's `Markdown`: GFM, and NO raw HTML
 * (`rehype-raw` is not used), so markup in a doc renders as text. Headings get
 * GitHub-compatible ids from rehype-slug — the same ids `pnpm docs:check`
 * verifies — and every link goes through `resolveDocHref`, shared with the
 * checker. Rendered on the server; only Mermaid diagrams run in the browser.
 */
export function DocMarkdown({
  children,
  gitRef,
}: {
  children: string
  /** Commit or branch that links leaving docs/ point at on GitHub. */
  gitRef: string
}) {
  const components: Components = {
    a: ({ href, children: text }) => {
      const r = resolveDocHref(href ?? '', gitRef)
      if (r.kind === 'doc' || r.kind === 'anchor' || r.kind === 'image') {
        return (
          <Link href={r.href} className="underline underline-offset-2">
            {text}
          </Link>
        )
      }
      return (
        <a
          href={r.href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {text}
        </a>
      )
    },
    img: ({ src, alt }) => {
      const r = resolveDocHref(typeof src === 'string' ? src : '', gitRef)
      return (
        // eslint-disable-next-line @next/next/no-img-element -- doc screenshots of unknown size, served by /docs-assets
        <img
          src={r.href}
          alt={alt ?? ''}
          loading="lazy"
          className="max-w-full rounded-lg border"
        />
      )
    },
    pre: ({ node, children: inner }) => {
      const code = node?.children?.[0]
      const classes =
        code && code.type === 'element' ? code.properties?.className : undefined
      const isMermaid =
        Array.isArray(classes) && classes.includes('language-mermaid')
      if (isMermaid && code && code.type === 'element') {
        const text = code.children
          .map((c) => (c.type === 'text' ? c.value : ''))
          .join('')
        return <MermaidDiagram chart={text.trim()} />
      }
      return <pre>{inner}</pre>
    },
  }

  return (
    <div className="prose-docs">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
