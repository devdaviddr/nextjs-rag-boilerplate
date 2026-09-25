'use client'

import { useRef, useState } from 'react'
import { Info } from 'lucide-react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * An ⓘ that explains the thing beside it (spec 0042 FR2). A toggletip, not a
 * tooltip: hover opens it with a mouse, focus with a keyboard, and a tap on
 * touch screens, where hover does not exist. The design follows Origin UI's
 * "Tooltip with title and icon" (21st.dev, MIT).
 */
export function InfoTip({
  title,
  children,
  label,
  className,
}: {
  title: string
  children: React.ReactNode
  /** Accessible name; defaults to "About <title>". */
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  // A mouse leaving closes it, unless a click pinned it open.
  const pinned = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hoverOpen = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const hoverClose = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || pinned.current) return
    closeTimer.current = setTimeout(() => setOpen(false), 120)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) pinned.current = false
        setOpen(next)
      }}
    >
      <PopoverTrigger
        type="button"
        aria-label={label ?? `About ${title}`}
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
        onClick={(e) => {
          // Radix toggles on click; a click after a hover-open pins it
          // instead of closing it.
          if (open && !pinned.current) {
            e.preventDefault()
            pinned.current = true
          } else {
            pinned.current = !open
          }
        }}
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle outline-none focus-visible:ring-[3px]',
          className,
        )}
      >
        <Info className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] space-y-1.5 text-sm"
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <p className="flex items-center gap-1.5 font-medium">
          <Info className="size-3.5 opacity-60" aria-hidden />
          {title}
        </p>
        <div className="text-muted-foreground space-y-1.5 leading-relaxed">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  )
}
