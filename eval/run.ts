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
import { runAgenticRetrieval } from '@/lib/rag/agentic-run'
import { buildEmbeddingText } from '@/lib/rag/chunk'
import { createChatCompletion } from '@/lib/rag/client'
import { chunksFromPdf } from '@/lib/rag/crack'
import { embedPassages } from '@/lib/rag/embed'
import {
  listReadyDocuments,
  retrieveDocumentChunks,
  retrieveForOwner,
  type RetrievedChunk,
} from '@/lib/rag/retrieve'
import type { RewriteTurn } from '@/lib/rag/rewrite'
import { SYSTEM_PROMPT, buildUserMessage } from '@/lib/rag/prompt'
import { resolveScope } from '@/lib/rag/scope'
import { putObject } from '@/lib/storage/client'

/**
 * Retrieval evaluation harness (spec 0027, Recommendation 0; spec 0028 NFR4;
 * spec 0029 Evaluation, NFR3).
 *
 * Ingests the corpus in `eval/corpus/` for a dedicated evaluation user, runs
 * the ground-truth questions through the SAME retrieval path the app uses, and
 * reports whether the right passage came back.
 *
 * It measures RETRIEVAL, not generation. Everything downstream is capped by
 * recall, so this is the number that decides whether a retrieval change helped
 * — and unlike an answer-quality judgement, it needs no model to score. This
 * stays true for the agentic path too: `--compare` scores `runAgenticRetrieval`'s
 * returned chunks, never the drafted prose or the citation-verification pass.
 *
 * Since spec 0028, the corpus is split across TWO knowledge bases (see
 * KNOWLEDGE_BASES below) and the harness also measures cross-KB leakage: the
 * one failure mode nothing here could previously detect even in principle,
 * because there was only ever one pool to search.
 *
 * Since spec 0029, `eval/questions.json` also carries `followup` and
 * `multi-hop` questions (see the Question interface below), and `--compare`
 * runs every question through BOTH the fixed pipeline and the agentic loop in
 * one invocation, side by side.
 *
 * Since spec 0032, BOTH passes are timed and both get a cost block (see
 * `PassCost` / `costSummary`). Before that only the agentic pass recorded
 * anything: `latencyMs`, `searches` and `tokensUsed` were written by
 * `agenticRetrieve` and by nothing else. So the project's own comparison table
 * cited "~1s" for the fixed path — a number lifted from prose in
 * `docs/rag.md`, and a MEDIAN at that ("Median 9–11s per question against
 * ~1s"), printed in a column headed "mean latency" beside a genuine mean of
 * 11,080ms from the agentic pass. Latency is the entire argument against the
 * loop and half of it had never been measured, which is why spec 0032 could
 * not settle the trade off the recorded numbers.
 *
 *   pnpm rag:eval                 # run the fixed pipeline, print a report
 *   pnpm rag:eval --label hybrid  # save results under that label for comparison
 *   pnpm rag:eval --no-ingest     # reuse what is already indexed
 *   pnpm rag:eval --label X --baseline Y   # gate X's refusal accuracy against
 *                                           # saved eval/results/Y.json (default Y=baseline)
 *   pnpm rag:eval --answers       # ALSO generate answers and assert against
 *                                 # them (spec 0031). Measures GENERATION, so
 *                                 # it is reported separately and never folded
 *                                 # into hit@k. Costs one chat call per
 *                                 # checked question.
 *   pnpm rag:eval --compare       # ALSO run the agentic path; save
 *                                 # eval/results/{baseline,agentic}.json; print
 *                                 # ONE comparison carrying both passes'
 *                                 # quality AND cost; gate on refusal accuracy
 *                                 # in the SAME run (0029 NFR3)
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
    documents: [
      'facilities-guide',
      // Spec 0031's layout documents. Filed here because they are
      // facilities-flavoured, and because keeping them out of the HR knowledge
      // base leaves the existing cross-KB leakage checks measuring exactly what
      // they measured before.
      'site-operations-report',
      'maintenance-log',
      'plant-services-manual',
    ],
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

/** One turn of prior conversation, oldest first — see `followup` questions. */
interface Turn {
  role: 'user' | 'assistant'
  content: string
}

/** One (document, page) fact a `multi-hop` answer must draw from. */
interface AnswerFact {
  document: string
  page: number
}

type QuestionType = 'single-hop' | 'followup' | 'multi-hop' | 'layout'

interface Question {
  id: string
  /** Defaults to 'single-hop' — every question from before spec 0029. */
  type?: QuestionType
  question: string
  document?: string
  knowledgeBase?: string
  page?: number
  answerable: boolean
  hard?: string
  /**
   * `followup` only: the conversation before `question`. The baseline path
   * ignores this entirely and embeds `question` literally — that omission IS
   * the behaviour spec 0029 exists to fix, not a bug in the harness. The
   * agentic path is given these turns so its planner can resolve the
   * reference.
   */
  turns?: Turn[]
  /**
   * `multi-hop` only: every (document, page) pair the answer must draw from.
   * A single `document`/`page` cannot express "needs two documents", so
   * multi-hop questions use this instead and leave `document`/`page` unset.
   */
  answerDocuments?: AnswerFact[]
  /**
   * Substrings the generated answer must contain (spec 0031).
   *
   * Retrieval metrics cannot see a flattened table or interleaved columns: the
   * right page comes back either way, so hit@1 reports a pass while the chunk
   * is unusable. Only an ANSWER can show the difference — "388" is either in it
   * or it is not.
   */
  answerMustContain?: string[]
  /**
   * A regex the generated answer must NOT match.
   *
   * The guard for a value that exists only as a bar height: the answer must
   * decline rather than state a number nobody wrote down.
   */
  answerMustNotMatch?: string
}

function questionType(q: Question): QuestionType {
  return q.type ?? 'single-hop'
}

