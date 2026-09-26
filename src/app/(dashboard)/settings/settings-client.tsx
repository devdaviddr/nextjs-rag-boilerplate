'use client'

import { useSyncExternalStore } from 'react'
import {
  Info,
  type LucideIcon,
  SlidersHorizontal,
  User,
  Users,
} from 'lucide-react'

import { CurrentUserCard } from '@/components/auth/current-user-card'
import { AdminPanel } from '@/components/auth/admin-panel'
import { ConnectedAccounts } from '@/components/auth/connected-accounts'
import { FilesPanel } from '@/components/files/files-panel'
import { NotificationsPanel } from '@/components/push/notifications-panel'
import { AiChangesCard } from '@/components/settings/ai-changes-card'
import { AiConnectionsCard } from '@/components/settings/ai-connections-card'
import { AiModelsCard } from '@/components/settings/ai-models-card'
import { AiRetrievalCard } from '@/components/settings/ai-retrieval-card'
import { BuildInfoCard } from '@/components/settings/build-info-card'
import type { AiSettingsView } from '@/lib/ai-settings/actions'
import { InfoTip } from '@/components/ui/info-tip'
import { FIELD_HELP } from '@/components/settings/ai-role-labels'
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

/** Tabs that were merged into Configuration (spec 0042 FR1). */
const LEGACY_HASHES: Record<string, string> = {
  'ai-provider': 'configuration',
  models: 'configuration',
}

/** The pane that scrolls; a new section starts at its top. */
const OUTLET_ID = 'settings-outlet'

function openSection(id: string) {
  // pushState keeps Back working; it fires no hashchange, so send one.
  window.history.pushState(null, '', `#${id}`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  document.getElementById(OUTLET_ID)?.scrollTo({ top: 0 })
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
  // Spec 0040 FR8.
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
            id: 'configuration',
            title: 'Configuration',
            description:
              'Which AI providers this app can use, which model does each job, and how search and answering behave. A change applies to the next request.',
            icon: SlidersHorizontal,
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
  // Links from before the two AI tabs were merged still land in the right place.
  const target = LEGACY_HASHES[hash] ?? hash
  const current = byId[target] ? target : 'account'
  const def = (id: string) => byId[id]!

  return (
    // Fills the shell's <main> and scrolls only the section pane: the title
    // and the tabs stay put.
    <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-4 pt-6 sm:px-6 lg:pt-10">
      <header className="mb-6 shrink-0 lg:mb-8">
        <h1 className="text-2xl font-semibold tracking-tight lg:text-3xl">
          Settings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your account{isAdmin ? ', and how this instance answers' : ''}.
        </p>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-6 md:grid-cols-[12rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] lg:gap-10">
        <nav aria-label="Settings sections" className="md:self-start">
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

        <div
          id={OUTLET_ID}
          // px/-mx keep focus rings inside the scroll box; pb leaves room
          // below the last card.
          className="-mx-1 min-h-0 min-w-0 overflow-y-auto px-1 pb-10 md:pr-3"
        >
          <Section def={def('account')} current={current}>
            <CurrentUserCard user={session.user} allRoles={formattedRoles} />
            <FilesPanel initialFiles={files} />
            <ConnectedAccounts state={linkedAccounts} />
            {pushPublicKey && <NotificationsPanel publicKey={pushPublicKey} />}
          </Section>

          {/* Server-authoritative gates: the admin server actions also enforce them. */}
          {ai && (
            <>
              <Section def={def('configuration')} current={current}>
                {ai.locked && (
                  <p
                    role="note"
                    className="bg-muted/40 rounded-lg border p-4 text-sm"
                  >
                    These settings are locked on this deployment (
                    <code>AI_SETTINGS_LOCKED</code>). They can be viewed and
                    tested here, and changed only in <code>.env</code>.
                  </p>
                )}
                <div id="providers" className="space-y-4">
                  <h3 className="flex items-center gap-1.5 font-semibold">
                    Providers
                    <InfoTip title={FIELD_HELP.providers.title}>
                      {FIELD_HELP.providers.details.map((d) => (
                        <p key={d}>{d}</p>
                      ))}
                    </InfoTip>
                  </h3>
                  <AiConnectionsCard
                    connections={ai.connections}
                    locked={ai.locked}
                  />
                </div>
                <div id="models" className="space-y-4 border-t pt-6">
                  <h3 className="font-semibold">Models</h3>
                  <AiModelsCard
                    roles={ai.roles}
                    connections={ai.connections}
                    reindex={ai.reindex}
                    locked={ai.locked}
                  />
                </div>
                <div id="retrieval" className="space-y-4 border-t pt-6">
                  <h3 className="font-semibold">Retrieval &amp; answering</h3>
                  <AiRetrievalCard fields={ai.retrieval} locked={ai.locked} />
                </div>
                <div id="changes" className="space-y-4 border-t pt-6">
                  <h3 className="font-semibold">Recent changes</h3>
                  <AiChangesCard changes={ai.recentChanges} />
                </div>
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
