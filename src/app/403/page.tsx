import type { Metadata } from 'next'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { HOME_PATH } from '@/lib/brand'

export const metadata: Metadata = { title: 'Forbidden' }

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
      <ShieldAlert className="text-muted-foreground size-10" />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">403 — Forbidden</h1>
        <p className="text-muted-foreground max-w-sm">
          You don&apos;t have permission to access this page.
        </p>
      </div>
      <Button asChild>
        <Link href={HOME_PATH}>Back to chat</Link>
      </Button>
    </main>
  )
}
