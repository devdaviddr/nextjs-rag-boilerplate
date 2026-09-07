import './load-env'

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { chunks, documents, files, knowledgeBases, users } from '@/db/schema'
import { env } from '@/lib/env'
import { buildEmbeddingText, chunkPages } from '@/lib/rag/chunk'
import { embedPassages } from '@/lib/rag/embed'
import { extractPdf } from '@/lib/rag/extract'
import {
  listReadyDocuments,
  retrieveDocumentChunks,
  retrieveForOwner,
} from '@/lib/rag/retrieve'
import { resolveScope } from '@/lib/rag/scope'

/**
 * Retrieval evaluation harness (spec 0027, Recommendation 0; spec 0028 NFR4).
 *
 * Ingests the corpus in `eval/corpus/` for a dedicated evaluation user, runs
 * the ground-truth questions through the SAME retrieval path the app uses, and
 * reports whether the right passage came back.
 *
 * It measures RETRIEVAL, not generation. Everything downstream is capped by
 * recall, so this is the number that decides whether a retrieval change helped
 * — and unlike an answer-quality judgement, it needs no model to score.
 *
 * Since spec 0028, the corpus is split across TWO knowledge bases (see
 * KNOWLEDGE_BASES below) and the harness also measures cross-KB leakage: the
 * one failure mode nothing here could previously detect even in principle,
 * because there was only ever one pool to search.
 *
 *   pnpm rag:eval                 # run, print a report
 *   pnpm rag:eval --label hybrid  # save results under that label for comparison
 *   pnpm rag:eval --no-ingest     # reuse what is already indexed
 *   pnpm rag:eval --label X --baseline Y   # gate X's refusal accuracy against
 *                                           # saved eval/results/Y.json (default Y=baseline)
 */

const EVAL_USER_ID = 'eval-harness-user'
const EVAL_USER_EMAIL = 'eval-harness@example.invalid'
const CORPUS_DIR = 'eval/corpus'
const RESULTS_DIR = 'eval/results'

/**
 * Which of the two eval knowledge bases each corpus document is filed into.
 *
 * The split has to put the corpus's deliberate cross-document overlap ON the
 * KB boundary, or cross-KB leakage is untestable in principle. The whole
 * reason "staff parking" (facilities-guide) and "fire assembly point"
 * (staff-handbook) share Wellington Street is that a broken KB filter could
 * plausibly surface one for a question that should only ever see the other —
 * but that is only a real test if the two documents are NOT in the same
 * knowledge base. Put them together and every leakage check below would
 * trivially pass for the wrong reason: there would be nothing on the other
 * side of the fence to leak.
 *
 * staff-handbook and employment-contract stay together (both HR-flavoured,
 * and share a second, un-exercised overlap of their own — notice periods),
 * while facilities-guide moves out on its own. That is also the realistic
 * split, not an arbitrary 2-vs-1: a user with one KB for HR/employment
 * paperwork and a separate one for building/facilities admin is exactly the
 * scenario spec 0028 exists for.
 */
const KNOWLEDGE_BASES = [
  {
    name: 'HR & Employment',
    documents: ['staff-handbook', 'employment-contract'],
  },
  {
    name: 'Facilities & Operations',
    documents: ['facilities-guide'],
  },
] as const

function kbNameForDocument(title: string): string {
  const kb = KNOWLEDGE_BASES.find((k) =>
    (k.documents as readonly string[]).includes(title),
  )
  if (!kb) {
    throw new Error(
      `Corpus document "${title}" has no knowledge-base assignment — ` +
        `add it to KNOWLEDGE_BASES in eval/run.ts.`,
    )
  }
  return kb.name
}