interface QuestionResult {
  id: string
  type: QuestionType
  question: string
  answerable: boolean
  hard?: string
  /** 1-based rank of the first correct chunk. null if never retrieved, or N/A for multi-hop. */
  rank: number | null
  /** multi-hop only: rank of each required fact, parallel to `answerDocuments`. */
  factRanks?: (number | null)[]
  retrieved: number
  topSimilarity: number | null
  topDocument: string | null
  topPage: number | null
  passed: boolean
  /**
   * Wall-clock milliseconds this question's retrieval took. Populated for
   * EVERY row on BOTH passes since spec 0032.
   *
   * It used to be written by `agenticRetrieve` alone, and that omission is why
   * the recorded comparison had a measured mean on one side and a remembered
   * "~1s" on the other. Both passes are now timed identically — `Date.now()`
   * either side of the single call that does the retrieval, nothing else
   * between the two reads — so the two columns are the same statistic rather
   * than two different ones printed next to each other.
   */
  latencyMs?: number
  /**
   * Loop-only, populated by the agentic pass alone: the fixed pipeline has no
   * iterations to count, no planner tokens to spend and no termination reason.
   *
   * Deliberately left UNDEFINED on baseline rows rather than set to 0, and
   * carried through to the saved JSON as `null` and to the report as `n/a`. A
   * 0 in a "mean searches" column beside the agentic path's 1.44 reads as a
   * measurement — "the fixed path searched zero times" — when the honest
   * statement is that the question does not apply to it. Silently turning "not
   * applicable" into "zero" is the same class of error as quoting a latency
   * that was never measured.
   */
  searches?: number
  tokensUsed?: number
  termination?: string
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
/** One answer-level check and what it found. */
interface AnswerCheck {
  questionId: string
  question: string
  passed: boolean
  answer: string
  /** Which expectation failed, for a report that says what broke. */
  detail: string
}

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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

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
    // The SAME path production ingestion takes, cracking included (spec 0031).
    // This used to be a local copy of extract-then-chunk, which quietly stopped
    // matching `ingest.ts` the moment cracking existed — the harness reported
    // no change because it was still measuring the old pipeline.
    const {
      chunks: pieces,
      pageCount,
      extraction,
    } = await chunksFromPdf(buffer, {
      chunkTokens: env.RAG_CHUNK_TOKENS,
      overlapTokens: env.RAG_CHUNK_OVERLAP_TOKENS,
    })

    // Upload the PDF for real. `read_figure` (spec 0031 FR9) fetches the
    // stored object to re-render a page, so a `files` row pointing at a key
    // that was never written makes the tool untestable here — the harness
    // would report "could not read the figure" for a reason that exists only
    // in the harness. Same principle as routing ingestion through
    // `chunksFromPdf`: measure the real path or do not claim to measure it.
    const bucketKey = `${EVAL_USER_ID}/${title}-${Date.now()}.pdf`
    await putObject(bucketKey, buffer, 'application/pdf')

    const [fileRow] = await db
      .insert(files)
      .values({
        ownerId: EVAL_USER_ID,
        bucketKey,
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
        pagesProcessed: pageCount,
        extraction,
      })
      .returning()

    const vectors = await embedPassages(
      pieces.map((piece) =>
        buildEmbeddingText({
          documentTitle: title,
          heading: piece.heading,
          caption: piece.caption,
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
        kind: piece.kind ?? 'text',
        bbox: piece.bbox ?? null,
        embedding: vectors[i] as number[],
      })),
    )

    console.log(
      `  ingested ${title} -> "${kbName}": ${pageCount} pages, ${pieces.length} chunks` +
        (extraction
          ? ` (${extraction.parseCalls} parse calls, ` +
            `${extraction.pages.filter((p) => p.outcome === 'parsed').length} pages cracked)`
          : ''),
    )
  }
}

/** 1-based rank of the first chunk matching (document, page), or null. */
function findRank(
  retrieved: readonly RetrievedChunk[],
  titleById: ReadonlyMap<string, string>,
  document: string,
  page: number,
): number | null {
  const idx = retrieved.findIndex(
    (r) => titleById.get(r.documentId) === document && r.pageNumber === page,
  )
  return idx === -1 ? null : idx + 1
}

/**
 * Score one question against what a retrieval path returned.
 *
 * Three shapes, deliberately kept apart rather than unified into one generic
 * "found the right thing" boolean, because "the right thing" means something
 * different for each type:
 *   - refusal (`answerable: false`): passing means NOTHING cleared the floor.
 *   - single-hop / followup: passing means the one named chunk was retrieved.
 *   - multi-hop: passing means EVERY required fact was retrieved — a partial
 *     answer (one document found, the other missed) is exactly the failure
 *     this question type exists to catch, so it does not get partial credit.
 */
function scoreQuestion(
  q: Question,
  retrieved: readonly RetrievedChunk[],
  titleById: ReadonlyMap<string, string>,
): { rank: number | null; factRanks?: (number | null)[]; passed: boolean } {
  if (questionType(q) === 'multi-hop') {
    const facts = q.answerDocuments ?? []
    const factRanks = facts.map((f) =>
      findRank(retrieved, titleById, f.document, f.page),
    )
    const passed = facts.length > 0 && factRanks.every((rank) => rank !== null)
    return { rank: null, factRanks, passed }
  }
  if (!q.answerable) {
    return { rank: null, passed: retrieved.length === 0 }
  }
  const rank = findRank(retrieved, titleById, q.document!, q.page!)
  return { rank, passed: rank !== null }
}

function buildResult(
  q: Question,
  retrieved: readonly RetrievedChunk[],
  titleById: ReadonlyMap<string, string>,
  extra: {
    searches?: number
    latencyMs?: number
    tokensUsed?: number
    termination?: string
  } = {},
): QuestionResult {
  const { rank, factRanks, passed } = scoreQuestion(q, retrieved, titleById)
  const top = retrieved[0]
  return {
    id: q.id,
    type: questionType(q),
    question: q.question,
    answerable: q.answerable,
    hard: q.hard,
    rank,
    factRanks,
    retrieved: retrieved.length,
    topSimilarity: top ? Number(top.similarity.toFixed(3)) : null,
    topDocument: top ? (titleById.get(top.documentId) ?? null) : null,
    topPage: top?.pageNumber ?? null,
    passed,
    ...extra,
  }
}

function logResult(r: QuestionResult): void {
  const mark = r.passed ? 'PASS' : 'FAIL'
  let where: string
  if (r.type === 'multi-hop') {
    where = (r.factRanks ?? [])
      .map((rank) => (rank === null ? 'missing' : `rank ${rank}`))
      .join(' + ')
  } else if (r.answerable) {
    where = r.rank === null ? 'not retrieved' : `rank ${r.rank}`
  } else {
    where = `${r.retrieved} chunk(s) above floor`
  }
  const top =
    r.topDocument === null
      ? '—'
      : `${r.topDocument} p${r.topPage} @ ${r.topSimilarity}`
  const tag = `[${r.type}]`.padEnd(13)
  // Latency sits on the main line for both passes, and has been taken OFF the
  // loop-detail line below. Both passes report it now, so it should appear in
  // the same place for both — a reader scanning the baseline pass and then the
  // agentic pass should not have to look for the same number in two different
  // shapes of line. The detail line keeps only what the fixed pipeline has no
  // counterpart for.
  const took = r.latencyMs === undefined ? '' : `  ${r.latencyMs}ms`
  console.log(
    `  ${mark}  ${tag}${r.id.padEnd(32)} ${where.padEnd(24)} ` +
      `top: ${took === '' ? top : top.padEnd(36)}${took}`,
  )
  if (r.searches !== undefined) {
    console.log(
      `        searches: ${r.searches}  tokens: ${r.tokensUsed}  ` +
        `termination: ${r.termination}`,
    )
  }
  if (!r.passed && r.hard) console.log(`        hard case: ${r.hard}`)
}

