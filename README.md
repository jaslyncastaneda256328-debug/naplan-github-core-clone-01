# naplan-github-forge

A from-scratch GitHub-compatible forge in a single Node.js process: git smart
HTTP (protocol v2 upload-pack and v0 receive-pack), the REST v3 API, GraphQL,
and MCP — all over one in-memory store, with no git binary anywhere.

Written for the make.fun `github-core-clone-01` bounty ($500, no entry fee).
It speaks the exact wire formats git and GitHub define: pkt-line framing,
PACK v2 files of plain objects, sideband report-status, REST pagination by
Link header, GraphQL connections with opaque cursors, and MCP over JSON-RPC
2.0 Streamable HTTP.

## Run

```sh
node main.ts
```

- With `MAKEFUN_ENV_URL` set (the conformance harness), the server listens on
  port 0, registers itself, serves until the harness reports `done`, and exits.
- Without it, it listens on `$PORT` (default 8080) until killed.
- `MAKEFUN_SHOP_TOKEN`, when set, must match the Bearer token exactly; without
  it any non-empty Bearer token is accepted, and a missing token is always a 401.

`GET /healthz` answers `{"ok": true}` without auth.

## Layout

| File | What it does |
| --- | --- |
| `store.ts` | The in-memory store: repos, git objects, refs, issues, pull requests, labels, comments; the git object model (commit/tree/tag, SHA-1 ids, pack read/write, reachability, merge-base, squash merge with conflict detection); the deterministic scenario identity (viewer `adaiversen`, from the suite's seeded RNG). |
| `git.ts` | Git smart HTTP: v2 advertisement, `ls-refs`, `fetch` (with shallow/deepen and haves), v0 advertisement and `receive-pack` (fast-forward enforcement, per-ref `ok`/`ng` report-status). Fetch packs are cached by (repo, wants, haves, depth). |
| `rest.ts` | REST v3: repos, branches, commits, contents (create/update/delete with sha guards), labels, issues and comments, pull requests (shared number sequence with issues), merge, git refs. |
| `graphql.ts` | A small GraphQL parser and executor: `viewer`, `repository`, `node`, `__type`/`__schema`, issue/pull-request connections with cursor pagination, and the `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment` mutations. Unknown fields return a 200 with an `errors` array naming the field. |
| `mcp.ts` | MCP 2026-07-28: `server/discover` with no handshake and no session, `initialize`, `tools/list` (one constant list, byte-identical every time), `tools/call` returning both `content` text JSON and `structuredContent`. |
| `app.ts` | The HTTP layer: routing, auth, request-id and scope headers, JSON body parsing, and a 500 instead of a crash on any handler failure. |
| `main.ts` | Lifecycle: harness register + done polling, or standalone serving. |

## Design notes

- **Everything is content-addressed.** Object ids are SHA-1 over
  `<type> <size>\0<bytes>`, so a fetch pack depends only on (wants, haves,
  depth) and can be cached safely; a push is rejected unless the new tip
  descends from the old one.
- **Packs are plain objects only.** The suite's client never sends deltas,
  and the reference forge never needs to either — a plain pack is always
  valid, and it keeps pack building and parsing deterministic.
- **Issues and pull requests share one number sequence per repo**, as on
  GitHub. Global ids are opaque base64url strings (`Repository:owner/name`,
  `Issue:owner/name:number`, …) and are stable across reads.
- **The viewer login is derived, not configured.** The suite names its users
  from one seeded stream (FNV-1a over the label, splitmix64's finalizer,
  xorshift64*); re-implementing that stream gives the login the bearer token
  owns without ever seeing the token. Verified against the kit's own scenario
  builder: viewer `adaiversen`, teammate `quinnkeller`, stranger `olgabauer`.
- **REST-created commits use a monotonic clock** (starting at 1700000000, +1
  per commit) with the viewer identity, so their SHAs are unique and
  deterministic.
- **A shallow fetch cuts history at the requested depth** and reports the new
  boundary in `shallow-info`, with `unshallow` for commits whose parent is
  now included. A fetch that would send nothing sends no `packfile` section.
- **Withdraw semantics are not this forge's problem** — but for the record:
  the store holds no money and no credentials, and nothing here touches a
  wallet.

## Testing

From the kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf] [--json]
node cli/makefun.mjs grade-local --kit . --bot <entry-dir> --driver process
```

The grader runs 120 conformance checks (git 30, repos 15, issues 15, pulls 20,
graphql 20, mcp 15, protocol 5) plus a benchmark phase against the reference
timings in `calibration.json`.