interface Question {
  id: string
  question: string
  document?: string
  knowledgeBase?: string
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

/** One chunk that came back from a knowledge base it should never have. */
interface LeakDetail {
  questionId: string
  question: string
  /** The KB(s) the query was scoped to for this check (excludes the answer's KB). */
  scopedTo: string[]
  leakedDocument: string
  leakedPage: number
  /** The KB the leaked chunk actually belongs to. */
  leakedFromKb: string
}

/** A question whose OWN knowledge base, scoped alone, still failed to retrieve it. */
interface ComplementFailure {
  questionId: string
  question: string
  correctKb: string
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

/**
 * Remove everything this harness previously created. Chunks and documents
 * cascade off the knowledge bases they belong to, so deleting `documents` and
 * `knowledgeBases` for this owner is enough — but `documents` is deleted
 * first anyway, explicitly, rather than relying solely on the KB cascade: the
 * same belt-and-braces shape as the rest of this file. Safe to re-run: every
 * delete is scoped to EVAL_USER_ID, and deleting nothing is not an error.
 */
async function clearCorpus(): Promise<void> {
  await db.delete(documents).where(eq(documents.ownerId, EVAL_USER_ID))
  await db.delete(files).where(eq(files.ownerId, EVAL_USER_ID))
  await db
    .delete(knowledgeBases)
    .where(eq(knowledgeBases.ownerId, EVAL_USER_ID))
}

async function ingestCorpus(): Promise<void> {
  // Create both knowledge bases up front so every document insert below has
  // somewhere to point.
  const kbIdByName = new Map<string, string>()
  for (const kb of KNOWLEDGE_BASES) {
    const [row] = await db
      .insert(knowledgeBases)
      .values({ ownerId: EVAL_USER_ID, name: kb.name })
      .returning()
    kbIdByName.set(kb.name, row!.id)
  }

  const pdfs = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.pdf'))
    .sort()

  for (const name of pdfs) {
    const title = name.replace(/\.pdf$/, '')
    const kbName = kbNameForDocument(title)
    const knowledgeBaseId = kbIdByName.get(kbName)!

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
        knowledgeBaseId,
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
        knowledgeBaseId,
        content: piece.content,
        heading: piece.heading,
        pageNumber: piece.pageNumber,
        chunkIndex: piece.chunkIndex,
        tokenCount: piece.tokenCount,
        embedding: vectors[i] as number[],
      })),
    )

    console.log(
      `  ingested ${title} -> "${kbName}": ${pageCount} pages, ${pieces.length} chunks`,
    )
  }
}

