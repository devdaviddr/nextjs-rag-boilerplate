# Extending the agent

**What this covers:** building your own agentic app on this template. It shows
how to give the agent a tool, how to change how documents are split, how to
use a different embedding model, and where retrieval's storage lives if you
want another. It assumes you have read [RAG](rag.md) far enough to know what
the planner and the relevance floor are.

## Add a tool

A tool is something the agent can call while it works out an answer: a
lookup in your own database, a calculation, an internal API. You write one
module and add it to the registry. The planner is offered it next to its
built-in `search_documents`, and nothing else needs to change (spec 0044).

### 1. Write it

This is `src/lib/rag/tools/examples/days-between.ts`, a complete tool:

```ts
import { z } from 'zod'

import { defineTool } from '../types'

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD')
  .describe('A date as YYYY-MM-DD')

/**
 * An example tool (docs/extending.md): the number of days between two
 * dates. Documents give dates and deadlines; models are unreliable at
 * counting days between them. Not registered by default.
 */
export const daysBetweenTool = defineTool({
  name: 'days_between',
  description:
    'Count the days from one date to another. Call this when the answer ' +
    'depends on a number of days between two dates, instead of counting ' +
    'them yourself.',
  schema: z.object({ from: isoDate, to: isoDate }).strict(),
  async run({ from, to }) {
    const start = Date.parse(`${from}T00:00:00Z`)
    const end = Date.parse(`${to}T00:00:00Z`)
    if (Number.isNaN(start) || Number.isNaN(end)) return 'Not a real date.'
    const days = Math.round((end - start) / 86_400_000)
    return `${days} day${Math.abs(days) === 1 ? '' : 's'} from ${from} to ${to}.`
  },
})
```

`defineTool` takes four things:

- **`name`**: what the model calls. Letters, digits, `_` and `-`, and not
  `search_documents` or `read_figure`, which are built in.
- **`description`**: written for the model, not for people. Say when to call
  the tool; the planner decides from this alone.
- **`schema`**: a Zod schema for the arguments. The model is shown it as JSON
  Schema, and whatever it sends is validated against it before `run` sees it.
  Use `.describe()` on fields and `.strict()` on the object: a malformed call
  is reported back to the planner so it can try again.
- **`run(args, context)`**: returns text, or `{ text, tokens }` if it called
  a model. Whatever it returns is shown to the planner, then to the model
  that writes the answer, as fenced data.

### 2. Register it

In `src/lib/rag/tools/index.ts`:

```ts
import { daysBetweenTool } from './examples/days-between'

export const agentTools: AnyAgentTool[] = [daysBetweenTool]
```

That's all. The next question can use it.

### What the model can and can't do

- **It chooses a tool and its arguments, nothing more.** `context` carries the
  user's id, the knowledge bases this conversation may read, and a signal that
  ends when the agent's time budget does. It comes from the session, never
  from the model. A tool that reads data must scope it by `context.userId`, or
  one user's question can reach another user's data. `list-documents.ts` in
  the same folder shows a tool that reads the database this way.
- **A tool result is evidence.** It can answer a question on its own, and the
  answer is checked against it. A question where no tool ran and no document
  passage is relevant enough is still refused without calling the model.
- **A tool call costs a step** of the agent's budget (`RAG_MAX_SEARCHES`), like
  a search.
- **Tools need the agentic path.** With `RAG_AGENTIC_ENABLED=false` none is
  offered. While any tool is registered, every question goes to the planner,
  whatever `RAG_AGENTIC_ROUTE` says.
- **A tool that throws** is logged and becomes a failed step; the answer still
  comes. Each call shows in the chat's Agent activity drawer.
- **A tool that changes things** (sends an email, writes a row) is yours to
  authorise: check `context.userId` may do it before you do it. The model
  decides when to call it, and the model can be talked into things by the
  documents it reads.

### Test it

`runRegisteredTool` runs a tool exactly as the agent does, so a unit test
needs no model:

```ts
const registry = toolRegistry([daysBetweenTool])
const out = await runRegisteredTool(
  registry,
  'days_between',
  '{"from":"2026-01-01","to":"2026-03-01"}',
  { userId: 'u', permittedKbIds: ['kb'], signal: new AbortController().signal },
)
// out?.text === '59 days from 2026-01-01 to 2026-03-01.'
```

`tests/unit/rag-tools.test.ts` has more, including a tool that throws.

## Change how documents are split

Documents are split into passages of about `RAG_CHUNK_TOKENS` tokens (512)
with `RAG_CHUNK_OVERLAP_TOKENS` (64) shared between neighbours. Set them in
`.env` or in Settings → Configuration. Smaller passages make retrieval more
precise and give the writer less around each hit; larger ones the reverse.

A new size applies to documents uploaded afterwards. Existing documents keep
the passages they were split into; delete and upload them again to re-split
them. The splitting itself is `chunkPages` and `chunkElements` in
`src/lib/rag/chunk.ts`, pure functions tested in `tests/unit/rag-chunk.test.ts`
if you need a different strategy. Check what a document became on its page in
the knowledge base (the inspector shows every passage).

## Use a different embedding model

Pick it in Settings → Models → Embeddings. The app asks the model for one
embedding to learn its size (up to 4000 numbers), then re-indexes every
document with it in the background; answers keep using the old index until the
new one is complete. Embeddings use the endpoint in `.env`
(`RAG_LLM_BASE_URL`, `LLM_API_KEY`). See
[RAG → Switching the embedding model](rag.md#switching-the-embedding-model).

The relevance floor, `RAG_MIN_SIMILARITY` (0.35), was measured with the default
model. Another model scores differently, so check that unrelated questions are
still refused after you switch, and tune the floor if they are not.

## Use another vector store

Every SQL statement retrieval runs is in `src/lib/rag/retrieval-store.ts`:
the hybrid search, the section loader, and the document readers. `retrieve.ts`
decides what to fetch and never touches the database. To use another store,
reimplement that module's functions against it. Keep the owner and
knowledge-base filter inside every query, as that file does: it is what stops
one user's question reaching another's documents.

## Coming next

Adding a document format beyond PDF (spec 0046) and a model provider that is
not OpenAI-compatible (spec 0045) will be covered here when they ship.

**Next:** [Architecture](architecture.md) for how the pieces fit, or
[RAG](rag.md) for the retrieval reference.
