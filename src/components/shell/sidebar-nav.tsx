'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { useRole } from '@/lib/auth/client-rbac'
import { navItems } from '@/lib/shell/nav'
import { cn } from '@/lib/utils'

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const isAdmin = useRole().includes('admin')

  return (
    <nav className="flex flex-col gap-1">
      {navItems
        .filter((item) => !item.adminOnly || isAdmin)
        .map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              <Icon className="size-4" />
              {item.title}
            </Link>
          )
        })}
    </nav>
  )
}
