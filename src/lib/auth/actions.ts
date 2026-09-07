'use server'

import { eq } from 'drizzle-orm'
import { AuthError } from 'next-auth'
import { headers } from 'next/headers'

import { db } from '@/db'
import { users } from '@/db/schema'
import { signIn, signOut } from '@/lib/auth'
import { sendVerificationEmail } from '@/lib/auth/email-verification'
import type { AuthFormState } from '@/lib/auth/form-state'
import { hashPassword } from '@/lib/auth/password'
import { verifyInviteToken } from '@/lib/auth/invite'
import { notifyRole } from '@/lib/push'
import { logger } from '@/lib/logger'
import { AUTH_LIMITS, rateLimit } from '@/lib/rate-limit'
import { clientIpFromHeaders } from '@/lib/request-ip'
import { loginSchema, registerSchema } from '@/lib/validations/auth'
import { HOME_PATH } from '@/lib/brand'

/**
 * `signIn` with a `redirectTo` succeeds by throwing a Next.js redirect. We must
 * re-throw those (identified by the NEXT_REDIRECT digest) rather than swallow
 * them as auth failures.
 */
function isNextRedirect(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  )
}

/** Postgres unique-violation SQLSTATE (surfaced by postgres-js as `.code`). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  )
}

function collectFieldErrors(
  issues: { path: PropertyKey[]; message: string }[],
): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {}
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '_form')
    ;(fieldErrors[key] ??= []).push(issue.message)
  }
  return fieldErrors
}

/** Best-effort client IP from proxy headers (falls back to a shared bucket). */
async function clientIp(): Promise<string> {
  return clientIpFromHeaders(await headers())
}

const TOO_MANY = 'Too many attempts. Please wait a few minutes and try again.'

/**
 * Register a new credentials user, then sign them in. On success this throws a
 * redirect (handled by Next.js) to the chat; on failure it returns a
 * form state describing what went wrong.
 *
 * Also handles "claiming" an admin-created account (user exists but has no password).
 */
export async function registerAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = registerSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      status: 'error',
      fieldErrors: collectFieldErrors(parsed.error.issues),
    }
  }

  const ip = await clientIp()
  const limit = rateLimit(
    `register:${ip}`,
    AUTH_LIMITS.register.limit,
    AUTH_LIMITS.register.windowMs,
  )
  if (!limit.success) {
    logger.warn('Registration rate limit exceeded', { ip })
    return { status: 'error', message: TOO_MANY }
  }

  const { name, email, password } = parsed.data
  const invite = String(formData.get('invite') ?? '')

  // Check if user exists
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: {
      id: true,
      hashedPassword: true,
      inviteTokenHash: true,
      inviteExpires: true,
    },
  })

  if (existing) {
    // An admin-created (passwordless) account can ONLY be claimed with the valid
    // invite token issued to it — knowing the email alone is not enough.
    const canClaim =
      !existing.hashedPassword &&
      verifyInviteToken(
        invite,
        existing.inviteTokenHash,
        existing.inviteExpires,
      )

    if (canClaim) {
      const hashedPassword = await hashPassword(password)
      await db
        .update(users)
        .set({
          hashedPassword,
          name: name || null,
          inviteTokenHash: null, // single-use — consume the invite
          inviteExpires: null,
        })
        .where(eq(users.id, existing.id))

      try {
        await signIn('credentials', {
          email,
          password,
          redirectTo: HOME_PATH,
        })
      } catch (error) {
        if (isNextRedirect(error)) throw error
        return {
          status: 'error',
          message: 'Account claimed, but sign-in failed. Please log in.',
        }
      }
      return { status: 'idle' }
    }

    // Existing account (or a claim without a valid invite): generic message so
    // we don't reveal whether an account is claimable.
    return {
      status: 'error',
      message: 'An account with this email already exists.',
    }
  }

  // Normal flow - create new user
  const hashedPassword = await hashPassword(password)

  // The unique index is the source of truth — catch the race where two
  // concurrent signups both pass the check above.
  try {
    await db.insert(users).values({ name, email, hashedPassword })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        status: 'error',
        message: 'An account with this email already exists.',
      }
    }
    logger.error('Registration insert failed', { error: String(error) })
    return { status: 'error', message: 'Could not create your account.' }
  }

  // Kick off email verification (no-op when email is disabled). A send failure
  // is swallowed inside sendVerificationEmail so it never blocks sign-in.
  await sendVerificationEmail(email)

  // Worked example of Web Push (no-op when VAPID isn't configured): tell admins
  // a new user just registered. Best-effort — never blocks registration.
  await notifyRole('admin', {
    title: 'New user registered',
    body: `${name || email} just created an account.`,
    url: '/settings',
  })

  try {
    await signIn('credentials', { email, password, redirectTo: HOME_PATH })
  } catch (error) {
    if (isNextRedirect(error)) throw error
    // Account was created but auto-login failed — send them to log in manually.
    return {
      status: 'error',
      message: 'Account created, but sign-in failed. Please log in.',
    }
  }
  return { status: 'idle' }
}

/** Sign the current user out and redirect to the login page. */
export async function signOutAction() {
  await signOut({ redirectTo: '/login' })
}

/**
 * Start an OAuth sign-in. Driven from the login page's provider buttons via a
 * hidden `provider` field. `signIn` completes by throwing a redirect (to the
 * provider, then back to `/chat`), so there's nothing to return.
 */
export async function oauthSignInAction(formData: FormData) {
  const provider = String(formData.get('provider'))
  if (provider !== 'github' && provider !== 'google') return
  await signIn(provider, { redirectTo: HOME_PATH })
}

/** Authenticate an existing user with email + password. */
export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      status: 'error',
      fieldErrors: collectFieldErrors(parsed.error.issues),
    }
  }

  const { email, password } = parsed.data

  const ip = await clientIp()
  // Per-account bucket + global per-IP bucket (credential stuffing) — see
  // rate-limit.ts. Keyed `login-*`, independent of authorize's `authz-*`.
  const limit = rateLimit(
    `login:${ip}:${email}`,
    AUTH_LIMITS.login.limit,
    AUTH_LIMITS.login.windowMs,
  )
  const ipLimit = rateLimit(
    `login-ip:${ip}`,
    AUTH_LIMITS.loginPerIp.limit,
    AUTH_LIMITS.loginPerIp.windowMs,
  )
  if (!limit.success || !ipLimit.success) {
    logger.warn('Login rate limit exceeded', { ip, email })
    return { status: 'error', message: TOO_MANY }
  }

  try {
    await signIn('credentials', { email, password, redirectTo: HOME_PATH })
  } catch (error) {
    if (isNextRedirect(error)) throw error
    if (error instanceof AuthError) {
      return { status: 'error', message: 'Invalid email or password.' }
    }
    throw error
  }
  return { status: 'idle' }
}
