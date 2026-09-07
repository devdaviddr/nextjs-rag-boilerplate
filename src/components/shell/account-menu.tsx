'use client'

import Link from 'next/link'
import { LogOut, Settings } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { signOutAction } from '@/lib/auth/actions'

/**
 * Account controls, pinned to the bottom of the sidebar.
 *
 * Settings and sign-out used to sit in a top bar. They live here now because
 * the top of the app belongs to the conversation, not to chrome.
 */
export function AccountMenu({
  user,
  initials,
}: {
  user: { name?: string | null; email?: string | null; image?: string | null }
  initials: string
}) {
  return (
    <div className="flex items-center gap-2 px-1 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5"
            aria-label="Account menu"
          >
            <Avatar className="size-7 shrink-0">
              {user.image && (
                <AvatarImage src={user.image} alt={user.name ?? ''} />
              )}
              <AvatarFallback
                delayMs={user.image ? 500 : 0}
                className="text-xs"
              >
                {initials}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 truncate text-sm font-normal">
              {user.email}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings className="mr-2 size-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* The server action, not `signOut()` from next-auth/react: it
              redirects to /login, which is what the old topbar button did.
              Invoked directly rather than through a nested <form>, because
              Radix closes the menu on select before a form inside it can
              submit. */}
          <DropdownMenuItem onSelect={() => void signOutAction()}>
            <LogOut className="mr-2 size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ThemeToggle />
    </div>
  )
}