/**
 * The baseline path a real request takes: `resolveScope` picks whole-document
 * vs. similarity search, exactly as `eval/run.ts` measured before spec 0029.
 *
 * `q.turns` is never read here — see the note on `Question.turns` above. A
 * `followup` question's pronoun-bearing text is embedded exactly as typed.
 *
 * Timed since spec 0032, the same way `agenticRetrieve` is timed: `Date.now()`
 * either side, `resolveScope` inside the window because deciding whole-document
 * vs. similarity IS part of the fixed pipeline's work, and nothing else in
 * between. Until then this pass recorded nothing at all, which left the
 * comparison table quoting prose for the half of the trade that matters most.
 *
 * Note what the resulting mean deliberately pools. A whole-document question
 * never calls the embedding API and returns in single-digit milliseconds; a
 * similarity question pays one embedding round-trip to the same rate-limited
 * account the agentic pass hammers. Both are requests a real deployment
 * serves, so both are in the mean — the same posture `costSummary` takes
 * towards the agentic pass's different termination reasons. `medianLatencyMs`
 * and `maxLatencyMs` are reported beside the mean precisely because that pool
 * is bimodal and a lone mean would hide it.
 */
async function baselineRetrieve(
  q: Question,
  ownerId: string,
  kbIds: readonly string[],
  docsInScope: { id: string; title: string }[],
): Promise<{ chunks: RetrievedChunk[]; latencyMs: number }> {
  const startedAt = Date.now()
  const scope = resolveScope(q.question, docsInScope)
  const chunks =
    scope.mode === 'document'
      ? await retrieveDocumentChunks(ownerId, scope.documentId, kbIds)
      : await retrieveForOwner(ownerId, q.question, kbIds)
  return { chunks, latencyMs: Date.now() - startedAt }
}

/**
 * The agentic path (spec 0029): call `runAgenticRetrieval` directly, the same
 * way the chat route would if `RAG_AGENTIC_ENABLED` were on — the harness
 * does this regardless of that flag so one run scores both paths without
 * flipping env vars between them.
 *
 * Only retrieval is scored, same posture as the rest of this file: drafting
 * and citation verification are downstream of recall and need no model to
 * evaluate here, and skipping them roughly halves the real API calls this
 * costs on a rate-limited free tier.
 */
async function agenticRetrieve(
  q: Question,
  ownerId: string,
  kbIds: readonly string[],
  documents: readonly { id: string; title: string }[],
): Promise<{
  chunks: RetrievedChunk[]
  searches: number
  latencyMs: number
  tokensUsed: number
  termination: string
}> {
  const turns: RewriteTurn[] = q.turns ?? []
  const controller = new AbortController()
  // A safety net, not the real bound — RAG_MAX_LOOP_MS (15s) is what actually
  // stops the loop. This is insurance against a hang the budget checks
  // somehow miss, set well above the spec's measured ~14s worst case.
  const timeout = setTimeout(() => controller.abort(), 45_000)
  const startedAt = Date.now()
  try {
    const outcome = await runAgenticRetrieval({
      userId: ownerId,
      documents,
      permittedKbIds: kbIds,
      question: q.question,
      turns,
      onStep: (phase, iteration) => {
        const suffix = iteration ? ` (${iteration})` : ''
        process.stdout.write(`    ...${phase}${suffix}\r`)
      },
      signal: controller.signal,
    })
    return {
      chunks: outcome.chunks,
      searches: outcome.searches,
      latencyMs: Date.now() - startedAt,
      tokensUsed: outcome.tokensUsed,
      termination: outcome.termination,
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Generate an answer and check it against the question's expectations.
 *
 * Deliberately NOT folded into hit@k. This measures generation, the harness's
 * headline numbers measure retrieval, and mixing them would make one number
 * move for two unrelated reasons. It also costs a chat call per checked
 * question, which is why it is opt-in behind `--answers`.
 *
 * The prompt is the app's own `SYSTEM_PROMPT` + `buildUserMessage`, not a
 * variant written for the harness — the same reason ingestion goes through
 * `chunksFromPdf`.
 */
async function runAnswerChecks(
  questions: readonly Question[],
  retrievedById: Map<string, RetrievedChunk[]>,
): Promise<AnswerCheck[]> {
  const checks: AnswerCheck[] = []

  for (const q of questions) {
    const wants = q.answerMustContain ?? []
    const forbids = q.answerMustNotMatch
    if (wants.length === 0 && !forbids) continue

    const chunks = retrievedById.get(q.id) ?? []
    if (chunks.length === 0) {
      checks.push({
        questionId: q.id,
        question: q.question,
        passed: !q.answerable,
        answer:
          '(nothing retrieved — the system refuses without calling the model)',
        detail: q.answerable
          ? 'expected an answer but retrieval returned nothing'
          : 'refused, as required',
      })
      continue
    }

    const { choice } = await createChatCompletion(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(q.question, chunks) },
      ],
      { maxTokens: 400, temperature: 0.2 },
    )
    const answer = (choice.message?.content ?? '').trim()

    const missing = wants.filter((want) => !answer.includes(want))
    const forbidden = forbids ? new RegExp(forbids, 'i').exec(answer) : null

    checks.push({
      questionId: q.id,
      question: q.question,
      passed: missing.length === 0 && !forbidden,
      answer,
      detail:
        missing.length > 0
          ? `missing ${missing.map((m) => JSON.stringify(m)).join(', ')}`
          : forbidden
            ? `stated ${JSON.stringify(forbidden[0])}, which the documents never print`
            : 'ok',
    })

    // Spaced out, same as the agentic pass: a free tier rate-limits rather
    // than bills, so a burst is the thing to avoid.
    await new Promise((resolve) => setTimeout(resolve, 400))
  }

  return checks
}

interface CoreMetrics {
  hitAt1: number
  hitAt3: number
  hitAtK: number
  mrr: number
  refusalAccuracy: number
  answerable: number
  mustRefuse: number
}

/**
 * hit@k / MRR / refusal accuracy, computed over whichever slice is passed in.
 *
 * The headline numbers reported at the top of a run are computed over
 * `type === 'single-hop'` ONLY — the original 20 questions, byte-for-byte
 * unchanged by spec 0029 — specifically so they stay comparable to the
 * recorded baseline (hit@1 0.941, hit@3 0.941, MRR 0.941, refusal 1.000).
 * Mixing the new `followup`/`multi-hop` questions into that pool would move
 * those numbers for a reason that has nothing to do with a retrieval
 * regression. They get their own metrics instead — see `multiHopMetrics` and
 * the followup section in `main`.
 */
function coreMetrics(results: readonly QuestionResult[]): CoreMetrics {
  const answerable = results.filter((r) => r.answerable)
  const refusals = results.filter((r) => !r.answerable)
  const ranks = answerable.map((r) => r.rank)
  const hitAt = (k: number) =>
    answerable.length === 0
      ? 0
      : ranks.filter((r) => r !== null && r <= k).length / answerable.length
  const mrr =
    answerable.length === 0
      ? 0
      : ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) /
        answerable.length
  return {
    hitAt1: Number(hitAt(1).toFixed(3)),
    hitAt3: Number(hitAt(3).toFixed(3)),
    hitAtK: Number(hitAt(env.RAG_TOP_K).toFixed(3)),
    mrr: Number(mrr.toFixed(3)),
    refusalAccuracy:
      refusals.length === 0
        ? 1
        : Number(
            (refusals.filter((r) => r.passed).length / refusals.length).toFixed(
              3,
            ),
          ),
    answerable: answerable.length,
    mustRefuse: refusals.length,
  }
}

