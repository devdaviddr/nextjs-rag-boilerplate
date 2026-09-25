import 'server-only'

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

import type { RerankerBackend } from './rerank'

/**
 * A local cross-encoder reranker (spec 0036, backend 1).
 *
 * Runs an ONNX cross-encoder in-process — no account, no rate limit, no
 * document text leaving the deployment, and no sidecar container (NFR3). This
 * is what FR2 asks for: the `llm` backend scores through the same NIM account
 * the answer uses, and was down along with the planner on 2026-09-25.
 *
 * **Why the WebAssembly runtime, not the native one.** The production image is
 * `node:22-alpine`. `onnxruntime-node`'s Linux binaries are built against glibc
 * and fail to load on musl (`ld-linux-aarch64.so.1: No such file`), and
 * Alpine's `gcompat` shim is not enough (`__sprintf_chk: symbol not found`) —
 * both checked 2026-09-25. `onnxruntime-web` runs the same model as WASM with
 * no native code, so it behaves identically on Alpine, Debian and macOS. It
 * scored the boardroom passage 9.42 against -10.66 on Alpine arm64 — the same
 * scores as the native runtime — and 20 passages in ~450ms single-threaded.
 * That is also why `@huggingface/transformers` is not used: its Node build
 * loads the native runtime on import, whichever device is asked for.
 *
 * The model is `RAG_RERANK_LOCAL_MODEL` — by default
 * `Xenova/ms-marco-MiniLM-L-6-v2`, a 23 MB int8 export; `Xenova/bge-reranker-
 * base` is the larger, multilingual option the spec named (279 MB). Its three
 * files are downloaded from the Hugging Face hub on first use into
 * `RAG_RERANK_MODEL_DIR` and read from there afterwards.
 *
 * Scores are the model's raw logits: higher is more relevant, and the scale is
 * only compared within one call, which is all the `RerankerBackend` contract
 * promises.
 */

/** What a loaded model offers: one logit per (question, passage) pair. */
export interface LoadedModel {
  score(question: string, passages: readonly string[]): Promise<number[]>
}

/** The loader, injectable so tests never touch the runtime or the network. */
export type ModelLoader = (
  modelId: string,
  cacheDir: string,
) => Promise<LoadedModel>

/** The files a Hugging Face ONNX cross-encoder export needs. */
export const MODEL_FILES = [
  'tokenizer.json',
  'tokenizer_config.json',
  // The int8 export: a quarter of fp32's size, no measurable ranking cost here.
  'onnx/model_quantized.onnx',
] as const

/** One tokenized (question, passage) pair. */
export interface PairEncoding {
  ids: number[]
  attention_mask: number[]
  token_type_ids: number[]
}

/**
 * Pad a batch of encodings to one length, truncating any longer than
 * `maxLength` — keeping the final token, which is the closing `[SEP]` the
 * model expects. The question comes first in every pair, so truncation only
 * ever cuts passage text.
 */
export function padBatch(
  encodings: readonly PairEncoding[],
  maxLength: number,
  padId = 0,
): { length: number; ids: number[]; mask: number[]; types: number[] } {
  const clip = (xs: number[]) =>
    xs.length <= maxLength ? xs : [...xs.slice(0, maxLength - 1), xs.at(-1)!]
  const clipped = encodings.map((e) => ({
    ids: clip(e.ids),
    mask: clip(e.attention_mask),
    types: clip(e.token_type_ids),
  }))
  const length = Math.max(...clipped.map((e) => e.ids.length))
  const pad = (xs: number[], value: number) => [
    ...xs,
    ...Array<number>(length - xs.length).fill(value),
  ]
  return {
    length,
    ids: clipped.flatMap((e) => pad(e.ids, padId)),
    mask: clipped.flatMap((e) => pad(e.mask, 0)),
    types: clipped.flatMap((e) => pad(e.types, 0)),
  }
}

/**
 * The directory weights are cached in, resolved against the working dir.
 *
 * `turbopackIgnore` matters: the standalone tracer cannot tell what a
 * `process.cwd()`-relative path will be, so without it the build copies the
 * ENTIRE project — source, docs, coverage, `.env` — into `.next/standalone`,
 * and from there into the Docker image. Seen on this branch before the
 * annotation: 132 MB of output where main is 83 MB.
 */
