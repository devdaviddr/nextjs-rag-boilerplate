import 'server-only'

import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

/**
 * Fetching a URL a user typed, without letting it reach anything the user
 * could not reach themselves (spec 0047).
 *
 * The server's network position is the asset: from here `localhost`, the
 * database, MinIO, the cloud metadata endpoint and the host's private network
 * are all one request away. So:
 *
 * - only `http:`/`https:` on the default ports, no credentials in the URL;
 * - the name is resolved once, every address is checked (`isPublicAddress`),
 *   and the connection is made to the checked address — not a second lookup,
 *   which DNS rebinding could answer differently;
 * - redirects are followed by hand, at most 3, each checked the same way;
 * - the whole fetch has a deadline and the body a size cap.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

const v4 = (ip: string) =>
  ip.split('.').reduce((n, part) => n * 256 + Number(part), 0)
const inV4 = (ip: string, base: string, bits: number) =>
  Math.floor(v4(ip) / 2 ** (32 - bits)) ===
  Math.floor(v4(base) / 2 ** (32 - bits))

/** Ranges that are not the public internet (IANA special-purpose registry). */
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255
]

/** The 16 bytes of an IPv6 address. */
function v6Bytes(ip: string): number[] {
  const [head, tail = ''] = ip.includes('::') ? ip.split('::') : [ip, '']
  const parse = (part: string) =>
    part
      ? part
          .split(':')
          .flatMap((group) =>
            group.includes('.')
              ? group.split('.').map(Number)
              : [parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff],
          )
      : []
  const left = parse(head!)
  const right = parse(tail)
  return [
    ...left,
    ...new Array(16 - left.length - right.length).fill(0),
    ...right,
  ]
}

/**
 * Whether an address is on the public internet. Anything unparseable, and any
 * IPv6 address outside global unicast (2000::/3), is treated as not.
 */
export function isPublicAddress(address: string): boolean {
  const kind = net.isIP(address)
  if (kind === 4)
    return !V4_BLOCKED.some(([base, bits]) => inV4(address, base, bits))
  if (kind !== 6) return false
  const b = v6Bytes(address.split('%')[0]!.toLowerCase())
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): judge the IPv4 inside.
  const embedded = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`
  if (
    b.slice(0, 10).every((x) => x === 0) &&
    b[10] === 0xff &&
    b[11] === 0xff
  ) {
    return isPublicAddress(embedded)
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isPublicAddress(embedded)
  }
  // Global unicast only, minus documentation (2001:db8::/32) and 6to4
  // (2002::/16, which embeds an IPv4 address of its own).
  if ((b[0]! & 0xe0) !== 0x20) return false
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8)
    return false
  if (b[0] === 0x20 && b[1] === 0x02) return false
  return true
}

export interface FetchedPage {
  /** Where the content finally came from, after redirects. */
  url: string
  contentType: string
  bytes: Buffer
  status: number
  /** Response headers, names lower-cased. */
  headers: Record<string, string>
}

/** A request other than a plain GET, e.g. an MCP call (spec 0048 NFR2). */
export interface RequestInit {
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: string
}

export interface SafeFetchOptions {
  maxBytes: number
  /** When set, only these hosts and their subdomains may be fetched. */
  allowedHosts?: readonly string[]
  timeoutMs?: number
  /** For tests: resolve a name. Defaults to the system resolver. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>
  /** For tests: make the request to the checked address. */
  transport?: typeof requestPinned
  /** Method, headers and body. Only a GET follows redirects. */
  request?: RequestInit
  /** Return a non-2xx response instead of refusing it. */
  anyStatus?: boolean
  /** The caller's own deadline, e.g. the agentic loop's, besides `timeoutMs`. */
  signal?: AbortSignal
}

const MAX_REDIRECTS = 3

/** Check a URL's form and allow-list, before any network access. */
export function checkUrl(raw: string, allowedHosts?: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError('That is not a valid web address.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https addresses can be added.')
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError(
      'Addresses with a user name or password cannot be added.',
    )
  }
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) {
    throw new UnsafeUrlError('Only the standard web ports can be used.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    allowedHosts?.length &&
    !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))
  ) {
    throw new UnsafeUrlError(
      `${host} is not on this server's list of allowed sites.`,
    )
  }
  return url
}

