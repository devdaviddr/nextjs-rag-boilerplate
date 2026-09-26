# Tutorial — build a RAG system step by step

**You'll learn:** how retrieval-augmented generation actually works. You take a
fresh clone of this repo to a running app that answers a question from your own
PDF and cites the page the answer came from, and you understand every step
along the way.

---

## What you are about to build

By the end of this page you will have a document chat running on your machine.
You upload a PDF, ask a question about it, and get an answer with a page
citation next to it. If you ask something the PDF does not cover, the app tells
you so instead of making something up.

The technique underneath is **retrieval-augmented generation**, usually
shortened to RAG. The problem it solves is simple to state. A language model
knows what was in its training data and nothing else, and your staff handbook
was not in there. Ask a raw chat model "how many days of annual leave do I
get?" and it will still answer, fluently and confidently, from something it
half-remembers about employment law in general. That failure is called
hallucination, and asking the model nicely does not prevent it.

RAG fixes this. Before you let the model speak, you search your own documents
and hand it only the passages you found. The model's job shrinks from "know the
answer" to "read these passages and write the answer". Because the passages are
real rows from your text, you can show the reader exactly which document and
which page each claim came from. An answer built this way is grounded in your
documents instead of merely sounding plausible.

Everything else in this tutorial (chunking, embeddings, vector indexes,
similarity floors) is machinery in service of that idea. You will meet each
piece at the point where it becomes necessary.

### What you need

