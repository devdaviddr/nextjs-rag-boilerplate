import { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getCurrentSession } from '@/lib/auth/session'
import {
  getAllUsersWithRoles,
  getAllRoles,
  type UserWithRoles,
} from '@/lib/auth/admin-actions'
import { getLinkedAccounts } from '@/lib/auth/account-actions'
import { getVapidPublicKey } from '@/lib/push'
import { listMyFiles } from '@/lib/storage/actions'
import { env } from '@/lib/env'
import { connectionFor, modelFor, refreshAiSettings } from '@/lib/ai-settings'
import {
  type AiSettingsView,
  getAiSettingsView,
} from '@/lib/ai-settings/actions'
import { SettingsClient } from './settings-client'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const session = await getCurrentSession()
  if (!session?.user) {
    redirect('/login')
  }

  const isAdmin = (session.user.roles ?? []).includes('admin')

  await refreshAiSettings()

  // Fetch data in parallel
  const [users, roles, files, linkedAccounts, ai] = await Promise.all([
    isAdmin ? getAllUsersWithRoles() : Promise.resolve([] as UserWithRoles[]),
    isAdmin
      ? getAllRoles()
      : Promise.resolve(
          [] as Array<{ id: string; name: string; description: string | null }>,
        ),
    listMyFiles(),
    getLinkedAccounts(),
    isAdmin
      ? getAiSettingsView().then((r) => (r.ok ? r.data : null))
      : Promise.resolve(null as AiSettingsView | null),
  ])

  // Ensure user properties are never undefined (they're required by auth)
  const sessionWithId = {
    ...session,
    user: {
      ...session.user,
      id: session.user.id ?? '',
      name: session.user.name ?? null,
      email: session.user.email ?? '',
      image: session.user.image ?? null,
      roles: session.user.roles ?? [],
    },
  }

  return (
    <SettingsClient
      session={sessionWithId}
      users={users ?? []}
      roles={roles ?? []}
      files={files ?? []}
      linkedAccounts={linkedAccounts}
      pushPublicKey={getVapidPublicKey()}
      isAdmin={isAdmin}
      buildVersion={env.APP_VERSION}
      buildSha={env.APP_GIT_SHA}
      ai={ai}
      // Everyone may see which model answers; never a URL or key (FR7).
      activeModel={{
        model: modelFor('chat'),
        provider: connectionFor('chat').name,
      }}
    />
  )
}