/** The address to connect to, having checked every address the name has. */
async function resolvePublic(
  url: URL,
  resolve: NonNullable<SafeFetchOptions['resolve']>,
): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await resolve(host).catch(() => {
        throw new UnsafeUrlError(`${host} could not be found.`)
      })
  if (
    addresses.length === 0 ||
    !addresses.every((a) => isPublicAddress(a.address))
  ) {
    throw new UnsafeUrlError(`${host} is not a public address.`)
  }
  return addresses[0]!
}

/** One GET to `url`, connected to the checked `pinned` address. */
export function requestPinned(
  url: URL,
  pinned: { address: string; family: number },
  signal: AbortSignal,
  maxBytes: number,
  init: RequestInit = {},
): Promise<{
  status: number
  location?: string
  contentType: string
  bytes: Buffer
  headers?: Record<string, string>
}> {
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: init.method ?? 'GET',
        signal,
        headers: {
          'user-agent': 'rag-boilerplate/1 (+document fetch)',
          accept: 'text/html, application/pdf;q=0.9',
          ...init.headers,
        },
        // Connect to the address that was checked; Host and SNI stay the name.
        // Node asks for every address (`all`) when it races address families.
        lookup: ((
          _host: string,
          opts: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) =>
          opts?.all
            ? callback(null, [pinned])
            : callback(null, pinned.address, pinned.family)) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const headers = Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [
            k.toLowerCase(),
            Array.isArray(v) ? v.join(', ') : String(v ?? ''),
          ]),
        )
        if (status >= 300 && status < 400) {
          res.resume()
          return resolve({
            status,
            location: res.headers.location,
            contentType: '',
            bytes: Buffer.alloc(0),
            headers,
          })
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            req.destroy()
            reject(
              new UnsafeUrlError('That page is larger than the upload limit.'),
            )
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({
            status,
            contentType: String(res.headers['content-type'] ?? ''),
            bytes: Buffer.concat(chunks),
            headers,
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(init.body)
  })
}

/** Fetch a URL under the rules above. Throws `UnsafeUrlError` with a user-facing reason. */
export async function safeFetch(
  raw: string,
  options: SafeFetchOptions,
): Promise<FetchedPage> {
  const resolve =
    options.resolve ??
    ((host: string) => lookup(host, { all: true, verbatim: true }))
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline
  let url = checkUrl(raw, options.allowedHosts)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const pinned = await resolvePublic(url, resolve)
    let res
    try {
      res = await (options.transport ?? requestPinned)(
        url,
        pinned,
        signal,
        options.maxBytes,
        options.request,
      )
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw error
      if (signal.aborted)
        throw new UnsafeUrlError('That page took too long to fetch.')
      throw new UnsafeUrlError('That page could not be fetched.')
    }
    if (res.location !== undefined) {
      // A redirect would replay a POST's body somewhere else; only GETs follow.
      if ((options.request?.method ?? 'GET') !== 'GET')
        throw new UnsafeUrlError(
          'That address redirects, which is not followed.',
        )
      if (hop === MAX_REDIRECTS)
        throw new UnsafeUrlError('That address redirects too many times.')
      url = checkUrl(
        new URL(res.location, url).toString(),
        options.allowedHosts,
      )
      continue
    }
    if (!options.anyStatus && (res.status < 200 || res.status >= 300)) {
      throw new UnsafeUrlError(
        `That page could not be fetched (HTTP ${res.status}).`,
      )
    }
    return {
      url: url.toString(),
      contentType: res.contentType,
      bytes: res.bytes,
      status: res.status,
      headers: res.headers ?? {},
    }
  }
  throw new UnsafeUrlError('That address redirects too many times.')
}