- Node.js ≥ 20.9 (22 recommended) and [pnpm](https://pnpm.io)
  (`corepack enable`)
- Docker, for a local Postgres and object store
- An API key for an OpenAI-compatible inference endpoint. This tutorial assumes
  a free [NVIDIA NIM](https://build.nvidia.com) key, which works and is
  rate-limited instead of billed per token.

Set aside about an hour. Stages 1 to 6 are the core and take roughly half of
that. Stages 7 and 8 are measurement, and they are worth doing while you still
remember what you built.

### The stages

| Stage                                                                    | What you do                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| [1. Get it running](#stage-1--get-it-running)                            | Postgres, object storage, schema, dev server           |
| [2. Make a knowledge base](#stage-2--make-a-knowledge-base)              | Create the boundary every search happens inside        |
| [3. Upload a PDF](#stage-3--upload-a-pdf-and-watch-it-become-searchable) | Extract, chunk, embed, index: the four ingestion steps |
| [4. Look at what it made](#stage-4--look-at-what-ingestion-made)         | Read the rows and the indexes in SQL                   |
| [5. Ask a question](#stage-5--ask-a-question-and-trace-what-happens)     | Follow one question through the whole pipeline         |
| [6. Make it refuse](#stage-6--make-it-refuse)                            | The point of the entire system                         |
| [7. Score retrieval](#stage-7--score-retrieval-with-pnpm-rageval)        | `pnpm rag:eval`, and what the numbers mean             |
| [8. The agentic loop](#stage-8-optional--turn-on-the-agentic-loop)       | Optional: let the model direct its own searching       |

---

## Stage 1 — get it running

In this stage you start a database and an object store, create the schema, seed
a login, and run the app.

A RAG system needs three stores. The database holds the searchable pieces of
your documents. Not just any Postgres will do, because searching by meaning
needs the `pgvector` extension, which the `pgvector/pgvector:pg17` image ships
and stock `postgres` does not. The object store (MinIO here, an S3-compatible
server) holds the original PDF files, so a citation can open the real page for
you to read. The inference endpoint runs the models. Everything else is
ordinary Next.js.

Run these commands. Each step is safe to re-run.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure the environment
cp .env.example .env
npx auth secret            # writes AUTH_SECRET into .env
# then set NVIDIA_API_KEY in .env

# 3. Start Postgres + MinIO, apply the schema, seed a demo user
pnpm docker:db
pnpm docker:minio
pnpm db:migrate
pnpm db:seed               # → demo@example.com / Password123

# 4. Run
pnpm dev                   # http://localhost:3000
```

`pnpm db:migrate` applies the committed migrations under `drizzle/`.
`pnpm db:seed` prints a line for each role it creates and each role it assigns,
and leaves you a `demo@example.com` / `Password123` login. `pnpm dev` serves
the app on `http://localhost:3000`.

If you skipped the API key, the app still boots. The documents panel shows
_"Document chat isn't configured on this deployment. Set NVIDIA_API_KEY to
enable uploads and chat."_ and the upload button stays disabled. You can read
the rest of the template, but this tutorial needs the key from stage 3 onwards.

`src/lib/env.ts` validates every value in `.env` at boot, so a malformed
setting fails immediately with a message naming the variable instead of
surfacing as a strange error later. The full table is in
[Usage → Environment variables](usage.md#environment-variables).

---

## Stage 2 — make a knowledge base

Now sign in and create one named collection to put documents in.

A **knowledge base** is a named collection of documents belonging to one user,
and every search happens inside one. It matters for two reasons. The obvious
one is tidiness: HR paperwork in one place, building and facilities admin in
another. The more important one is that scope is a security boundary. A
conversation is pinned to a set of knowledge bases when it is created, and
retrieval cannot see outside that set. The restriction lives in the SQL `WHERE`
clause of every retrieval query. It is neither an instruction to the model nor
a filter applied to results afterwards, and unlike a model, a `WHERE` clause
cannot be argued with. [RAG → Two guarantees](rag.md#two-guarantees) spells out
both guarantees this app makes.

Follow these steps:

1. Open `http://localhost:3000` and sign in as `demo@example.com` /
   `Password123`.
2. Go to `/documents`, the "Knowledge bases" page.
3. Click **New knowledge base**. Give it a name; a description is optional.
4. Open it. You land on that knowledge base's own page, where its documents
   live.

You should see an empty knowledge base with the message _"No documents yet.
Upload a PDF to get started."_ and an **Upload PDF** button.

---

## Stage 3 — upload a PDF and watch it become searchable

In this stage you upload one PDF and watch four things happen to it.

A PDF is not searchable by meaning. It takes four steps to make it so, and
together they are the **ingestion** job, the half of RAG that runs once per
document. The other half, answering, runs once per question and is covered in
stage 5.

Use a PDF whose answers you already know. This repo ships three small ones for
its evaluation harness, and `eval/corpus/staff-handbook.pdf` is a good first
document. It has four pages, one section per page, with facts you can check
against `eval/make-corpus.mjs`. Page 1 says the annual leave entitlement is 20
working days per calendar year and carries the policy reference `POL-HR-014`.
Page 3 puts the fire assembly point on Wellington Street. Your own PDF works
too, as long as it is a real text PDF and not a scan.

Click **Upload PDF**, choose the file, and watch the status badge on the row.
It moves through these labels in order, one for each of the four steps:

| Badge        | Underlying status | What is happening                            |
| ------------ | ----------------- | -------------------------------------------- |
| **Queued**   | `pending`         | The file is stored; work has not started yet |
| **Reading**  | `extracting`      | Text is being pulled out of the PDF          |
| **Indexing** | `embedding`       | Passages are being turned into numbers       |
| **Ready**    | `ready`           | The document is searchable                   |

A four-page document gets through all of that in seconds. A 200-page one takes
a few minutes, because indexing means hundreds of calls to the embedding
endpoint. The work runs in the background, separately from your upload request,
so nothing blocks. The page polls the status for you.

Here is what each step does.

Extract pulls the readable text out of the PDF, one page at a time. This app
does it in-process with the [`unpdf`](https://github.com/unjs/unpdf) library,
so there is no sidecar container and it works offline. The page number is
attached from this first step, and keeping it is the only reason a citation can
later say "page 3" and be right.

A scanned PDF has no text to extract. It is a picture of text, and reading text
out of a picture is OCR, which this app does not do. Extraction rejects such a
file instead of ingesting an empty document. If you try one, the row turns
**Failed** and shows the reason: _"No selectable text found — this looks like a
scanned PDF. OCR is not supported yet, so it cannot be added to your knowledge
base."_ An upload that refuses is better than a knowledge base that silently
contains nothing.

Chunk cuts each page into short passages. A whole document is too coarse to
search: knowing that "this 90-page handbook is relevant" does not answer
anything. So the text is cut into **chunks** of a few paragraphs each, stored
as their own rows. A chunk is the unit that gets retrieved, cited and shown.
Two rules shape the cutting here. Chunks never span a page boundary, which
keeps every citation resolvable to an exact page. And consecutive chunks
overlap by a few dozen tokens, so a fact that straddles a split point still
appears whole in at least one chunk.

Embed is the step that makes searching by meaning possible. An **embedding** is
a list of numbers a model produces from a piece of text, arranged so that texts
with similar meanings end up with similar lists. If you read that list as
coordinates, each chunk becomes a point in space, and "means something similar"
becomes "close together". That is how a search for _"where do we meet in a
fire?"_ can find a paragraph that uses none of those words. The count of
numbers is the embedding's dimensions, fixed at 2048 here because that is what
the model emits.

Index stores those numbers in a structure that can find the nearest ones
quickly. Without an index, answering a question means comparing it against
every chunk you own. You will look at the index itself in the next stage.

[RAG → Ingestion](rag.md#ingestion) covers all four steps in full, including
why chunk sizes are estimated instead of tokenised and what gets prepended to a
chunk before it is embedded.

---

## Stage 4 — look at what ingestion made

Next, read the rows your upload created, straight from Postgres.

So far everything has only been described. Two minutes in `psql` lets you see
it, and the shape of these rows explains most of the design decisions that
come later.

With the dev stack running:

```bash
# The chunks your document was cut into
docker compose exec db psql -U postgres -d app -c \
  "SELECT d.title, c.page_number, c.token_count, left(c.content, 50) AS preview
     FROM chunks c JOIN documents d ON d.id = c.document_id
    ORDER BY d.title, c.page_number, c.chunk_index LIMIT 5;"
```

You get one row per chunk, each with its document title, its page number, its
estimated token count and the first 50 characters of its text. The page number
is stored on the chunk itself, so a citation is a lookup and never a guess.

Now look at one embedding:

```bash
# How many numbers are in one embedding, and what the first few look like
docker compose exec db psql -U postgres -d app -c \
  "SELECT vector_dims(embedding) AS dimensions,
          left(embedding::text, 60) AS first_numbers
     FROM chunks LIMIT 1;"
```

`dimensions` comes back as 2048 and `first_numbers` shows the start of a long
list of small signed decimals. As far as the search is concerned, that list is
the entire representation of the passage's meaning.

Finally, the indexes:

```bash
docker compose exec db psql -U postgres -d app -c "\di chunks*"
```

Four indexes matter here:

- `chunks_embedding_idx` is an **HNSW** index, a navigable-graph structure that
  finds the nearest vectors in roughly logarithmic time instead of comparing
  your question against every row. It is an _approximate_ nearest-neighbour
  method: it accepts an occasional near-miss in exchange for not scanning the
  table.
- `chunks_content_tsv_idx` is a GIN index over a Postgres full-text column.
  That is the keyword half of the search, and stage 5 uses it directly.
- `chunks_owner_kb_idx` covers `owner_id` and `knowledge_base_id` together, the
  two columns every retrieval query filters on.
- `chunks_document_id_idx` is the ordinary foreign-key index.

Look closely at the embedding column's type: it is `halfvec(2048)`, and a
`vector(2048)` column would not work here. pgvector cannot index a plain
`vector` above 2000 dimensions, and the model emits 2048. A `vector` column
would store the data perfectly well and then silently scan the whole table on
every query, with nothing in the logs to say so. `halfvec` stores each number
at half precision and indexes up to 4000 dimensions.
[RAG → Why `halfvec(2048)`](rag.md#why-halfvec2048-and-not-vector2048) has the
full reasoning, with the three measured facts that force the choice.

You may also notice that `chunks` carries both `owner_id` and
`knowledge_base_id`, even though both are reachable through `documents`. The
duplication is deliberate, and [Database](database.md#entity-relationship-diagram)
has the full schema and the reasoning.

---

## Stage 5 — ask a question and trace what happens

Now ask one question, then walk back through what the app did to answer it.

This is the per-question half of RAG. It makes four decisions in a row: what
kind of question this is, which passages match it, whether any of them are
good enough, and only after that, what to write as the answer.

Try it:

1. Go to `/chat`. An empty chat greets you with "Ready when you are."
2. Above the composer is the scope selector. It starts on **All knowledge
   bases**, and you can narrow it to specific ones. The conversation is pinned
   to whatever it says when you send the first message. Once the thread exists,
   the selector becomes a read-only label.
3. Ask something the document actually answers. With the sample handbook, try
   _How many days of annual leave do I get?_

You should see three dots, then text streaming in, then a **Sources** row
beneath the answer with one chip per cited passage in the form
`[1] staff-handbook — p1`. Clicking a chip opens that document's PDF so you can
read the page yourself. Under that is a metrics line. Separated by `·`, it
lists the completion token count, the tokens per second, the time to the first
token, the total time, how many sources were used, the retrieval mode
(`similarity search` here) and the model name.

Here is what happened, in order.

Your question was saved first, before any model was called. A conversation
showing a question with no answer is a bad failure, and one missing the
question entirely is worse.

The app then decided what kind of question it was. Similarity search answers
_"which passage is about X"_. It cannot answer _"summarise this document"_,
because that request has no passage to match. It is an instruction about the
document, not a question whose answer sits inside one. So whole-document
requests go to a different path that reads the document in order. Try
_summarise the staff handbook_ later and watch the metrics line say
`whole document` in place of `similarity search`. The measured similarity
scores that forced this split are in
[RAG → Scoping](rag.md#scoping-two-retrieval-paths).

Next your question was embedded, as a question. The embedding model here is
**asymmetric**: it is told whether the text is a stored passage or a query, and
it produces a different vector for each. The same sentence embedded both ways
scores only 0.785 cosine similarity against itself. If you embed a question the
wrong way, every search quietly gets worse and nothing in the logs says so.
That is why the code exposes `embedPassages()` and `embedQuery()` and has no
generic `embed()`.

Then two searches ran. The dense search compares your question's vector
against the chunk vectors. It is good at meaning and bad at exact strings: an
identifier like `POL-HR-014` means nothing in vector space. The lexical search
is classic keyword matching over the GIN index from stage 4, and it has the
opposite strengths. It is excellent on `POL-HR-014` and useless on _"where do
we meet in a fire?"_. Running both and merging the results is **hybrid
search**. You can run the keyword half by hand right now, with no API call at
all:

```bash
docker compose exec db psql -U postgres -d app -c \
  "SELECT d.title, c.page_number,
          ts_rank_cd(c.content_tsv, to_tsquery('english','annual | leave')) AS rank
     FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.content_tsv @@ to_tsquery('english','annual | leave')
    ORDER BY rank DESC LIMIT 5;"
```

That is the shape of one of the two channels. The `|` is an OR, so a chunk
matches if it contains _either_ word. The app builds exactly that OR-ed query
for you from the lexemes of whatever question you typed, because AND-ing a
question's words rejects the passage that answers it. See
[RAG → Hybrid retrieval](rag.md#hybrid-retrieval--dense-and-lexical-fused).
The other channel needs the embedding endpoint, so you cannot run it from
`psql`.

The two result lists were merged by rank. Cosine similarity and a text-rank
score are on different scales, and forcing them onto one is the fragile part of
naive hybrid search. Instead, each chunk scores `1 / (k + its rank)` in each
list it appears in, and the scores are summed. This is called **Reciprocal Rank
Fusion**. A chunk that both channels liked beats one that only a single channel
found.

The best eight results were kept, and a floor was applied. `RAG_TOP_K` (8) sets
how many chunks the model may see. **Cosine similarity**, a 0-to-1 score for
how alike two embeddings are, has to reach `RAG_MIN_SIMILARITY` (0.35) for a
chunk to count as relevant at all.

Only then was the model called. The surviving passages are wrapped in a
delimited context block and labelled as data, never as instructions. An
uploaded PDF is untrusted input that reaches the model, and anyone can write
"ignore your instructions" into a PDF. The answer streams back one JSON object
per line, which is why the citation chips can appear before the prose finishes.

[RAG → Search](rag.md#search) has the complete version of this stage, including
the SQL the retrieval actually runs and the end-to-end sequence diagram.

---

## Stage 6 — make it refuse

In this stage you deliberately ask something your documents cannot answer.

This is the point of the whole system, and it is the step people skip. The
typical failure of a document chatbot is a confident, fluent, invented answer.
Stages 3 to 5 exist so that this stage behaves correctly.

In the same conversation, ask two questions:

1. _What is the melting point of tungsten?_ This obviously has nothing to do
   with a staff handbook.
2. _How much parental leave am I entitled to?_ This one is plausible and
   adjacent, and still not in the document. It is the harder case, because it
   shares vocabulary with the leave section that _is_ there.

Both come back as exactly:

> I couldn't find anything about that in your documents.

Notice what is _missing_ underneath: there is no **Sources** row and no metrics
line. There are no metrics because the chat model was never called, so there
was nothing to measure. When nothing clears the similarity floor, the code
returns that fixed sentence and stops. This is ordinary control flow. It is not
a prompt instruction the model might disobey, and it does not degrade when a
model is swapped. Since there is no drafting call, there is nothing to hijack.

For the same reason, an empty knowledge base cannot produce a confident
hallucination, and a refusal costs nothing.

It is worth lowering the floor to watch this property erode. Set
`RAG_MIN_SIMILARITY=0.1` in `.env`, restart `pnpm dev` (environment variables
are read at boot), and ask the parental-leave question again. You will get an
answer built from whatever loosely-related passage scraped past. Put the floor
back to `0.35` afterwards. [RAG → Tuning](rag.md#tuning) explains the
trade-off and shows the measured spread of true and false positives that sets
the default where it is.

---

## Stage 7 — score retrieval with `pnpm rag:eval`

Here you run the evaluation harness and read its numbers.

A claim that retrieval got better stays an opinion until you have a number for
it. Everything downstream of retrieval is limited by what retrieval found, so
this measurement decides whether a change to chunking, the floor or the search
helped. Unlike answer quality, it needs no model to judge it.

The harness is a **ground-truth corpus**: a fixed set of documents, a fixed
list of questions, and the passage each question is supposed to find. The three
PDFs in `eval/corpus/` deliberately overlap. The handbook's fire assembly point
and the facilities guide's staff parking are both on Wellington Street, and
both the handbook and the employment contract discuss notice periods. Those
near-misses are **distractors**. A corpus without them measures nothing,
because every question would have only one plausible answer in it.

The harness makes real embedding calls, so keep an eye on your rate limit.

```bash
pnpm rag:eval                   # run, print a report
```

It ingests `eval/corpus/` under a dedicated evaluation user, leaving the
knowledge base you made in stage 2 alone, and then runs 25 questions through
the same retrieval code the app uses. Twenty are single-hop, three are
follow-ups and two are multi-hop.

The output starts with a header naming the label and the settings in force:

```
Retrieval evaluation — label: baseline
top_k=8  floor=0.35  chunk=512/64
```

Then comes one line per question. Each shows `PASS` or `FAIL`, the question
type, its id, where the correct passage ranked (or, for a question that should
be refused, how many chunks came back above the floor), and the top hit as
`<document> p<page> @ <similarity>`. After that, a summary block reports
`hit@1`, `hit@3`, `hit@8`, `MRR`, `refusal accuracy` and `cross-KB leakage`,
followed by separate follow-up and multi-hop lines. The whole run is saved to
`eval/results/baseline.json`.

Here is how to read the numbers:

- hit@k is the fraction of questions whose correct passage appears anywhere in
  the top k results. `hit@1` is the strictest: was it the very first hit.
- MRR (mean reciprocal rank) averages `1 / (position of the first correct
result)`. Rank 1 scores 1.0 and rank 2 scores 0.5, so a near-miss still earns
  partial credit where hit@1 would score zero.
- Refusal accuracy is the share of unanswerable questions the system correctly
  declines. Unlike the others, it is a pass/fail gate and not just a report
  line, for the reason given below.
- Cross-KB leakage counts chunks returned from a knowledge base the
  conversation was not scoped to. The correct value is `0`, and anything else
  fails the run. The harness deliberately splits the corpus so the overlapping
  documents land on opposite sides of the boundary. Otherwise the check could
  pass only because there was nothing on the other side to leak.

**Why refusal accuracy is a hard gate:** a change to this repo once took MRR to
0.971 while taking refusal accuracy from 1.000 to 0.000. Every headline number
improved while the property the system exists to provide disappeared entirely.
Measuring it was not enough to stop that change; the gate is what stops it
shipping by accident. `pnpm rag:eval --label <name> --baseline <name>` fails a
run outright if refusal accuracy drops below the saved baseline's, whatever the
other metrics do.

Some useful flags:

```bash
pnpm rag:corpus                 # regenerate the corpus PDFs from eval/make-corpus.mjs
pnpm rag:eval --label hybrid    # save this run under a name, for comparison
pnpm rag:eval --no-ingest       # reuse what is already indexed
```

The measured results for this repo's own retrieval changes are in
[RAG → Evaluation](rag.md#evaluation).

---

## Stage 8 (optional) — turn on the agentic loop

In this last stage you let the model decide what to search for, and compare
that against everything you have built so far.

Everything up to here is the **fixed pipeline**: one search runs, and the model
only writes prose. That pipeline has two real weaknesses. It cannot handle a
follow-up. If you ask "how many days of annual leave do I get?" and then "can I
carry it over to next year?", the second question is embedded literally, with
no idea what "it" refers to. It also cannot handle a question that needs facts
from two different places, because one search returns one neighbourhood of
passages.

The **agentic path** addresses both. A separate, cheaper **planner** model
chooses the search query, looks at what came back, and searches again if the
first attempt was thin. It is on by default, and it is roughly ten times
slower.

Measure before you switch:

```bash
pnpm rag:eval --compare
```

This runs every question through _both_ paths in one invocation and prints the
results side by side. It does not need the feature flag, because the harness
calls the agentic retrieval directly so that one run scores both. Expect it to
take a while and to use a lot of your rate limit. The agentic path costs
several upstream calls per question, against two for the fixed path.

To use it in the app, set the flag and restart the dev server:

```bash
RAG_AGENTIC_ENABLED=true        # in .env, then restart pnpm dev
```

When you ask a question now, the thinking indicator shows a phase label
instead of bare dots: _"Deciding where to look…"_, _"Searching your
documents…"_ (with a number if it searches again), _"Writing the answer…"_,
_"Checking sources…"_. The metrics line reports `agentic search` in place of
`similarity search`. Answers take several seconds longer.

Now try the case it was built for. Ask _How many days of annual leave do I
get?_, wait for the answer, then ask _Can I carry it over to next year?_ with
no other context. The planner sees the last few turns, works out what "it"
means, and searches for that subject.

On this repo's own corpus, the agentic path is slightly worse on ordinary
single-hop questions, much better on follow-ups and multi-hop questions, and
about ten times slower. That is why the flag ships off. Most questions are
single-hop, so the default favours the cheap path. Turn it on for
conversational use where follow-ups dominate, after running the comparison on
your own corpus.

Two practical notes. A free NIM key allows roughly 40 requests a minute. That
is about 20 questions a minute on the fixed path and 5 to 8 on the agentic one,
and for the same reason the E2E suite must run with `--workers=1` under this
flag. Also, letting a model retry a search reopens a risk the fixed pipeline
had closed: more attempts mean more chances to scrape past the similarity floor
by luck. [RAG → The agentic path](rag.md#the-agentic-path) has the fix, the
measurement that made it necessary, and the full A/B table.

---

## Experiments worth running

You now have a working system and a way to score it. These four changes teach
the most for the time they take. Environment variables are read at boot, so
restart `pnpm dev` after each one.

Move the similarity floor. With `RAG_MIN_SIMILARITY` at 0.6 the system refuses
questions it used to answer, and at 0.1 it answers questions it should refuse.
The default of 0.35 sits in a gap measured on this corpus, where true positives
score 0.41 to 0.62 and an off-topic question scores 0.13.

Change the chunk size. `RAG_CHUNK_TOKENS` at 128 gives you many small, precise
chunks, and at 1024, a few large ones that each carry more context. This
one requires re-ingesting, because existing chunks were cut under the old
setting. Delete and re-upload the document, or use **Retry** on a failed one,
which re-runs extraction and embedding and replaces the chunks in a single
transaction.

Change `RAG_TOP_K`. More chunks give the model more to work with, and also more
to be distracted by.

Score every change. Run `pnpm rag:eval --label <name>` after each one and
compare the saved runs in `eval/results/`. [RAG → Tuning](rag.md#tuning) lists
all the knobs and their defaults.

---

## Where to go next

You have built and measured a RAG system. Read the rest of the documentation in
this order. Each page assumes the vocabulary you now have.

| Read this next                  | For                                                                  |
| ------------------------------- | -------------------------------------------------------------------- |
| [Summary](summary.md)           | The whole project on one page: stack, stats, what ships              |
| [Usage & Development](usage.md) | Every script, every environment variable, the test suites, Docker    |
| [RAG — how it works](rag.md)    | The full version of stages 3 to 8, with the measurements behind each |
| [Database](database.md)         | The complete schema, the ERD, and the migration workflow             |
| [Architecture](architecture.md) | Request flow, authentication design, and the security model          |
| [Features](features.md)         | Everything else in the box: RBAC, uploads, PWA, email, push          |
| [Self-hosting](self-hosting.md) | `make setup`, from this clone to a live deployment                   |

If something did not behave the way this page said it would,
[RAG → When things go wrong](rag.md#when-things-go-wrong) lists the failures
actually observed against a live endpoint and how each is handled.
[RAG → Known gaps](rag.md#known-gaps) names what this system deliberately does
not do.

The design decisions behind each feature are recorded as specs. For retrieval
and chat, see [`0025`](../specs/0025-rag-knowledge-base-and-chat.md),
[`0026`](../specs/0026-chat-first-ux-and-history.md),
[`0028`](../specs/0028-independent-knowledge-bases.md) and
[`0029`](../specs/0029-agentic-retrieval-loop.md).

---

**Next:** [Summary](summary.md) for the project on one page, then
[Usage & Development](usage.md) for the scripts and environment variables you
will use every day.