interface MultiHopMetrics {
  count: number
  /** Fraction of multi-hop questions where EVERY required fact was retrieved. */
  fullMatchRate: number
  /** Fraction of individual required facts retrieved, pooled across all multi-hop questions. */
  factRecall: number
}

function multiHopMetrics(results: readonly QuestionResult[]): MultiHopMetrics {
  const rows = results.filter((r) => r.type === 'multi-hop')
  const allFacts = rows.flatMap((r) => r.factRanks ?? [])
  return {
    count: rows.length,
    fullMatchRate:
      rows.length === 0
        ? 0
        : Number(
            (rows.filter((r) => r.passed).length / rows.length).toFixed(3),
          ),
    factRecall:
      allFacts.length === 0
        ? 0
        : Number(
            (
              allFacts.filter((f) => f !== null).length / allFacts.length
            ).toFixed(3),
          ),
  }
}

/**
 * The per-question cost profile of ONE retrieval pass.
 *
 * Every field the fixed pipeline structurally cannot have is `number | null`
 * rather than `number`, and the baseline block sets those to `null`. See the
 * note on `QuestionResult.searches` for why "not applicable" must not be
 * flattened to 0 on its way into a comparison table.
 */
interface PassCost {
  /** How many questions the figures below are pooled over. */
  questions: number
  /**
   * Mean, median and slowest wall-clock ms per question.
   *
   * All three, because the first two answer different questions and the
   * project had already confused them once: the recorded comparison put
   * `docs/rag.md`'s MEDIAN for the fixed path in a column headed "mean
   * latency" beside the agentic path's genuine mean. Printing both, each
   * labelled, makes that particular substitution unavailable. `maxLatencyMs`
   * is here because a mean over ~25 questions hides the one question that took
   * four times as long, and for a decision about a default that outlier is the
   * number a reader actually needs.
   */
  meanLatencyMs: number
  medianLatencyMs: number
  maxLatencyMs: number
  /** Loop-only. null for the fixed pipeline, which searches exactly once by construction. */
  meanSearches: number | null
  /** Loop-only. null for the fixed pipeline, which sends no planner tokens at all. */
  meanTokensUsed: number | null
  /** Loop-only. null for the fixed pipeline, which has no loop to terminate. */
  terminationCounts: Record<string, number> | null
}

/**
 * Which cost fields a pass can meaningfully report.
 *
 * Passed in explicitly rather than sniffed off the rows (`r.searches !==
 * undefined`), so a pass that legitimately measured zero searches can never be
 * mistaken for a pass that has no searches to measure. The distinction only
 * matters at the edges today, but it is exactly the distinction this whole
 * change exists to keep straight.
 */
type PassKind = 'fixed' | 'agentic'

/**
 * Latency (and, for the agentic pass, searches / tokens / termination
 * reasons) over EVERY question the pass ran — answerable, refusal, followup,
 * multi-hop alike. The full per-question cost profile a real deployment would
 * see, not just the cases that happen to succeed.
 *
 * This is the number the whole A/B exists to surface: cost is the entire
 * argument against the agentic path, so it is reported beside the quality
 * metrics rather than filed away separately. Until spec 0032 it was computed
 * for the agentic pass only, which made "beside" half true. Both passes go
 * through this one function now, so the two blocks in a comparison are
 * guaranteed to be the same statistic computed the same way — the one property
 * the old report could not honestly claim.
 */
function costSummary(
  results: readonly QuestionResult[],
  kind: PassKind,
): PassCost {
  const n = results.length
  const sum = (f: (r: QuestionResult) => number) =>
    results.reduce((total, r) => total + f(r), 0)

  // Latency is averaged over the rows that actually carry a timing, not over
  // `n`. Both passes time every row today, so the two divisors are identical —
  // but a future pass that skips a question would otherwise report a mean
  // dragged towards zero by rows that were never measured, which is the bug
  // this function was written to stop repeating.
  const latencies = results
    .map((r) => r.latencyMs)
    .filter((ms): ms is number => ms !== undefined)
    .sort((a, b) => a - b)
  const mid = Math.floor(latencies.length / 2)
  const medianLatencyMs =
    latencies.length === 0
      ? 0
      : latencies.length % 2 === 1
        ? latencies[mid]!
        : Math.round((latencies[mid - 1]! + latencies[mid]!) / 2)

  const terminationCounts: Record<string, number> = {}
  for (const r of results) {
    const t = r.termination ?? 'unknown'
    terminationCounts[t] = (terminationCounts[t] ?? 0) + 1
  }

  // The one place "not applicable" is turned into `null` rather than a number.
  // A single helper for all three loop-only fields, so no future field can be
  // added that quietly reports 0 for the fixed pipeline.
  const loopMean = (
    field: (r: QuestionResult) => number,
    decimals: number,
  ): number | null => {
    if (kind === 'fixed') return null
    if (n === 0) return 0
    return Number((sum(field) / n).toFixed(decimals))
  }

  return {
    questions: n,
    meanLatencyMs:
      latencies.length === 0
        ? 0
        : Math.round(sum((r) => r.latencyMs ?? 0) / latencies.length),
    medianLatencyMs,
    maxLatencyMs: latencies.length === 0 ? 0 : latencies[latencies.length - 1]!,
    meanSearches: loopMean((r) => r.searches ?? 0, 2),
    meanTokensUsed: loopMean((r) => r.tokensUsed ?? 0, 0),
    terminationCounts: kind === 'fixed' ? null : terminationCounts,
  }
}

interface DocRow {
  id: string
  title: string
  knowledgeBaseId: string
}

