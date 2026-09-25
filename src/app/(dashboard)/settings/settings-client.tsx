'use client'

import { useSyncExternalStore } from 'react'
import { Cpu, Info, type LucideIcon, Plug, User, Users } from 'lucide-react'

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

interface SectionDef {
  id: string
  title: string
  description: string
  icon: LucideIcon
}

/** The open section lives in the URL hash, so it can be linked and survives a reload. */
function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}
const hashSnapshot = () => window.location.hash.slice(1)
const serverHashSnapshot = () => ''

function openSection(id: string) {
  // pushState keeps Back working; it fires no hashchange, so send one.
  window.history.pushState(null, '', `#${id}`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

function Section({
  def,
  current,
  children,
}: {
  def: SectionDef
  current: string
  children: React.ReactNode
}) {
  return (
    <section
      id={def.id}
      aria-labelledby={`${def.id}-title`}
      hidden={current !== def.id}
      className="space-y-6"
    >
      <header className="border-b pb-4">
        <h2 id={`${def.id}-title`} className="text-xl font-semibold">
          {def.title}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{def.description}</p>
      </header>
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
  const sections: SectionDef[] = [
    {
      id: 'account',
      title: 'Account',
      description: 'Your profile, files, sign-in methods and notifications.',
      icon: User,
    },
    ...(ai
      ? [
          {
            id: 'ai-provider',
            title: 'AI provider',
            description:
              'The endpoints this app sends questions to. A provider receives the questions and the passages retrieved to answer them.',
            icon: Plug,
          },
          {
            id: 'models',
            title: 'Models',
            description:
              'The model each job uses, and the connection it runs on. A change applies to the next request.',
            icon: Cpu,
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            id: 'users',
            title: 'Users',
            description: 'Everyone with an account, and what they can do.',
            icon: Users,
          },
        ]
      : []),
    {
      id: 'about',
      title: 'About',
      description: 'What this instance is running.',
      icon: Info,
    },
  ]
  const byId = Object.fromEntries(sections.map((d) => [d.id, d]))
  const hash = useSyncExternalStore(
    subscribeHash,
    hashSnapshot,
    serverHashSnapshot,
  )
  const current = byId[hash] ? hash : 'account'
  const def = (id: string) => byId[id]!

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-10">
      <header className="mb-6 lg:mb-8">
        <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">
          Settings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your account{isAdmin ? ', and how this instance answers' : ''}.
        </p>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10">
        <nav
          aria-label="Settings sections"
          className="md:sticky md:top-6 md:self-start"
        >
          <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1 md:mx-0 md:flex-col md:overflow-visible md:pb-0">
            {sections.map(({ id, title, icon: Icon }) => (
              <li key={id} className="shrink-0">
                <a
                  href={`#${id}`}
                  aria-current={current === id ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    openSection(id)
                  }}
                  className={
                    current === id
                      ? 'bg-muted text-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm'
                  }
                >
                  <Icon className="size-4 shrink-0" />
                  {title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          <Section def={def('account')} current={current}>
            <CurrentUserCard user={session.user} allRoles={formattedRoles} />
            <FilesPanel initialFiles={files} />
            <ConnectedAccounts state={linkedAccounts} />
            {pushPublicKey && <NotificationsPanel publicKey={pushPublicKey} />}
          </Section>

          {/* Server-authoritative gates: the admin server actions also enforce them. */}
          {ai && (
            <>
              <Section def={def('ai-provider')} current={current}>
                <AiConnectionsCard connections={ai.connections} />
              </Section>
              <Section def={def('models')} current={current}>
                <AiModelsCard roles={ai.roles} connections={ai.connections} />
              </Section>
            </>
          )}

          {isAdmin && (
            <Section def={def('users')} current={current}>
              <AdminPanel
                initialUsers={users}
                allRoles={formattedRoles}
                currentUserId={session.user.id}
              />
            </Section>
          )}

          <Section def={def('about')} current={current}>
            <div className="bg-muted/40 rounded-lg border p-4 text-sm">
              <p className="text-muted-foreground">Answers are written by</p>
              <p className="mt-1">
                <span className="font-mono">{activeModel.model}</span>
                <span className="text-muted-foreground">
                  {' '}
                  via {activeModel.provider}
                </span>
              </p>
            </div>
            <BuildInfoCard version={buildVersion} sha={buildSha} />
          </Section>
        </div>
      </div>
    </div>
  )
}
