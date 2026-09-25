import 'server-only'

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

import { env } from '@/lib/env'

/**
 * Encryption for API keys saved from Settings (spec 0040, Storage):
 * AES-256-GCM under a key derived with HKDF-SHA256 from
 * `SETTINGS_ENCRYPTION_KEY`, or from `AUTH_SECRET` when that is unset.
 *
 * Stored as `v1:<base64 of iv | tag | ciphertext>`. The version prefix leaves
 * room to change the scheme without guessing what an old value is.
 */

const VERSION = 'v1'
const INFO = 'ai-settings/v1'
const SALT = 'nextjs-rag-boilerplate/ai-settings'

function key(secret = env.SETTINGS_ENCRYPTION_KEY ?? env.AUTH_SECRET): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, SALT, INFO, 32))
}

export function encryptSecret(plaintext: string, secret?: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const packed = Buffer.concat([iv, cipher.getAuthTag(), body])
  return `${VERSION}:${packed.toString('base64')}`
}

/**
 * The plaintext, or null when it cannot be read — the secret it was
 * encrypted under has changed, or the value is not ours.
 */
export function decryptSecret(stored: string, secret?: string): string | null {
  const [version, data] = stored.split(':', 2)
  if (version !== VERSION || !data) return null
  try {
    const packed = Buffer.from(data, 'base64')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(secret),
      packed.subarray(0, 12),
    )
    decipher.setAuthTag(packed.subarray(12, 28))
    return Buffer.concat([
      decipher.update(packed.subarray(28)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

/** The last four characters, for `••••1a2b`. Nothing for a short key. */
export function secretHint(plaintext: string): string | null {
  return plaintext.length >= 12 ? plaintext.slice(-4) : null
}
