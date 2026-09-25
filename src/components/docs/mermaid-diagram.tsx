'use client'

import { useEffect, useId, useState } from 'react'
import { useTheme } from 'next-themes'

/**
 * A Mermaid diagram from the docs, rendered in the browser (spec 0041 FR4).
 *
 * `mermaid` is ~600 KB, so it is imported only when a page actually has a
 * diagram (NFR1). `securityLevel: 'strict'` keeps Mermaid's own sanitiser on:
 * the SVG it returns has no scripts or event handlers, which is what makes
 * inserting it as markup safe. It follows the light/dark theme and, if a
 * diagram fails to parse, shows its source instead of a blank box.
 */
export function MermaidDiagram({ chart }: { chart: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const { resolvedTheme } = useTheme()
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
        })
        const { svg: rendered } = await mermaid.render(id, chart)
        if (!cancelled) {
          setSvg(rendered)
          setFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [chart, id, resolvedTheme])

  if (failed) {
    return (
      <pre data-mermaid-fallback>
        <code>{chart}</code>
      </pre>
    )
  }
  if (!svg) {
    return (
      <div
        className="text-muted-foreground rounded-lg border p-6 text-center text-sm"
        role="status"
      >
        Drawing diagram…
      </div>
    )
  }
  return (
    <div
      className="docs-diagram overflow-x-auto rounded-lg border p-4"
      data-mermaid
      // Mermaid output with securityLevel 'strict' is sanitised SVG.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
