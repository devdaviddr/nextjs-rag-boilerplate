'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Renders an assistant answer as Markdown (spec 0026 FR10).
 *
 * SECURITY: this content is model output derived from PDFs the user uploaded,
 * which is exactly the indirect-injection surface named in spec 0025. Raw HTML
 * is therefore NOT enabled — no `rehype-raw` — so a document that induces the
 * model to emit `<script>` or `<img onerror=…>` produces inert text. Links are
 * rel-hardened and open in a new tab, so a crafted link cannot navigate the app
 * itself or reach `window.opener`.
 *
 * Do not add `rehype-raw` here. Nothing in a document-QA answer needs it.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: linkChildren }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline underline-offset-2"
            >
              {linkChildren}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
