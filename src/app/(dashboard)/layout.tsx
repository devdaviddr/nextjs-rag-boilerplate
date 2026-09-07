import { redirect } from 'next/navigation'
import { SessionProvider } from 'next-auth/react'

import { AppShell } from '@/components/shell/app-shell'
import { VerificationBanner } from '@/components/auth/verification-banner'
import { getCurrentSession } from '@/lib/auth/session'
import { listConversations } from '@/lib/chat/actions'
import {
  isCurrentUserVerified,
  isEmailVerificationEnforced,
} from '@/lib/auth/verification-guard'

// Wraps all protected pages in the app shell. Also enforces auth at the layout
// level (defense in depth on top of the edge proxy). The SessionProvider is
// hydrated with the server session so client role hooks (useRole/RequireRole)
// work reliably here without a client-side fetch.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getCurrentSession()
  if (!session?.user) {
    redirect('/login')
  }

  // Soft gate: show the verify-email banner when enforced and unverified.
  const showVerificationBanner =
    isEmailVerificationEnforced() && !(await isCurrentUserVerified())

  // Recents are server-rendered on navigation rather than fetched client-side,
  // so the sidebar is correct on first paint (spec 0026 NFR6).
  const conversations = await listConversations()

  return (
    <SessionProvider session={session}>
      <AppShell
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        }}
        conversations={conversations}
      >
        {showVerificationBanner && <VerificationBanner />}
        {children}
      </AppShell>
    </SessionProvider>
  )
}
