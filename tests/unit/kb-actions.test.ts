import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the vi.mock factory below can reference it.
const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: {
      knowledgeBases: { findFirst: vi.fn() },
    },
    update: vi.fn(),
  },
}))

const mockGetSession = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  getCurrentSession: () => mockGetSession(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/storage/client', () => ({ deleteObject: vi.fn() }))

vi.mock('@/db', () => ({ db: dbMock }))

import { renameKnowledgeBase } from '@/lib/rag/kb-actions'

// --- fixtures ---------------------------------------------------------------

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const KB_ID = 'kb-1'

/** The single error text used for both "missing" and "not yours" — see below. */
const NOT_FOUND = 'Knowledge base not found.'

/** `db.update(table).set(...).where(...)`, with the calls exposed. */
function updateChain() {
  const where = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where })
  return { chain: { set }, set, where }
}

let update: ReturnType<typeof updateChain>

beforeEach(() => {
  mockGetSession.mockReset().mockResolvedValue({ user: { id: OWNER_ID } })
  dbMock.query.knowledgeBases.findFirst.mockReset()
  update = updateChain()
  dbMock.update.mockReset().mockReturnValue(update.chain)
})

/** The KB row `ownedKnowledgeBaseId` looks up, owned by `ownerId`. */
function kbOwnedBy(ownerId: string) {
  dbMock.query.knowledgeBases.findFirst.mockResolvedValue({
    id: KB_ID,
    ownerId,
  })
}

describe('renameKnowledgeBase', () => {
  it('writes the new name to the caller’s own knowledge base', async () => {
    kbOwnedBy(OWNER_ID)

    const result = await renameKnowledgeBase(KB_ID, 'Employee Handbook')

    expect(result).toEqual({ ok: true, data: null })
    expect(update.set).toHaveBeenCalledWith({ name: 'Employee Handbook' })
    expect(update.where).toHaveBeenCalledTimes(1)
  })

  it('trims and collapses whitespace before storing the name', async () => {
    kbOwnedBy(OWNER_ID)

    await renameKnowledgeBase(KB_ID, '  Employee   Handbook \n')

    expect(update.set).toHaveBeenCalledWith({ name: 'Employee Handbook' })
  })

  it('accepts a name of exactly the maximum length', async () => {
    kbOwnedBy(OWNER_ID)
    const name = 'a'.repeat(80)

    const result = await renameKnowledgeBase(KB_ID, name)

    expect(result.ok).toBe(true)
    expect(update.set).toHaveBeenCalledWith({ name })
  })

  describe('rejects a name that is not usable, without writing', () => {
    it.each([
      ['empty', ''],
      ['whitespace only', '   \n\t '],
      ['one character too long', 'a'.repeat(81)],
      ['not a string', undefined as unknown as string],
    ])('%s', async (_label, name) => {
      kbOwnedBy(OWNER_ID)

      const result = await renameKnowledgeBase(KB_ID, name)

      expect(result.ok).toBe(false)
      expect(dbMock.update).not.toHaveBeenCalled()
    })
  })

  describe('ownership', () => {
    it('will not rename a knowledge base belonging to someone else', async () => {
      kbOwnedBy(OTHER_ID)

      const result = await renameKnowledgeBase(KB_ID, 'Mine now')

      expect(result).toEqual({ ok: false, error: NOT_FOUND })
      expect(dbMock.update).not.toHaveBeenCalled()
    })

    it('gives a knowledge base that does not exist the same answer', async () => {
      dbMock.query.knowledgeBases.findFirst.mockResolvedValue(undefined)

      const result = await renameKnowledgeBase('kb-missing', 'Anything')

      expect(result).toEqual({ ok: false, error: NOT_FOUND })
      expect(dbMock.update).not.toHaveBeenCalled()
    })

    /**
     * The reason ownership is resolved BEFORE the name is validated, and the
     * reason this test exists: if the order were flipped, a caller probing
     * someone else's knowledge base id with a deliberately invalid name would
     * get the validation error back for a row that exists and the not-found
     * error for one that doesn't — turning the rename action into an oracle
     * for which ids are real. Both paths must answer identically.
     */
    it('does not leak existence through the error when the name is also invalid', async () => {
      kbOwnedBy(OTHER_ID)
      const existsButNotMine = await renameKnowledgeBase(KB_ID, '')

      dbMock.query.knowledgeBases.findFirst.mockResolvedValue(undefined)
      const doesNotExist = await renameKnowledgeBase('kb-missing', '')

      expect(existsButNotMine).toEqual({ ok: false, error: NOT_FOUND })
      expect(existsButNotMine).toEqual(doesNotExist)
      expect(dbMock.update).not.toHaveBeenCalled()
    })
  })

  it('refuses when nobody is signed in', async () => {
    mockGetSession.mockResolvedValue(null)

    await expect(renameKnowledgeBase(KB_ID, 'Handbook')).rejects.toThrow(
      /signed in/i,
    )
    expect(dbMock.update).not.toHaveBeenCalled()
  })
})