async function main(): Promise<void> {
  const label = arg('label') ?? 'baseline'
  const baselineLabel = arg('baseline') ?? 'baseline'
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
    .select({
      id: documents.id,
      title: documents.title,
      knowledgeBaseId: documents.knowledgeBaseId,
    })
    .from(documents)
    .where(eq(documents.ownerId, EVAL_USER_ID))
  const kbRows = await db
    .select({ id: knowledgeBases.id, name: knowledgeBases.name })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.ownerId, EVAL_USER_ID))

  const titleById = new Map(docRows.map((d) => [d.id, d.title]))
  const kbIdByTitle = new Map(docRows.map((d) => [d.title, d.knowledgeBaseId]))
  const docKbById = new Map(docRows.map((d) => [d.id, d.knowledgeBaseId]))
  const kbNameById = new Map(kbRows.map((k) => [k.id, k.name]))
  const allKbIds = kbRows.map((k) => k.id)

  const results: QuestionResult[] = []

  for (const q of questions) {
    // The same two-path routing the app uses, so the harness measures the
    // real system rather than a convenient subset of it. Scoped to ALL of the
    // eval user's knowledge bases — the "everything I own" default a new
    // conversation gets — so this loop reproduces the pre-0028 flat-pool
    // numbers exactly and stays comparable to the recorded baseline.
    const docsInScope = await listReadyDocuments(EVAL_USER_ID, allKbIds)
    const scope = resolveScope(q.question, docsInScope)
    const retrieved =
      scope.mode === 'document'
        ? await retrieveDocumentChunks(EVAL_USER_ID, scope.documentId, allKbIds)
        : await retrieveForOwner(EVAL_USER_ID, q.question, allKbIds)

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

  // Cross-KB leakage (spec 0028 NFR4) — the check nothing before this spec
  // could even express, because there was only ever one pool to search.
  //
  // For every answerable question, run it TWICE more: once scoped to only
  // the knowledge base(s) that do NOT contain its answer (leakage check —
  // the correct value is 0 chunks from anywhere else), and once scoped to
  // ONLY the knowledge base that DOES (the complement — the answer must
  // still come back). The complement matters because a filter bug that
  // returns nothing at all for a wrongly-scoped query would otherwise look
  // identical to a filter that works: both retrieve zero leaked chunks.
  // Checking only the leakage direction would let a broken filter that
  // discards everything "pass" by accident.
  console.log(
    '\nCross-KB leakage check (spec 0028 NFR4) — scoped to the KB WITHOUT the answer:',
  )
  const leaks: LeakDetail[] = []
  const complementFailures: ComplementFailure[] = []

  for (const q of answerable) {
    const question = questions.find((x) => x.id === q.id)!
    const correctKbId = kbIdByTitle.get(question.document!)
    if (!correctKbId) {
      throw new Error(
        `Question "${q.id}" names document "${question.document}", which is ` +
          `not in the ingested corpus.`,
      )
    }
    const wrongKbIds = allKbIds.filter((id) => id !== correctKbId)
    const correctKbName = kbNameById.get(correctKbId)!

    // --- Complement: scoped to ONLY the correct KB, the answer must still be found.
    const docsInCorrectKb = docRows
      .filter((d) => d.knowledgeBaseId === correctKbId)
      .map((d) => ({ id: d.id, title: d.title }))
    const correctScope = resolveScope(question.question, docsInCorrectKb)
    const correctRetrieved =
      correctScope.mode === 'document'
        ? await retrieveDocumentChunks(EVAL_USER_ID, correctScope.documentId, [
            correctKbId,
          ])
        : await retrieveForOwner(EVAL_USER_ID, question.question, [correctKbId])
    const foundCorrect = correctRetrieved.some(
      (r) =>
        titleById.get(r.documentId) === question.document &&
        r.pageNumber === question.page,
    )
    // Only a genuine scoping regression if the SAME question was already
    // found when every KB was selected (the main pass above). A question
    // that already misses at full scope — e.g. "policy-code-hr", a known
    // weak case for exact identifiers documented in docs/rag.md — is not
    // evidence of a KB-scoping bug, and flagging it here would make every
    // future run "fail" on a pre-existing, already-measured miss rather than
    // on something spec 0028 could have broken.
    const foundInMainPass = q.rank !== null
    const complementOk = foundCorrect || !foundInMainPass
    if (!complementOk) {
      complementFailures.push({
        questionId: q.id,
        question: q.question,
        correctKb: correctKbName,
      })
    }

    // --- Leakage: scoped to the OTHER KB(s), nothing from the correct one may appear.
    const docsInWrongKbs = docRows
      .filter((d) => wrongKbIds.includes(d.knowledgeBaseId))
      .map((d) => ({ id: d.id, title: d.title }))
    const wrongScope = resolveScope(question.question, docsInWrongKbs)
    const wrongRetrieved =
      wrongScope.mode === 'document'
        ? await retrieveDocumentChunks(
            EVAL_USER_ID,
            wrongScope.documentId,
            wrongKbIds,
          )
        : await retrieveForOwner(EVAL_USER_ID, question.question, wrongKbIds)

    let leakedHere = 0
    for (const r of wrongRetrieved) {
      const actualKb = docKbById.get(r.documentId)
      if (actualKb && !wrongKbIds.includes(actualKb)) {
        leakedHere += 1
        leaks.push({
          questionId: q.id,
          question: q.question,
          scopedTo: wrongKbIds.map((id) => kbNameById.get(id)!),
          leakedDocument: titleById.get(r.documentId) ?? '(unknown)',
          leakedPage: r.pageNumber,
          leakedFromKb: kbNameById.get(actualKb) ?? '(unknown)',
        })
      }
    }

    const mark = leakedHere === 0 && complementOk ? 'PASS' : 'FAIL'
    const complementLabel = foundCorrect
      ? 'found'
      : foundInMainPass
        ? 'MISSING (regression)'
        : 'missing (pre-existing, see main pass)'
    console.log(
      `  ${mark}  ${q.id.padEnd(22)} correct kb: ${correctKbName.padEnd(24)} ` +
        `leaked: ${leakedHere}  complement: ${complementLabel}`,
    )
  }

  const crossKbLeakage = leaks.length

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
    knowledgeBases: kbRows.map((k) => ({
      id: k.id,
      name: k.name,
      documents: docRows
        .filter((d) => d.knowledgeBaseId === k.id)
        .map((d) => d.title),
    })),
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
      // The only correct value is 0. Any positive count means a chunk from a
      // knowledge base outside the requested selection was returned — the
      // exact failure spec 0028 exists to make impossible (see run() below,
      // which fails the process for this).
      crossKbLeakage,
      crossKbComplementFailures: complementFailures.length,
    },
    crossKbLeaks: leaks,
    crossKbComplementDetails: complementFailures,
    results,
  }

  console.log('\nSummary')
  console.log(`  hit@1              ${summary.metrics.hitAt1}`)
  console.log(`  hit@3              ${summary.metrics.hitAt3}`)
  console.log(`  hit@${env.RAG_TOP_K}              ${summary.metrics.hitAtK}`)
  console.log(`  MRR                ${summary.metrics.mrr}`)
  console.log(`  refusal accuracy   ${summary.metrics.refusalAccuracy}`)
  console.log(`  cross-KB leakage   ${summary.metrics.crossKbLeakage}`)

  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(
    join(RESULTS_DIR, `${label}.json`),
    JSON.stringify(summary, null, 2),
  )
  console.log(`\nSaved eval/results/${label}.json`)

  // --- Hard gates. Both checked; both fail the process loudly and non-zero.
  // Printed after the summary is saved, so a failing run still leaves the
  // full detail on disk for a post-mortem.

  if (crossKbLeakage > 0) {
    console.error(`\n${'!'.repeat(72)}`)
    console.error(
      `CROSS-KB LEAKAGE DETECTED (spec 0028 NFR4) — ${crossKbLeakage} chunk(s) ` +
        `returned from a knowledge base outside the requested scope.`,
    )
    for (const leak of leaks) {
      console.error(
        `  "${leak.question}" (${leak.questionId}) scoped to [${leak.scopedTo.join(', ')}] ` +
          `still returned "${leak.leakedDocument}" p${leak.leakedPage}, which belongs to ` +
          `"${leak.leakedFromKb}".`,
      )
    }
    console.error(
      'The correct value is 0. This is a tenant-scoping bug, not a tuning issue.',
    )
    console.error('!'.repeat(72))
  }

  if (complementFailures.length > 0) {
    console.error(`\n${'!'.repeat(72)}`)
    console.error(
      `CROSS-KB COMPLEMENT CHECK FAILED — ${complementFailures.length} question(s) ` +
        `were not answerable even when scoped to their OWN, correct knowledge base.`,
    )
    for (const f of complementFailures) {
      console.error(
        `  "${f.question}" (${f.questionId}) was not retrieved when scoped to "${f.correctKb}" alone.`,
      )
    }
    console.error(
      'A filter that returns nothing for every scope would pass the leakage check ' +
        'above trivially — this is what catches that.',
    )
    console.error('!'.repeat(72))
  }

  // Refusal-accuracy hard gate (spec 0029 NFR3). This project has already
  // shipped a change that took MRR to 0.971 while silently taking refusal
  // accuracy from 1.000 to 0.000 (eval/results/hybrid-or.json) — every other
  // metric improved, so nothing else would have caught it. Only fires for an
  // explicit --label run being compared against a saved baseline: running
  // the baseline itself has nothing to compare against.
  const explicitLabel = arg('label') !== undefined
  let refusalGateFailed = false
  if (explicitLabel && label !== baselineLabel) {
    const baselinePath = join(RESULTS_DIR, `${baselineLabel}.json`)
    if (existsSync(baselinePath)) {
      const baselineSummary = JSON.parse(
        readFileSync(baselinePath, 'utf8'),
      ) as {
        metrics: { refusalAccuracy: number }
      }
      const baselineRefusal = baselineSummary.metrics.refusalAccuracy
      if (summary.metrics.refusalAccuracy < baselineRefusal) {
        refusalGateFailed = true
        console.error(`\n${'!'.repeat(72)}`)
        console.error(
          `REFUSAL ACCURACY REGRESSION (spec 0029 NFR3) — HARD FAIL, regardless ` +
            `of every other metric.`,
        )
        console.error(
          `  baseline "${baselineLabel}": refusal accuracy ${baselineRefusal}`,
        )
        console.error(
          `  this run  "${label}":        refusal accuracy ${summary.metrics.refusalAccuracy}`,
        )
        console.error(
          '  A retrieval change that trades refusal accuracy for everything else ' +
            'must never ship silently.',
        )
        console.error('!'.repeat(72))
      } else {
        console.log(
          `\nRefusal-accuracy gate: ${summary.metrics.refusalAccuracy} >= ` +
            `baseline "${baselineLabel}" ${baselineRefusal} — OK`,
        )
      }
    } else {
      console.log(
        `\nRefusal-accuracy gate: no ${baselinePath} to compare against — skipped.`,
      )
    }
  }

  await db.$client.end()

  if (
    crossKbLeakage > 0 ||
    complementFailures.length > 0 ||
    refusalGateFailed
  ) {
    process.exit(1)
  }
}

main().catch(async (error) => {
  console.error(error)
  await db.$client.end().catch(() => undefined)
  process.exit(1)
})
