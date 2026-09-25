'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/utils'

// The Overview joins with the telemetry dashboard (spec 0042 FR10).
const TABS = [
  { href: '/observability/runs', label: 'Runs' },
  { href: '/observability/logs', label: 'Logs' },
]

export function ObservabilityTabs() {
  const pathname = usePathname()
  return (
    <nav aria-label="Observability sections" className="border-b">
      <ul className="-mb-px flex gap-4 overflow-x-auto">
        {TABS.map((tab) => {
          const active =
            pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-block border-b-2 px-1 pb-2 text-sm',
                  active
                    ? 'border-foreground text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground border-transparent',
                )}
              >
                {tab.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
