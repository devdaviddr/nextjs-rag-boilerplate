import { env } from '@/lib/env'

/**
 * Which header carries the client's address (#156). The rate limits are keyed
 * on it, so it must be one the client cannot set.
 *
 * - `cf-connecting-ip`: behind a Cloudflare Tunnel. Only Cloudflare sets it.
 * - `x-forwarded-for`: behind your own reverse proxy. The LAST hop, the one
 *   the proxy appended; earlier entries came from the client and can be
 *   anything.
 * - `x-real-ip`: a proxy that sets that header instead.
 * - `auto`: no proxy is declared — `CF-Connecting-IP`, then the first
 *   `X-Forwarded-For` hop, then `X-Real-IP`. Right for local development and
 *   the test suite, which give each client its own address that way; wrong
 *   for an internet-facing box, where each of those can be forged.
 */
export type TrustedIpHeader =
  'auto' | 'cf-connecting-ip' | 'x-forwarded-for' | 'x-real-ip'

/**
 * Best-effort client IP from request headers.
 *
 * Returns `'unknown'` when the trusted header is missing (callers key rate
 * limits per IP; an `'unknown'` bucket degrades gracefully).
 */
export function clientIpFromHeaders(
  headers: Headers,
  trusted: TrustedIpHeader = env.TRUSTED_IP_HEADER,
): string {
  const header = (name: string) => headers.get(name)?.trim() || undefined
  const forwarded = headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((hop) => hop.trim())
    .filter(Boolean)

  switch (trusted) {
    case 'cf-connecting-ip':
      return header('cf-connecting-ip') ?? 'unknown'
    case 'x-forwarded-for':
      return forwarded?.at(-1) ?? 'unknown'
    case 'x-real-ip':
      return header('x-real-ip') ?? 'unknown'
    case 'auto':
      return (
        header('cf-connecting-ip') ??
        forwarded?.[0] ??
        header('x-real-ip') ??
        'unknown'
      )
  }
}
