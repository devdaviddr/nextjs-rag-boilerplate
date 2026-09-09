# Tutorial — build a RAG system step by step

[← Back to README](../README.md)

**You'll learn:** how retrieval-augmented generation actually works, by taking
a fresh clone of this repo to a running app that answers a question from your
own PDF and cites the page it came from — understanding every step you took.

---

## What you are about to build

By the end of this page you will have a document chat running on your machine.
You upload a PDF, ask a question about it, and get an answer with a page
citation next to it. Ask something the PDF does not cover and the app tells you
so instead of inventing something.

The technique underneath is **retrieval-augmented generation**, usually
shortened to RAG. The problem it solves is simple to state. A language model
knows what was in its training data and nothing else. Your staff handbook was
not in there. Ask a raw chat model "how many days of annual leave do I get?"
and it will still answer — fluently, confidently, and from something it
half-remembers about employment law in general. That failure has a name,
**hallucination**, and no amount of asking the model nicely prevents it.

RAG is the repair. Before you let the model speak, you search your own
documents and hand it only the passages you found. The model's job shrinks from
"know the answer" to "read these passages and write the answer". Because the
passages are real rows from your text, you can show the reader exactly which
document and which page each claim came from. That is what makes an answer
**grounded** rather than merely plausible.

That is the whole idea. Everything else — chunking, embeddings, vector
indexes, similarity floors — is machinery in service of it, and you will meet
each piece at the moment it becomes necessary rather than up front.

### What you need

