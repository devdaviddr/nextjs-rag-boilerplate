'use client'

import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

interface TocItem {
  id: string
  text: string
  depth: number
}

/** How far below the top of the viewport a heading counts as "being read". */
const READING_LINE = 120

/**
 * "On this page" for a doc (spec 0041 FR2), marking the section being read.
 * The app shell scrolls an inner element, not the window, so scroll events
 * are caught in the capture phase from wherever they come.
 */
export function DocToc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? '')

  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      let current = items[0]?.id ?? ''
      for (const item of items) {
        const el = document.getElementById(item.id)
        if (el && el.getBoundingClientRect().top <= READING_LINE) {
          current = item.id
        } else if (el) break
      }
      setActive(current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      if (frame) cancelAnimationFrame(frame)
    }
  }, [items])

  return (
    <aside className="hidden w-60 shrink-0 lg:block" aria-label="On this page">
      <div className="bg-muted/50 sticky top-8 max-h-[calc(100vh-4rem)] overflow-y-auto rounded-2xl p-4 text-sm">
        <p className="text-muted-foreground mb-3 px-2 text-xs font-semibold tracking-wider uppercase">
          On this page
        </p>
        <ul className="space-y-0.5">
          {items.map((h) => (
            <li key={h.id} className={h.depth === 3 ? 'pl-3' : undefined}>
              <a
                href={`#${h.id}`}
                onClick={() => setActive(h.id)}
                aria-current={active === h.id ? 'location' : undefined}
                className={cn(
                  'line-clamp-2 rounded-lg px-2 py-1.5 transition-colors',
                  active === h.id
                    ? 'bg-orange-100 font-medium text-orange-700 dark:bg-orange-500/15 dark:text-orange-300'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