export function modelCacheDir(configured: string): string {
  return isAbsolute(configured)
    ? configured
    : join(/* turbopackIgnore: true */ process.cwd(), configured)
}

/**
 * A model file from the cache, downloading it on a miss. Written to a
 * temporary name and renamed, so a download interrupted halfway never leaves
 * a truncated file that later loads as a corrupt model.
 */
export async function cachedModelFile(
  modelId: string,
  file: string,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const path = join(cacheDir, modelId, file)
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    // Not cached yet.
  }
  const url = `https://huggingface.co/${modelId}/resolve/main/${file}`
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`model download failed: ${url} → ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  await mkdir(dirname(path), { recursive: true })
  const partial = `${path}.partial-${process.pid}`
  await writeFile(partial, bytes)
  await rename(partial, path)
  return bytes
}

const loadFromHub: ModelLoader = async (modelId, cacheDir) => {
  const [ort, { Tokenizer }] = await Promise.all([
    import('onnxruntime-web'),
    import('@huggingface/tokenizers'),
  ])
  const [tokenizerJson, configJson, modelBytes] = await Promise.all(
    MODEL_FILES.map((f) => cachedModelFile(modelId, f, cacheDir)),
  )
  const decode = (bytes: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  const config = decode(configJson!)
  const tokenizer = new Tokenizer(decode(tokenizerJson!), config)
  const maxLength = Math.min(Number(config.model_max_length) || 512, 512)

  // Threads need worker files the image does not trace; one thread scores a
  // 20-passage window in well under a second, which is inside the budget.
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(modelBytes!, {
    executionProviders: ['wasm'],
  })

  return {
    async score(question, passages) {
      const batch = padBatch(
        passages.map((passage) =>
          tokenizer.encode(question, {
            text_pair: passage,
            return_token_type_ids: true,
          }),
        ),
        maxLength,
      )
      const tensor = (values: number[]) =>
        new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [
          passages.length,
          batch.length,
        ])
      const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
        input_ids: tensor(batch.ids),
        attention_mask: tensor(batch.mask),
      }
      // BERT-family exports take segment ids; XLM-R ones (bge) do not.
      if (session.inputNames.includes('token_type_ids')) {
        feeds.token_type_ids = tensor(batch.types)
      }
      const output = await session.run(feeds)
      const logits = output[session.outputNames[0]!]
      return Array.from(logits!.data as Float32Array)
    },
  }
}

/**
 * After a failed load, how long to wait before trying again. Without it a
 * missing network or a bad model id would retry — and log — on every query.
 */
const RETRY_AFTER_MS = 60_000

/**
 * Build a local reranker. `loader` is for tests; the app uses the default,
 * through `localReranker` below.
 */
export function createLocalReranker(
  loader: ModelLoader = loadFromHub,
  now: () => number = Date.now,
): RerankerBackend {
  let loading: Promise<LoadedModel> | null = null
  let failedAt: number | null = null

  const load = (): Promise<LoadedModel> | null => {
    if (loading) return loading
    if (failedAt !== null && now() - failedAt < RETRY_AFTER_MS) return null

    const modelId = env.RAG_RERANK_LOCAL_MODEL
    const started = now()
    loading = loader(modelId, modelCacheDir(env.RAG_RERANK_MODEL_DIR)).then(
      (loaded) => {
        failedAt = null
        logger.info('local reranker loaded', {
          model: modelId,
          elapsedMs: now() - started,
        })
        return loaded
      },
      (error: unknown) => {
        // Forget the failed promise so a later call can retry, after the
        // back-off. The caller treats the throw as "keep fusion order".
        loading = null
        failedAt = now()
        throw error
      },
    )
    return loading
  }

  return {
    name: 'local',
    async score(question, passages, signal) {
      if (passages.length === 0) return null
      // Inference cannot be interrupted once started, so an already-aborted
      // request is checked here, before any work.
      if (signal?.aborted) return null

      const pending = load()
      // Inside the back-off after a failed load: no scores, fusion order.
      if (!pending) return null
      const model = await pending
      if (signal?.aborted) return null

      const scores = await model.score(question, passages)
      return scores.length === passages.length ? scores : null
    },
  }
}

/** The app's local backend; one model per process, loaded on first use. */
export const localReranker: RerankerBackend = createLocalReranker()