- Node.js ≥ 20.9 (22 recommended) and [pnpm](https://pnpm.io)
  (`corepack enable`)
- Docker, for a local Postgres and object store
- An API key for an OpenAI-compatible inference endpoint. A free
  [NVIDIA NIM](https://build.nvidia.com) key works and is rate-limited rather
  than billed per token, which is what this tutorial assumes.

Set aside about an hour. Stages 1 to 6 are the core and take roughly half of
that; stages 7 and 8 are measurement and are worth doing while you still
remember what you built.

### The stages

| Stage                                                                    | What you do                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| [1. Get it running](#stage-1--get-it-running)                            | Postgres, object storage, schema, dev server            |
| [2. Make a knowledge base](#stage-2--make-a-knowledge-base)              | Create the boundary every search happens inside         |
| [3. Upload a PDF](#stage-3--upload-a-pdf-and-watch-it-become-searchable) | Extract, chunk, embed, index — the four ingestion steps |
| [4. Look at what it made](#stage-4--look-at-what-ingestion-made)         | Read the rows and the indexes in SQL                    |
| [5. Ask a question](#stage-5--ask-a-question-and-trace-what-happens)     | Follow one question through the whole pipeline          |
| [6. Make it refuse](#stage-6--make-it-refuse)                            | The point of the entire system                          |
| [7. Score retrieval](#stage-7--score-retrieval-with-pnpm-rageval)        | `pnpm rag:eval`, and what the numbers mean              |
| [8. The agentic loop](#stage-8-optional--turn-on-the-agentic-loop)       | Optional: let the model direct its own searching        |

---

## Stage 1 — get it running

**What you are about to do.** Start a database, start an object store, create
the schema, seed a login, and run the app.

**Why it is necessary.** A RAG system needs three stores, not one. The
**database** holds the searchable pieces of your documents — and not any
Postgres will do, because searching by meaning needs the `pgvector` extension,
which the `pgvector/pgvector:pg17` image ships and stock `postgres` does not.
The **object store** (MinIO here, an S3-compatible server) holds the original
PDF files, so a citation can open the real page you can read with your own
eyes. The **inference endpoint** runs the models. Everything else is ordinary
Next.js.

**Do this.** Each step is safe to re-run.

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

**What you should see.** `pnpm db:migrate` applies the committed migrations
under `drizzle/`. `pnpm db:seed` prints a line per role it creates and per role
it assigns, and leaves you a `demo@example.com` / `Password123` login.
`pnpm dev` serves the app on `http://localhost:3000`.

**If you skipped the API key**, the app still boots. The documents panel shows
_"Document chat isn't configured on this deployment. Set NVIDIA_API_KEY to
enable uploads and chat."_ and the upload button stays disabled. You can read
the rest of the template, but this tutorial needs the key from stage 3 onwards.

Every value in `.env` is validated at boot by `src/lib/env.ts`, so a malformed
setting fails immediately with a message naming the variable, rather than
surfacing as a strange error later. The full table is in
[Usage → Environment variables](usage.md#environment-variables).

---

## Stage 2 — make a knowledge base

**What you are about to do.** Sign in and create one named collection to put
documents in.

**Why it is necessary.** A **knowledge base** is a named collection of
documents belonging to one user, and it is the boundary every search happens
inside. It matters for two different reasons. The obvious one is tidiness — HR
paperwork in one place, building and facilities admin in another. The important
one is that scope is a security boundary: a conversation is pinned to a set of
knowledge bases when it is created, and retrieval cannot see outside that set.
That restriction lives in the SQL `WHERE` clause of every retrieval query, not
in an instruction to the model and not in a filter applied to results
afterwards. A model can be argued with. A `WHERE` clause cannot. Both guarantees
this app makes are spelled out in
[RAG → Two guarantees](rag.md#two-guarantees).

**Do this.**

1. Open `http://localhost:3000` and sign in as `demo@example.com` /
   `Password123`.
2. Go to **`/documents`**, the "Knowledge bases" page.
3. Click **New knowledge base**. Give it a name — a description is optional.
4. Open it. You land on that knowledge base's own page, where its documents
   live.

**What you should see.** An empty knowledge base with the message _"No
documents yet. Upload a PDF to get started."_ and an **Upload PDF** button.

---

## Stage 3 — upload a PDF and watch it become searchable

**What you are about to do.** Upload one PDF and watch four things happen to
it.

**Why it is necessary.** A PDF is not searchable by meaning. Making it so takes
four steps, and this is the half of RAG that runs once per document — the
**ingestion** job. The other half, answering, runs once per question and is
stage 5.

**Use a PDF whose answers you already know.** This repo ships three small ones
for its evaluation harness, and `eval/corpus/staff-handbook.pdf` is a good
first document: four pages, one section per page, with facts you can check
against `eval/make-corpus.mjs`. Page 1 says the annual leave entitlement is 20
working days per calendar year and carries the policy reference `POL-HR-014`;
page 3 puts the fire assembly point on Wellington Street. Your own PDF works
too, as long as it is a real text PDF rather than a scan.

**Do this.** Click **Upload PDF**, choose the file, and watch the status badge
on the row.

**What you should see**, in order — each label is one of the four steps:

| Badge        | Underlying status | What is happening                            |
| ------------ | ----------------- | -------------------------------------------- |
| **Queued**   | `pending`         | The file is stored; work has not started yet |
| **Reading**  | `extracting`      | Text is being pulled out of the PDF          |
| **Indexing** | `embedding`       | Passages are being turned into numbers       |
| **Ready**    | `ready`           | The document is searchable                   |

A four-page document passes through all of that in seconds. A 200-page one
takes a few minutes, because indexing is hundreds of calls to the embedding
endpoint. The work runs in the background, out of band from your upload
request, so nothing blocks — the page polls the status for you.

Here is what each step means.

**Extract** is pulling the readable text out of the PDF, one page at a time.
This app does it in-process with the [`unpdf`](https://github.com/unjs/unpdf)
library, so there is no sidecar container and it works offline. The page number
is attached from this very first step, and holding on to it is the entire
reason a citation can later say "page 3" and be right.

A scanned PDF has no text to extract — it is a picture of text, and reading
text out of a picture is **OCR**, which this app does not do. Rather than
ingesting an empty document, extraction rejects it. If you try one, the row
turns **Failed** and shows the reason: _"No selectable text found — this looks
like a scanned PDF. OCR is not supported yet, so it cannot be added to your
knowledge base."_ A knowledge base that silently contains nothing is worse than
an upload that refuses.

**Chunk** is cutting each page into short passages. A whole document is too
coarse a thing to search: "this 90-page handbook is relevant" does not answer
anything. So the text is cut into **chunks** — a few paragraphs each, stored as
their own rows. A chunk is the unit that gets retrieved, cited and shown. Two
rules shape the cutting here. Chunks never span a page boundary, which is what
keeps every citation resolvable to an exact page. And consecutive chunks
**overlap** by a few dozen tokens, so a fact that happens to straddle a split
point still appears whole in at least one chunk.

**Embed** is the step that makes searching by meaning possible. An **embedding**
is a list of numbers a model produces from a piece of text, arranged so that
texts meaning similar things end up with similar lists. Read that list as
coordinates and each chunk becomes a point in space; "close together" is what
"means something similar" turns into. That is why a search for _"where do we
meet in a fire?"_ can find a paragraph that uses none of those words. How many
numbers there are is the embedding's **dimensions** — fixed at 2048 here,
because that is what the model emits.

**Index** is storing those numbers in a structure that can find the nearest
ones quickly. Without an index, answering a question means comparing it against
every chunk you own. You will look at the index itself in the next stage.

The full treatment of all four, including why chunk sizes are estimated rather
than tokenised and what gets prepended to a chunk before it is embedded, is in
[RAG → Ingestion](rag.md#ingestion).

---

## Stage 4 — look at what ingestion made

**What you are about to do.** Read the rows your upload created, straight from
Postgres.

**Why it is necessary.** Everything so far has been described. Two minutes in
`psql` turns it into something you have seen, and the shape of these rows
explains most of the design decisions that come later.

**Do this.** With the dev stack running:

```bash
# The chunks your document was cut into
docker compose exec db psql -U postgres -d app -c \
  "SELECT d.title, c.page_number, c.token_count, left(c.content, 50) AS preview
     FROM chunks c JOIN documents d ON d.id = c.document_id
    ORDER BY d.title, c.page_number, c.chunk_index LIMIT 5;"
```

**What you should see.** One row per chunk, each carrying its document title,
its page number, its estimated token count and the first 50 characters of its
text. Note that the page number is on the chunk itself — a citation is a lookup,
not a guess.

Now look at one embedding:

```bash
# How many numbers are in one embedding, and what the first few look like
docker compose exec db psql -U postgres -d app -c \
  "SELECT vector_dims(embedding) AS dimensions,
          left(embedding::text, 60) AS first_numbers
     FROM chunks LIMIT 1;"
```

`dimensions` comes back as **2048**, and `first_numbers` shows the start of a
long list of small signed decimals. That list is the entire representation of
the passage's meaning as far as the search is concerned.

Finally, the indexes:

```bash
docker compose exec db psql -U postgres -d app -c "\di chunks*"
```

Four indexes matter here:

- **`chunks_embedding_idx`** is an **HNSW** index — a navigable-graph structure
  that finds the nearest vectors in roughly logarithmic time instead of
  comparing your question against every row. It is an _approximate_
  nearest-neighbour method: it accepts an occasional near-miss in exchange for
  not scanning the table.
- **`chunks_content_tsv_idx`** is a GIN index over a Postgres full-text column.
  That is the keyword half of the search, and stage 5 uses it directly.
- **`chunks_owner_kb_idx`** covers `owner_id` and `knowledge_base_id` together —
  the two columns every retrieval query filters on.
- **`chunks_document_id_idx`** is the ordinary foreign-key index.

One detail worth pausing on: the embedding column's type is `halfvec(2048)`,
not `vector(2048)`. That is not a micro-optimisation. pgvector cannot index a
plain `vector` above 2000 dimensions, and the model emits 2048 — so a `vector`
column would store the data perfectly well and then silently scan the whole
table on every query, with nothing in the logs to say so. `halfvec` stores each
number at half precision and indexes up to 4000 dimensions. The full reasoning,
with the three measured facts that force it, is in
[RAG → Why `halfvec(2048)`](rag.md#why-halfvec2048-and-not-vector2048).

You will also notice `chunks` carries both `owner_id` and `knowledge_base_id`
even though both are reachable through `documents`. That duplication is
deliberate, and [Database](database.md#entity-relationship-diagram) has the
full schema and the reasoning.

---

## Stage 5 — ask a question and trace what happens

**What you are about to do.** Ask one question, then walk back through what the
app did to answer it.

**Why it is necessary.** This is the per-question half of RAG, and it is four
decisions in a row: what kind of question is this, which passages match it, are
any of them good enough, and only then — write the answer.

**Do this.**

1. Go to **`/chat`**. An empty chat greets you with **"Ready when you are."**
2. Above the composer is the scope selector. It starts on **All knowledge
   bases**; you can narrow it to specific ones. Whatever it says when you send
   the first message is what the conversation is pinned to from then on — the
   selector becomes a read-only label once the thread exists.
3. Ask something the document actually answers. With the sample handbook:
   _How many days of annual leave do I get?_

**What you should see.** Three dots, then text streaming in, then a **Sources**
row beneath the answer with one chip per cited passage in the form
`[1] staff-handbook — p1`. Clicking a chip opens that document's PDF so you can
read the page yourself. Under that is a metrics line listing, separated by
`·`, the completion token count, the tokens per second, the time to the first
token, the total time, how many sources were used, the retrieval mode
(`similarity search` here) and the model name.

**What happened, in order.**

**Your question was saved first**, before any model was called. A conversation
showing a question with no answer is a bad failure; a conversation missing the
question entirely is worse.

**The app decided what kind of question it was.** Similarity search answers
_"which passage is about X"_. It cannot answer _"summarise this document"_,
because such a request has no passage to match — it is an instruction about the
document rather than a question whose answer sits inside one. So whole-document
requests are routed to a different path that reads the document in order
instead. Try _summarise the staff handbook_ later and watch the metrics line
say `whole document` rather than `similarity search`. The measured similarity
scores that forced this split are in
[RAG → Scoping](rag.md#scoping-two-retrieval-paths).

**Your question was embedded — as a question.** The embedding model here is
**asymmetric**: it is told whether the text is a stored passage or a query, and
produces a different vector for each. The same sentence embedded both ways
scores only 0.785 cosine similarity against itself. Embed a question the wrong
way and every search quietly gets worse with nothing in the logs to say so,
which is why the code exposes `embedPassages()` and `embedQuery()` and no
generic `embed()`.

**Two searches ran, not one.** The **dense** search compares your question's
vector against the chunk vectors and is good at meaning and bad at exact
strings — an identifier like `POL-HR-014` means nothing in vector space. The
**lexical** search is classic keyword matching over that GIN index from stage 4,
and it is the mirror image: excellent on `POL-HR-014`, useless on _"where do we
meet in a fire?"_. Running both and merging them is **hybrid search**, and you
can run the keyword half by hand right now, with no API call at all:

```bash
docker compose exec db psql -U postgres -d app -c \
  "SELECT d.title, c.page_number,
          ts_rank_cd(c.content_tsv, to_tsquery('english','annual | leave')) AS rank
     FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.content_tsv @@ to_tsquery('english','annual | leave')
    ORDER BY rank DESC LIMIT 5;"
```

That is the shape of one of the two channels. The `|` is an OR: a chunk matches
if it contains _either_ word. The app builds exactly that OR-ed query for you,
from the lexemes of whatever question you typed, because AND-ing a question's
words rejects the passage that answers it — see
[RAG → Hybrid retrieval](rag.md#hybrid-retrieval--dense-and-lexical-fused).
The other channel needs the embedding endpoint, so it cannot be run from
`psql`.

**The two result lists were merged by rank, not by score.** Cosine similarity
and a text-rank score are not on comparable scales, and forcing them onto one
is the fragile part of naive hybrid search. Instead each chunk scores
`1 / (k + its rank)` in each list it appears in, and the scores are summed —
**Reciprocal Rank Fusion**. A chunk both channels liked beats one only a single
channel found.

**The best eight survivors were kept, and a floor was applied.** `RAG_TOP_K`
(8) sets how many chunks the model may see. **Cosine similarity** — a 0-to-1
score for how alike two embeddings are — has to reach `RAG_MIN_SIMILARITY`
(0.35) for a chunk to count as relevant at all.

**Only then was the model called.** The surviving passages are wrapped in a
delimited context block and labelled as data, never as instructions — an
uploaded PDF is untrusted input that reaches the model, and someone can write
"ignore your instructions" into a PDF. The answer streams back one JSON object
per line, which is why the citation chips can appear before the prose finishes.

The complete version of this stage, including the SQL the retrieval actually
runs and the end-to-end sequence diagram, is in
[RAG → Search](rag.md#search).

---

## Stage 6 — make it refuse

**What you are about to do.** Deliberately ask something your documents cannot
answer.

**Why it is necessary.** This is the point of the whole system, and it is the
one step people skip. A document chatbot's characteristic failure is not
silence — it is a confident, fluent, invented answer. Everything in stages 3
to 5 exists so that this stage behaves correctly.

**Do this.** In the same conversation, ask two questions:

1. _What is the melting point of tungsten?_ — obviously nothing to do with a
   staff handbook.
2. _How much parental leave am I entitled to?_ — plausible, adjacent, and still
   not in the document. This is the harder case, because it shares vocabulary
   with the leave section that _is_ there.

**What you should see.** Both come back as exactly:

> I couldn't find anything about that in your documents.

Look at what is _missing_ underneath: no **Sources** row and no metrics line.
There are no metrics because there was nothing to measure — the chat model was
never called. When nothing clears the similarity floor, the code returns that
fixed sentence and stops. It is ordinary control flow, not a prompt instruction
the model might disobey and not a behaviour that degrades when a model is
swapped. There is no drafting call to hijack, because there is no drafting
call.

That is also why an empty knowledge base cannot produce a confident
hallucination, and why a refusal costs nothing.

**Worth trying.** Lower the floor and watch the property erode. Set
`RAG_MIN_SIMILARITY=0.1` in `.env`, restart `pnpm dev` (environment variables
are read at boot), and ask the parental-leave question again. You will get an
answer built from whatever loosely-related passage scraped past. Put the floor
back to `0.35` afterwards. The trade-off, and the measured spread of true and
false positives that puts the default where it is, is in
[RAG → Tuning](rag.md#tuning).

---

## Stage 7 — score retrieval with `pnpm rag:eval`

**What you are about to do.** Run the evaluation harness and read its numbers.

**Why it is necessary.** "Retrieval got better" is an opinion until it is a
number. Everything downstream of retrieval is capped by what retrieval found,
so this is the measurement that decides whether a change to chunking, the
floor or the search helped — and unlike answer quality, it needs no model to
judge it.

The harness is a **ground-truth corpus**: a fixed set of documents, a fixed
list of questions, and the passage each question is supposed to find. The three
PDFs in `eval/corpus/` deliberately overlap — the handbook's fire assembly
point and the facilities guide's staff parking are both on Wellington Street,
and both the handbook and the employment contract discuss notice periods. Those
near-misses are **distractors**, and a corpus without them measures nothing,
because every question would have only one plausible answer in it.

**Do this.** The harness makes real embedding calls, so keep an eye on your
rate limit.

```bash
pnpm rag:eval                   # run, print a report
```

It ingests `eval/corpus/` under a dedicated evaluation user — it does not touch
the knowledge base you made in stage 2 — and then runs 25 questions through the
same retrieval code the app uses. Twenty are single-hop, three are follow-ups
and two are multi-hop.

**What you should see.** A header naming the label and the settings in force:

```
Retrieval evaluation — label: baseline
top_k=8  floor=0.35  chunk=512/64
```

Then one line per question: `PASS` or `FAIL`, the question type, its id, where
the correct passage ranked (or, for a question that should be refused, how many
chunks came back above the floor), and the top hit as
`<document> p<page> @ <similarity>`. Then a summary block reporting `hit@1`,
`hit@3`, `hit@8`, `MRR`, `refusal accuracy` and `cross-KB leakage`, followed by
separate follow-up and multi-hop lines. The whole run is saved to
`eval/results/baseline.json`.

**Reading the numbers.**

- **hit@k** is the fraction of questions whose correct passage appears anywhere
  in the top k results. `hit@1` is the strictest: was it the very first hit.
- **MRR** (mean reciprocal rank) averages `1 / (position of the first correct
result)`. Rank 1 scores 1.0, rank 2 scores 0.5, so a near-miss still earns
  partial credit where hit@1 would score zero.
- **Refusal accuracy** is the share of unanswerable questions the system
  correctly declines. This is the one that is a pass/fail gate rather than a
  report line, for a reason given below.
- **Cross-KB leakage** counts chunks returned from a knowledge base the
  conversation was not scoped to. The correct value is `0`, and anything else
  fails the run. The harness deliberately splits the corpus so the overlapping
  documents land on opposite sides of the boundary — otherwise the check would
  pass for the wrong reason, with nothing on the other side to leak.

**Why refusal accuracy is a hard gate.** A change to this repo once took MRR to
0.971 while taking refusal accuracy from 1.000 to 0.000. Every headline number
improved while the property the system exists to provide disappeared entirely.
Measuring it was not enough; the gate is what stops that shipping by accident.
`pnpm rag:eval --label <name> --baseline <name>` fails a run outright if
refusal accuracy drops below the saved baseline's, whatever the other metrics
do.

Useful flags:

```bash
pnpm rag:corpus                 # regenerate the corpus PDFs from eval/make-corpus.mjs
pnpm rag:eval --label hybrid    # save this run under a name, for comparison
pnpm rag:eval --no-ingest       # reuse what is already indexed
```

The measured results for this repo's own retrieval changes are in
[RAG → Evaluation](rag.md#evaluation).

---

## Stage 8 (optional) — turn on the agentic loop

**What you are about to do.** Let the model decide what to search for, and
compare that against everything you have built so far.

**Why it is necessary.** Everything up to here is the **fixed pipeline**: one
search runs, and the model only writes prose. That pipeline has two honest
weaknesses. It cannot handle a follow-up — ask "how many days of annual leave
do I get?" and then "can I carry it over to next year?", and the second
question is embedded literally, with no idea what "it" refers to. And it cannot
handle a question needing facts from two different places, because one search
returns one neighbourhood of passages.

The **agentic path** addresses both by letting a separate, cheaper **planner**
model choose the search query, look at what came back, and search again if the
first attempt was thin. It is off by default, and it is roughly ten times
slower.

**Do this first — measure before you switch.**

```bash
pnpm rag:eval --compare
```

This runs every question through _both_ paths in one invocation and prints them
side by side. It does not need the feature flag; the harness calls the agentic
retrieval directly so one run scores both. Expect it to take a while and to
spend a lot of your rate limit — the agentic path costs several upstream calls
per question against the fixed path's two.

**Then, to use it in the app**, set the flag and restart the dev server:

```bash
RAG_AGENTIC_ENABLED=true        # in .env, then restart pnpm dev
```

**What you should see.** Ask a question and the thinking indicator now carries
a phase label instead of bare dots — _"Deciding where to look…"_, _"Searching
your documents…"_ (with a number if it searches again), _"Writing the answer…"_,
_"Checking sources…"_. The metrics line reports `agentic search` rather than
`similarity search`. Answers take several seconds longer.

Now try the thing it was built for. Ask _How many days of annual leave do I
get?_, wait for the answer, then ask _Can I carry it over to next year?_ with
no other context. The planner sees the last few turns, resolves what "it"
means, and searches for the resolved subject.

**What it costs.** On this repo's own corpus the agentic path is slightly worse
on ordinary single-hop questions, dramatically better on follow-ups and
multi-hop questions, and about ten times slower. That is why the flag ships
off: most questions are single-hop, so the default favours the cheap path. Turn
it on for conversational use where follow-ups dominate — after running the
comparison on your own corpus.

Two practical notes. A free NIM key allows roughly 40 requests a minute, which
is about 20 questions a minute on the fixed path and 5 to 8 on the agentic one;
the E2E suite must run with `--workers=1` under this flag for the same reason.
And letting a model retry a search reopens a risk the fixed pipeline had
closed: more attempts mean more chances to scrape past the similarity floor by
luck. The fix, the measurement that made it necessary, and the full A/B table
are in [RAG → The agentic path](rag.md#the-agentic-path).

---

## Experiments worth running

You now have a working system and a way to score it. These four changes teach
the most per minute spent. Environment variables are read at boot, so restart
`pnpm dev` after each one.

**Move the similarity floor.** `RAG_MIN_SIMILARITY` at 0.6 makes the system
refuse questions it used to answer; at 0.1 it answers questions it should
refuse. The default of 0.35 sits in a gap measured on this corpus, where true
positives score 0.41–0.62 and an off-topic question scores 0.13.

**Change the chunk size.** `RAG_CHUNK_TOKENS` at 128 gives you many small,
precise chunks; at 1024, few large ones carrying more context each. This one
requires re-ingesting — existing chunks were cut under the old setting. Delete
and re-upload the document, or use **Retry** on a failed one, which re-runs
extraction and embedding and replaces the chunks in a single transaction.

**Change `RAG_TOP_K`.** More chunks give the model more to work with and more
to be distracted by.

**Score every change.** `pnpm rag:eval --label <name>` after each one, and
compare the saved runs in `eval/results/`. The complete list of knobs and their
defaults is in [RAG → Tuning](rag.md#tuning).

---

## Where to go next

You have built and measured a RAG system. The rest of the documentation set
reads in this order, and each page assumes the vocabulary you now have.

| Read this next                      | For                                                                  |
| ----------------------------------- | -------------------------------------------------------------------- |
| **[Summary](summary.md)**           | The whole project on one page — stack, stats, what ships             |
| **[Usage & Development](usage.md)** | Every script, every environment variable, the test suites, Docker    |
| **[RAG — how it works](rag.md)**    | The full version of stages 3 to 8, with the measurements behind each |
| **[Database](database.md)**         | The complete schema, the ERD, and the migration workflow             |
| **[Architecture](architecture.md)** | Request flow, authentication design, and the security model          |
| **[Features](features.md)**         | Everything else in the box — RBAC, uploads, PWA, email, push         |
| **[Self-hosting](self-hosting.md)** | `make setup`, from this clone to a live deployment                   |

If something did not behave the way this page said it would,
[RAG → When things go wrong](rag.md#when-things-go-wrong) lists the failures
that were actually observed against a live endpoint and how each is handled,
and [RAG → Known gaps](rag.md#known-gaps) names what this system deliberately
does not do.

The design decisions behind each feature are recorded as specs — retrieval and
chat are [`0025`](../specs/0025-rag-knowledge-base-and-chat.md),
[`0026`](../specs/0026-chat-first-ux-and-history.md),
[`0028`](../specs/0028-independent-knowledge-bases.md) and
[`0029`](../specs/0029-agentic-retrieval-loop.md).

---

**Next:** [Summary](summary.md) for the project on one page, then
[Usage & Development](usage.md) for the scripts and environment variables you
will use every day.
