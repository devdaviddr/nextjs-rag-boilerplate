---
id: 0044
title: Give the agent tools a developer can add
status: Shipped
release: v0.27.0
created: 2026-09-27
updated: 2026-09-27
---

# 0044 — Give the agent tools a developer can add

## Summary

A developer building on this boilerplate can give the agentic planner a new
tool by writing one module: a name, a description, a schema for its arguments
and a function that runs it. The planner is offered every registered tool, the
loop runs a call with the user's scope bound on the server, and the result
reaches the planner, the answer writer and the citation verifier as fenced tool
output. A tool the developer registered is a source of evidence like a
document: its result can answer a question. With no tools registered, the
refusal guarantee is exactly as before.

## Problem / motivation

The agentic path (spec 0029) is a bounded retrieval planner with a closed set
of decisions, `'search' | 'answer' | 'read-figure'` (`src/lib/rag/planner.ts`).
Adding a tool means editing that type, the parser, the loop in
`src/lib/rag/agentic.ts`, its dependencies and the tools array in
`src/lib/rag/agentic-run.ts`, and knowing the budget, floor and fallback rules
that live between them. For a template sold as a starting point for agentic
RAG apps, that is the seam a developer reaches for first, and today it does
not exist (#141).

Separately, the planner is told how many searches it has left as
`maxSearches - steps.length` (`budgetLine`), but a search the time budget cut
short adds no step, so it can be told it has more than it does.

## Goals

- Adding a tool is one new file and one line in the registry, with no change
  to the loop, the planner parser or the route.
- A tool call is validated, scoped, budgeted and visible in the Agent activity
  drawer like a search.
- With no tools registered, behaviour is exactly today's.

## Non-goals

- **A tool-message conversation.** The planner keeps its rebuilt single prompt
  (`historyPrompt`); tool results are summarised into it like search results.
  Moving to `tool` role messages changes what the planner sees on every call,
  and its effect on planning can only be measured with an evaluation run,
  which is deferred with the other measurements to #157.
- **Tools from MCP servers.** Spec 0048 builds on this registry.
- **Built-in tools beyond today's.** The registry ships empty; an example tool
  is used by the tests and the guide.

## Requirements

### Functional

- **FR1** — An `AgentTool` has a `name`, a `description`, a Zod schema for its
  arguments and a `run(args, context)` function returning text (and
  optionally a token count). `defineTool` builds one and derives the JSON
  Schema the model is shown from the Zod schema.
- **FR2** — `src/lib/rag/tools/index.ts` exports the registry, `agentTools`.
  Every tool in it is offered to the planner alongside `search_documents` and,
  when figures can be read, `read_figure`. Names must be unique and must not
  shadow those two. Tools exist only on the agentic path, so while any are
  registered every question is planned, whatever `RAG_AGENTIC_ROUTE` says:
  adaptive routing would otherwise send a standalone question straight to the
  fixed pipeline, where no tool can be called (found live, 2026-09-27). With
  `RAG_AGENTIC_ENABLED=false` no tool is offered.
- **FR3** — A call to a registered tool is parsed into a `tool` decision
  carrying the tool's name and raw arguments. Arguments are validated against
  the tool's schema before it runs; invalid arguments are reported back to the
  planner as the step's result, not thrown.
- **FR4** — `run` receives a `ToolContext` with the user's id, the permitted
  knowledge-base ids and an abort signal carrying what is left of the loop's
  time budget. The model supplies arguments only; scope comes from the session
  and the conversation, exactly as for `search_documents` (spec 0028).
- **FR5** — A tool call counts one step against the loop's search budget, like
  a figure read. It does not raise the similarity floor, which rises with text
  searches only (spec 0031 FR15).
- **FR6** — A tool's result is shown to the planner in the next prompt, fenced
  as data, and passed to the answer writer and the citation verifier as a
  fenced "tool results" block. Tool results are not numbered sources and
  cannot be cited; a sentence they support is supported.
- **FR7** — Each tool call is logged with the tool's name, its arguments and a
  preview of its result, so the Agent activity drawer shows it.
- **FR8** — The planner is told how many steps are left from the loop's own
  count of steps taken, including a search the time budget cut short.
- **FR9** — A tool result is evidence. When a registered tool returned output,
  the answer is written even if no passage cleared the floor, and verified
  against the tool results. A question for which no tool ran and no passage
  cleared the floor is still refused without calling the model (spec 0025).

  Found live on 2026-09-27: with the example `list_documents` registered, the
  planner called it for "Which documents do I have?", got the titles, and the
  answer was refused because no passage cleared the floor. A tool that can
  never produce an answer is not worth registering.

### Non-functional

- **NFR1** — With the registry empty, the planner's request, the prompts and
  the loop's decisions are byte-for-byte what they are today (the tools array,
  `historyPrompt` and `buildUserMessage` output are unchanged).
- **NFR2** — A tool that throws or times out ends as a failed step, never as a
  failed answer; the loop continues with the evidence it has.
