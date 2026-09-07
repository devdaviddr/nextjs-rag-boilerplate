import './load-env'

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { chunks, documents, files, users } from '@/db/schema'
import { env } from '@/lib/env'
import { buildEmbeddingText, chunkPages } from '@/lib/rag/chunk'
import { embedPassages } from '@/lib/rag/embed'
import { extractPdf } from '@/lib/rag/extract'
import { retrieveForOwner } from '@/lib/rag/retrieve'
import { resolveScope } from '@/lib/rag/scope'
import { retrieveDocumentChunks } from '@/lib/rag/retrieve'

/**
 * Retrieval evaluation harness (spec 0027, Recommendation 0).
 *
 * Ingests the corpus in `eval/corpus/` for a dedicated evaluation user, runs
 * the ground-truth questions through the SAME retrieval path the app uses, and
 * reports whether the right passage came back.
 *
 * It measures RETRIEVAL, not generation. Everything downstream is capped by
 * recall, so this is the number that decides whether a retrieval change helped
 * — and unlike an answer-quality judgement, it needs no model to score.
 *
 *   pnpm rag:eval                 # run, print a report
 *   pnpm rag:eval --label hybrid  # save results under that label for comparison
 *   pnpm rag:eval --no-ingest     # reuse what is already indexed
 */

const EVAL_USER_ID = 'eval-harness-user'
const EVAL_USER_EMAIL = 'eval-harness@example.invalid'
const CORPUS_DIR = 'eval/corpus'
const RESULTS_DIR = 'eval/results'

interface Question {
  id: string
  question: string
  document?: string
  page?: number
  answerable: boolean
  hard?: string
}

