'use client'

import { CurrentUserCard } from '@/components/auth/current-user-card'
import { AdminPanel } from '@/components/auth/admin-panel'
import { ConnectedAccounts } from '@/components/auth/connected-accounts'
import { FilesPanel } from '@/components/files/files-panel'
import { NotificationsPanel } from '@/components/push/notifications-panel'
import { AiConnectionsCard } from '@/components/settings/ai-connections-card'
import { AiModelsCard } from '@/components/settings/ai-models-card'
import { BuildInfoCard } from '@/components/settings/build-info-card'
import type { AiSettingsView } from '@/lib/ai-settings/actions'
import type { LinkedAccountsState } from '@/lib/auth/account-actions'
import type { FileSummary } from '@/lib/storage/actions'

interface SettingsClientProps {
  session: {
    user: {
      id: string
      name: string | null
      email: string
      image: string | null | undefined
      roles: string[]
    }
  }
  users: Array<{
    id: string
    name: string | null
    email: string
    createdAt: Date
    roles: Array<{ id: string; name: string; description: string | null }>
    hasPassword: boolean
  }>
  roles: Array<{ id: string; name: string; description: string | null }>
  files: FileSummary[]
  linkedAccounts: LinkedAccountsState
  pushPublicKey: string | null
  isAdmin: boolean
  buildVersion?: string
  buildSha?: string
  /** The AI sections; null for non-admins. */
  ai: AiSettingsView | null
  activeModel: { model: string; provider: string }
}

function Section({
  id,
  title,
  children,
  titleHidden = false,
}: {
  id: string
  title: string
  children: React.ReactNode
  /** For a section whose one card already carries the same title. */
  titleHidden?: boolean
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-6 space-y-4"
    >
      <h2
        id={`${id}-title`}
        className={titleHidden ? 'sr-only' : 'text-lg font-semibold'}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

export function SettingsClient({
  session,
  users,
  roles,
  files,
  linkedAccounts,
  pushPublicKey,
  isAdmin,
  buildVersion,
  buildSha,
  ai,
  activeModel,
}: SettingsClientProps) {
  const formattedRoles = roles.map((r) => ({ id: r.id, name: r.name }))
  // Spec 0040 FR8. Retrieval & answering joins with #57.
  const sections = [
    { id: 'account', title: 'Account' },
    ...(ai
      ? [
          { id: 'ai-provider', title: 'AI provider' },
          { id: 'models', title: 'Models' },
        ]
      : []),
    ...(isAdmin ? [{ id: 'users', title: 'Users' }] : []),
    { id: 'about', title: 'About' },
  ]

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <nav
        aria-label="Settings sections"
        className="-mt-2 flex flex-wrap gap-1"
      >
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-2.5 py-1 text-sm"
          >
            {s.title}
          </a>
        ))}
      </nav>

      <Section id="account" title="Account">
        <CurrentUserCard user={session.user} allRoles={formattedRoles} />
        <FilesPanel initialFiles={files} />
        <ConnectedAccounts state={linkedAccounts} />
        {pushPublicKey && <NotificationsPanel publicKey={pushPublicKey} />}
      </Section>

      {/* Server-authoritative gates: the admin server actions also enforce them. */}
      {ai && (
        <>
          <Section id="ai-provider" title="AI provider" titleHidden>
            <AiConnectionsCard connections={ai.connections} />
          </Section>
          <Section id="models" title="Models" titleHidden>
            <AiModelsCard roles={ai.roles} connections={ai.connections} />
          </Section>
        </>
      )}

      {isAdmin && (
        <Section id="users" title="Users">
          <AdminPanel
            initialUsers={users}
            allRoles={formattedRoles}
            currentUserId={session.user.id}
          />
        </Section>
      )}

      <Section id="about" title="About">
        <p className="text-muted-foreground text-sm">
          Answers are written by{' '}
          <span className="text-foreground font-mono">{activeModel.model}</span>{' '}
          via {activeModel.provider}.
        </p>
        <BuildInfoCard version={buildVersion} sha={buildSha} />
      </Section>
    </div>
  )
}