- **NFR3** — Tool output is untrusted, like document text: fenced with the
  per-prompt random id (#126) wherever a model reads it.

## Design / approach

- `src/lib/rag/tools/types.ts`: `AgentTool<Args>`, `ToolContext`,
  `ToolResult`, and `defineTool`, which calls `z.toJSONSchema` once and drops
  the `$schema` key the OpenAI tool format does not use.
- `src/lib/rag/tools/index.ts`: `export const agentTools: AgentTool[] = []`,
  plus `toolDefinition(tool)` for the request and `findTool(name)`.
- `src/lib/rag/tools/examples/list-documents.ts`: an example tool, not
  registered, that lists the titles of the documents in scope. It shows the
  shape a real tool takes and is what the tests and `docs/extending.md` use.
- `planner.ts`: `PlannerAction` gains `'tool'`; `PlannerDecision` gains
  `tool?: { name: string; arguments: string }`. `parseToolCallDecision` takes
  the registered names and returns a `tool` decision for a call to one of
  them, after `read_figure` and before `search_documents`.
- `agentic.ts`: `LoopDeps.runTool(name, argumentsJson, signal)` returns
  `{ text, tokens } | null`. The loop handles a `tool` decision like a figure
  read: one step against the budget, a `LoopStep` whose `query` names the call
  and whose `found` is the result, and the result collected in
  `LoopOutcome.toolResults`.
- `agentic-run.ts`: offers the registry's definitions, implements `runTool`
  (find, validate, bind context, log, catch), returns `toolResults` on
  `AgenticResult`, and computes the steps left from the loop's counter.
- `prompt.ts` / `verify.ts` / `answer.ts`: a fenced tool-results block after
  the sources, only when there are tool results, so NFR1 holds.

## Acceptance criteria

- [x] FR1: `defineTool` produces a tool whose `parameters` is the schema's JSON Schema without `$schema` — `tests/unit/rag-tools.test.ts` _"shows the model the Zod schema"_
- [x] FR2: registered tools are offered after the built-ins; a duplicate or shadowing name throws — `rag-tools.test.ts` _"duplicate name"_, _"ships empty"_; `rag-answer.test.ts` _"plans a standalone question under adaptive routing"_
- [x] FR3: a call to a registered tool parses to a `tool` decision; invalid arguments come back to the planner as the step's result — `rag-tools.test.ts` _"reads a call to a registered tool"_, _"reports bad arguments back"_
- [x] FR4: `run` receives the user's id and permitted knowledge bases from the server, whatever the arguments say — `rag-tools.test.ts` _"runs with the scope the server bound"_
- [x] FR5: a tool call spends one step and does not raise the floor — `rag-tools.test.ts` _"spends a step on a tool call … does not raise the floor"_
- [x] FR6: tool results reach the planner, the writer and the verifier, fenced — `rag-tools.test.ts` _"fences tool results"_; `rag-answer.test.ts` _"answers from a tool result"_ (writer and verifier)
- [x] FR7: each tool call is logged with name, arguments and a result preview — `rag-tools.test.ts` _"logs each call"_
- [x] FR8: the planner's "steps left" counts a search the time budget cut short — `rag-tools.test.ts` _"counts steps left from the loop"_ and the `spent` values in the loop test
- [x] NFR1: with no tools registered, the request, prompts and decisions are unchanged (existing agentic tests pass unmodified) — the existing agentic, planner, prompt and answer tests pass unmodified, bar the loop outcome gaining a `toolResults` key; `rag-tools.test.ts` _"leaves the writer and verifier prompts unchanged"_
- [x] FR9: a tool result with no passage produces an answer; no tool output and no passage is still refused without a model call — `rag-answer.test.ts` _"answers from a tool result"_, _"still refuses with neither"_; tried live 2026-09-27 with `list_documents` registered: the documents question answered from the tool, an unrelated one refused, the leave question cited as before
- [x] NFR2: a tool that throws ends as a failed step and the answer still comes — `rag-tools.test.ts` _"turns a tool that throws into a failed step"_, _"records a failed tool as a step and carries on"_

## Security & privacy

A tool runs server-side with the caller's scope, bound from the session and
the conversation (FR4). The model can choose which registered tool to call and
with what arguments, and nothing else: it cannot register a tool, reach one
that is not in the registry, or widen scope through arguments. Tool output is
fenced wherever a model reads it (NFR3), because a tool that reads external
data is an injection path like a document. A developer writing a tool that
performs writes or calls an external API owns that tool's authorisation; the
guide says so.

## Alternatives considered

- **Rewrite the loop as a generic tool-calling agent** (every capability,
  search included, a registered tool, with `tool` messages). Cleaner, but it
  would replace machinery tuned against measurements (the rising floor,
  fallback searches, parallel searches, the confident stop) with untested
  behaviour, and could not be verified without an evaluation run. Revisit
  with #157's numbers.
- **Keep tool results out of the refusal gate.** The first draft of this spec
  did, to leave refusal untouched; it made a tool that answers a question on
  its own useless (FR9). Refusal is untouched where it is measured: with no
  tools registered, and for any question no tool answered.

## Out of scope / future

- Tool-message conversations (above).
- Tools from MCP servers (spec 0048).
- Per-tool budgets and per-tool enable/disable in Settings.

## References

- Spec 0029 (agentic retrieval loop), 0031 (figure reads), 0043 (adaptive
  planning), 0028 (knowledge-base scope).
- Issues #141 (capability), #143 (this spec), #126 (fencing), #157 (deferred
  measurements).
