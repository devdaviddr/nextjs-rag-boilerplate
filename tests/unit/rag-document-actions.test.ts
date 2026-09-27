import { beforeEach, describe, expect, it, vi } from 'vitest'

// Cross-user isolation for the document actions (#131). Each action must
// answer someone else's id exactly as it answers a missing one, and must not
// write, delete or start ingestion before that check.

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: {
      knowledgeBases: { findFirst: vi.fn() },
      documents: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}))

const mockGetSession = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  getCurrentSession: () => mockGetSession(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/ai-settings', () => ({
  aiSettings: () => ({}),
  refreshAiSettings: vi.fn(),
}))
vi.mock('@/lib/rag/client', () => ({ isRagConfigured: () => true }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

const mockAfter = vi.fn()
vi.mock('next/server', () => ({ after: (fn: unknown) => mockAfter(fn) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

const mockDeleteObject = vi.fn()
const mockPutObject = vi.fn()
vi.mock('@/lib/storage/client', () => ({
  deleteObject: (...a: unknown[]) => mockDeleteObject(...a),
  putObject: (...a: unknown[]) => mockPutObject(...a),
}))
vi.mock('@/lib/rag/ingest', () => ({ ingestDocument: vi.fn() }))
vi.mock('@/db', () => ({ db: dbMock }))
vi.mock('@/lib/env', () => ({
  env: {
    UPLOAD_MAX_SIZE_MB: 25,
    MAX_STORAGE_PER_USER_MB: 500,
    UPLOAD_ALLOWED_MIME_TYPES: 'application/pdf',
  },
}))

import {
  deleteDocument,
  retryDocument,
  uploadDocument,
} from '@/lib/rag/actions'
import { moveDocument } from '@/lib/rag/kb-actions'

const ME = 'user-me'
const THEM = 'user-them'

const theirDocument = {
  id: 'doc-theirs',
  ownerId: THEM,
  fileId: 'file-theirs',
  status: 'failed',
}
const myDocument = { ...theirDocument, id: 'doc-mine', ownerId: ME }

function pdfForm(knowledgeBaseId: string) {
  const form = new FormData()
  form.set('file', new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' }))
  form.set('knowledgeBaseId', knowledgeBaseId)
  return form
}

/** Nothing was written, deleted, stored or queued. */
function expectNoSideEffects() {
  expect(dbMock.insert).not.toHaveBeenCalled()
  expect(dbMock.update).not.toHaveBeenCalled()
  expect(dbMock.delete).not.toHaveBeenCalled()
  expect(dbMock.transaction).not.toHaveBeenCalled()
  expect(mockPutObject).not.toHaveBeenCalled()
  expect(mockDeleteObject).not.toHaveBeenCalled()
  expect(mockAfter).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSession.mockResolvedValue({ user: { id: ME } })
  dbMock.query.knowledgeBases.findFirst.mockResolvedValue(undefined)
  dbMock.query.documents.findFirst.mockResolvedValue(undefined)
})

describe('uploadDocument', () => {
  it("rejects someone else's knowledge base as if it did not exist", async () => {
    dbMock.query.knowledgeBases.findFirst.mockResolvedValueOnce({
      id: 'kb-theirs',
      ownerId: THEM,
    })
    const theirs = await uploadDocument(pdfForm('kb-theirs'))
    const missing = await uploadDocument(pdfForm('kb-missing'))

    expect(theirs).toEqual({ ok: false, error: 'Knowledge base not found.' })
    expect(theirs).toEqual(missing)
    expectNoSideEffects()
  })
})

describe.each([
  ['deleteDocument', deleteDocument],
  ['retryDocument', retryDocument],
] as const)('%s', (_name, action) => {
  it("rejects someone else's document as if it did not exist", async () => {
    dbMock.query.documents.findFirst.mockResolvedValueOnce(theirDocument)
    const theirs = await action(theirDocument.id)
    const missing = await action('doc-missing')

    expect(theirs).toEqual({ ok: false, error: 'Document not found.' })
    expect(theirs).toEqual(missing)
    expectNoSideEffects()
  })
})

describe('deleteDocument', () => {
  it('deletes the caller’s own document and its stored object', async () => {
    dbMock.query.documents.findFirst.mockResolvedValueOnce(myDocument)
    dbMock.query.files.findFirst.mockResolvedValueOnce({ bucketKey: 'k/a.pdf' })
    dbMock.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    })

    expect(await deleteDocument(myDocument.id)).toEqual({
      ok: true,
      data: null,
    })
    expect(mockDeleteObject).toHaveBeenCalledWith('k/a.pdf')
  })
})

describe('moveDocument', () => {
  it("rejects someone else's document", async () => {
    dbMock.query.documents.findFirst.mockResolvedValueOnce(theirDocument)

    expect(await moveDocument(theirDocument.id, 'kb-mine')).toEqual({
      ok: false,
      error: 'Document not found.',
    })
    expectNoSideEffects()
  })

  it("rejects moving the caller's document into someone else's knowledge base", async () => {
    dbMock.query.documents.findFirst.mockResolvedValueOnce(myDocument)
    dbMock.query.knowledgeBases.findFirst.mockResolvedValueOnce({
      id: 'kb-theirs',
      ownerId: THEM,
    })

    expect(await moveDocument(myDocument.id, 'kb-theirs')).toEqual({
      ok: false,
      error: 'Knowledge base not found.',
    })
    expectNoSideEffects()
  })
})