/**
 * Cross-KB leakage + complement check (spec 0028 NFR4).
 *
 * Restricted to `single-hop` and `followup` questions — both have a single
 * `document`/`page`/`knowledgeBase`, which is what this check is built
 * around. `multi-hop` questions name two documents that may span the check's
 * "correct KB" notion in ways the original check was never designed for, so
 * they are excluded rather than bent to fit.
 *
 * Deliberately NOT re-run through the agentic path. The KB boundary this
 * checks is enforced in `retrieve.ts`'s SQL — `AND c.knowledge_base_id =
 * ANY($kbIds)` — which is the SAME function the agentic loop's `search`
 * callback calls with the SAME `permittedKbIds`. The planner supplies a query
 * string and, at most, a `documentId` hint; it has no parameter through which
 * to touch which knowledge bases are searched (spec 0029's security section).
 * Re-running this scoped-down check through several extra planner calls per
 * question would spend real, rate-limited API budget to re-verify code that
 * cannot behave differently depending on which path called it. So the number
 * reported for BOTH paths in `--compare` is this single, cheap, model-free
 * check — a documented decision, not an oversight.
 */
async function crossKbCheck(
  results: readonly QuestionResult[],
  questions: readonly Question[],
  docRows: readonly DocRow[],
  kbIdByTitle: ReadonlyMap<string, string>,
  docKbById: ReadonlyMap<string, string>,
  kbNameById: ReadonlyMap<string, string>,
  allKbIds: readonly string[],
  titleById: ReadonlyMap<string, string>,
): Promise<{ leaks: LeakDetail[]; complementFailures: ComplementFailure[] }> {
  console.log(
    '\nCross-KB leakage check (spec 0028 NFR4) — scoped to the KB WITHOUT the answer:',
  )
  const leaks: LeakDetail[] = []
  const complementFailures: ComplementFailure[] = []

  const checkable = results.filter(
    (r) => r.answerable && r.type !== 'multi-hop',
  )

  for (const q of checkable) {
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

    // Two embedding calls just happened (complement + leakage). Paced the
    // same way as the agentic pass, for the same reason — see the cooldown
    // comment at this function's call site.
    await sleep(150)
  }

  return { leaks, complementFailures }
}

function printGates(
  crossKbLeakage: number,
  leaks: readonly LeakDetail[],
  complementFailures: readonly ComplementFailure[],
): void {
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
}

/** Right-pad a formatted number/string into a column of fixed width. */
function col(value: string | number, width = 12): string {
  return String(value).padEnd(width)
}

