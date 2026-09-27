import { beforeEach, describe, expect, it, vi } from 'vitest'

// Adding a web page by URL and refreshing it (spec 0047 FR1–FR3, NFR5). The
// fetch itself is `safeFetch`, tested in fetch-url.test.ts; here it is mocked
// and these tests check what the actions do around it.

const { dbMock, envMock, mockSafeFetch } = vi.hoisted(() => ({
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
  },
  envMock: {
    UPLOAD_MAX_SIZE_MB: 25,
    MAX_STORAGE_PER_USER_MB: 500,
    UPLOAD_ALLOWED_MIME_TYPES: 'application/pdf',
    URL_ALLOWED_HOSTS: undefined as string | undefined,
  },
  mockSafeFetch: vi.fn(),
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
const mockPutObject = vi.fn()
vi.mock('@/lib/storage/client', () => ({
  deleteObject: vi.fn(),
  putObject: (...a: unknown[]) => mockPutObject(...a),
}))
vi.mock('@/lib/rag/ingest', () => ({ ingestDocument: vi.fn() }))
vi.mock('@/db', () => ({ db: dbMock }))
vi.mock('@/lib/env', () => ({ env: envMock }))
vi.mock('@/lib/rag/fetch-url', async (original) => ({
  ...(await original<typeof import('@/lib/rag/fetch-url')>()),
  safeFetch: (...a: unknown[]) => mockSafeFetch(...a),
}))

import { addDocumentFromUrl, refreshDocument } from '@/lib/rag/actions'
import { UnsafeUrlError } from '@/lib/rag/fetch-url'

const ME = 'user-me'
const PAGE = Buffer.from(
  '<!doctype html><html><head><title>Leave policy</title></head><body><h1>Leave</h1><p>Staff get 25 days.</p></body></html>',
)

/** Chainable stand-ins for the insert/update/delete/select builders. */
function stubWrites() {
  const inserted: unknown[] = []
  dbMock.insert.mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      inserted.push(v)
      return {
        returning: async () => [
          {
            id: `row-${inserted.length}`,
            title: 'x',
            status: 'pending',
            pageCount: null,
            error: null,
            createdAt: new Date(0),
            sourceUrl: null,
            ...v,
          },
        ],
      }
    },
  }))
  const updates: unknown[] = []
  dbMock.update.mockImplementation(() => ({
    set: (v: unknown) => {
      updates.push(v)
      return { where: async () => undefined }
    },
  }))
  dbMock.delete.mockImplementation(() => ({ where: async () => undefined }))
  dbMock.select.mockImplementation(() => ({
    from: () => ({ where: async () => [{ total: 1000 }] }),
  }))
  return { inserted, updates }
}

beforeEach(() => {
  vi.clearAllMocks()
  envMock.URL_ALLOWED_HOSTS = undefined
  mockGetSession.mockResolvedValue({ user: { id: ME } })
  dbMock.query.knowledgeBases.findFirst.mockResolvedValue({
    id: 'kb-mine',
    ownerId: ME,
  })
  mockSafeFetch.mockResolvedValue({
    url: 'https://example.com/leave',
    contentType: 'text/html',
    bytes: PAGE,
  })
})

describe('addDocumentFromUrl', () => {
  it("does not fetch for someone else's knowledge base", async () => {
    dbMock.query.knowledgeBases.findFirst.mockResolvedValueOnce({
      id: 'kb-theirs',
      ownerId: 'user-them',
    })
    expect(
      await addDocumentFromUrl('kb-theirs', 'https://example.com/leave'),
    ).toEqual({ ok: false, error: 'Knowledge base not found.' })
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('stores the page with its URL, titled from <title>, and queues it', async () => {
    const { inserted } = stubWrites()
    const result = await addDocumentFromUrl(
      'kb-mine',
      ' https://example.com/leave ',
    )

    expect(result.ok).toBe(true)
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://example.com/leave',
      expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }),
    )
    expect(mockPutObject).toHaveBeenCalledWith(
      expect.stringContaining('example.com.html'),
      PAGE,
      'text/html',
    )
    expect(inserted[1]).toMatchObject({
      knowledgeBaseId: 'kb-mine',
      title: 'Leave policy',
      sourceUrl: 'https://example.com/leave',
      fetchedAt: expect.any(Date),
    })
    expect(mockAfter).toHaveBeenCalledOnce()
  })

  it('passes the allow-list from URL_ALLOWED_HOSTS', async () => {
    stubWrites()
    envMock.URL_ALLOWED_HOSTS = 'Example.com, docs.example.org'
    await addDocumentFromUrl('kb-mine', 'https://example.com/leave')
    expect(mockSafeFetch.mock.calls[0]![1].allowedHosts).toEqual([
      'example.com',
      'docs.example.org',
    ])
  })

  it('returns the reason a URL was refused, and stores nothing', async () => {
    mockSafeFetch.mockRejectedValueOnce(
      new UnsafeUrlError('127.0.0.1 is not a public address.'),
    )
    expect(await addDocumentFromUrl('kb-mine', 'http://127.0.0.1/')).toEqual({
      ok: false,
      error: '127.0.0.1 is not a public address.',
    })
    expect(mockPutObject).not.toHaveBeenCalled()
    expect(dbMock.insert).not.toHaveBeenCalled()
  })

  it('refuses a response that is neither HTML nor PDF (FR2)', async () => {
    mockSafeFetch.mockResolvedValueOnce({
      url: 'https://example.com/a.png',
      contentType: 'text/html',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })
    const result = await addDocumentFromUrl(
      'kb-mine',
      'https://example.com/a.png',
    )
    expect(result).toEqual({
      ok: false,
      error: 'That address is not a web page or a PDF.',
    })
    expect(mockPutObject).not.toHaveBeenCalled()
  })
})

describe('refreshDocument', () => {
  const webDoc = {
    id: 'doc-web',
    ownerId: ME,
    fileId: 'file-web',
    status: 'ready',
    sourceUrl: 'https://example.com/leave',
  }

  it('refuses an uploaded document, and someone else’s, as not found', async () => {
    dbMock.query.documents.findFirst.mockResolvedValueOnce({
      ...webDoc,
      sourceUrl: null,
    })
    expect(await refreshDocument('doc-web')).toEqual({
      ok: false,
      error: 'Document not found.',
    })
    dbMock.query.documents.findFirst.mockResolvedValueOnce({
      ...webDoc,
      ownerId: 'user-them',
    })
    expect(await refreshDocument('doc-web')).toEqual({
      ok: false,
      error: 'Document not found.',
    })
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('refetches into the same file and re-indexes the same document (FR3)', async () => {
    const { updates, inserted } = stubWrites()
    dbMock.query.documents.findFirst.mockResolvedValueOnce(webDoc)
    dbMock.query.files.findFirst.mockResolvedValueOnce({
      bucketKey: 'u/example.com.html',
      sizeBytes: 500,
    })

    expect(await refreshDocument('doc-web')).toEqual({ ok: true, data: null })
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://example.com/leave',
      expect.anything(),
    )
    expect(mockPutObject).toHaveBeenCalledWith(
      'u/example.com.html',
      PAGE,
      'text/html',
    )
    expect(inserted).toEqual([])
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: 'pending',
        fetchedAt: expect.any(Date),
      }),
    )
    expect(mockAfter).toHaveBeenCalledOnce()
  })
})
