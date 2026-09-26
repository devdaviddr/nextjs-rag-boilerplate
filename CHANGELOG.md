# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
As this project is pre-1.0, minor versions may introduce breaking changes.

## [Unreleased]

## [0.25.0] - 2026-09-26

### Added

- **Switch the embedding model from Settings**
  ([#56](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/56),
  [#64](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/64),
  spec 0040 FR3). Picking a new embedding model re-indexes every document
  with it in the background, with progress and a Cancel button, while search
  keeps using the current model; it switches over in one step when done.
  Models of any size up to 4000 dimensions work, not only 2048. Vectors move
  to a new `chunk_embeddings` table, and migration `0024` copies the existing
  ones there.

- **Tune retrieval and answering from Settings**
  ([#57](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/57),
  spec 0040 FR4). Settings → Configuration → Retrieval & answering holds the
  switches and limits behind search: passages per answer, the relevance floor,
  agentic search and its limits, reranking, HyDE and document processing. Each
  applies to the next question, shows whether it is the default, from `.env`
  or saved here, and is refused with its allowed range if out of bounds.
- **See who changed AI settings, and lock them**
  ([#58](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/58),
  spec 0040 FR5). Every saved setting says who saved it, and Recent changes
  lists each change old → new, with API keys only as their last four
  characters. `AI_SETTINGS_LOCKED=true` makes the section read-only, enforced
  by the server, for deployments that keep AI config in `.env`.
- **OpenRouter and llama.cpp work as providers out of the box**
  ([#67](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/67),
  spec 0040 FR9). OpenRouter requests carry its attribution headers and its
  model list shows context length and price. The chat test checks the endpoint
  streams, and an embeddings test on a llama.cpp server without `--embeddings`
  says so.

### Changed

- **Summaries cover the whole of a long document**
  ([#99](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/99),
  spec 0025 FR9a). "Summarise the handbook" read the document's first 24
  passages, so a long document was summarised from its opening alone. It now
  reads each section's opening across the whole document, and when that is
  still only part of it, the answer says so.

### Fixed

- **"Afterwards" follow-ups reach the planner**
  ([#106](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/106)).
  With `RAG_AGENTIC_ROUTE=adaptive`, a follow-up such as "How long does the
  fire watch stay afterwards?" was treated as a standalone question and
  searched word for word. "Afterwards", "beforehand" and "meanwhile" now count
  as pointing back at the conversation.

## [0.24.1] - 2026-09-26

### Changed

- **The agentic search spends its searches better**
  ([#93](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/93),
  [#94](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/94),
  [#95](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/95),
  [#100](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/100)).
  When the planner asks for two searches in one reply, both now run together
  instead of the second being dropped. A search it already ran is not run
  again; the loop stops with what it has (`repeated-query` in Observability).
  The planner is told how many searches it has left, and sees past answers cut
  to 300 characters instead of in full.
- **Agent token counts include figure reads**
  ([#96](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/96)).
  The log and Observability counted planner tokens only.

### Fixed

- **Figure questions are answered from what the figure shows**
  ([#90](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/90),
  [#91](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/91),
  spec 0031 FR14, FR15). What `read_figure` saw only reached the planner, so
  the answer was written from the figure's label and refused or guessed. The
  reading now reaches the answer and is cited as the figure. A figure read also
  no longer raises the relevance bar, which had dropped the very figure it read.
- **Follow-up answers know what "it" refers to**
  ([#97](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/97)).
  The answer was written from the literal follow-up, so "Who signs it off?"
  could name the signer of the wrong permit. It now gets the planner's reading
  of the question too.
- **The planner can no longer skip the relevance floor**
  ([#98](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/98)).
  Its search tool offered a document id it was never shown, so any id was
  invented and wasted a search, and a real one would have returned a whole
  document past the floor. The option is removed.
- **A slow search can no longer overrun the agentic time limit**
  ([#92](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/92)).
  Searches, including the fallback when the planner is down, are now cut off
  at `RAG_MAX_LOOP_MS` like planner calls.

## [0.24.0] - 2026-09-26

### Added

- **Plan only when it pays**
  ([#85](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/85),
  [#86](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/86),
  [#87](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/87),
  spec 0043). Three settings to stop paying for the agentic planner where it
  does not help: `RAG_AGENTIC_ROUTE=adaptive` plans only follow-ups and
  multi-part questions; `RAG_AGENTIC_CONFIDENT_SIMILARITY` skips the second
  planner decision when the first search is a strong match;
  `RAG_PLANNER_CALL_MS` caps each planner call so a stall costs seconds, not
  the whole loop budget. Each defaults to the old behaviour until the eval
  sets it. The activity drawer and Overview name the new outcomes.
- **`RAG_PLANNER_REASONING=off` lets the planner skip its hidden reasoning**
  ([#84](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/84)).
  For planner models that honour it (Nemotron and Qwen3 on NIM or vLLM), each
  decision comes back faster: 1.3 s instead of 2.4 s typical in a benchmark,
  with the same searches chosen. Off by default until the retrieval eval has
  compared the two.

### Changed

- **The documentation reads more plainly**
  ([#70](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/70)).
  The pages under Docs were rewritten in plain language, with the same facts.

### Fixed

- **Running out of time after a search is no longer called a planner failure**
  ([#83](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/83)).
  When the agentic search's time limit cut off a planner decision after it
  had already found passages, the log warned that the planner was
  unavailable and Observability counted it that way, though the answer was
  written from those passages as normal. It is now recorded as a stop at the
  time limit, with an info line saying how many passages were kept.
- **A model NVIDIA lists but does not serve now says so**
  ([#82](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/82)).
  NIM's model list includes some models it does not run for the account;
  choosing one (in Settings → Models) made every call fail with an opaque
  "Function … Not found for account" 404. The error now names the model and
  says to choose another, and fails at once instead of looking like a
  provider outage.

## [0.23.0] - 2026-09-26

### Added

- **Watch an answer being built, live**
  ([#80](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/80),
  spec 0042). Every chat answer has an **Agent activity** drawer. Opened while
  the answer is written, it follows each step and says in plain words what
  happened (what the planner decided, what each search found, retries);
  opened on an older answer, it shows what was recorded. Everyone sees it for
  their own answers; admins also see each line's details and links to the
  full run.
- **Watch RAG and agent health over time**
  ([#79](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/79),
  spec 0042). Observability → Overview shows the last 24 hours or 7 days
  against the period before: questions, no-match rate, answer time, time to
  first word, tokens per answer and failures, with trends; charts over time;
  how agentic searches ended; best match against the similarity floor; where
  the time goes step by step; failures by model; and documents processed.
- **See how each question was answered, step by step**
  ([#78](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/78),
  spec 0042). Every question and every document ingestion is now recorded as
  a run of timed steps. Observability → Runs lists them; opening one shows a
  replayable timeline of what happened, from the planner's decisions and each
  search to writing and checking the answer, with the model, tokens and
  results of every step, and a link to its log lines.
- **Read the system's logs in the app**
  ([#77](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/77),
  spec 0042). Admins get an **Observability** item in the sidebar with a live
  Logs page: colour-coded by level and by area (agent, retrieval, inference,
  ingestion, auth, settings, system), searchable, with each line's details
  and every line of one question a click away. The agents now log what they
  decide as they decide it. Lines are kept in Postgres for 7 days
  (`LOG_RETENTION_DAYS`; `LOG_PERSIST=false` turns it off), with secrets
  removed first.
- **Choose the AI provider and models from Settings**
  ([#54](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/54),
  [#55](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/55),
  spec 0040). Admins can add connections to NVIDIA NIM, OpenRouter, a
  llama.cpp server, OpenAI, Ollama, vLLM / LM Studio or any OpenAI-compatible
  URL, test them, and choose the connection and model for each job (chat,
  planner, HyDE, vision, page parsing). Changes apply to the next request,
  with no restart and no `.env` edit. API keys are encrypted at rest and never
  sent back to the browser. The model box is a searchable dropdown of the
  models the connection lists. Settings is now laid out as tabs down the side
  (a row on phones): Account, Configuration (providers and models), Users and
  About, each linkable (`/settings#configuration`). Every AI setting has an ⓘ
  that explains it in plain words
  ([#76](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/76)). Embeddings stay on the `.env` endpoint
  until re-indexing lands (#56).
- **Documentation inside the app**
  ([#60](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/60),
  [#61](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/61),
  [#59](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/59),
  spec 0041). A **Docs** item in the sidebar opens the platform's
  documentation — the same `docs/*.md` the repo maintains — grouped as About,
  Using the app, Features, Architecture & retrieval, Data and Operations. Pages
  have a table of contents, links that stay in the app (or go to GitHub at the
  running commit for README, specs and source), and all 12 architecture
  diagrams drawn, in light and dark. Signed-in users only. `pnpm docs:check`,
  now in CI, fails on an unindexed doc or any broken link or anchor.
- **Search the docs**
  ([#62](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/62),
  spec 0041 FR7). A search box at the top of `/docs` (press `/` to jump to it)
  finds the page and the heading that mention what you type, shows the
  matching passage, and links straight to that heading. It searches in the
  browser; nothing is sent to a model. The Docs pages were restyled with it:
  illustrated cards on the index, a section label and title on each page, and
  an "On this page" panel that follows along as you scroll.

### Fixed

- **The account avatar opens its menu again in development**
  ([#74](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/74)).
  Under `pnpm dev`, Next.js's dev-tools button (a dark circle with an "N")
  sat on top of the avatar and took the click, and looked enough like an
  avatar to be clicked instead of it. It is now hidden; build and runtime
  errors still show.

## [0.22.0] - 2026-09-25

### Added

- **Whole sections come back as one source**
  ([#26](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/26),
  spec 0033 1c). When two or more chunks of one section on one page clear the
  similarity floor, retrieval returns the whole section once, in reading
  order, instead of several adjacent slices of it. The citation highlights
  every paragraph of the section, and the document inspector shows which
  section run each chunk belongs to. Sections come from the headings ingestion
  already records, so nothing is re-embedded and no re-ingest or migration is
  needed; the similarity floor still decides what is relevant, so a question
  the documents cannot answer is still refused. On by default;
  `RAG_PARENT_ASSEMBLY=false` turns it off. `pnpm rag:eval --parents-ab`
  scores one retrieval both ways, against a new `records-policy` evaluation
  document and a `section` question type.
- **A local reranker that needs no account**
  ([#16](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/16),
  spec 0036). `RAG_RERANK_BACKEND=local` — now the default backend — scores
  retrieved passages with a 23 MB cross-encoder
  (`Xenova/ms-marco-MiniLM-L-6-v2`) running in-process as WebAssembly: no API
  calls, no rate limit, no document text sent anywhere. The model downloads
  once into `RAG_RERANK_MODEL_DIR`. Measured with reranking on: hit@1 and MRR
  0.882 → 0.941, refusal accuracy 1.000, at about +1.5s of retrieval per
  question, which is why reranking itself (`RAG_RERANK_ENABLED`) stays off by
  default. It runs on the Alpine image, where the native ONNX runtime does not
  load, and adds 14.6 MB to it.

### Changed

- **Filtered vector search keeps its recall on large corpora**
  ([#25](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/25),
  spec 0033 1e). Migration `0017` sets `hnsw.iterative_scan = relaxed_order`
  on the database. When Postgres uses the HNSW index for a tenant-filtered
  query, the filter is applied after the scan, and a tenant holding 0.1% of all
  chunks kept 1 in 20 true matches (recall 0.055); with the setting, 0.950. At
  today's sizes the planner picks an exact scan for tenant queries, so nothing
  changes yet — `pnpm rag:eval` is identical. Run `pnpm db:migrate`.

### Fixed

- **You can ask the next question as soon as the answer is written**
  ([#48](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/48)).
  The composer stayed locked until citation verification finished — up to
  12s after the answer and its metrics were on screen. The answer is now
  saved and its metrics sent the moment drafting ends, and that unlocks the
  composer; verification continues in the background, shows "Checking
  sources…" on that answer, and revises it in place if it strips a claim, even
  if the next question is already streaming. Measured on the live endpoint:
  unlock at 17.0s instead of 29.0s.

- **An overloaded model is reported as overloaded**
  ([#43](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/43)).
  The chat endpoint can answer `200` and then stream an error frame
  (`"Service temporarily overloaded"`, code 503). The route read it as an
  empty frame, retried 230ms later into the same overload, and told the user
  "The model returned an empty answer". Error frames are now recognised, the
  retry backs off (2s after an upstream error, 1s after an empty stream), and
  a failure after the retry says the model is overloaded, with its code.

- **The send button unlocks within seconds of the answer**
  ([#42](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/42)).
  Citation verification runs after the answer streams and keeps the
  conversation busy until it returns; it used the client defaults of a 60s
  timeout and up to 4 attempts, so a slow planner held the composer for
  92–113s. It now gets one attempt with a 12s deadline and still fails open
  (nothing is stripped on a timeout). The answer's total time and tokens/sec
  now describe drafting only, not the verification wait.

- **Follow-up questions survive a planner outage**
  ([#41](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/41)).
  Only the planner resolved "what about Sweden Central?" from the
  conversation, so when it was down the fallback searched the words alone and
  refused. The fallback now also searches the previous user question together
  with the new one, and keeps a passage found only that way when the new
  question made it more relevant than the previous question did on its own —
  otherwise "And can it be extended?" would be answered with the probation
  length. With the planner forced down: follow-up hit@1 0 → 0.563, all 4
  unanswerable follow-ups still refused, single-hop unchanged.

## [0.21.1] - 2026-09-25

### Fixed

- **Chat no longer refuses every question when the planner model is down**
  ([#32](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/32)).
  With the agentic path on by default, a planner that failed before its first
  search — endpoint down, call timed out, or nothing usable in the reply —
  ended retrieval with no evidence, and every answer became a refusal after
  the 15s budget. Observed on 2026-09-25 when `nemotron-3.5-lightning` stopped
  responding while the embedding and chat models were fine. The loop now
  searches the original question once in that case, so an outage degrades to
  the fixed pipeline's retrieval and answers stay grounded. It still waits out
  the planner's budget first.
- **GitHub Release titles use the tag message again**
  ([#33](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/33)). The
  release job read the subject of the commit the tag points at, because
  `actions/checkout` fetches a tag as a lightweight ref, so v0.21.0 was titled
  "Merge pull request #31 …". It now fetches the annotated tag before reading
  its message.

## [0.21.0] - 2026-09-25

### Security

- **Next.js and Auth.js patched past critical advisories**
  ([#11](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/11)).
  `next` 16.2.10 → 16.3.6 fixes an unauthenticated RCE in image optimisation,
  a proxy bypass, SSRF and a Server Action DoS; `next-auth` 5.0.0-beta.31 →
  beta.32 (with `@auth/core` 0.41.3) fixes auth-check and email-normalisation
  issues. `@auth/drizzle-adapter` 1.11.3, `nodemailer` 9.1.1, `sharp` 0.35.4
  and `eslint-config-next` 16.3.6 follow, and pnpm overrides set floors for
  `browserslist` and `baseline-browser-mapping`. `pnpm audit --prod` now
  reports no known vulnerabilities (it reported 33, 5 of them critical).

### Added

- **Work is tied to issues, and the release process is checked**
  ([#19](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/19)).
  A new `PR checks` workflow (`.github/workflows/pr.yml`) runs commitlint over
  every PR commit and title, requires `Closes #N` / `Part of #N` in the PR
  body, and requires a `CHANGELOG.md` entry for `feat`, `fix`, `perf`, `revert`
  and breaking changes unless the PR is labelled `no-changelog`.
  `pnpm release:next` suggests the next version from the Conventional Commits
  since the last tag; `pnpm release:check` fails a release whose
  `package.json`, CHANGELOG heading and tag disagree, whose `[Unreleased]` was
  not rolled in, whose version does not go up, or that leaves a finished spec
  `Proposed` — and CI's `release` job now runs it before re-tagging anything.
  `CLAUDE.md` gains "Work tracking" and "Releasing" sections, the PR template
  asks for the issue, spec, CHANGELOG line, docs and version impact, and a
  `/ship` Claude Code skill walks a release end to end. Branches are named
  `<type>/<issue#>-<slug>`, and `main` only changes through pull requests.

- **A document's structure is found in its text layer**
  ([spec 0039](specs/0039-structure-from-the-text-layer.md)). A page read by
  the layout parser came back as typed elements and got everything built on
  them — furniture dropped, headings attached with their boxes, one chunk per
  element. A page read from the text layer got none of it: one page-sized
  chunk, the running header promoted to a heading, the footer indexed as prose.
  Same document, and nothing told the reader the difference was in how the page
  was _read_ rather than in what it contains.

  The signals were already in the pipeline and being discarded: every text item
  carries a **point size** and an **end-of-line** flag, and only its string and
  box were kept. Measured on a real report — body 10.5pt, section headers 12.5,
  title 17, running header and footer both 7.5 — separating those needs
  arithmetic, not a model. So a text-layer page now produces the parser's own
  element shape and flows through the same two functions, with no API call and
  with document cracking disabled as well as enabled.

  Two thresholds were wrong until real geometry corrected them. Furniture is
  positioned by line **rank**, not by a margin band: the measured footer sits
  71% down a page whose content stops early. And the paragraph test is bounded
  below as well as above, because a column break is a large negative gap that a
  one-sided test reads as no gap — which merged the foot of one column into the
  head of the next.

  `pnpm rag:eval` after this and spec 0038: hit@1 0.882, MRR 0.912, refusal
  accuracy 1.000, cross-KB leakage 0, layout suite 1.000 — identical to the run
  before both. Chunk boundaries moved for every text-layer document and the
  numbers did not.

- **The search key is stored, not just embedded**
  ([spec 0038](specs/0038-store-the-search-key.md)). A figure's caption — or,
  for a caption-less figure, the sentence a vision model spends ~40 seconds
  writing — was prepended to the embedded text and then discarded. It reached
  exactly one vector and nothing else: no lexical match, no citation could show
  it, nobody could check whether the label was any good.

  Measured on the local corpus before this landed: the query _"unplanned
  downtime by quarter across all sites"_, whose words appear only in a caption,
  scored **0.650** dense similarity against the right figure and matched **no
  row at all** lexically. The two halves of hybrid retrieval were searching
  different documents.

  `chunks.caption` now stores it, and `chunks.content_tsv` is generated from
  heading, caption and content together, so a keyword question can find a
  section title or a caption. Existing rows gain the heading half immediately —
  the generated column re-derives on migration — and the caption after a
  re-ingest, which is the only way to recover text that was never written down.

  The inspector draws heading and caption regions on the page in their own
  weights, with a legend, so text that was indexed as _context_ no longer looks
  like text that was skipped. Each chunk shows what it is found by, and a **Raw
  chunk** view shows the stored record verbatim alongside the text composed for
  embedding — marked as recomputed, because a document renamed after ingestion
  makes that composition and the stored vector disagree.

- **See what was actually indexed from a document**
  ([spec 0037](specs/0037-inspect-what-was-indexed.md)). Clicking a document
  opens every page of it: what happened to that page in plain language, the
  page image with the indexed regions drawn on it, and the stored text of each
  chunk — the text retrieval actually matches against, not a tidied rendering
  of it.

  The database already recorded all of this and the UI showed none of it. A
  document whose page 8 failed to parse, or that hit its page budget and had
  the rest read the cheap way, displayed the same `Ready` badge as one indexed
  perfectly. So the list gains a **Partly indexed** badge — shown _beside_
  `Ready`, not instead of it, because the document really is searchable and
  part of it really is missing — whenever the budget ran out, a page failed, or
  a recorded page produced no chunks at all. That last one is the case that was
  invisible, and it is the shape of the silent failure document cracking was
  written to fix.

  The badge is derived from the recorded outcomes on every read rather than
  stored, so it cannot drift from what ingestion wrote. A `figure` chunk is
  labelled as a search key and an `ocr` chunk as recovered from an image, so
  neither reads as a quotation. A document ingested before the per-page record
  existed says the routing detail is unknown instead of inventing one, and is
  not marked partial — there is nothing to compare against. Read-only, one page
  image at a time, and nothing on the ingestion or retrieval path changed.

- **A citation highlights the passage, not just the page**
  ([spec 0035](specs/0035-span-level-citations.md)). Opening a source marks the
  cited region on the page instead of leaving the reader to find the sentence
  themselves. A chunk stored with several boxes — a passage spanning two
  columns — highlights each of them; their union would cover the gutter and the
  wrong column.

  A framed PDF viewer cannot be drawn on, so the panel now shows a
  **server-rendered image of the page** with the boxes over it. That is a
  security decision, made deliberately: the alternative, running pdf.js in the
  panel, would put an attacker-supplied PDF inside the authenticated origin's
  JavaScript context, which is exactly the class of bug CVE-2024-4367 was.
  Rendering server-side adds no new exposure at all, because ingestion already
  parses every one of these PDFs with pdf.js in the same process, and what
  reaches the browser is a PNG pinned with `nosniff`. The trade is real: the
  page is a picture, so its text cannot be selected or searched. The document
  itself is still one click away in "Open in new tab", served by the unchanged,
  hardened `/api/documents/[id]/source`.

  Nothing about this is conditional on re-ingesting. A chunk with no stored box
  opens at its page with no highlight, silently — the behaviour every citation
  had before — and so does a page that will not render, which falls back to the
  browser's own viewer. A **figure** citation is outlined rather than filled and
  says in words that it is a description written to make the figure findable,
  not the document's own words: a box around it looks more like a quotation than
  a page number ever did, so the labelling matters more there, not less.

- **Tables, figures and scanned pages can be indexed**
  ([spec 0031](specs/0031-tables-figures-and-complex-layouts.md)), behind
  `RAG_CRACK_ENABLED` (default off). Each page is triaged locally, for free, and
  only pages that need help — multi-column, tabular, image-bearing or scanned —
  are sent to `nvidia/nemotron-parse`, which returns typed, boxed elements
  instead of a flat string. On the evaluation corpus that is 4 parse calls
  across 6 documents; three documents spend nothing, which is the property that
  makes it affordable on a rate-limited tier. A scanned appendix that previously
  ingested as "success" while contributing nothing to the index is now read.
  Chunks gain `kind` and `bbox`, the latter being what span-level citation
  highlighting will need.

  A figure is indexed by a **search key** — its caption where it has one, free
  and in the document's own words, and a generated one-sentence label where it
  does not. What the figure _shows_ is read at answer time by the new
  `read_figure` tool on the agentic loop (`RAG_READ_FIGURE_ENABLED`). That split
  is measured: transcribing a chart blind at ingestion was wrong by 15–30% and
  took 40s, while a specific question against a cropped region was correct in
  4s. Unlabelled quantities remain unreliable under any instruction tested, so a
  deterministic guard replaces any number the figure does not print with
  `[unlabelled]`.

  Budgets degrade rather than fail: past `RAG_CRACK_MAX_PAGES` or
  `RAG_DESCRIBE_MAX_FIGURES` the remaining pages take the text-layer path, the
  document still reaches `ready`, and `documents.extraction` records per page
  which route it took and why.

- **`pnpm rag:eval --answers`** generates an answer from the retrieved context
  and asserts against it, reported separately from `hit@k` because it measures
  generation rather than retrieval.

- **Ingestion survives a restart, and resumes instead of starting over**
  ([spec 0034](specs/0034-resumable-ingestion.md)). A deploy or a crash
  partway through a document used to leave it in "extracting" forever, with
  nothing running and nothing that would ever run again — the only way out was
  deleting it and uploading it again. Now a worker takes a document with a
  10-minute lease, a sweep on boot and every minute afterwards picks up anything
  whose lease has expired, and a document that repeatedly fails to complete ends
  as "failed" with a reason you can read rather than cycling forever.

  Resuming does not re-buy what the interrupted run already paid for. Parser
  output is cached per page, so a document that cracked 20 of 25 pages before a
  restart pays for the remaining 5. A resumed run also spends the same cracking
  budget the original would have, so an interruption cannot quietly produce a
  better-indexed document than an uninterrupted run of the same file.

  This needs no queue, no broker and no second container — the lease is one
  conditional `UPDATE` that Postgres serialises. **Not yet verified against a
  real container kill**: the unit suite mocks the database driver, so it proves
  the SQL is shaped correctly rather than that Postgres serialises two racing
  claims as intended.

### Changed

- **CI is back** ([#12](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/12)).
  `.github/workflows/ci.yml` runs format, lint, typecheck, unit tests with
  coverage, `specs:check` and the Playwright suite on every PR and push to
  `main`, publishes the multi-arch app and migrate images to GHCR from a green
  `main`, and turns a `v*` tag into a re-tagged image and a GitHub Release. A
  release tag ships something again. MinIO in CI uses the Chainguard images,
  because `minio/minio` and `minio/mc` no longer pull
  ([#18](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/18)).
  CodeQL stays off.
- **Scanned PDFs are no longer rejected outright** when cracking is enabled.
  With it off, the existing rejection is unchanged.

### Fixed

- **Object storage starts again on a fresh pull**
  ([#18](https://github.com/devdaviddr/nextjs-rag-boilerplate/issues/18)).
  `minio/minio` and `minio/mc` stopped pulling from Docker Hub and quay.io, so
  `docker compose` could not start MinIO, create the bucket or run the MinIO
  backup — in local dev and in `docker-compose.prod.yml`. Both compose files
  and CI now use Chainguard's builds (`cgr.dev/chainguard/minio` and
  `minio-client`, `-dev` tags) pinned by digest, running as root like the old
  image so existing data stays readable. No data migration is needed.

- **Inference requests are now bounded.** `fetch` has no timeout of its own, so
  a stalled endpoint hung a request indefinitely — measured at 86 seconds on a
  planner call that normally takes 3–6, while the agentic loop's 15-second
  budget could do nothing about it. Every request now carries a 60-second
  per-attempt deadline, so a stall becomes a retry; a caller abort is still
  final and never retried.

- **The agentic loop's wall-clock budget is now a bound rather than a
  checkpoint.** It was read between iterations while every call got the outer
  request signal, so one slow call overran it freely (a 45-second budget
  finishing at 102). Each call now carries a signal composed from the budget it
  has left. Latent since spec 0029; only surfaced once figure reading added a
  call slow enough to expose it.

- **Loop budgets are sized for figure reading when it is enabled.** One
  `read_figure` costs ~13.5s and ~6,600 tokens against text-only defaults of 15s
  and 8,000, so the first look at a picture exhausted the loop and it stopped
  holding a correct reading it never used. Floors of 45s and 30k tokens apply
  with the tool on; they raise a configured value and never lower one.

- **The upload panel no longer claims scanned documents are unsupported** when
  cracking is enabled — the copy now reflects what the deployment actually
  does.

- **Page furniture no longer sends every page to the parser.** With cracking
  enabled, triage counted the ruled header, ruled footer and border box that
  nearly every corporate PDF carries on every page as though they were content,
  so ordinary prose pages cleared the "this page is drawing something"
  threshold on decoration alone. On a realistically styled 8-page report that
  meant **all 8 pages bought a parse call; now 6 do** — the two prose pages are
  free, while the chart, the flowchart, both table pages and the scanned page
  still route. Full-width rules and page-size frames are discounted before
  triage sees them, and the item count no longer includes the empty spacers the
  PDF text layer emits.

  The threshold itself is unchanged, so this narrows what triggers a parse call
  rather than weakening the trigger: the evaluation corpus routes exactly the
  same 6 of 17 pages by exactly the same route as before. That corpus never
  caught the defect because its fixtures have no page template at all, and the
  8-page report it was measured on is not in the repository — so the numbers
  above are not reproducible from a checkout.

### Notes

- Spec 0031 asserted that flattened tables and interleaved columns cost answers.
  Two deliberately destructive evaluation corpora failed to reproduce that: the
  chat model reconstructed both reliably. OCR and figures justify this feature;
  tables and columns are better chunks that have not been shown to be better
  answers. The spec records the contradiction rather than editing its premise.

## [0.20.1] - 2026-09-10

### Fixed

- **Sessions naming a deleted user are now invalidated instead of trusted**
  ([spec 0030](specs/0030-invalidate-sessions-for-deleted-users.md)). A JWT was
  trusted on its signature alone, so a token outlived the row it named: delete
  an account, restore an older backup, or point one `AUTH_SECRET` at a second
  database, and the holder stayed "signed in" as a user that did not exist —
  route protection passed, the UI rendered as authenticated, and the first
  write died on a foreign key as an unexplained 500 (reported against
  knowledge-base creation). The Node `jwt` callback now re-checks that the user
  row exists and returns `null` when it does not, which both nulls the session
  and clears the stale cookie. The check is throttled to once per
  `SESSION_REVALIDATE_SECONDS` (300) so ordinary requests add no query, and a
  failed lookup is treated as "unknown", never "deleted" — a database blip must
  not log everyone out.

## [0.20.0] - 2026-09-08

### Added

- **Agentic retrieval loop**
  ([spec 0029](specs/0029-agentic-retrieval-loop.md)), behind
  `RAG_AGENTIC_ENABLED` (default off). The model plans its own searches through
  a `search_documents` tool, resolves conversational references itself, and can
  search again when the first attempt is thin — inside hard caps on searches,
  wall-clock and tokens. Refusal remains a code path around the loop, never
  something the model is asked to honour. Citation verification strips claims
  their sources do not support. A separate query-rewriting call was built,
  measured at 15s, and folded into the planner instead. `step` frames report the
  current phase so the client is never silent without a heartbeat. The
  similarity floor rises with each extra search, because N attempts get N
  chances to clear it by luck — without that, refusal accuracy fell from 1.000
  to 0.667 while every other metric improved. `pnpm rag:eval --compare` scores
  both paths side by side and fails on a refusal regression.

- **Independent knowledge bases**
  ([spec 0028](specs/0028-independent-knowledge-bases.md)). A user can create,
  rename and delete several knowledge bases, upload a PDF into a chosen one, and
  move a document between them without re-ingesting it. A conversation searches
  a set of knowledge bases chosen when the thread is created, and cannot
  retrieve outside it — the filter sits beside `owner_id` in the same `WHERE`
  clause in all five places that clause appears, including the whole-document
  path where owner alone is no longer sufficient. `pnpm rag:eval` gains a
  cross-knowledge-base leakage metric (measured: 0) and fails the run on a
  refusal-accuracy regression against a saved baseline. Existing documents and
  conversations are migrated into one "My documents" knowledge base per user,
  with the backfill asserting its own correctness before it commits.

- **Rag Boilerplate: chat-first UX, conversation history and source viewing**
  ([spec 0026](specs/0026-chat-first-ux-and-history.md)). The product is now
  called Rag Boilerplate, signing in opens a new chat, and the shell uses the
  full viewport. Conversations and their citations persist and are listed as
  Recents in the sidebar, grouped by recency and renameable. Answers render as
  Markdown, show a thinking indicator until the first token, and carry
  generation metrics (tokens, tok/s, time to first token, model). Clicking a
  citation opens the source PDF at the cited page in a side panel.

### Removed

- **The `CI` and `CodeQL` GitHub Actions workflows.** No automated
  lint/typecheck/test/E2E run, and no container images published on a `v*` tag
  — which `deploy.yml` depended on. Run the quality gate locally before
  pushing. `docs/ci-cd.md` is kept as a record.

- **The `/dashboard` route.** It was a boilerplate demo page; chat is the
  landing surface now. Removed rather than redirected — a dead route still has
  to be maintained and tested.

- **RAG knowledge base and document chat** ([spec 0025](specs/0025-rag-knowledge-base-and-chat.md),
  [docs](docs/rag.md)). Upload PDFs into a private per-user knowledge base and
  ask questions answered only from your own documents, with a page-level
  citation for every source. Retrieval runs on `pgvector` inside the existing
  Postgres — no new service — and inference goes to any OpenAI-compatible
  endpoint (NVIDIA NIM by default, or a local Ollama/llama.cpp for a fully
  offline deployment). New `/documents` and `/chat` pages.

### Changed

- The `db` service image is now `pgvector/pgvector:pg17` (was
  `postgres:17-alpine`). The stock image does not ship the `vector` extension.
  Existing volumes keep working; the extension is created by migration `0008`.

## [0.19.0] - 2026-07-16

### Added

- **GitHub Releases are now generated by CI.** The `release` job creates the
  GitHub Release entry for every `v*` tag: notes come from that version's
  `CHANGELOG.md` section (falling back to auto-generated notes with a warning if
  the section is missing), and the title comes from the annotated tag's subject
  (`git tag -a vX.Y.Z -m "short title"` → "vX.Y.Z — short title"; lightweight
  tags get the bare version). Idempotent on job re-runs. The Releases page had
  silently frozen at v0.5.0 while tags marched on to v0.18.0 — those 27 missing
  entries were backfilled from the changelog, and this keeps it from drifting
  again.

## [0.18.0] - 2026-07-16

### Added

- **Floating `stable` image tag — "tag a release → the box deploys it".** The
  `release` job now also moves `ghcr.io/<owner>/<repo>:stable` (app + migrate) to
  every `v*` release it re-tags. A Tier B box that sets `APP_TAG="stable"`
  auto-deploys each new release within ~a minute of the tag push — the missing
  middle between `APP_TAG="latest"` (ships every green `main` merge) and a pinned
  semver (never moves without a manual bump on the box). Any `v*` push moves
  `stable`, so roll back by pinning `APP_TAG` to a previous version. With a
  floating tag, Settings → Build shows `stable · <sha7>` (the SHA still identifies
  the exact commit); pin a semver to display the version number.

## [0.17.0] - 2026-07-16

### Changed

- **Faster time-to-deploy (spec 0024).** A `v*` release tag no longer rebuilds the
  image — it **re-tags** the multi-arch image `main` already built and tested for
  that exact commit (`docker buildx imagetools create`, ~30s instead of a ~5.5 min
  rebuild). The `release` job waits for `main`'s `sha-<short>` image before
  re-tagging, so it inherits `main`'s full `quality` + `e2e` gate with no re-run.
  Tag CI drops from ~5m27s to ~30s.
- On `main`, the image build now **overlaps `e2e`**: `docker` is gated on `quality`
  only and runs in parallel with `e2e`, while `docker-merge` (which assigns the
  human tags) still needs both — so a failed test never yields a tagged image.
- The deployed version is now applied at **runtime** from `APP_TAG`
  (`APP_VERSION: ${APP_TAG}` on the `app` service in `docker-compose.deploy.yml`),
  since the re-tagged image keeps `main`'s baked `APP_VERSION`. `APP_GIT_SHA` stays
  baked. Settings → Build still shows `APP_TAG · <sha7>`.
- **Tier B pull timer** now defaults to a **60s** interval and **skips the deploy
  when the published app image is unchanged** (compares the pulled image digest to
  `~/.config/<repo>/.last-deployed-image`), so frequent polling is nearly free and a
  new release lands within ~a minute. Re-run `make deploy-timer` to pick up the new
  default on an existing box.

## [0.16.3] - 2026-07-16

### Fixed

- `make deploy` hung on some Podman machines: a single parallel
  `docker compose pull` (all services at once) wedges at 0% CPU on Podman, so the
  Tier B timer never completed a deploy. Now pulls the two GHCR images
  (`app`, `migrate`) individually, then `up -d`. This also stops re-checking the
  Docker Hub base images (postgres/minio/cloudflared) every run, avoiding Hub
  rate limits on a short timer interval. Found on the live self-hosted box; the
  individual-pull sequence was verified there end-to-end.

## [0.16.2] - 2026-07-16

### Fixed

- Deploy timer / autostart under launchd: the LaunchAgent ran with a bare `PATH`
  (`/usr/bin:/bin`) that omits Homebrew, so `docker` (at `/opt/homebrew/bin`)
  was unresolvable and every scheduled tick aborted at the readiness gate — even
  after the 0.16.1 probe fix. The install now **bakes the operator's `PATH` into
  the plist** and the scripts self-prepend the common Homebrew locations, so the
  engine resolves whether invoked from a shell or from launchd. Re-run
  `make deploy-timer` (or `make autostart`) to regenerate the plist. Found on the
  live self-hosted box.
- `scripts/setup.sh` preflight also switched from `docker info` to
  `docker version` (same Podman-hang avoidance).

## [0.16.1] - 2026-07-16

### Fixed

- Deploy timer / autostart: the container-engine readiness probe used
  `docker info`, which **hangs indefinitely on some Podman machines** — so every
  scheduled `make deploy-timer` tick (and `make autostart` boot) stalled before
  it ever deployed. Switched both to `docker version` (same reachability check,
  returns fast). Found on the live self-hosted box after 0.16.0.

## [0.16.0] - 2026-07-16

### Added

- **Deployed build version in Settings.** CI bakes the build identity
  (`APP_VERSION` = git ref, `APP_GIT_SHA` = commit) into the image via build-args;
  the app surfaces it in a new **Settings → Build** card, so you can confirm which
  version a self-hosted box is running after an unattended pull. Falls back to a
  "development build" note when unset (`next dev`, un-baked image).
  ([spec 0023](specs/0023-tier-b-default-and-build-version.md))
- **Pull-based deploy timer (Tier B).** `make deploy-timer`
  ([`scripts/macos-deploy-timer.sh`](scripts/macos-deploy-timer.sh)) installs a
  launchd timer that runs `make deploy` on an interval (default 300s), rolling out
  new releases unattended with **no self-hosted runner**.

### Changed

- **Pull-based deploy (Tier B) is now the recommended default**; the self-hosted
  runner path (Tier C) is documented as **private-repo-only**. On a public repo a
  fork pull request can execute arbitrary code on a self-hosted runner — Tier B
  (the box pulls from GHCR) has no such surface. `deploy.yml` now carries a loud
  do-not-use-on-public-repos warning.

### Security

- Documented and hardened against the **public-repo + self-hosted-runner** RCE
  risk (SECURITY.md, `deploy.yml`, Self-hosting → Tier C).

### Fixed

- Tier C self-hosted deploys: `deploy.yml` now copies the operator's `.env` from
  `~/.config/nextjs-fullstack-boilerplate/.env` (or `DEPLOY_ENV_FILE`) into the
  checkout before `make deploy` — `actions/checkout` cleans the work tree every
  run, so a `.env` in the checkout could never survive. Documented in
  Self-hosting → Tier C, along with the correct pinned-tag format
  (`APP_TAG=0.15.0`, no `v` — semver image tags are unprefixed).

## [0.15.0] - 2026-07-16

### Added

- **macOS boot persistence** (`make autostart`) — installs a login LaunchAgent
  ([`scripts/macos-autostart.sh`](scripts/macos-autostart.sh)) that waits for the
  Docker engine after a reboot and brings the tunnel stack up (`tunnel-up` by
  default, or `deploy` for pull-based updates). Closes the last gap between
  "deployed on a Mac mini" and "survives a power cut unattended".
- **Global per-IP login rate limit** (`AUTH_LIMITS.loginPerIp`, 50/10 min) —
  blunts credential stuffing across many accounts from one source. Enforced in
  both the login server action and the non-bypassable `authorize` callback,
  keyed independently so the two entry points don't double-count. Existing
  per-account (IP+email) limits unchanged.
- **"Running on a Mac mini (always-on)"** section in
  [Self-hosting](docs/self-hosting.md): autostart, auto-login/pmset, Docker
  Desktop vs OrbStack/Colima, memory sizing, and the Time Machine caveat
  (Docker volumes live in the VM and are NOT covered — offsite backups are the
  real safety net; also noted in [backups.md](docs/backups.md)).
- Unit tests for `getCurrentSession()` (decode-error tolerance, control-flow
  rethrow, genuine-failure rethrow) and the new per-IP login cap.

### Changed

- Renovate now pins GitHub Actions to commit digests
  (`helpers:pinGitHubActionDigests`).
- GitHub secret scanning + push protection enabled on the repository.

### Fixed

- Published container images are now **multi-arch** (`linux/amd64` +
  `linux/arm64`), so `make deploy` / `docker pull` works on Apple Silicon Mac
  minis and other ARM hosts — not just amd64 servers. CI builds each arch on its
  own native runner (`ubuntu-latest` + `ubuntu-24.04-arm`), pushes by digest, and
  merges a multi-arch manifest. The initial v0.14.0 images were amd64-only.
- Deployment-script hardening: `tunnel-verify.sh` uses `mktemp` instead of a
  fixed `/tmp` path and is shellcheck-clean; the setup wizard preflights
  `.env.example`; the quick-tunnel `cloudflared` gets `restart: unless-stopped`;
  the Terraform module README documents the provider v4→v5 upgrade caveat.

## [0.14.0] - 2026-07-16

### Added

- **One-click self-hosting** (`make setup`) — a guided wizard
  ([`scripts/setup.sh`](scripts/setup.sh)) that takes a fresh clone to a live app
  behind a Cloudflare Tunnel: preflight checks, `AUTH_SECRET` generation, a choice
  of quick / guided / automated on-ramp, demo-admin seeding, and a health verify.
  It orchestrates the existing tunnel primitives (spec 0005) rather than replacing
  them; idempotent and scriptable (non-interactive via env vars). New
  **[Self-hosting](docs/self-hosting.md)** guide and README pointer. See
  [spec 0020](specs/0020-one-click-self-hosting-setup.md).
- **`self-host` agent skill** for **Claude Code** (`.claude/skills/self-host/`) and
  **opencode** (`.opencode/skills/self-host/`) — auto-discovered when the project is
  opened, so you can tell your agent "self-host this on my domain" and it drives
  `make setup` (mode choice, Cloudflare inputs, run, verify) under the same
  secret-hygiene rules.
- **Continuous deployment for self-hosted instances** — CI now publishes the app +
  migrator images to GHCR (on `main`/tags, after tests pass), a
  `docker-compose.deploy.yml` overlay + `make deploy` pull and run them (migrations
  first, no build on the box), and an opt-in self-hosted-runner
  [`deploy.yml`](.github/workflows/deploy.yml) gives push-button deploys on release
  tags. Pull-based to respect the tunnel's outbound-only model. See
  [spec 0021](specs/0021-continuous-deployment-self-hosted.md) and
  [Self-hosting → Continuous deployment](docs/self-hosting.md#continuous-deployment).

## [0.13.6] - 2026-07-13

### Documentation

- Added a dedicated **[Web Push](docs/push.md)** guide (VAPID setup, subscribe/
  send, service-worker handlers, security), so every opt-in feature — OAuth,
  Email, Web Push, Backups — now has its own page. Linked from the README docs
  index and referenced from `pwa.md` / `features.md`.

## [0.13.5] - 2026-07-13

### Documentation

- Documentation review pass — corrected stale content, added a consolidated
  scripts reference, and tightened consistency:
  - **README** gains a full **Scripts** table (dev, quality, tests, database,
    docker, generators); refreshed the tech-stack and project-structure entries
    for OAuth / Web Push / theming / Mailpit.
  - **`docs/pwa.md`** — rewrote the "Push notifications" section, which still
    described the shipped feature as unbuilt to-do work.
  - **`docs/usage.md`** — added the missing env vars (OAuth, `APP_URL`,
    `REQUIRE_EMAIL_VERIFICATION`, `VAPID_*`, backup settings); fixed the
    `PROTECTED_PREFIXES` location (`proxy.ts`) and the stale "Add OAuth"
    extending row; expanded the testing/CI sections (Mailpit, per-test IP
    isolation, seed).
  - Consistency: standardized every doc's back-to-README link, aligned the
    email-provider list, fenced the deployment ASCII diagram as `text`, and
    fixed the "gitflow" → trunk-based wording in `specs/README.md`.

## [0.13.4] - 2026-07-13

### Added

- End-to-end email round-trips via a Mailpit catcher (`tests/e2e/email-flow.spec.ts`):
  register → emailed verification link → verified; and request reset → emailed
  link → new password → sign in with it. This closes the last manually-verified
  gap in spec 0011. A `mailpit` service is added to `docker-compose.yml`
  (`pnpm docker:mail`) and the CI e2e job; the e2e web server points at it
  (`playwright.config` / CI env). The round-trip tests self-skip when Mailpit
  isn't reachable, so a local run without it still passes the rest of the suite.
- Unit test for the email-disabled FR6 branch of `requestPasswordReset`
  (`tests/unit/recovery-actions.test.ts`), which the e2e suite can no longer
  cover now that it runs email-enabled.

## [0.13.3] - 2026-07-13

### Added

- Unit tests for the auth-recovery internals that were previously verified only
  by reading: `verification-tokens` (single-use consume, expiry rejection,
  hash-not-raw storage, purpose mismatch) and `verification-guard` (the
  `REQUIRE_EMAIL_VERIFICATION` soft-gate branches). +13 unit tests.

### Fixed

- Flaky E2E runs. Registration was rate-limited per **IP**, so every test shared
  one `register:::1` bucket that accumulated across the suite and tripped under
  CI retries. Each test now gets a unique client IP via `X-Forwarded-For`
  (`tests/e2e/fixtures.ts`), isolating rate-limit buckets so limits only fire
  in the test that provokes them. A Playwright `globalSetup` also seeds the demo
  admin (idempotent), making local runs self-healing if the dev DB was mutated.

## [0.13.2] - 2026-07-13

### Fixed

- OAuth users are now marked email-verified at creation. GitHub/Google verify
  email ownership before issuing their token, but the providers don't map
  `emailVerified`, so an OAuth account previously landed with
  `email_verified = null` — which meant `REQUIRE_EMAIL_VERIFICATION=true` would
  needlessly nag a provider-verified user with the verify banner and soft-gate
  their admin actions. `events.createUser` now sets `emailVerified` for
  adapter-created (OAuth) users. Credentials users are unaffected — they still
  verify via the emailed link. (Password reset was already correct: it only
  applies to accounts that have a password.)

## [0.13.1] - 2026-07-13

### Documentation

- Brought all docs current with the features shipped in 0.8.0–0.13.0 and added
  diagrams + setup guides:
  - **ERD** (Mermaid) of the full schema in [`docs/database.md`](docs/database.md),
    and a refreshed schema table (accounts/verification_tokens now in use;
    `push_subscriptions` added).
  - **ASCII container-topology diagram** of the production stack in
    [`docs/architecture.md`](docs/architecture.md); updated the overview diagram,
    auth-module table, and project tree for OAuth/email/push.
  - New **[OAuth setup guide](docs/oauth.md)** (GitHub + Google) and
    **[Email guide](docs/email.md)** (SMTP setup, password reset, verification,
    soft gate).
  - `README` "What it is" + Documentation index updated to link every guide.

## [0.13.0] - 2026-07-13

### Added

- Automated backups ([spec 0009](specs/0009-automated-backups.md)). The
  production compose stack gains a `db-backup` service (maintained
  `postgres-backup-local` image) writing nightly compressed Postgres dumps to
  `./backups/postgres/` with rolling retention (`BACKUP_RETENTION_DAYS`,
  default 14), and a `minio-backup` sidecar that `mc mirror`s the object bucket
  to `./backups/minio/` on an interval. A `scripts/backup-verify.sh` doctor
  script (mirrors `tunnel-verify.sh`) fails when the newest dump is stale or
  missing, so a silently-broken backup gets caught. Full restore runbook in
  [`docs/backups.md`](docs/backups.md), including an optional, opt-in offsite
  copy (e.g. Cloudflare R2). `backups/` is git- and docker-ignored (dumps
  contain user data).

## [0.12.0] - 2026-07-13

### Added

- Web Push notifications ([spec 0015](specs/0015-web-push-notifications.md)).
  Activates the push hooks that were stubbed in `public/sw.js` since the PWA
  work: a `push` handler that shows the notification and a `notificationclick`
  handler that focuses/opens the right tab. A new `push_subscriptions` table
  stores per-device subscriptions; Settings gains an "Enable notifications"
  toggle (permission prompt → `pushManager.subscribe` → `saveSubscription`
  server action, ownership-checked delete on disable). `sendPushNotification()`
  / `notifyRole()` server helpers send via `web-push` and auto-prune
  subscriptions the push service reports as Gone (HTTP 404/410). Wired
  end-to-end with one worked example — admins are notified when a new user
  self-registers. VAPID keys are opt-in env vars (`VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`); with none set the feature — including
  the Settings panel — is fully inert. The private key is server-only.

### Changed

- New `push_subscriptions` table (migration `0007_sticky_slyde`).

## [0.11.0] - 2026-07-13

### Added

- Email verification & password reset
  ([spec 0011](specs/0011-email-verification-password-reset.md)). Self-service
  password reset via `/forgot-password` → emailed single-use link (1-hour TTL)
  → `/reset-password`, with an anti-enumeration response (the same "if an
  account exists…" message regardless of whether the email is registered) and
  a "Forgot password?" link on the login form. Optional email verification:
  a verification email is sent on registration when email is enabled, confirmed
  at `/verify-email`. A new `REQUIRE_EMAIL_VERIFICATION` flag (default off, and
  ignored when email is disabled) soft-gates unverified users — a dismissible
  banner with a resend action, plus a server-side block on admin mutations —
  without locking them out of the app. The invite-token machinery was
  generalised from `invite.ts` into a shared `tokens.ts` primitive (same
  32-byte / SHA-256 / timing-safe design) now backing invites, reset, and
  verification; a `purpose` column on `verification_tokens` scopes each token
  so it can't be replayed cross-flow.

### Changed

- `verification_tokens` gains a nullable `purpose` column (migration
  `0006_daily_silver_fox`).

## [0.10.0] - 2026-07-13

### Added

- OAuth providers — GitHub & Google sign-in
  ([spec 0010](specs/0010-oauth-providers.md)). Wires the Auth.js Drizzle
  adapter into the Node auth config (the schema was already adapter-compatible)
  while keeping `session.strategy: 'jwt'`, so `proxy.ts`'s edge route
  protection still reads the JWT with zero DB round-trips. Each provider is
  independently opt-in via env vars (`AUTH_GITHUB_ID`/`_SECRET`,
  `AUTH_GOOGLE_ID`/`_SECRET`); with none set, nothing changes for
  credentials-only deployments. The login page shows "Continue with …" buttons
  only for configured providers. New OAuth users get a bootstrap role (first
  user → `admin`, rest → `member`) via `events.createUser`. Email-match
  auto-linking is **off** (an account-takeover vector): a matching email shows
  a "sign in and link from Settings" message instead. Settings gains a
  "Connected accounts" panel to link/unlink providers, with a server-side
  guard against unlinking your only remaining sign-in method.

## [0.9.1] - 2026-07-13

### Changed

- The app shell now shows the app icon (the same mark as the favicon/PWA icon)
  to the left of the wordmark in the sidebar, mobile drawer, and mobile topbar.
  The icon is decorative (`alt=""`) since the adjacent text already names the
  app. Rendered via `next/image` from `public/icon-192.png`.

## [0.9.0] - 2026-07-13

### Added

- SEO & OpenGraph metadata ([spec 0019](specs/0019-seo-opengraph-metadata.md)):
  shared links now unfurl to a rich preview card. Adds `metadataBase` plus
  `openGraph` and `twitter` (`summary_large_image`) blocks to the root layout,
  a default 1200×630 share image (`public/og.png`, generated by
  `pnpm gen:og` — swap the file to rebrand a fork, no code change), and
  `robots.txt` / `sitemap.xml` routes via Next's file conventions. A new
  optional `APP_URL` env var (defaults to `http://localhost:3000`) drives the
  canonical origin so image URLs resolve absolutely; set it to the real domain
  per deployment.

## [0.8.0] - 2026-07-13

### Added

- Dark-mode toggle & theming ([spec 0013](specs/0013-dark-mode-theming.md)):
  a light / dark / system theme switcher. The CSS token set (`.dark` oklch
  variables in `globals.css`) already existed but was unreachable — this wires
  up the switch. Powered by `next-themes` with `attribute="class"` and
  `defaultTheme="system"`, so it respects `prefers-color-scheme` until the user
  makes an explicit choice, which then persists in `localStorage`. The
  anti-flash inline script runs under the strict production CSP via the existing
  per-request nonce (threaded from `proxy.ts` through the root layout) — no
  `script-src` loosening. A `lucide-react` sun/moon dropdown lives in the app
  shell topbar and on the login/register pages, so authenticated and
  unauthenticated users can both pick a theme. The trigger icon swaps purely via
  CSS to avoid any flash-of-wrong-icon or hydration mismatch.

## [0.7.2] - 2026-07-13

### Fixed

- Profile photos no longer flash the fallback initials on every page refresh.
  Two causes: the download route sent `Cache-Control: no-store` for all files
  (so the avatar was re-fetched over the network on every load), and Radix's
  `Avatar` shows the fallback until the `<img>` finishes loading. Avatars are
  now served `private, max-age=…, immutable` — safe because each avatar has a
  unique, immutable URL (a fresh file id on every change; the old one is
  deleted) — while general file downloads keep the stricter `no-store`. The
  `AvatarFallback` also gets a short `delayMs` when a photo is expected, so a
  fast/cached load renders the image directly instead of briefly flashing
  initials.

## [0.7.1] - 2026-07-13

### Fixed

- File downloads (`GET /api/files/[id]`) 500'd when the original filename
  contained a character above U+00FF — e.g. the U+202F narrow no-break space
  macOS puts in screenshot names (`Screenshot … 12.01.47 pm.png`). HTTP
  header values are ByteStrings, so the raw name in the `Content-Disposition`
  `filename="…"` fallback threw. The fallback is now stripped to printable
  ASCII; the RFC 5987 `filename*=UTF-8''…` parameter (already present)
  carries the real Unicode name for modern browsers. Existing avatars/files
  affected by this display correctly on the next request — no re-upload
  needed. Regression-tested with a macOS-screenshot-style filename.

## [0.7.0] - 2026-07-13

### Added

- Profile photo upload ([spec 0018](specs/0018-profile-photo-upload.md)):
  every signed-in user can upload/replace/remove their own avatar from
  Settings, built entirely on the file-storage infrastructure from
  [0007](specs/0007-file-uploads.md). Narrower size/type limits than general
  uploads; counts against the same per-user quota. Surfaced through Auth.js's
  standard `session.user.image` — shows in the app shell topbar and Settings
  immediately, no re-login required. `users` gains a nullable
  `avatar_file_id` column (FK → `files.id`, `set null`).
- shadcn `Avatar` component (`src/components/ui/avatar.tsx`).

### Fixed

- `useSession().update()` called with no argument only re-fetches the
  current session — it never reruns the `jwt` callback's
  `trigger === 'update'` branch, so client-triggered session refreshes
  (e.g. after a profile-photo change) silently did nothing. Fixed by calling
  `update({})`; documented in `CLAUDE.md` since it's easy to get wrong again.
- `AvatarFallback`'s default styling (`bg-muted`/`text-muted-foreground`,
  shadcn's own default) failed WCAG AA contrast at small sizes — caught by
  the existing a11y test suite, fixed by switching to `text-foreground`.

## [0.6.0] - 2026-07-13

### Added

- File uploads & object storage ([spec 0007](specs/0007-file-uploads.md)):
  self-hosted, S3-compatible **MinIO** as a docker-compose service (no public
  ingress — the app is the only gateway to it), a `files` table, and
  `src/lib/storage/` (upload/list/delete Server Actions, an
  ownership-checked `GET /api/files/[id]` download route). Uploads are
  validated server-side against a size cap, a MIME-type allow-list, and a
  per-user storage quota, and are rate-limited. A "My Files" panel in
  Settings is available to every signed-in user. Deleting a user now also
  deletes their stored files and objects.
- `pnpm docker:minio` — brings up MinIO plus a one-shot bucket-init service,
  alongside the existing `pnpm docker:db`.

### Fixed

- Server Actions now return `{ ok, error }` results instead of throwing for
  expected/validation failures (`src/lib/storage/actions.ts`) — Next.js
  redacts thrown error messages in production builds, which silently broke
  user-facing validation messages. Caught by testing against the actual
  production Docker image, not just `next dev`.

## [0.5.2] - 2026-07-13

### Added

- Specs for the next phase of the roadmap: file uploads & object storage
  ([0007](specs/0007-file-uploads.md)), automated backups
  ([0009](specs/0009-automated-backups.md)), OAuth providers
  ([0010](specs/0010-oauth-providers.md)), email verification & password
  reset ([0011](specs/0011-email-verification-password-reset.md)), dark-mode
  theming ([0013](specs/0013-dark-mode-theming.md)), Web Push
  ([0015](specs/0015-web-push-notifications.md)), and a written-but-not-
  scheduled note on shared-store rate limiting
  ([0017](specs/0017-shared-store-rate-limiting.md)).

### Changed

- Condensed the README roadmap checklist; it now points at `specs/` for
  detail instead of carrying per-item prose.
- Simplified the branch strategy to trunk-based: `main` is the only
  long-lived branch (no `develop`). Feature branches go `main` → `feature/*`
  → `main`; CI/CodeQL triggers updated to match.

## [0.5.1] - 2026-07-13

### Added

- Automated accessibility regression checks (`tests/e2e/a11y.spec.ts`) — axe
  (`@axe-core/playwright`) scans of login, register, dashboard, the settings
  admin panel (incl. the "Add User" dialog), and `/403` against WCAG 2.0/2.1
  A + AA, so an a11y regression fails CI instead of relying on a one-time
  manual pass.
- Unit test coverage for `src/lib/auth/admin-actions.ts` (previously 0%,
  the largest untested surface in the app) — create/update/delete user,
  role assignment, and invite completion, including the self-role-removal,
  self-delete, duplicate-email, and unknown-role guard paths.

### Changed

- Roadmap reframed around forking this boilerplate per POC/portfolio project
  and self-hosting a single instance (Docker + Cloudflare Tunnel), not scaling
  out across a cluster. Cloudflare Tunnel deployment is now marked shipped;
  file uploads (MinIO), SEO/public-facing metadata, and automated backups are
  the near-term priorities; shared-store rate limiting is deprioritized.

## [0.5.0] - 2026-07-13

### Added

- Role-based access control ([spec 0006](specs/0006-rbac.md)): `roles` / `user_roles`
  tables, roles in the JWT session, `requireRole` / `hasRole` server guards and
  `useRole` / `<RequireRole>` client helpers, edge role-gating in `proxy.ts`, a `/403`
  page, and an admin user-management panel in Settings.
- Invite-only account claim: admin-created users are passwordless and can only be
  claimed with a single-use, hashed, 7-day invite token via `/register?invite=…`.
- Optional email delivery (`src/lib/email/`): SMTP-based, provider-agnostic, and
  **off by default**. It activates only when `EMAIL_ENABLED=true` **and** an SMTP
  provider is configured — enabling it without a provider fails fast at boot, and
  when disabled every send is a safe no-op. Invite links are emailed when enabled and
  always shown in the admin UI as a fallback.

### Changed

- CI and CodeQL now run on `develop` as well as `main`, so feature PRs into the
  integration branch are gated by the full pipeline.

## [0.4.1] - 2026-07-12

### Changed

- Expanded the deployment guide ([docs/deployment.md](docs/deployment.md)) with a
  how-it-works overview, an environment-variables table, and operating /
  troubleshooting sections; added a prominent Deployment section to the README.

## [0.4.0] - 2026-07-12

### Added

- Cloudflare Tunnel deployment ([spec 0005](specs/0005-cloudflare-tunnel-deployment.md)):
  quick-tunnel and named-tunnel Compose overlays, a Terraform module
  (`infra/cloudflare/`), a `Makefile`, `docs/deployment.md`, and a
  `tunnel-verify` doctor. Rate limiting now trusts `CF-Connecting-IP`.
- Spec-driven development: a `specs/` directory with a template, workflow guide,
  and one spec per release.

## [0.3.1] - 2026-07-12

### Added

- `CLAUDE.md` with repo context, conventions, and a gitflow/commit guide for AI
  assistants working in this repository.
- graphify integration for Claude Code (`.claude/settings.json` PreToolUse
  hooks) that queries the knowledge graph before browsing source.

## [0.3.0] - 2026-07-12

### Added

- Auth rate limiting on login and registration — enforced in the server actions
  and, non-bypassably, in the credentials `authorize` callback.
- Nonce-based Content-Security-Policy with `strict-dynamic`, HSTS, and
  `X-Powered-By` disabled.
- Case-insensitive `lower(email)` unique index (defense in depth).
- Accessible mobile drawer: focus trap, Escape to close, focus restore, and a
  skip-to-content link.
- Structured-logging shim and graceful database-pool shutdown on SIGTERM.
- Renovate, CodeQL, commitlint (Conventional Commits), and a CI dependency audit.
- Contributor docs: CONTRIBUTING, SECURITY, and issue/PR templates.
- Tests for auth error paths and rate limiting.

### Changed

- `getCurrentSession` now treats only undecryptable cookies as signed-out;
  genuine errors surface instead of being swallowed.
- Registration relies on the unique constraint (handles the duplicate-signup
  race) and returns a clean error.
- Documentation expanded with a security model and session-revocation notes.

### Fixed

- Service worker no longer reloads on its initial claim (fixed a sign-out race).

## [0.2.0] - 2026-07-11

### Added

- Progressive Web App: web manifest, generated icons, a service worker with
  auth-safe caching, an offline fallback, and an install prompt.
- Minimal, borderless responsive app shell (sidebar + topbar with a mobile
  drawer) with PWA safe-area handling.
- MIT license.

### Fixed

- Resilient session handling and error boundaries (`error.tsx`,
  `global-error.tsx`, `not-found.tsx`) — resolves a Next.js 16 Turbopack
  global-error crash.

### Changed

- README restructured into a `docs/` directory.

## [0.1.0] - 2026-07-11

### Added

- Initial production-grade Next.js 16 boilerplate: App Router, Auth.js v5
  credentials auth (Argon2id, JWT sessions), Drizzle ORM + PostgreSQL,
  Tailwind CSS v4 + shadcn/ui, Vitest + Playwright, a multi-stage Docker image,
  and a GitHub Actions CI pipeline.

[Unreleased]: https://github.com/devdaviddr/nextjs-rag-boilerplate/compare/v0.24.0...HEAD
[0.24.0]: https://github.com/devdaviddr/nextjs-rag-boilerplate/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/devdaviddr/nextjs-rag-boilerplate/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/devdaviddr/nextjs-rag-boilerplate/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/devdaviddr/nextjs-rag-boilerplate/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/devdaviddr/nextjs-rag-boilerplate/compare/v0.20.1...v0.21.0
[0.7.2]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devdaviddr/nextjs-fullstack-boilerplate/releases/tag/v0.1.0
