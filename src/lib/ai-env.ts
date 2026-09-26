import { z } from 'zod'

/**
 * The AI settings' environment fields (spec 0040): provider, models, and the
 * retrieval and answering knobs. Spread into the env schema in `./env.ts`, and
 * used on their own by `src/lib/ai-settings` to validate a saved value exactly
 * as the environment variable would be — same parsing, same bounds.
 *
 * zod only, like env.ts, so it is safe in any runtime.
 */

/** Treat unset AND empty-string env vars as "not provided". */
const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v))

export const aiEnvShape = {
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
  // is rejected). It names the model of the first embedding generation; a
  // different one is chosen in Settings, which re-indexes (#56). Changing it
  // here after documents are indexed makes queries incomparable with them.
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
  RAG_CHUNK_TOKENS: z.coerce.number().int().positive().optional().default(512),
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
  RAG_MIN_SIMILARITY: z.coerce.number().min(0).max(1).optional().default(0.35),
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

  // --- Document cracking (spec 0031) -------------------------------------
  // Off by default, same posture as RAG_AGENTIC_ENABLED below: with this
  // false, ingestion runs exactly as it did, page routing included.
  RAG_CRACK_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  RAG_PARSE_MODEL: z
    .string()
    .min(1)
    .optional()
    .default('nvidia/nemotron-parse'),
  RAG_VISION_MODEL: z
    .string()
    .min(1)
    .optional()
    .default('meta/llama-3.2-11b-vision-instruct'),
  // Parse calls a single document may spend. Triage decides WHICH pages are
  // worth one; this bounds how many, so a pathological 200-page scan cannot
  // consume a shared free-tier quota on its own. Past the cap the remaining
  // pages fall back to the text layer and the document still reaches `ready`.
  RAG_CRACK_MAX_PAGES: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(25),
  // Render scale for the page image sent to the parser. 2.0 was what every
  // measurement in spec 0031 was taken at.
  RAG_CRACK_RENDER_SCALE: z.coerce.number().positive().optional().default(2.0),
  // Share of the page a `Picture` must cover to be treated as a figure.
  // Below this it is a logo, a rule or a bullet glyph — describing those
  // would spend the most expensive call in the system on decoration.
  RAG_CRACK_MIN_FIGURE_AREA: z.coerce
    .number()
    .nonnegative()
    .optional()
    .default(0.02),
  // Vision calls per document, for figures that have NO caption to use as a
  // search key. Measured at ~40s each for blind description, so this is the
  // tightest budget here by a wide margin.
  RAG_DESCRIBE_MAX_FIGURES: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(8),
  // The answer-time `read_figure` tool on the 0029 loop. Separate from
  // RAG_CRACK_ENABLED because it is a different cost in a different place:
  // cracking spends at ingestion, this spends per question, inside a loop
  // that is already budgeted. Requires cracking, since without it no chunk
  // is ever a figure.
  RAG_READ_FIGURE_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),

  // --- Agentic retrieval (spec 0029) -------------------------------------
  // Off by default. The agentic path must earn its place against the fixed
  // pipeline on the same eval questions before it becomes the default; with
  // this false, the existing path runs byte-identically.
  // ON by default since 2026-09-11, on measurement rather than preference.
  //
  // The fixed pipeline embeds the question literally, so a follow-up carrying
  // a pronoun retrieves nothing: measured over 16 answerable follow-ups it
  // scored hit@1 **0.062** against the loop's **0.938**. That is not a
  // percentage difference, it is a capability the fixed path does not have —
  // and the one question it did win was reachable by lexical luck rather
  // than by resolving anything.
  //
  // The cost is real and is named here rather than hidden: single-hop hit@1
  // 0.882 -> 0.824, one question of seventeen, and roughly 11s per question
  // against 0.15s. A deployment that only ever asks standalone questions
  // should set this back to false and will lose nothing.
  //
  // Refusal accuracy is 1.000 on both paths, which is what makes the trade
  // safe to take at all.
  RAG_AGENTIC_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
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
  // Whether the planner writes its hidden reasoning before each decision
  // (#84). `off` sends `chat_template_kwargs: { enable_thinking: false }` on
  // planner-role calls (planning, citation checking), the switch Nemotron and
  // Qwen3 honour on NIM and vLLM; providers that do not know the field may
  // reject it, so it applies to planner calls only. Measured on NIM's free
  // tier: the first decision 2.4s -> 1.3s typical, 9/9 correct either way.
  RAG_PLANNER_REASONING: z.enum(['on', 'off']).optional().default('on'),
  // Spec 0043: plan only when it pays. `adaptive` sends only follow-ups and
  // multi-part questions to the planner (see src/lib/rag/plan-route.ts);
  // `always` is the behaviour before it. Default decided by the eval.
  RAG_AGENTIC_ROUTE: z
    .enum(['adaptive', 'always'])
    .optional()
    .default('always'),
  // A first search whose best match reaches this ends the loop without a
  // second planner decision (spec 0043 FR2). 1 turns it off.
  RAG_AGENTIC_CONFIDENT_SIMILARITY: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(1),
  // Most any one planner call may take, in ms (spec 0043 FR3). 0 means no cap
  // beyond RAG_MAX_LOOP_MS.
  RAG_PLANNER_CALL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(120_000)
    .optional()
    .default(0),
  // Three, not two. Measured planner latency is 2.6-4.4s medians, not the
  // ~10s previously on record — at 10s a call, three searches worst-cased at
  // 45s and would have been unusable; at the real numbers it is about 14s.
  RAG_MAX_SEARCHES: z.coerce.number().int().positive().optional().default(3),
  // Wall-clock for the loop, excluding answer streaming. At the limit the
  // loop stops and the caller answers from what it has, or refuses — never a
  // partial ungrounded answer because time ran out.
  RAG_MAX_LOOP_MS: z.coerce.number().int().positive().optional().default(15000),
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

  // --- Reranking (spec 0036) ---------------------------------------------
  // Off by default, same posture as RAG_AGENTIC_ENABLED and RAG_CRACK_ENABLED
  // above: with this false, `retrieveForOwner` returns the fused order
  // byte-identically and spends no extra call.
  //
  // Turning it on only PERMUTES the fused candidates — see rerank.ts for why
  // that means the similarity gate admits exactly the same set either way,
  // and therefore why this knob cannot move refusal accuracy.
  RAG_RERANK_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  // How many fused candidates get re-scored, counted from the top.
  //
  // This SIZES THE RETRIEVED POOL, it does not merely cap a window over an
  // already-cut list. With reranking on, `retrieveForOwner` fuses, keeps
  // this many candidates, reranks them, applies the similarity gate and only
  // then cuts to `RAG_TOP_K`. Above `RAG_TOP_K` (8) that is the entire
  // point: at 20 the reranker can promote a chunk that fusion ranked 9th
  // into the answer, which is the only thing reranking is actually for.
  //
  // Values below `RAG_TOP_K` are raised to it — a pool smaller than the
  // answer would discard chunks the gate would have kept.
  RAG_RERANK_CANDIDATES: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(20),
  // Which backend scores the candidates (spec 0036 FR2).
  //
  // `local` runs a cross-encoder in-process as WebAssembly — no account, no
  // rate limit, no document text leaving the deployment — and is the
  // default. It costs ~1.5s of retrieval per question (spec 0036).
  // `llm` scores with RAG_PLANNER_MODEL in one completion, over the same NIM
  // account the answer uses; kept as the comparison baseline.
  RAG_RERANK_BACKEND: z.enum(['local', 'llm']).optional().default('local'),
  // Hugging Face model id for the local backend. Must be a single-label
  // cross-encoder with an ONNX int8 export. The default is 23 MB and
  // English; `Xenova/bge-reranker-base` is multilingual and 279 MB.
  RAG_RERANK_LOCAL_MODEL: z
    .string()
    .min(1)
    .optional()
    .default('Xenova/ms-marco-MiniLM-L-6-v2'),
  // Where the local model's weights are cached after the first download.
  // Relative paths resolve against the working directory; in the Docker
  // image that is /app, which the app user owns.
  RAG_RERANK_MODEL_DIR: z
    .string()
    .min(1)
    .optional()
    .default('.cache/rerank-models'),

  // --- Parent–child assembly (spec 0033, 1c) ------------------------------
  // After the similarity gate, two or more admitted chunks of one section
  // run on one page are replaced by that whole run (the "parent"). Nothing
  // is embedded or stored for it, so the gate — and refusal — decide exactly
  // what they decided before; see src/lib/rag/parents.ts. Read by
  // `retrieveForOwner` as the default for `RetrieveOptions.assembleParents`.
  // The parent's size cap is derived (3 x RAG_CHUNK_TOKENS), not configured.
  // Default ON, so only an explicit 'false' turns it off, as with
  // RAG_AGENTIC_ENABLED: `.default()` covers only an unset variable, and an
  // empty or '1' value must not silently mean flat retrieval.
  RAG_PARENT_ASSEMBLY: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
}

export type AiEnvKey = keyof typeof aiEnvShape

export const AI_ENV_KEYS = Object.keys(aiEnvShape) as AiEnvKey[]
