import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/env', () => ({
  env: {
    AUTH_SECRET: 'auth-secret-for-tests',
    SETTINGS_ENCRYPTION_KEY: undefined,
  },
}))

import {
  decryptSecret,
  encryptSecret,
  secretHint,
} from '@/lib/ai-settings/crypto'

/** Saved API keys, encrypted at rest (spec 0040, Storage; NFR3). */
describe('encryptSecret / decryptSecret', () => {
  it('round-trips, and never stores the plaintext', () => {
    const stored = encryptSecret('sk-live-1234567890')
    expect(stored.startsWith('v1:')).toBe(true)
    expect(stored).not.toContain('sk-live')
    expect(decryptSecret(stored)).toBe('sk-live-1234567890')
  })

  it('uses a fresh IV, so the same key encrypts differently each time', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('cannot be read under another secret, or once tampered with', () => {
    const stored = encryptSecret('sk-live-1234567890')
    expect(decryptSecret(stored, 'a-different-secret')).toBeNull()
    const bytes = Buffer.from(stored.slice(3), 'base64')
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    expect(decryptSecret(`v1:${bytes.toString('base64')}`)).toBeNull()
    expect(decryptSecret('plain-text')).toBeNull()
  })
})

describe('secretHint', () => {
  it('shows the last four characters of a real key, nothing of a short one', () => {
    expect(secretHint('nvapi-abcdefgh1234')).toBe('1234')
    expect(secretHint('short')).toBeNull()
  })
})
