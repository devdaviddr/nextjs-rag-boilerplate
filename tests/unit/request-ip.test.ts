import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/env', () => ({ env: { TRUSTED_IP_HEADER: 'auto' } }))

import { clientIpFromHeaders } from '@/lib/request-ip'

const h = (init: Record<string, string>) => new Headers(init)

describe('clientIpFromHeaders, auto (no proxy declared)', () => {
  it('prefers CF-Connecting-IP (unspoofable behind Cloudflare)', () => {
    expect(
      clientIpFromHeaders(
        h({
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '10.0.0.1',
          'x-real-ip': '10.0.0.2',
        }),
      ),
    ).toBe('203.0.113.7')
  })

  it('falls back to the first X-Forwarded-For hop', () => {
    expect(
      clientIpFromHeaders(h({ 'x-forwarded-for': '198.51.100.5, 10.0.0.1' })),
    ).toBe('198.51.100.5')
  })

  it('falls back to X-Real-IP', () => {
    expect(clientIpFromHeaders(h({ 'x-real-ip': '198.51.100.9' }))).toBe(
      '198.51.100.9',
    )
  })

  it('returns "unknown" when no IP header is present', () => {
    expect(clientIpFromHeaders(h({}))).toBe('unknown')
  })
})

// #156: a declared proxy header is the only one read.
describe('clientIpFromHeaders with a trusted header', () => {
  const forged = {
    'cf-connecting-ip': '6.6.6.6',
    'x-forwarded-for': '6.6.6.7, 203.0.113.9',
    'x-real-ip': '6.6.6.8',
  }

  it('behind your own proxy, takes the hop the proxy appended', () => {
    expect(clientIpFromHeaders(h(forged), 'x-forwarded-for')).toBe(
      '203.0.113.9',
    )
  })

  it('ignores a CF-Connecting-IP the client sent to your own proxy', () => {
    expect(
      clientIpFromHeaders(
        h({ 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '203.0.113.9' }),
        'x-forwarded-for',
      ),
    ).toBe('203.0.113.9')
  })

  it('behind Cloudflare, reads only CF-Connecting-IP', () => {
    expect(clientIpFromHeaders(h(forged), 'cf-connecting-ip')).toBe('6.6.6.6')
    expect(
      clientIpFromHeaders(
        h({ 'x-forwarded-for': '1.2.3.4' }),
        'cf-connecting-ip',
      ),
    ).toBe('unknown')
  })

  it('reads X-Real-IP when that is the declared header', () => {
    expect(clientIpFromHeaders(h(forged), 'x-real-ip')).toBe('6.6.6.8')
  })
})