interface QuestionResult {
  id: string
  question: string
  answerable: boolean
  hard?: string
  /** 1-based rank of the first correct chunk, or null if never retrieved. */
  rank: number | null
  retrieved: number
  topSimilarity: number | null
  topDocument: string | null
  topPage: number | null
  passed: boolean
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`)

async function ensureEvalUser(): Promise<void> {
  await db
    .insert(users)
    .values({ id: EVAL_USER_ID, email: EVAL_USER_EMAIL })
    .onConflictDoNothing()
}

/** Remove everything this harness previously created. Chunks cascade. */
async function clearCorpus(): Promise<void> {
  await db.delete(documents).where(eq(documents.ownerId, EVAL_USER_ID))
  await db.delete(files).where(eq(files.ownerId, EVAL_USER_ID))
}

async function ingestCorpus(): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const pdfs = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.pdf'))
    .sort()

  for (const name of pdfs) {
    const title = name.replace(/\.pdf$/, '')
    const buffer = readFileSync(join(CORPUS_DIR, name))
    const { pages, pageCount } = await extractPdf(buffer)

    const pieces = chunkPages(pages, {
      chunkTokens: env.RAG_CHUNK_TOKENS,
      overlapTokens: env.RAG_CHUNK_OVERLAP_TOKENS,
    })

    const [fileRow] = await db
      .insert(files)
      .values({
        ownerId: EVAL_USER_ID,
        bucketKey: `${EVAL_USER_ID}/${title}-${Date.now()}.pdf`,
        originalName: name,
        mimeType: 'application/pdf',
        sizeBytes: buffer.length,
      })
      .returning()

    const [doc] = await db
      .insert(documents)
      .values({
        ownerId: EVAL_USER_ID,
        fileId: fileRow!.id,
        title,
        status: 'ready',
        pageCount,
      })
      .returning()

    const vectors = await embedPassages(
      pieces.map((piece) =>
        buildEmbeddingText({
          documentTitle: title,
          heading: piece.heading,
          content: piece.content,
        }),
      ),
    )
    await db.insert(chunks).values(
      pieces.map((piece, i) => ({
        documentId: doc!.id,
        ownerId: EVAL_USER_ID,
        content: piece.content,
        heading: piece.heading,
        pageNumber: piece.pageNumber,
        chunkIndex: piece.chunkIndex,
        tokenCount: piece.tokenCount,
        embedding: vectors[i] as number[],
      })),
    )

    titles.set(doc!.id, title)
    console.log(
      `  ingested ${title}: ${pageCount} pages, ${pieces.length} chunks`,
    )
  }
  return titles
}

async function main(): Promise<void> {
  const label = arg('label') ?? 'baseline'
  const { questions } = JSON.parse(
    readFileSync('eval/questions.json', 'utf8'),
  ) as { questions: Question[] }

  console.log(`\nRetrieval evaluation — label: ${label}`)
  console.log(
    `top_k=${env.RAG_TOP_K}  floor=${env.RAG_MIN_SIMILARITY}  ` +
      `chunk=${env.RAG_CHUNK_TOKENS}/${env.RAG_CHUNK_OVERLAP_TOKENS}\n`,
  )

  await ensureEvalUser()
  if (!hasFlag('no-ingest')) {
    console.log('Ingesting corpus...')
    await clearCorpus()
    await ingestCorpus()
    console.log()
  }

  const docRows = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(eq(documents.ownerId, EVAL_USER_ID))
  const titleById = new Map(docRows.map((d) => [d.id, d.title]))

  const results: QuestionResult[] = []

  for (const q of questions) {
    // The same two-path routing the app uses, so the harness measures the
    // real system rather than a convenient subset of it.
    const scope = resolveScope(
      q.question,
      docRows.map((d) => ({ id: d.id, title: d.title })),
    )
    const retrieved =
      scope.mode === 'document'
        ? await retrieveDocumentChunks(
            EVAL_USER_ID,
            scope.documentId,
            env.RAG_DOC_SCOPE_MAX_CHUNKS,
          )
        : await retrieveForOwner(EVAL_USER_ID, q.question)

    let rank: number | null = null
    if (q.answerable) {
      const idx = retrieved.findIndex(
        (r) =>
          titleById.get(r.documentId) === q.document && r.pageNumber === q.page,
      )
      rank = idx === -1 ? null : idx + 1
    }

    const top = retrieved[0]
    results.push({
      id: q.id,
      question: q.question,
      answerable: q.answerable,
      hard: q.hard,
      rank,
      retrieved: retrieved.length,
      topSimilarity: top ? Number(top.similarity.toFixed(3)) : null,
      topDocument: top ? (titleById.get(top.documentId) ?? null) : null,
      topPage: top?.pageNumber ?? null,
      // Answerable: the right chunk must be retrieved at all.
      // Unanswerable: nothing may clear the floor, or the model gets called
      // on irrelevant context.
      passed: q.answerable ? rank !== null : retrieved.length === 0,
    })
  }

  const answerable = results.filter((r) => r.answerable)
  const refusals = results.filter((r) => !r.answerable)
  const ranks = answerable.map((r) => r.rank)
  const hitAt = (k: number) =>
    ranks.filter((r) => r !== null && r <= k).length / answerable.length
  const mrr =
    ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) /
    answerable.length

  console.log('Per question:')
  for (const r of results) {
    const mark = r.passed ? 'PASS' : 'FAIL'
    const where = r.answerable
      ? r.rank === null
        ? 'not retrieved'
        : `rank ${r.rank}`
      : `${r.retrieved} chunk(s) above floor`
    const top =
      r.topDocument === null
        ? '—'
        : `${r.topDocument} p${r.topPage} @ ${r.topSimilarity}`
    console.log(`  ${mark}  ${r.id.padEnd(22)} ${where.padEnd(22)} top: ${top}`)
    if (!r.passed && r.hard) console.log(`        hard case: ${r.hard}`)
  }

  const summary = {
    label,
    at: new Date().toISOString(),
    config: {
      topK: env.RAG_TOP_K,
      minSimilarity: env.RAG_MIN_SIMILARITY,
      chunkTokens: env.RAG_CHUNK_TOKENS,
      overlapTokens: env.RAG_CHUNK_OVERLAP_TOKENS,
      embedModel: env.RAG_EMBED_MODEL,
    },
    metrics: {
      hitAt1: Number(hitAt(1).toFixed(3)),
      hitAt3: Number(hitAt(3).toFixed(3)),
      hitAtK: Number(hitAt(env.RAG_TOP_K).toFixed(3)),
      mrr: Number(mrr.toFixed(3)),
      refusalAccuracy: Number(
        (refusals.filter((r) => r.passed).length / refusals.length).toFixed(3),
      ),
      answerable: answerable.length,
      mustRefuse: refusals.length,
    },
    results,
  }

  console.log('\nSummary')
  console.log(`  hit@1              ${summary.metrics.hitAt1}`)
  console.log(`  hit@3              ${summary.metrics.hitAt3}`)
  console.log(`  hit@${env.RAG_TOP_K}              ${summary.metrics.hitAtK}`)
  console.log(`  MRR                ${summary.metrics.mrr}`)
  console.log(`  refusal accuracy   ${summary.metrics.refusalAccuracy}`)

  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(
    join(RESULTS_DIR, `${label}.json`),
    JSON.stringify(summary, null, 2),
  )
  console.log(`\nSaved eval/results/${label}.json`)

  await db.$client.end()
}

main().catch(async (error) => {
  console.error(error)
  await db.$client.end().catch(() => undefined)
  process.exit(1)
})
