'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

/** What the picker knows about a connection's model list. */
export type ModelList =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; models: string[] }
  | { status: 'error'; error: string }

/** Enough to scroll through; typing narrows the rest. */
const MAX_SHOWN = 200

function matches(model: string, terms: string[]): boolean {
  const lower = model.toLowerCase()
  return terms.every((t) => lower.includes(t))
}

/**
 * A model name with the connection's `/models` list as a dropdown (spec 0040
 * FR2). Opening it shows the whole list; typing narrows it, and any name can
 * still be typed, since not every server lists every model it serves.
 */
export function ModelPicker({
  id,
  value,
  onChange,
  list,
  onOpen,
  disabled,
}: {
  id: string
  value: string
  onChange: (model: string) => void
  list: ModelList
  /** Called when the dropdown opens, to load the list the first time. */
  onOpen: () => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  // Empty until the admin types: opening shows everything, not just the
  // entry that matches the current name.
  const [query, setQuery] = useState('')
  // Null until the admin moves: then the current model is the active one.
  const [chosen, setActive] = useState<number | null>(null)

  const models = useMemo(
    () => (list.status === 'ready' ? list.models : []),
    [list],
  )
  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return terms.length ? models.filter((m) => matches(m, terms)) : models
  }, [models, query])
  const shown = filtered.slice(0, MAX_SHOWN)
  const active = chosen ?? Math.max(0, shown.indexOf(value))

  // Opening (or the list arriving) brings the current model into view.
  const ready = list.status === 'ready'
  useEffect(() => {
    if (!open || !ready || query) return
    const at = shown.indexOf(value)
    if (at === -1) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${at}"]`)
      ?.scrollIntoView({ block: 'center' })
    // Only on open / arrival, not on every keystroke or hover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready])

  const show = () => {
    if (disabled) return
    if (!open) {
      setQuery('')
      setActive(null)
      onOpen()
    }
    setOpen(true)
  }

  const choose = (model: string) => {
    onChange(model)
    setOpen(false)
    setQuery('')
  }

  const move = (delta: number) => {
    if (!shown.length) return
    const next = (active + delta + shown.length) % shown.length
    setActive(next)
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) show()
      else move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      const pick = shown[active]
      if (pick) choose(pick)
      else setOpen(false)
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setOpen(false)
    }
  }

  const listId = `${id}-list`
  const listShowing = open && ready && models.length > 0

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false)
      }}
    >
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        // Expanded only while the list itself is showing (not the loading
        // or error note), and aria-controls only then: axe rejects both a
        // dangling id and an expanded combobox that controls nothing.
        aria-expanded={listShowing}
        aria-controls={listShowing ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          open && shown[active] ? `${listId}-${active}` : undefined
        }
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onFocus={show}
        onClick={show}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          onChange(e.target.value)
          setQuery(e.target.value)
          setActive(0)
          if (!open) show()
        }}
        className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border py-1 pr-9 pl-3 font-mono text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Show models"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) setOpen(false)
          else {
            inputRef.current?.focus()
            show()
          }
        }}
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center disabled:opacity-50"
      >
        <ChevronDown className="size-4" />
      </button>

      {open && (
        <div className="bg-popover text-popover-foreground absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border shadow-md">
          {list.status === 'error' ? (
            <p className="text-destructive px-3 py-2 text-sm">
              Could not list models: {list.error}. You can still type a name.
            </p>
          ) : list.status !== 'ready' ? (
            <p className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-sm">
              <Loader2 className="size-3.5 animate-spin" /> Loading models…
            </p>
          ) : models.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2 text-sm">
              This connection lists no models. Type the model name.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground border-b px-3 py-1.5 text-xs">
                {query
                  ? `${filtered.length} of ${models.length} models match`
                  : `${models.length} models`}
                {filtered.length > MAX_SHOWN &&
                  ` · showing ${MAX_SHOWN}, type to narrow`}
              </p>
              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label="Models"
                className="max-h-64 overflow-y-auto py-1"
              >
                {shown.length === 0 && (
                  <li className="text-muted-foreground px-3 py-1.5 text-sm">
                    None match. “{value}” will be used as typed.
                  </li>
                )}
                {shown.map((model, i) => (
                  <li
                    key={model}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(model)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-sm',
                      i === active && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <Check
                      className={cn(
                        'size-3.5 shrink-0',
                        model === value ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="truncate">{model}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
