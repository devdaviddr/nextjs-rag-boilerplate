import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  UnsafeUrlError,
  checkUrl,
  isPublicAddress,
  requestPinned,
  safeFetch,
} from '@/lib/rag/fetch-url'

// Spec 0047: fetching a URL a user typed without reaching anything private.

describe('isPublicAddress (NFR2)', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
    '2001:db8::1', // documentation
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each([
    '93.184.216.34',
    '1.1.1.1',
    '172.32.0.1', // just outside 172.16.0.0/12
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
})

describe('checkUrl (NFR1, NFR5)', () => {
  it.each([
    ['file:///etc/passwd', /Only http and https/],
    ['ftp://example.com/', /Only http and https/],
    ['http://user:pass@example.com/', /user name or password/],
    ['http://example.com:8080/', /standard web ports/],
    ['not a url', /not a valid web address/],
  ])('refuses %s', (url, message) => {
    expect(() => checkUrl(url)).toThrow(message)
  })

  it('keeps to the allow-list, subdomains included', () => {
    expect(
      checkUrl('https://docs.example.com/a', ['example.com']).hostname,
    ).toBe('docs.example.com')
    expect(() => checkUrl('https://evil.com/', ['example.com'])).toThrow(
      /not on this server's list/,
    )
  })
})

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]

describe('safeFetch (NFR2, NFR3)', () => {
  it('refuses a name that resolves to a private address', async () => {
    await expect(
      safeFetch('http://internal.example/', {
        maxBytes: 1000,
        resolve: async () => [{ address: '10.0.0.5', family: 4 }],
      }),
    ).rejects.toThrow(/not a public address/)
  })

  it('refuses a name when ANY of its addresses is private', async () => {
    await expect(
      safeFetch('http://mixed.example/', {
        maxBytes: 1000,
        resolve: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
    ).rejects.toThrow(/not a public address/)
  })

  it('refuses an IP literal in the URL', async () => {
    await expect(
      safeFetch('http://169.254.169.254/latest/meta-data/', { maxBytes: 1000 }),
    ).rejects.toThrow(/not a public address/)
  })

  it('checks every redirect target, and stops at three', async () => {
    const redirectTo = (location: string) => async () => ({
      status: 302,
      location,
      contentType: '',
      bytes: Buffer.alloc(0),
    })
    await expect(
      safeFetch('http://public.example/', {
        maxBytes: 1000,
        resolve: async (host) =>
          host === 'public.example'
            ? [{ address: '93.184.216.34', family: 4 }]
            : [{ address: '127.0.0.1', family: 4 }],
        transport: redirectTo('http://localhost/admin'),
      }),
    ).rejects.toThrow(/not a public address/)

    await expect(
      safeFetch('http://public.example/', {
        maxBytes: 1000,
        resolve: publicResolver,
        transport: redirectTo('http://public.example/again'),
      }),
    ).rejects.toThrow(/redirects too many times/)
  })

  it('returns the page and where it finally came from', async () => {
    const page = await safeFetch('http://public.example/start', {
      maxBytes: 1000,
      resolve: publicResolver,
      transport: async (url) =>
        url.pathname === '/start'
          ? {
              status: 301,
              location: '/end',
              contentType: '',
              bytes: Buffer.alloc(0),
            }
          : {
              status: 200,
              contentType: 'text/html',
              bytes: Buffer.from('<p>hi</p>'),
            },
    })
    expect(page).toMatchObject({
      url: 'http://public.example/end',
      contentType: 'text/html',
      bytes: Buffer.from('<p>hi</p>'),
      status: 200,
    })
  })
})

describe('requestPinned (NFR2, NFR4)', () => {
  let port = 0
  let lastHost = ''
  const server = createServer((req, res) => {
    lastHost = req.headers.host ?? ''
    if (req.url === '/hang') return // never answers
    if (req.url === '/big') {
      res.end('x'.repeat(5000))
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end('<p>ok</p>')
  })
  beforeAll(
    () =>
      new Promise<void>((done) =>
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as AddressInfo).port
          done()
        }),
      ),
  )
  afterAll(() => new Promise<void>((done) => server.close(() => done())))

  it('connects to the checked address, whatever the name resolves to now', async () => {
    // A name that would resolve anywhere; the connection goes to the pin.
    const res = await requestPinned(
      new URL(`http://rebinding.example:${port}/`),
      { address: '127.0.0.1', family: 4 },
      AbortSignal.timeout(5000),
      1000,
    )
    expect(res.bytes.toString()).toBe('<p>ok</p>')
    expect(lastHost).toBe(`rebinding.example:${port}`)
  })

  it('stops reading at the size limit', async () => {
    await expect(
      requestPinned(
        new URL(`http://x.example:${port}/big`),
        { address: '127.0.0.1', family: 4 },
        AbortSignal.timeout(5000),
        1000,
      ),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('gives up on a response that takes too long', async () => {
    await expect(
      safeFetch(`http://slow.example/hang`, {
        maxBytes: 1000,
        timeoutMs: 200,
        resolve: async () => [{ address: '93.184.215.14', family: 4 }],
        transport: (url, _pinned, signal, max) =>
          requestPinned(
            new URL(`http://slow.example:${port}${url.pathname}`),
            { address: '127.0.0.1', family: 4 },
            signal,
            max,
          ),
      }),
    ).rejects.toThrow('That page took too long to fetch.')
  })
})
