import type { NextConfig } from 'next'

// The onnxruntime-node binary directory for the arch being built (see
// outputFileTracingIncludes). Anything but arm64 is treated as x64, the only
// other Linux build the package ships.
const LINUX_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const OTHER_ARCH = LINUX_ARCH === 'arm64' ? 'x64' : 'arm64'

const nextConfig: NextConfig = {
  // No dev-tools button. It is a dark circle with an "N", which reads as a
  // user avatar: bottom-left it covered the account menu's avatar, and
  // anywhere else it was mistaken for it (#74). Next.js still shows build
  // and runtime errors without it. Development only either way.
  devIndicators: false,
  // Pin the workspace root so Next doesn't misdetect it from stray parent-dir
  // lockfiles; also keeps standalone output file-tracing scoped correctly.
  turbopack: {
    root: import.meta.dirname,
  },
  outputFileTracingRoot: import.meta.dirname,
  // Emit a minimal standalone server bundle for small, secure Docker images.
  output: 'standalone',
  // Keep native addons out of the bundler so their platform-specific .node
  // binaries are resolved from node_modules (and traced into standalone).
  //
  // @napi-rs/canvas renders PDF pages for document cracking (spec 0031).
  // Without it here the Turbopack build fails outright — "non-ecmascript
  // placeable asset ... doesn't have a module id" — because the binding is not
  // JavaScript and cannot be placed in an ESM chunk. It fails at BUILD time,
  // not at run time, so it cannot slip through unnoticed.
  // onnxruntime-node: the local reranker (spec 0036, #113), a native addon
  // like the other two.
  serverExternalPackages: [
    '@node-rs/argon2',
    '@napi-rs/canvas',
    'onnxruntime-node',
  ],
  // onnxruntime-node loads its binding with a template-string require
  // (`bin/napi-v6/${platform}/${arch}/…`), which the standalone tracer cannot
  // follow: without an include the image ships no runtime and the local
  // reranker fails open on every query — reranking "on", nothing reranked.
  // The package carries every platform (~290 MB), so only the build machine's
  // arch of the Linux binary is included, 24 MB (arm64) or 44 MB (x64), and
  // the rest is excluded in case a future tracer does follow the require
  // (#114). The Docker build runs on the target arch, so `process.arch` is the
  // image's.
  outputFileTracingExcludes: {
    '*': [
      './node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/{darwin,win32}/**',
      `./node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/linux/${OTHER_ARCH}/**`,
    ],
  },
  outputFileTracingIncludes: {
    // The in-app Docs section reads docs/*.md and serves docs/images at run
    // time (spec 0041); the tracer cannot see those paths, so they are listed.
    // Keys are globs over route paths: `[slug]` would be a character class, so
    // dynamic segments are matched with `*`.
    '/docs': ['./docs/*.md'],
    '/docs/*': ['./docs/*.md'],
    '/docs-assets/*': ['./docs/images/*'],
    // Every route that can reach retrieval (chat, server actions); standalone
    // copies each file once however many routes list it.
    '*': [
      `./node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/linux/${LINUX_ARCH}/**`,
    ],
  },
  // File uploads go through a Server Action (src/lib/storage/actions.ts) as a
  // multipart body — the 1 MB default is far too small. Matches the app's own
  // UPLOAD_MAX_SIZE_MB ceiling (see src/lib/env.ts); bump both together.
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
  },
  // Don't advertise the framework.
  poweredByHeader: false,
  // Fail the production build on type errors instead of silently shipping them.
  typescript: {
    ignoreBuildErrors: false,
  },
  // Harden default response headers for every route.
  async headers() {
    return [
      {
        // Everything EXCEPT the document source route, which the citation
        // panel frames from this same origin. A global `X-Frame-Options: DENY`
        // blocks that too — same-origin framing is not exempt — and the panel
        // renders "refused to connect" instead of the PDF. The route sets its
        // own, narrower `SAMEORIGIN` + `frame-ancestors 'self'`.
        source: '/:path((?!api/documents/[^/]+/source$).*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            // Force HTTPS for two years (browsers ignore this over plain HTTP,
            // so it's safe in local dev). Consider submitting to the preload list.
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
      {
        // The service worker must never be cached, or clients get stuck on an
        // old version. Service-Worker-Allowed widens its controllable scope.
        source: '/sw.js',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ]
  },
}

export default nextConfig
