# Spec Review

A browser-first, **ref-resolving design-diff for API specs**: paste an old and a new OpenAPI
(or AsyncAPI / Arazzo) document, and it resolves every internal `$ref` so you review the
**real resolved shape** — then walks the two versions into a readable, breaking-flagged change
list plus a Markdown summary you can paste straight into a pull request. No backend, no
accounts; runs entirely in your browser. Live at
**[review.apicommons.org](https://review.apicommons.org)**.

## Why this exists

Reviewing an API change in a pull request today means squinting at a raw YAML or JSON diff —
a format that is hostile to the very people who most need to weigh in on a design: product
owners, partners, security, and the humans who will actually consume the API. Our
[State of API Governance / Spectral](https://apievangelist.com) research kept surfacing the
same maintainer complaint: **PR review of specs is bad.** Two reasons, both concrete:

- **Raw diffs are unfriendly to non-engineers.** A green/red block of YAML doesn't say
  "customers now have to send a `currency` field" — it just moves lines around.
- **`$ref` hides the resolved shape.** The diff shows a pointer changing, not the schema it
  points at, so the actual change lives one indirection away from what the reviewer sees.

And Spectral — which lints a spec against a ruleset — **won't help you review a change or
reason about versioning.** It tells you whether a document satisfies rules, not what changed
between two documents or whether that change breaks a consumer. Spec Review fills exactly that
gap.

## What it reports

Paste the **old** and **new** spec; Spec Review parses both (YAML or JSON), resolves internal
`$ref` pointers **cycle-safe** (a ref that closes a loop is rendered as a stable marker, never
an infinite recursion), and diffs the resolved structures into categories:

- **Paths/Operations** — added and removed paths and operations (a removed operation is
  **breaking**), plus new AsyncAPI channels / Arazzo workflows.
- **Parameters** — added, removed, or newly-required parameters (a new required parameter is
  **breaking**).
- **Request/Response bodies** — required request bodies, added/removed responses (a removed
  response is **breaking**), and schema changes inside them.
- **Schemas/Models** — added/removed models and, within a model, removed or newly-required
  properties, narrowed types, and dropped enum values.
- **Security** — new or dropped security schemes and tightened auth (requiring authentication
  where it wasn't required before is **breaking**).

Each change is tagged **added / removed / changed** and flagged **BREAKING** where a consumer
could break — removed operation, removed or renamed required property, added required
property, narrowed type, removed enum value, removed response, new required parameter, auth
tightened. Every change is a plain-English one-liner ("`POST /orders` now requires new
property `currency`"). The hero shows added / removed / **breaking** counts, a **Breaking
only** toggle narrows to the risky set, and **Copy Markdown** hands you a summary to drop into
the PR.

## Develop

```bash
npm install
npm run dev
npm run build     # → dist/
```

Pure client-side; no data build. The samples in `public/` are the same API a version apart —
with a resolved `$ref`, several non-breaking additions, and multiple breaking changes — so the
default view demonstrates every category.

## Privacy

Everything runs client-side. The specs you paste never leave the page — there is no server.

---

**Design & versioning guidance** — the human *why* behind API change:
[Versioning](https://guidance.apievangelist.com/store/versioning/) and
[Design](https://guidance.apievangelist.com/store/design/) at guidance.apievangelist.com.

A project of [API Evangelist](https://apievangelist.com), maintained openly under
[API Commons](https://apicommons.org). Free to fork; API Evangelist offers expert API design
and versioning services — including standing up a real spec-review practice — when you want
help. Apache-2.0.

## Part of API Commons

An open, browser-first tool from **[API Commons](https://apicommons.org)** — free, no backend, your data stays in your browser. Browse the full set at **[apicommons.org/tools](https://apicommons.org/tools/)**.

**Related tools**
- [Model Library](https://library.apicommons.org) — versioned model library + drift/breaking-change detection
- [API Validator](https://validator.apicommons.org) — lint OpenAPI/AsyncAPI/Arazzo/JSON Schema in-browser
- [Code-First Governance](https://codefirst.apicommons.org) — govern generated specs; fix findings in code
- [API Governance Graph](https://graph.apicommons.org) — bind building blocks into one graph + Gaps view
- [Spectral Reporter](https://reporter.apicommons.org) — Spectral JSON → self-contained HTML report

## License

**[Apache-2.0](LICENSE).**

API Commons licenses **code** under Apache-2.0 and **artifacts** — schemas, rulesets,
examples and API descriptions — under CC BY-NC-SA 4.0.
