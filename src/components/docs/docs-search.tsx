'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CornerDownLeft, FileText, Hash, Search } from 'lucide-react'

import {
  type SearchEntry,
  highlight,
  searchDocs,
  searchTerms,
} from '@/lib/docs/search'
import { cn } from '@/lib/utils'

type IndexState =
  | { status: 'idle' | 'loading' | 'error' }
  | { status: 'ready'; entries: SearchEntry[] }

/** True when a keypress belongs to something the user is typing into. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
}

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((part, i) =>
        part.match ? (
          <mark
            key={i}
            className="rounded-sm bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200"
          >
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  )
}

/**
 * Search box on the docs index (spec 0041 FR7). The index is fetched the
 * first time the box is focused, then every keystroke is searched in the
 * browser. `/` focuses it from anywhere on the page; arrows, Enter and Escape
 * work the list.
 */
export function DocsSearch() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [index, setIndex] = useState<IndexState>({ status: 'idle' })
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const load = useCallback(() => {
    if (index.status === 'loading' || index.status === 'ready') return
    setIndex({ status: 'loading' })
    fetch('/docs/search-index')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<{ entries: SearchEntry[] }>
      })
      .then(({ entries }) => setIndex({ status: 'ready', entries }))
      .catch(() => setIndex({ status: 'error' }))
  }, [index.status])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (typingInto(e.target)) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const terms = useMemo(() => searchTerms(query), [query])
  const results = useMemo(
    () => (index.status === 'ready' ? searchDocs(index.entries, query) : []),
    [index, query],
  )
  const showList = open && terms.length > 0
  const listShowing = showList && index.status === 'ready' && results.length > 0

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (query) setQuery('')
      else inputRef.current?.blur()
      return
    }
    if (!showList || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = results[active]
      if (hit) {
        setOpen(false)
        router.push(hit.href)
      }
    }
  }

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
    >
      <Search
        aria-hidden
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2"
      />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search the docs"
        // Expanded, and controlling the list, only while the list shows.
        aria-expanded={listShowing}
        aria-controls={listShowing ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          listShowing && results[active] ? `${listId}-${active}` : undefined
        }
        placeholder="Search the docs"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => {
          load()
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        className="bg-background placeholder:text-muted-foreground h-14 w-full rounded-2xl border pr-14 pl-12 text-base shadow-sm transition-shadow outline-none focus:border-orange-400 focus:ring-4 focus:ring-orange-500/15 dark:focus:border-orange-500 [&::-webkit-search-cancel-button]:hidden"
      />
      <kbd
        aria-hidden
        className="text-muted-foreground bg-muted pointer-events-none absolute top-1/2 right-4 hidden size-7 -translate-y-1/2 items-center justify-center rounded-md border font-mono text-sm sm:flex"
      >
        /
      </kbd>

      {showList && (
        <div className="bg-popover text-popover-foreground absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border shadow-lg">
          {index.status !== 'ready' ? (
            <p className="text-muted-foreground px-4 py-6 text-center text-sm">
              {index.status === 'error'
                ? 'Search is unavailable right now. Try reloading the page.'
                : 'Loading the docs…'}
            </p>
          ) : results.length === 0 ? (
            <p className="text-muted-foreground px-4 py-6 text-center text-sm">
              Nothing in the docs matches “{query.trim()}”.
            </p>
          ) : (
            <ul
              id={listId}
              role="listbox"
              aria-label="Search results"
              className="max-h-[min(28rem,60vh)] overflow-y-auto p-2"
            >
              {results.map((r, i) => (
                <li
                  key={r.href}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-labelledby={`${listId}-${i}-name`}
                  aria-describedby={`${listId}-${i}-where`}
                >
                  <Link
                    href={r.href}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'flex gap-3 rounded-xl px-3 py-2.5',
                      i === active && 'bg-orange-50 dark:bg-orange-500/10',
                    )}
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300">
                      {r.entry.id ? (
                        <Hash className="size-4" />
                      ) : (
                        <FileText className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        id={`${listId}-${i}-where`}
                        className="text-muted-foreground block truncate text-xs"
                      >
                        {r.entry.section} · {r.entry.title}
                      </span>
                      <span
                        id={`${listId}-${i}-name`}
                        className="block truncate font-medium"
                      >
                        <Highlighted
                          text={r.entry.heading || r.entry.title}
                          terms={terms}
                        />
                      </span>
                      {r.snippet && (
                        <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-sm">
                          <Highlighted text={r.snippet} terms={terms} />
                        </span>
                      )}
                    </span>
                    {i === active && (
                      <CornerDownLeft
                        aria-hidden
                        className="text-muted-foreground mt-1 size-4 shrink-0"
                      />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