function formatDelta(base: number, candidate: number): string {
  const delta = candidate - base
  if (delta === 0) return '±0'
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toFixed(3)}`
}

/**
 * Render a cost figure that a pass may not have.
 *
 * `n/a` and not `0`, `-`, or a blank cell. It has to be a word a reader parses
 * as "this pass cannot have this number", because the failure mode being fixed
 * is precisely a reader taking an absent measurement for a measured zero.
 */
function costCell(value: number | null, unit = ''): string {
  return value === null ? 'n/a' : `${value}${unit}`
}

/**
 * Delta for a cost row, in the row's own units.
 *
 * `formatDelta` above is built for 0–1 rates and prints three decimals, which
 * turns an 11-second latency gap into "+10931.000". Cost rows get their own
 * formatter instead. When either side is not applicable the delta is `n/a`
 * rather than a difference invented against an absent number.
 */
function formatCostDelta(
  base: number | null,
  candidate: number | null,
  unit = '',
): string {
  if (base === null || candidate === null) return 'n/a'
  const delta = Number((candidate - base).toFixed(2))
  if (delta === 0) return '±0'
  return `${delta > 0 ? '+' : ''}${delta}${unit}`
}

async function main(): Promise<void> {
  const compare = hasFlag('compare')
  const label = arg('label') ?? 'baseline'
  const baselineLabel = arg('baseline') ?? 'baseline'
  const { questions } = JSON.parse(
    readFileSync('eval/questions.json', 'utf8'),
  ) as { questions: Question[] }

  console.log(
    compare
      ? '\nA/B evaluation — spec 0029'
      : `\nRetrieval evaluation — label: ${label}`,
  )
  console.log(
    `top_k=${env.RAG_TOP_K}  floor=${env.RAG_MIN_SIMILARITY}  ` +
      `chunk=${env.RAG_CHUNK_TOKENS}/${env.RAG_CHUNK_OVERLAP_TOKENS}` +
      (compare
        ? `  planner=${env.RAG_PLANNER_MODEL}  maxSearches=${env.RAG_MAX_SEARCHES}  maxLoopMs=${env.RAG_MAX_LOOP_MS}\n`
        : '\n'),
  )

  await ensureEvalUser()
  if (!hasFlag('no-ingest')) {
    console.log('Ingesting corpus...')
    await clearCorpus()
    await ingestCorpus()
    console.log()
  }

  const docRows: DocRow[] = await db
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

  // Fixed across every question — the "everything I own" default a new
  // conversation gets — so hoisted out of the per-question loop rather than
  // refetched each time.
  const docsInScope = await listReadyDocuments(EVAL_USER_ID, allKbIds)

  // --- Baseline pass: the fixed pipeline, exactly what `pnpm rag:eval` has
  // always measured. Scored for every question type — followup and
  // multi-hop included — because that is the whole point of adding them:
  // measuring how the pipeline that CANNOT use conversation history or
  // search twice does on exactly the cases designed to need that.
  console.log('Baseline (fixed pipeline) — per question:')
  const baselineResults: QuestionResult[] = []
  // Kept so `--answers` can generate from exactly what retrieval returned,
  // rather than retrieving a second time and scoring a different context.
  const retrievedById = new Map<string, RetrievedChunk[]>()
  for (const q of questions) {
    const outcome = await baselineRetrieve(
      q,
      EVAL_USER_ID,
      allKbIds,
      docsInScope,
    )
    retrievedById.set(q.id, outcome.chunks)
    // Only `latencyMs`. `searches`, `tokensUsed` and `termination` are left
    // off entirely rather than passed as 0 — see QuestionResult's note.
    const result = buildResult(q, outcome.chunks, titleById, {
      latencyMs: outcome.latencyMs,
    })
    baselineResults.push(result)
    logResult(result)
  }

  // --- Agentic pass, ONLY under --compare: real NVIDIA calls, several per
  // question (routing is free; planning is not). Spaced out rather than
  // fired back to back, so a run doesn't trip the free tier's rate limit on
  // its own.
  const agenticResults: QuestionResult[] = []
  if (compare) {
    console.log('\nAgentic (spec 0029 loop) — per question:')
    for (const q of questions) {
      // Same KB-scoped list the chat route builds, so whole-document intent
      // resolves here exactly as it does in the product.
      const agenticDocs = await listReadyDocuments(EVAL_USER_ID, allKbIds)
      const outcome = await agenticRetrieve(
        q,
        EVAL_USER_ID,
        allKbIds,
        agenticDocs,
      )
      const result = buildResult(q, outcome.chunks, titleById, {
        searches: outcome.searches,
        latencyMs: outcome.latencyMs,
        tokensUsed: outcome.tokensUsed,
        termination: outcome.termination,
      })
      agenticResults.push(result)
      logResult(result)
      await sleep(400)
    }
  }

  // --- Cross-KB leakage + complement (spec 0028 NFR4). Computed once, off
  // the baseline pass's results — see crossKbCheck's own comment for why this
  // is not re-run through the agentic path.
  //
  // Under --compare this runs immediately after ~25 questions' worth of
  // planner tool calls. Measured directly: firing this check's ~34 more
  // embedding calls back to back with no gap right after that burst produced
  // spurious complement "failures" — embedQuery returned 200 OK but the
  // resulting vectors did not cluster correctly, for documents the SAME
  // check finds correctly seconds later once the account is no longer under
  // sustained load. A short cooldown here is cheap insurance against
  // reporting a rate-limit artifact as a knowledge-base-scoping regression.
  if (compare) await sleep(3000)
  const { leaks, complementFailures } = await crossKbCheck(
    baselineResults,
    questions,
    docRows,
    kbIdByTitle,
    docKbById,
    kbNameById,
    allKbIds,
    titleById,
  )
  const crossKbLeakage = leaks.length

  const baselineSingleHop = baselineResults.filter(
    (r) => r.type === 'single-hop',
  )
  const baselineFollowup = baselineResults.filter((r) => r.type === 'followup')
  // Spec 0031. Kept out of the headline pool for the same reason `followup` and
  // `multi-hop` are: these questions are designed to FAIL until cracking ships,
  // and folding them into the single-hop numbers would show up as a retrieval
  // regression against the recorded baseline that nothing regressed.
  const baselineLayout = baselineResults.filter((r) => r.type === 'layout')
  const baselineCore = coreMetrics(baselineSingleHop)
  const baselineFollowupCore = coreMetrics(baselineFollowup)
  const baselineLayoutCore = coreMetrics(baselineLayout)
  const baselineMultiHop = multiHopMetrics(baselineResults)
  // Pooled over every question the pass ran, exactly like the agentic block —
  // not over the single-hop headline slice. Cost does not care which slice a
  // question belongs to, and pooling the two blocks differently would put two
  // incomparable numbers side by side in the comparison table, which is the
  // failure this change exists to remove rather than relocate.
  const baselineCost = costSummary(baselineResults, 'fixed')

  // --- Answer-level checks (spec 0031). Opt-in: they cost a chat call per
  // checked question, and they measure generation rather than retrieval.
  let answerChecks: AnswerCheck[] = []
  if (hasFlag('answers')) {
    console.log('\nAnswer checks — generating from the retrieved context:')
    answerChecks = await runAnswerChecks(questions, retrievedById)
    for (const check of answerChecks) {
      console.log(
        `  ${check.passed ? 'PASS' : 'FAIL'}  ${check.questionId} — ${check.detail}`,
      )
      if (!check.passed) {
        console.log(
          `        answer: ${check.answer.replace(/\s+/g, ' ').slice(0, 220)}`,
        )
      }
    }
    const failed = answerChecks.filter((c) => !c.passed).length
    console.log(
      `  ${answerChecks.length - failed}/${answerChecks.length} answer checks passed`,
    )
  }

  const baselineSummary = {
    label: compare ? 'baseline' : label,
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
    // Headline metrics: single-hop only, so this stays comparable to the
    // recorded baseline (hit@1 0.941, hit@3 0.941, MRR 0.941, refusal 1.000).
    metrics: {
      ...baselineCore,
      crossKbLeakage,
      crossKbComplementFailures: complementFailures.length,
    },
    followup: baselineFollowupCore,
    layout: baselineLayoutCore,
    multiHop: baselineMultiHop,
    // New in spec 0032, and purely additive: older files in eval/results/ have
    // no `cost` key at all, and the only field this harness ever reads back
    // out of a saved file is `metrics.refusalAccuracy` (the --baseline gate
    // below), so every historical record still parses and still gates.
    cost: baselineCost,
    crossKbLeaks: leaks,
    crossKbComplementDetails: complementFailures,
    answerChecks,
    results: baselineResults,
  }

  console.log('\nBaseline summary (single-hop, n=%d)', baselineSingleHop.length)
  console.log(`  hit@1              ${baselineCore.hitAt1}`)
  console.log(`  hit@3              ${baselineCore.hitAt3}`)
  console.log(`  hit@${env.RAG_TOP_K}              ${baselineCore.hitAtK}`)
  console.log(`  MRR                ${baselineCore.mrr}`)
  console.log(`  refusal accuracy   ${baselineCore.refusalAccuracy}`)
  console.log(`  cross-KB leakage   ${crossKbLeakage}`)
  console.log(
    `\nBaseline followup (n=${baselineFollowup.length}): hit@1 ${baselineFollowupCore.hitAt1}  ` +
      `hit@3 ${baselineFollowupCore.hitAt3}  MRR ${baselineFollowupCore.mrr}`,
  )
  console.log(
    `Baseline multi-hop (n=${baselineMultiHop.count}): full-match ${baselineMultiHop.fullMatchRate}  ` +
      `fact recall ${baselineMultiHop.factRecall}`,
  )
  console.log(
    `Baseline layout (n=${baselineLayout.length}): hit@1 ${baselineLayoutCore.hitAt1}  ` +
      `hit@3 ${baselineLayoutCore.hitAt3}  MRR ${baselineLayoutCore.mrr}  ` +
      `refusal ${baselineLayoutCore.refusalAccuracy}`,
  )
  for (const row of baselineLayout.filter((r) => !r.passed)) {
    console.log(`    ✗ ${row.id} — ${row.hard ?? 'no note'}`)
  }

  // Printed on EVERY run, not only under --compare. A plain `pnpm rag:eval`
  // should be able to answer "how long does the fixed path take?" out of its
  // own output; the last time nobody could, the answer got copied out of a
  // paragraph in docs/rag.md and into a results table.
  console.log(
    `\nBaseline cost (n=${baselineCost.questions} questions, every type, ` +
      `answerable and refusal alike):`,
  )
  console.log(`  mean latency/question    ${baselineCost.meanLatencyMs}ms`)
  console.log(`  median latency/question  ${baselineCost.medianLatencyMs}ms`)
  console.log(`  slowest question         ${baselineCost.maxLatencyMs}ms`)
  console.log(
    `  searches/tokens          n/a — the fixed pipeline searches exactly once ` +
      `by construction and sends no planner tokens`,
  )

  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(
    join(RESULTS_DIR, `${baselineSummary.label}.json`),
    JSON.stringify(baselineSummary, null, 2),
  )
  console.log(`\nSaved eval/results/${baselineSummary.label}.json`)

  printGates(crossKbLeakage, leaks, complementFailures)

  // --- Refusal-accuracy hard gate against a SAVED baseline file (unchanged
  // from before spec 0029) — only meaningful outside --compare, for gating
  // one fixed-pipeline config change against another (e.g. hybrid vs dense).
  let savedLabelGateFailed = false
  const explicitLabel = arg('label') !== undefined
  if (!compare && explicitLabel && label !== baselineLabel) {
    const baselinePath = join(RESULTS_DIR, `${baselineLabel}.json`)
    if (existsSync(baselinePath)) {
      const saved = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
        metrics: { refusalAccuracy: number }
      }
      const savedRefusal = saved.metrics.refusalAccuracy
      if (baselineCore.refusalAccuracy < savedRefusal) {
        savedLabelGateFailed = true
        console.error(`\n${'!'.repeat(72)}`)
        console.error(
          `REFUSAL ACCURACY REGRESSION (spec 0029 NFR3) — HARD FAIL, regardless ` +
            `of every other metric.`,
        )
        console.error(
          `  baseline "${baselineLabel}": refusal accuracy ${savedRefusal}`,
        )
        console.error(
          `  this run  "${label}":        refusal accuracy ${baselineCore.refusalAccuracy}`,
        )
        console.error(
          '  A retrieval change that trades refusal accuracy for everything else ' +
            'must never ship silently.',
        )
        console.error('!'.repeat(72))
      } else {
        console.log(
          `\nRefusal-accuracy gate: ${baselineCore.refusalAccuracy} >= ` +
            `baseline "${baselineLabel}" ${savedRefusal} — OK`,
        )
      }
    } else {
      console.log(
        `\nRefusal-accuracy gate: no ${baselinePath} to compare against — skipped.`,
      )
    }
  }

  // --- The A/B, if asked for. Everything below this line is additive to the
  // baseline-only flow above; a plain `pnpm rag:eval` never reaches it.
  let compareGateFailed = false
  if (compare) {
    const agenticSingleHop = agenticResults.filter(
      (r) => r.type === 'single-hop',
    )
    const agenticFollowup = agenticResults.filter((r) => r.type === 'followup')
    const agenticCore = coreMetrics(agenticSingleHop)
    const agenticFollowupCore = coreMetrics(agenticFollowup)
    const agenticMultiHop = multiHopMetrics(agenticResults)
    const agenticCost = costSummary(agenticResults, 'agentic')

    const agenticSummary = {
      label: 'agentic',
      at: new Date().toISOString(),
      config: {
        topK: env.RAG_TOP_K,
        minSimilarity: env.RAG_MIN_SIMILARITY,
        chunkTokens: env.RAG_CHUNK_TOKENS,
        overlapTokens: env.RAG_CHUNK_OVERLAP_TOKENS,
        embedModel: env.RAG_EMBED_MODEL,
        plannerModel: env.RAG_PLANNER_MODEL,
        maxSearches: env.RAG_MAX_SEARCHES,
        maxLoopMs: env.RAG_MAX_LOOP_MS,
        maxLoopTokens: env.RAG_MAX_LOOP_TOKENS,
      },
      knowledgeBases: baselineSummary.knowledgeBases,
      // Same slice, same reason as baselineSummary.metrics: single-hop only,
      // so the two headline rows are directly comparable.
      metrics: {
        ...agenticCore,
        // The KB boundary is enforced by the same SQL regardless of caller —
        // see crossKbCheck's comment. Reported here for a complete, uniform
        // results file, not because it was independently re-measured.
        crossKbLeakage,
        crossKbComplementFailures: complementFailures.length,
      },
      followup: agenticFollowupCore,
      multiHop: agenticMultiHop,
      // Same `PassCost` shape as baselineSummary.cost, computed by the same
      // function, so the two files can be diffed field by field. Gains
      // `questions`, `medianLatencyMs` and `maxLatencyMs` over the block
      // recorded on 2026-09-07; the four fields that block already had keep
      // their names and meanings.
      cost: agenticCost,
      results: agenticResults,
    }

    writeFileSync(
      join(RESULTS_DIR, 'agentic.json'),
      JSON.stringify(agenticSummary, null, 2),
    )
    console.log('\nSaved eval/results/agentic.json')

    // --- The comparison table. Delta column so "is agentic better" is read
    // off the page, not reconstructed by the reader from two separate runs.
    //
    // Quality sections first, then a cost section, both passes in every one of
    // them: the whole trade inside one banner-delimited block. Splitting
    // quality (two columns) from cost (one column, agentic only) is what made
    // the previous report impossible to act on without going elsewhere for the
    // missing column.
    console.log(`\n${'='.repeat(78)}`)
    console.log(
      'A/B comparison — single-hop (n=%d), the recorded-baseline slice',
      baselineSingleHop.length,
    )
    console.log('='.repeat(78))
    console.log(
      `  ${col('metric', 20)}${col('baseline')}${col('agentic')}${col('delta')}`,
    )
    console.log(
      `  ${col('hit@1', 20)}${col(baselineCore.hitAt1)}${col(agenticCore.hitAt1)}${col(formatDelta(baselineCore.hitAt1, agenticCore.hitAt1))}`,
    )
    console.log(
      `  ${col('hit@3', 20)}${col(baselineCore.hitAt3)}${col(agenticCore.hitAt3)}${col(formatDelta(baselineCore.hitAt3, agenticCore.hitAt3))}`,
    )
    console.log(
      `  ${col('MRR', 20)}${col(baselineCore.mrr)}${col(agenticCore.mrr)}${col(formatDelta(baselineCore.mrr, agenticCore.mrr))}`,
    )
    console.log(
      `  ${col('refusal accuracy', 20)}${col(baselineCore.refusalAccuracy)}${col(agenticCore.refusalAccuracy)}${col(formatDelta(baselineCore.refusalAccuracy, agenticCore.refusalAccuracy))}`,
    )
    console.log(
      `  ${col('cross-KB leakage', 20)}${col(crossKbLeakage)}${col(crossKbLeakage)}${col('shared *')}`,
    )
    console.log(
      '  * enforced by the same SQL filter regardless of caller — see crossKbCheck; not independently re-run.',
    )

    console.log(
      `\nFollowup (n=${baselineFollowup.length}) — the case spec 0029 exists for:`,
    )
    console.log(
      `  ${col('metric', 20)}${col('baseline')}${col('agentic')}${col('delta')}`,
    )
    console.log(
      `  ${col('hit@1', 20)}${col(baselineFollowupCore.hitAt1)}${col(agenticFollowupCore.hitAt1)}${col(formatDelta(baselineFollowupCore.hitAt1, agenticFollowupCore.hitAt1))}`,
    )
    console.log(
      `  ${col('hit@3', 20)}${col(baselineFollowupCore.hitAt3)}${col(agenticFollowupCore.hitAt3)}${col(formatDelta(baselineFollowupCore.hitAt3, agenticFollowupCore.hitAt3))}`,
    )
    console.log(
      `  ${col('MRR', 20)}${col(baselineFollowupCore.mrr)}${col(agenticFollowupCore.mrr)}${col(formatDelta(baselineFollowupCore.mrr, agenticFollowupCore.mrr))}`,
    )

    console.log(`\nMulti-hop (n=${baselineMultiHop.count}):`)
    console.log(
      `  ${col('metric', 20)}${col('baseline')}${col('agentic')}${col('delta')}`,
    )
    console.log(
      `  ${col('full-match rate', 20)}${col(baselineMultiHop.fullMatchRate)}${col(agenticMultiHop.fullMatchRate)}${col(formatDelta(baselineMultiHop.fullMatchRate, agenticMultiHop.fullMatchRate))}`,
    )
    console.log(
      `  ${col('fact recall', 20)}${col(baselineMultiHop.factRecall)}${col(agenticMultiHop.factRecall)}${col(formatDelta(baselineMultiHop.factRecall, agenticMultiHop.factRecall))}`,
    )

    // --- Cost, BOTH passes, in the same banner-delimited report as the
    // quality numbers above and in the same baseline/agentic/delta shape.
    //
    // Cost is the entire argument against the loop, so it belongs beside the
    // argument for it — and both columns here are now measurements taken in
    // this run. The old block printed the agentic figures alone, which meant
    // anyone assembling the trade had to fetch the other half from somewhere
    // else; what they fetched was a median out of docs/rag.md prose, and it
    // ended up in a column labelled "mean latency".
    // Both passes run the same question list, so the two counts are equal in
    // practice — printed separately anyway if they ever diverge, because a
    // header claiming one n over two differently-sized pools is how a
    // comparison table starts lying.
    const costN =
      baselineCost.questions === agenticCost.questions
        ? `n=${baselineCost.questions} questions per pass`
        : `n=${baselineCost.questions} baseline / ${agenticCost.questions} agentic`
    console.log(`\nCost (${costN}, every type, answerable and refusal alike):`)
    console.log(
      `  ${col('metric', 20)}${col('baseline')}${col('agentic')}${col('delta')}`,
    )
    const costRow = (
      name: string,
      base: number | null,
      candidate: number | null,
      unit = '',
    ) =>
      console.log(
        `  ${col(name, 20)}${col(costCell(base, unit))}${col(costCell(candidate, unit))}` +
          `${col(formatCostDelta(base, candidate, unit))}`,
      )
    costRow(
      'mean latency',
      baselineCost.meanLatencyMs,
      agenticCost.meanLatencyMs,
      'ms',
    )
    costRow(
      'median latency',
      baselineCost.medianLatencyMs,
      agenticCost.medianLatencyMs,
      'ms',
    )
    costRow(
      'slowest question',
      baselineCost.maxLatencyMs,
      agenticCost.maxLatencyMs,
      'ms',
    )
    costRow(
      'mean searches',
      baselineCost.meanSearches,
      agenticCost.meanSearches,
    )
    costRow(
      'mean tokens',
      baselineCost.meanTokensUsed,
      agenticCost.meanTokensUsed,
    )
    console.log(
      `  ${col('termination', 20)}${col('n/a')}${Object.entries(
        agenticCost.terminationCounts ?? {},
      )
        .map(([k, v]) => `${k}=${v}`)
        .join('  ')}`,
    )
    console.log(
      '  n/a above is not zero: the fixed pipeline searches exactly once by construction,',
    )
    console.log(
      '  sends no planner tokens and has no loop to terminate — those rows do not apply to it.',
    )

    // The trade in one line. A ratio rather than only a difference, because
    // "+10931ms" and "74x" land very differently on a reader deciding whether
    // to flip a default, and the ratio is the one spec 0032 has to weigh
    // against the followup and multi-hop gains printed above.
    if (baselineCost.meanLatencyMs > 0) {
      const slower = agenticCost.meanLatencyMs / baselineCost.meanLatencyMs
      console.log(
        `\n  The trade: the agentic path costs ${slower.toFixed(1)}x the fixed path's mean ` +
          `latency\n  (${agenticCost.meanLatencyMs}ms vs ${baselineCost.meanLatencyMs}ms) ` +
          `for the quality deltas above. Both measured in this run.`,
      )
    }
    console.log('='.repeat(78))

    // --- NFR3, the hard gate this whole comparison exists to enforce:
    // refusal accuracy must not regress, checked in THIS run rather than
    // against a stale saved file, and naming exactly which question(s)
    // flipped so a regression is diagnosable, not just a red number.
    if (agenticCore.refusalAccuracy < baselineCore.refusalAccuracy) {
      compareGateFailed = true
      const regressed = baselineSingleHop
        .filter((b) => !b.answerable && b.passed)
        .filter((b) => {
          const a = agenticSingleHop.find((x) => x.id === b.id)
          return a !== undefined && !a.passed
        })
      console.error(`\n${'!'.repeat(72)}`)
      console.error(
        'REFUSAL ACCURACY REGRESSION (spec 0029 NFR3) — HARD FAIL, regardless ' +
          'of every other metric in this comparison.',
      )
      console.error(
        `  baseline refusal accuracy: ${baselineCore.refusalAccuracy}`,
      )
      console.error(
        `  agentic  refusal accuracy: ${agenticCore.refusalAccuracy}`,
      )
      for (const r of regressed) {
        const a = agenticSingleHop.find((x) => x.id === r.id)
        console.error(
          `  regressed: "${r.question}" (${r.id}) — baseline refused correctly, ` +
            `agentic surfaced ${a?.retrieved ?? '?'} chunk(s) above the floor ` +
            `(top similarity ${a?.topSimilarity ?? '?'}).`,
        )
      }
      console.error(
        '  More attempts means more chances to clear the similarity floor by luck ' +
          '— this is exactly the risk spec 0029 names. The floor, not this gate, is ' +
          'what needs revisiting if it fires.',
      )
      console.error('!'.repeat(72))
    } else {
      console.log(
        `\nRefusal-accuracy gate (0029 NFR3): agentic ${agenticCore.refusalAccuracy} >= ` +
          `baseline ${baselineCore.refusalAccuracy} — OK`,
      )
    }
  }

  await db.$client.end()

  if (
    crossKbLeakage > 0 ||
    complementFailures.length > 0 ||
    savedLabelGateFailed ||
    compareGateFailed
  ) {
    process.exit(1)
  }
}

main().catch(async (error) => {
  console.error(error)
  await db.$client.end().catch(() => undefined)
  process.exit(1)
})
