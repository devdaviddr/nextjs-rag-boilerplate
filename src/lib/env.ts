import { z } from 'zod'

/**
 * Centralised, validated environment access.
 *
 * Importing this module fails fast (at boot) with a readable error if a
 * required variable is missing or malformed, instead of surfacing a cryptic
 * `undefined` deep inside a request. Keep this file dependency-free (only
 * `zod`) so it is safe to import from any runtime, including the edge.
 */
/** Treat unset AND empty-string env vars as "not provided". */
const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v))

const envSchema = z
  .object({
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection URL'),
    AUTH_SECRET: z
      .string()
      .min(1, 'AUTH_SECRET is required — generate one with `npx auth secret`'),
    AUTH_URL: z.string().url().optional(),
    AUTH_TRUST_HOST: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),

    // When true, newly-registered users must verify their email before admin
    // actions are allowed (a soft gate, not a full lockout). Off by default.
    // Only meaningful when email is enabled.
    REQUIRE_EMAIL_VERIFICATION: z
      .string()
      .optional()
      .transform((v) => v === 'true'),

    // --- OAuth providers (opt-in) ------------------------------------------
    // Each provider is enabled only when BOTH its id and secret are set (see
    // isGithubConfigured/isGoogleConfigured). Absent → the provider button is
    // hidden and nothing changes for credentials-only deployments.
    AUTH_GITHUB_ID: optionalStr,
    AUTH_GITHUB_SECRET: optionalStr,
    AUTH_GOOGLE_ID: optionalStr,
    AUTH_GOOGLE_SECRET: optionalStr,

    // --- Web Push (opt-in) -------------------------------------------------
    // Generate a keypair with:  npx web-push generate-vapid-keys
    // The feature is inert unless all three are set. VAPID_SUBJECT is a contact
    // URL, typically `mailto:you@example.com`. The public key is safe to expose
    // to the client; the private key is server-only.
    VAPID_PUBLIC_KEY: optionalStr,
    VAPID_PRIVATE_KEY: optionalStr,
    VAPID_SUBJECT: optionalStr,

    // --- Public app URL ----------------------------------------------------
    // Canonical, publicly-reachable origin of this deployment. Used for
    // `metadataBase` (so OpenGraph/Twitter image URLs resolve absolutely) and
    // the robots/sitemap routes. Optional with a dev default so zero-config
    // still boots; set it per fork to the real domain for correct share cards.
    APP_URL: z
      .string()
      .url('APP_URL must be a valid URL')
      .optional()
      .default('http://localhost:3000'),

    // --- Email (opt-in) ---------------------------------------------------
    // Everything email-related is OFF unless EMAIL_ENABLED=true AND a provider
    // (SMTP) is configured. See src/lib/email/. SMTP is provider-agnostic:
    // Resend / SendGrid / Mailgun / SES / Gmail all expose SMTP credentials.
    EMAIL_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
    EMAIL_FROM: z
      .string()
      .email('EMAIL_FROM must be a valid email address')
      .optional(),
    SMTP_HOST: optionalStr,
    SMTP_PORT: z.coerce.number().int().positive().max(65535).optional(),
    SMTP_USER: optionalStr,
    SMTP_PASSWORD: optionalStr,
    SMTP_SECURE: z
      .string()
      .optional()
      .transform((v) => v === 'true'),

    // --- File storage (S3-compatible — MinIO by default) -------------------
    // Required: the docker-compose `minio` service ships working defaults in
    // .env.example, so `cp .env.example .env` works with zero extra setup —
    // same posture as DATABASE_URL.
    S3_ENDPOINT: z.string().url('S3_ENDPOINT must be a valid URL'),
    S3_ACCESS_KEY_ID: z.string().min(1, 'S3_ACCESS_KEY_ID is required'),
    S3_SECRET_ACCESS_KEY: z.string().min(1, 'S3_SECRET_ACCESS_KEY is required'),
    S3_BUCKET: z.string().min(1, 'S3_BUCKET is required'),
    S3_REGION: z.string().min(1).optional().default('us-east-1'),
    UPLOAD_MAX_SIZE_MB: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(10),
    MAX_STORAGE_PER_USER_MB: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(500),
    // Comma-separated MIME allow-list.
    UPLOAD_ALLOWED_MIME_TYPES: z
      .string()
      .min(1)
      .optional()
      .default('image/png,image/jpeg,image/webp,image/gif,application/pdf'),

    // --- RAG / NVIDIA NIM (spec 0025) --------------------------------------
    // Opt-in, same posture as OAuth/email/push: absent -> the knowledge-base
    // and chat features report themselves as unconfigured rather than the app
    // refusing to boot. That keeps `pnpm build` and CI green without secrets.
    //
    // The base URL is any OpenAI-compatible endpoint, so pointing it at a
    // local Ollama or llama.cpp gives a fully offline deployment.
    NVIDIA_API_KEY: optionalStr,
    RAG_LLM_BASE_URL: z
      .string()
      .url('RAG_LLM_BASE_URL must be a valid URL')
      .optional()
      .default('https://integrate.api.nvidia.com/v1'),
    // Measured 2026-09-07: this is the only embedding model reachable on a
    // free NIM account, and it is fixed at 2048 dimensions (`dimensions: 1024`
    // is rejected). Changing it almost certainly requires a schema migration —
    // see EMBEDDING_DIMENSIONS in src/lib/rag/constants.ts.
    RAG_EMBED_MODEL: z
      .string()
      .min(1)
      .optional()
      .default('nvidia/nemotron-3-embed-1b'),
    RAG_CHAT_MODEL: z
      .string()
      .min(1)
      .optional()
      .default('nvidia/nemotron-3-super-120b-a12b'),
    RAG_CHUNK_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(512),
    RAG_CHUNK_OVERLAP_TOKENS: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(64),
    RAG_EMBED_BATCH: z.coerce.number().int().positive().optional().default(32),
    RAG_EMBED_CONCURRENCY: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(4),
    RAG_TOP_K: z.coerce.number().int().positive().optional().default(8),
    // Cosine similarity floor. Below this, retrieval is treated as a miss and
    // the chat model is never called (spec 0025 FR10).
    RAG_MIN_SIMILARITY: z.coerce
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.35),
    // Average extractable characters per page below which a PDF is treated as
    // image-only and rejected rather than partially ingested.
    RAG_MIN_CHARS_PER_PAGE: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(50),
    // How many chunks a whole-document request may send to the model. Bounds
    // both cost and context length when someone asks to summarise a long PDF.
    // --- Hybrid retrieval (spec 0027, 1b) ------------------------------------
    // Candidates pulled from EACH channel before fusion. Larger costs a little
    // more work per query and gives fusion more to work with.
    RAG_HYBRID_CANDIDATES: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(20),
    // Reciprocal Rank Fusion constant. 60 is the value from the original paper
    // and is not sensitive; it damps the influence of top ranks.
    RAG_RRF_K: z.coerce.number().int().positive().optional().default(60),
    RAG_DOC_SCOPE_MAX_CHUNKS: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(24),
    RAG_MAX_DOCUMENT_PAGES: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(200),

    // --- Agentic retrieval (spec 0029) -------------------------------------
    // Off by default. The agentic path must earn its place against the fixed
    // pipeline on the same eval questions before it becomes the default; with
    // this false, the existing path runs byte-identically.
    RAG_AGENTIC_ENABLED: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true'),
    // Planning and prose are separate roles and need not be the same model.
    // Measured over 40 native tool-call attempts: lightning 10/10 and 5/5 on a
    // two-round tool loop; the default chat model 8/10, its failures clean
    // transport 500s already inside the retry wrapper. Prose quality was NOT
    // measured, which is exactly why the roles are configured separately.
    RAG_PLANNER_MODEL: z
      .string()
      .min(1)
      .optional()
      .default('nvidia/nemotron-3.5-lightning-30b-a3b'),
    // Three, not two. Measured planner latency is 2.6-4.4s medians, not the
    // ~10s previously on record — at 10s a call, three searches worst-cased at
    // 45s and would have been unusable; at the real numbers it is about 14s.
    RAG_MAX_SEARCHES: z.coerce.number().int().positive().optional().default(3),
    // Wall-clock for the loop, excluding answer streaming. At the limit the
    // loop stops and the caller answers from what it has, or refuses — never a
    // partial ungrounded answer because time ran out.
    RAG_MAX_LOOP_MS: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(15000),
    // How much the similarity floor rises per EXTRA search (spec 0029).
    //
    // Measured: with a flat floor the agentic path's refusal accuracy fell
    // 1.000 -> 0.667, because searching three times for something the corpus
    // cannot answer eventually turned up a chunk at 0.421 — above the 0.35
    // floor purely by persistence. Every other metric improved, which is
    // precisely the shape of regression this project has been bitten by before.
    //
    // Raising the flat floor instead would not work: true positives on this
    // corpus score 0.41-0.62, so a floor above 0.421 discards real answers.
    // The problem is not the threshold, it is that N attempts get N chances at
    // it. So the bar rises with the number of attempts, and evidence found on
    // the first search is judged exactly as before.
    RAG_AGENTIC_FLOOR_STEP: z.coerce
      .number()
      .nonnegative()
      .optional()
      .default(0.04),
    // Prompt + completion across every planning call in one question.
    RAG_MAX_LOOP_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .default(8000),

    // --- Build identity (baked into the image at CI build time) ------------
    // ci.yml passes these as Docker build-args (APP_VERSION=git ref name,
    // APP_GIT_SHA=commit sha); the Dockerfile persists them as ENV. Surfaced
    // read-only in the Settings page. Absent under `next dev` and in un-baked
    // local images — the UI degrades gracefully.
    APP_VERSION: optionalStr,
    APP_GIT_SHA: optionalStr,
  })
  .superRefine((val, ctx) => {
    // A chunk overlap >= the chunk size makes the chunker loop forever.
    if (val.RAG_CHUNK_OVERLAP_TOKENS >= val.RAG_CHUNK_TOKENS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RAG_CHUNK_OVERLAP_TOKENS'],
        message:
          'RAG_CHUNK_OVERLAP_TOKENS must be smaller than RAG_CHUNK_TOKENS',
      })
    }

    // If email is toggled on, a provider MUST be configured — fail fast at boot
    // rather than silently dropping mail (or throwing on first send).
    if (!val.EMAIL_ENABLED) return
    const requiredWhenEnabled: Array<[string, unknown]> = [
      ['EMAIL_FROM', val.EMAIL_FROM],
      ['SMTP_HOST', val.SMTP_HOST],
      ['SMTP_PORT', val.SMTP_PORT],
    ]
    for (const [key, value] of requiredWhenEnabled) {
      if (value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when EMAIL_ENABLED=true`,
        })
      }
    }
  })

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`❌ Invalid environment variables:\n${issues}`)
}

export const env = parsed.data
export type Env = typeof env
