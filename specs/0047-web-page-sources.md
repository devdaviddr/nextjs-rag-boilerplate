---
id: 0047
title: Add a web page to a knowledge base, fetched safely
status: Shipped
release: v0.27.0
created: 2026-09-27
updated: 2026-09-27
---

# 0047 — Add a web page to a knowledge base, fetched safely

## Summary

A user can add a web page to a knowledge base by its URL. The server fetches
it once, keeps what it fetched, and indexes it through the HTML loader (spec
0046), or the PDF loader when the URL serves a PDF. The fetch is locked down
against server-side request forgery: public addresses only, checked again on
every redirect, with limits on time, size and type. "Refresh" fetches it again.

## Problem / motivation

Much of what people want to ask about is on the web, and today the only way
in is to save the page as a PDF and upload it (#142). Letting the server fetch
a URL a user types is also the classic server-side request forgery hole: the
server can reach addresses the user cannot, such as `localhost`, the database,
MinIO, the cloud metadata endpoint at `169.254.169.254`, or anything on the
host's private network.

## Goals

- Paste a URL, get a document that answers with citations like any other.
- No URL can make the server reach a private, loopback, link-local or
  otherwise non-public address, directly or through a redirect.

## Non-goals

- **Crawling** (following links, sitemaps). One URL is one document.
- **Scheduled re-fetching.** Refresh is by hand.
- **Pages that need a login or JavaScript to render.** The server fetches the
  HTML as served.

## Requirements

### Functional

- **FR1** — "Add from a URL" on a knowledge base takes an `http` or `https`
  URL and creates a document titled from the page's `<title>`.
- **FR2** — The fetched bytes are stored like an upload, with the URL and the
  time fetched; ingestion then runs through the loader for the response's
  type (HTML → spec 0046's HTML loader, PDF → the PDF loader). Any other
  type is refused.
- **FR3** — "Refresh" fetches the URL again and re-indexes the document from
  the new bytes, keeping its knowledge base and its id.
- **FR4** — Citations to a web document link to its URL.

### Non-functional (the fetch)

- **NFR1** — Only `http` and `https`, ports 80 and 443 unless an admin allows
  others. No credentials in the URL.
- **NFR2** — The host is resolved before connecting, and the connection goes to
  the address that was checked, not a second lookup. Loopback, private
  (RFC 1918, `fc00::/7`), link-local (`169.254.0.0/16`, `fe80::/10`),
  carrier-grade NAT, multicast, unspecified and IPv4-mapped forms of these are
  refused, as are names that resolve to them.
- **NFR3** — Redirects are followed by hand, at most 3, and each target is
  checked as in NFR1 and NFR2.
- **NFR4** — 15 seconds for the whole fetch; the body is read up to the upload
  size limit and refused beyond it.
- **NFR5** — Optional `URL_ALLOWED_HOSTS`: when set, only those hosts (and
  their subdomains) may be fetched. Rate-limited like uploads.

## Design / approach

- `src/lib/rag/fetch-url.ts`: `safeFetch(url)`: parse, check scheme and port,
  resolve with `dns.lookup(..., { all: true })`, refuse if any address is
  non-public, connect to the checked address with the original `Host` header
  and SNI, handle redirects manually, enforce the time and size limits.
  Addresses are checked with one function, unit-tested against every range.
- `addDocumentFromUrl(knowledgeBaseId, url)` server action, owner-checked like
  `uploadDocument`, then the normal ingestion path.
- `documents` gains `source_url` and `fetched_at` (nullable), one migration.

## Acceptance criteria

- [x] FR1, FR2: a public HTML page and a public PDF URL become documents that
      answer with citations — e2e `web-pages.spec.ts` (example.com: Ready, titled
      from `<title>`, answers with a citation); `rag-url-actions.test.ts` (stored
      with its URL and fetch time, a non-HTML/PDF response refused); a public PDF
      URL fetched live and identified as PDF by its bytes
- [x] FR3: refresh re-indexes from a new fetch, same document — e2e
      `web-pages.spec.ts` (same row and link after refresh);
      `rag-url-actions.test.ts` _"refetches into the same file"_
- [x] FR4: a web document's citation links to its URL — e2e `web-pages.spec.ts`
      ("Open the web page" links to https://example.com/)
- [x] NFR1–NFR3: loopback, private, link-local, metadata and IPv4-mapped
      addresses are refused, directly, by name and through a redirect —
      `fetch-url.test.ts` (every range, by name, via redirect, redirect cap);
      e2e: the metadata address is refused with its reason
- [x] NFR4: a slow or oversized response is refused — `fetch-url.test.ts`
      (timeout, body over the cap)
- [x] NFR5: with an allow-list, other hosts are refused — `fetch-url.test.ts`
      (allow-list, subdomains); `rag-url-actions.test.ts` (read from
      `URL_ALLOWED_HOSTS`)

## Security & privacy

This spec is mostly security. The server's network position is the asset:
NFR2 and NFR3 stop a URL reaching anything a user could not reach themselves,
including through DNS that answers differently the second time (connecting to
the checked address closes that rebinding window). Fetched content is
untrusted and reaches models fenced (#126). The fetch sends no cookies and no
credentials of the app's.

## Alternatives considered

- **Fetch in the browser and upload the result.** No server-side request, but
  most sites refuse cross-origin fetches, so it would rarely work.
- **An outbound proxy that enforces the rules.** Stronger isolation, but one
  more service to run for a single-box deployment. The checks here are what
  such a proxy would do.

## Out of scope / future

- Crawling, scheduled refresh, rendered (JavaScript) pages.

## References

- #142 (capability), #147 (this spec), spec 0046 (loaders), #126 (fencing).
- OWASP Server-Side Request Forgery Prevention Cheat Sheet.
