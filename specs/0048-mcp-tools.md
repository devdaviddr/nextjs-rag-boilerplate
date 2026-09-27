---
id: 0048
title: Give the agent tools from MCP servers
status: Proposed
release: '—'
created: 2026-09-27
updated: 2026-09-27
---

# 0048 — Give the agent tools from MCP servers

## Summary

An admin connects a Model Context Protocol (MCP) server in Settings, and the
tools it offers become agent tools (spec 0044), each one switched on by hand.
The planner can then call them like a tool written in code, with the same
budget, logging and fencing.

## Problem / motivation

Spec 0044 lets a developer add a tool by writing code. Many useful tools
already exist as MCP servers (search, ticketing, databases, internal APIs),
and connecting one should not need a code change and a deploy (#141).

## Goals

- Connect a remote MCP server from Settings, see its tools, switch on the ones
  the agent may use.
- An MCP tool behaves exactly like a registered tool: planned, budgeted,
  logged, fenced, and its result counts as evidence.

## Non-goals

- **Local (stdio) MCP servers.** Starting a process on the app's host from a
  Settings page is remote code execution for anyone who can reach that page.
  Streamable HTTP only.
- **MCP resources and prompts.** Tools only.
- **Per-user MCP connections or OAuth to the MCP server.** One connection per
  server, configured by an admin.

## Requirements

### Functional

- **FR1** — Settings → Tools: an admin adds an MCP server by URL (Streamable
  HTTP) with an optional bearer token, tests it, and sees the tools it lists
  (`tools/list`) with their descriptions.
- **FR2** — Each tool is off until an admin switches it on. Only switched-on
  tools are offered to the planner.
- **FR3** — A switched-on tool is registered as an agent tool named
  `mcp_<server>_<tool>`, with the server's JSON Schema as its parameters;
  arguments are checked against that schema before the call.
- **FR4** — A call goes to the server with `tools/call`, within the loop's time
  budget and a per-call cap; its text content is the tool's result.
- **FR5** — A server that is down or times out makes that call a failed step
  (spec 0044 NFR2); the list of tools is cached and refreshed on test.
- **FR6** — Adding, changing, switching tools on or off and removing a server
  are audited like other AI settings, and admin-only.

### Non-functional

- **NFR1** — The bearer token is encrypted at rest like an API key (spec 0040)
  and never sent to the browser.
- **NFR2** — The server's URL is fetched with spec 0047's protections unless an
  admin marks it as internal, which is logged.
- **NFR3** — An MCP tool's output is untrusted: fenced wherever a model reads
  it, and capped in length like any tool result.

## Design / approach

- `mcp_servers` table (name, url, encrypted token, cached tool list, enabled
  tool names, timestamps), one migration.
- `src/lib/rag/tools/mcp.ts`: a small Streamable HTTP client
  (`initialize`, `tools/list`, `tools/call`), and `mcpTools()` returning
  `AnyAgentTool[]` for the switched-on tools, validated with the server's JSON
  Schema.
- `agentic-run.ts`: the registry becomes `[...agentTools, ...await mcpTools()]`.
- Settings: a Tools section beside AI provider, reusing the connection card's
  patterns (test, audit, lock).

## Acceptance criteria

- [x] FR1: a server is added, tested and its tools listed — e2e
      `mcp-tools.spec.ts` (Settings → Configuration → Tools, against a stub
      server); `mcp-tools.test.ts` (initialize, session, every page of
      `tools/list`, JSON and event-stream replies)
- [x] FR2: only switched-on tools reach the planner — `mcp-tools.test.ts`
      _"offers only the switched-on tools"_; `ai-settings-actions.test.ts`
      (listed off, switched on one at a time); live: the NIM planner called a
      switched-on stub tool with `tools/call` and answered from it
- [x] FR3, FR4: a call is validated, sent with `tools/call`, and its text is
      the result (against a stub MCP server in tests) — `mcp-tools.test.ts`
      _"validates arguments against the server schema, then calls it"_
- [x] FR5: a down server makes a failed step, not a failed answer —
      `mcp-tools.test.ts` _"a server that is down makes a failed step"_; a
      failure to load MCP tools leaves the agent its own tools
- [x] FR6: changes are audited and admin-only — `ai-settings-actions.test.ts`
      (every action refused to a non-admin; add, switch on and remove
      audited; the lock refuses changes); e2e: the switch appears in Recent
      changes
- [x] NFR1: the token is encrypted and never reaches the browser —
      `ai-settings-actions.test.ts` (stored `v1:` ciphertext, absent from the
      view and the audit); e2e: no response the page received contains it
- [x] NFR2: an MCP URL is fetched with spec 0047's protections —
      `mcp-tools.test.ts` (a local and a metadata address refused unless
      marked internal); e2e: a local server is refused until marked as on a
      private network

## Security & privacy

An MCP server is code the admin chose to trust, run by someone else. It does
not know which user is asking: the app sends only the tool's arguments, never
the user's identity or scope. A tool that reads per-user data therefore cannot
be scoped by this app, and the admin must only switch on tools whose results
any user may see. The Settings page says so beside every tool. Tools are off by
default for this reason.

## Alternatives considered

- **Pass the user's identity to the MCP server.** Would let a server scope its
  results, but MCP has no standard for it yet, and a custom header would tie
  the template to servers that honour it.
- **Allow stdio servers.** The most common kind today, but see Non-goals.

## Out of scope / future

- Per-user MCP auth, resources, prompts, stdio.

## References

- #141 (capability), #148 (this spec), spec 0044 (tool registry), spec 0047
  (safe fetch), spec 0040 (settings, key encryption).
- Model Context Protocol specification, Streamable HTTP transport.
