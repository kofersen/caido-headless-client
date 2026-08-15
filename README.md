# caido-headless-client

Dependency-free Node.js client and CLI for Caido's GraphQL and REST APIs, built for secure automation without npm packages.

## Why

This client is meant for agent and script workflows where supply-chain risk matters. It uses only Node's built-in runtime APIs:

- `fetch` for GraphQL and REST requests
- `WebSocket` for GraphQL subscriptions
- Node standard library modules for file and token handling

No `npm install` is required.

## Requirements

- Node.js 24 or newer (Node 22.4+ also works; older Node requires the optional `ws` fallback below)
- A running Caido instance
- A Caido Personal Access Token for first-time setup

### WebSocket fallback for older Node

The client uses Node's built-in global `WebSocket`, enabled by default in Node 22.4+. On older runtimes you'll see `Global WebSocket is not available...`. To fix without upgrading Node, install the optional `ws` package in this directory — it's auto-detected at runtime and remains optional:

```bash
npm install ws
```

## Compatibility

- **Schema target:** Caido v0.57.x. Verified live against 0.57.0; v0.57.1 is the current release.
- **Reference:** the canonical GraphQL documents in [`@caido/sdk-client`](https://github.com/caido/sdk-js)
  (`src/transport/latest/documents/`, generated from `@caido/schema-proxy` 0.57.0). Every embedded
  query, mutation and subscription is field-checked against them; the device-code auth flow is
  checked against `@caido/server-auth`.
- **Version fork:** replay operations branch at Caido 0.57.0 (`*_V056` vs `*_V057`), the same
  threshold the SDK uses for its own transport fork (`TransportVersion.V0_57`).
- **Last verified:** 2026-07-30 against sdk-client 0.5.0. No drift — every document change since
  0.4.0 was additive (new operations only, no edits to the ones already used here).

Intercept control and Automate have no SDK coverage; those operations are hand-written and verified
against a live instance instead.

## Upstream parity

The `caido-mode` skill that ships this client began as a mirror of Caido's official [`caido/skills`](https://github.com/caido/skills) `caido-mode` — same command names, same flags, same output field shapes, and the same `~/.claude/config/secrets.json` path and format. Upstream has since diverged.

Checked 2026-08-10 against upstream **v3.2.0** (the `caido-mode-revamp` merge, PR #22). It still pins `@caido/sdk-client` ^0.4.0. Two things it has that this client does not:

- **`export-curl --config`** — writes a reusable `-K` config per host holding the proxy line and every auth/identity header from a captured request, cookies inlined statically. Upstream's whole testing model is built on it: probe with `curl -K auth.cfg`, and use Replay only to hand a request to the operator. This client has `export-curl` in its self-contained form only.
- **`test-mr-rule`** — preview a match-and-replace rule against a raw message without applying it. Deliberately skipped here (see *Checked and left out*), a decision worth revisiting now that upstream has built it.

A third, `--name` on every session-creating command plus collections resolvable by name, landed here in `e96bd48` after upstream arrived at the same two changes independently. Upstream wraps neither WebSocket replay nor hosted-file upload, which this client gained in the same pass.

The embedded GraphQL is field-checked against the canonical documents in [`caido/sdk-js`](https://github.com/caido/sdk-js) — `@caido/sdk-client` 0.5.0, generated from `@caido/schema-proxy` 0.57.0 — with no drift, since every document change between 0.4.0 and 0.5.0 was additive. Details under **Compatibility** above.

### What differs

| | This client | Upstream `caido-mode` v3.2.0 |
|---|---|---|
| Implementation | one dependency-free `.mjs` on Node's built-in `fetch` and `WebSocket` | `@caido/sdk-client` + `graphql-tag` + `tsx`, installed from npm |
| Auditability | exact client revision pinned by submodule commit hash | dependency range (`^0.4.0`) resolved at install time |
| Binary bodies | `download` writes raw bytes — `--out`, `--request`/`--response`, `--raw`, `--body-only`, `--force` | no such command; bodies only come back through JSON text |
| Comparing two results | `compare` reports status, length, header deltas and the differing body region, decided on bytes | not available; read both responses and judge |
| Report evidence | `evidence` writes `request.http`, `response.http`, `curl.sh`, `meta.json` at `0600` | assemble by hand from `download` and `export-curl` |
| Repeating one request | `edit --values` sends one per value in a single session, a row each, stopping on backoff | one invocation per value |
| Rate discipline | `--delay` paces sends per host across processes; 429, challenge, 503 and `Retry-After` are reported as `backoff` | no pacing, no backoff signal |
| Scope | `search --scope` filters history by a Caido scope | not exposed |
| Coverage | `sitemap` gives Caido's deduplicated tree of what has been seen on a host | not exposed |
| WebSocket | `streams` and `stream-messages` read WS and SSE traffic with StreamQL filtering, which `search` cannot see; `ws-connect` / `ws-send` / `ws-stop` open a WS replay session and push frames into it | not exposed |
| Hosted files | `upload-hosted-file` serves a payload from the instance; list and delete alongside it | not exposed |
| Proxy rewrites | full match-and-replace management; `get`, `search` and sends report `alteration` and `edited` | equivalent M&R management as of v3.2.0, plus `test-mr-rule` for previewing one; `alteration`/`edited` are not exposed, so a rule's effect reads as the target's behaviour |
| Expired access token | refresh token is stored, rotated on the first auth failure, and the call retried | refresh token is never stored; the run exits telling you to re-run `setup <pat>` |
| PAT on disk | `setup --no-save-pat` keeps it out of `secrets.json` | `setup` always writes the PAT |
| Auth env vars | `CAIDO_ACCESS_TOKEN`, `CAIDO_INSTANCE_URL`, `CAIDO_URL`, `CAIDO_PAT` | `CAIDO_URL`, `CAIDO_PAT` |
| Schema versions | GraphQL forked in-client at the 0.57.0 threshold (`*_V056` / `*_V057`) | delegated to the SDK's own transport forks |
| Older Node | optional `ws` fallback below Node 22.4 | handled by the SDK's transport |

The last two rows are a trade rather than a win: tracking Caido's schema by hand is what the missing dependencies cost, which is why the verification note above carries a date.

## Checked and left out

Verified against the live schema on 2026-07-30, recorded so it is not re-researched:

- **Bulk request export** (`startExportRequestsTask`, JSON/CSV with raw) returns
  `PermissionDeniedUserError` on a Basic plan with no entitlements. It is a paid feature, so a
  command for it would fail every time here.
- **Findings export** (`exportFindings` → a signed `downloadUri`) works, but returns what
  `findings` already gives as JSON. Redundant.
- **Intercept queue** (`interceptMessages(kind:)` plus forward and drop) works and is empty
  unless something is held. Left out because interception is an interactive workflow: an agent
  forwarding or dropping traffic would act on the operator's own live session. Note that
  `interceptEntries` is intercept *history*, which `search 'source:"intercept"'` already covers.
- **Response screenshots** (`renderRequest` → an `Image`) fail with `RENDER_FAILED / INTERNAL`
  on this host even with Caido's browser installed, so nothing was built on top of it.
- **Testing a rule** (`testTamperRule`) takes a raw message plus the rule's section rebuilt as a
  fifteen-branch union input. Testing an *existing* rule therefore means mapping its output
  union back into an input union — more machinery than it answers, now that `rules` lists what
  each rule does and `alteration` says which messages one touched.

### Not covered

Surface this client does not wrap, with the reason, so the question is not reopened every time.
Checked against the live 0.57.1 schema on 2026-08-15.

| Not wrapped | Why |
|---|---|
| Certificate **export** | Not in the API. The schema has `importCertificate` and `regenerateCertificate` and no export of any kind, and no REST route serves the CA either. Nothing to wrap, whatever the SDK's surface list implies |
| Certificate import / regenerate | Would replace or reissue the CA for the whole instance. A wrong call breaks every proxied client at once, and the UI is the safer place for a once-a-year action |
| Workflows — list, create, update, toggle, test, run | An agent driving this client can express the same logic in the shell it is already in, and read the result directly instead of through a workflow's output |
| DNS upstream resolvers and rewrites | `--connect-host`, `--connect-port` and `--sni` already redirect this client's own sends without touching the header. A rewrite only adds anything for *browser* traffic, which is a real but narrower case |
| Hosted-file **rename** | `upload-hosted-file` and `delete-hosted-file` cover the lifecycle; a rename is a re-upload |
| Plugin installation | Installs code into the operator's instance. Not an agent's call to make |
| `createRequest` | Puts a request into history without sending it. Everything here is interested in what a target answered |
| `deleteFindings` | Destructive, and findings are the record of the engagement |
| Project create / rename / delete | Delete is destructive; create is genuinely useful given one-project-per-engagement, and is the most likely next addition |
| Instance settings | They carry AI provider API keys. Deliberately out of scope |

## Setup

Create a PAT in Caido Dashboard -> Developer -> Personal Access Tokens, then run:

```bash
node caido-client.mjs setup <pat> <caido-url> --no-save-pat
```

Example for a local Caido instance:

```bash
node caido-client.mjs setup <pat> http://localhost:8080 --no-save-pat
```

The setup command starts Caido's device-code auth flow, approves it with the PAT, then caches OAuth access and refresh tokens in `~/.claude/config/secrets.json`. Use `--no-save-pat` to avoid persisting the PAT.

Check status:

```bash
node caido-client.mjs auth-status
```

## Usage

Search HTTP history:

```bash
node caido-client.mjs search 'req.host.cont:"api"' --limit 20
node caido-client.mjs recent --limit 10
```

Retrieve requests and responses:

```bash
node caido-client.mjs get <request-id>
node caido-client.mjs get-response <request-id> --compact
node caido-client.mjs export-curl <request-id>
```

Byte-safe downloads:

```bash
node caido-client.mjs download <request-id> --out body.bin
node caido-client.mjs download <request-id> --response --raw --out response.http
node caido-client.mjs download <request-id> --request --raw --out request.http
```

Replay and edit traffic through Caido:

```bash
node caido-client.mjs replay <request-id> --compact
node caido-client.mjs edit <request-id> --path /api/test --set-header "X-Test: 1" --compact
node caido-client.mjs send-raw --host example.com --raw "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"
```

Compare two requests or responses instead of reading both:

```bash
node caido-client.mjs compare <id-a> <id-b>
node caido-client.mjs compare <id-a> <id-b> --request --all-headers
```

Reports status, length delta, header differences (per-response headers such as `date` and
`cf-ray` are listed as `ignored` unless `--all-headers`), and the differing body region.
Equality is decided on bytes and described in text, so two binary bodies are not called
identical because both decoded to `U+FFFD`. A minified body is one very long line, so the
output windows around the first differing character and reports `firstDiffOffset` rather than
printing the head.

Export one request as report evidence:

```bash
node caido-client.mjs evidence <request-id> --out ./evidence
node caido-client.mjs evidence --finding <finding-id> --out ./evidence
```

Writes `request.http`, `response.http`, `curl.sh` and `meta.json`, mode `0600` since they
carry cookies and authorization headers. The whole set is checked before anything is written,
so a conflict never leaves half a bundle, and a symlink target is refused even with `--force`.
`request.http` and `response.http` are the stored bytes; `curl.sh` is a reconstruction.

Name a replay tab when you open it, and address collections by name:

```bash
node caido-client.mjs edit <request-id> --path /api/user/999 --name "idor-user-profile" --collection "IDOR"
node caido-client.mjs create-session <request-id> --name "idor-user-profile" --collection "IDOR"
node caido-client.mjs edit <request-id> --path /api/user/1000 --session "idor-user-profile"
```

`replay`, `edit`, `send-raw` and `create-session` all take `--name`, which is applied before
the first send, so a tab is never created unnamed. `--collection` takes a collection's name or
its id, and so do `move-session`, `rename-collection` and `delete-collection`; `--session`,
`rename-session` and `delete-sessions` take a session's name or id. Nothing has to be looked up
before it can be used. `--name` alongside `--session` is refused, because that tab already
exists and naming it there would silently rename someone else's work — use `rename-session`.

Send one request per value:

```bash
node caido-client.mjs edit <request-id> --path '/api/user/{}' --values 1-100
node caido-client.mjs edit <request-id> --replace 'ORIG:::{}' --values @ids.txt --delay 500
```

`{}` marks where each value goes, in any of `--method`, `--path`, `--body`, `--set-header` or
`--replace`. One replay session, one summary row per value instead of full bodies. `--values`
takes an ascending range, a comma list or `@file`, caps at 1000 entries, paces at 250ms unless
`--delay` says otherwise, and stops at the first backoff signal or send error.

Management commands:

```bash
node caido-client.mjs scopes
node caido-client.mjs filters
node caido-client.mjs envs
node caido-client.mjs findings --limit 10
node caido-client.mjs replay-sessions --limit 10
node caido-client.mjs plugins
node caido-client.mjs health
```

Show all commands:

```bash
node caido-client.mjs --help
```

## Knowing What The Proxy Changed

```bash
node caido-client.mjs rules
```

Lists Caido's match-and-replace rules read-only: name, enabled, which part of the message the
rule rewrites, its HTTPQL condition, and for header and body rules the matcher and the
replacement. Rules apply to traffic this client never issued — a browser, a script, another
tool — so without this their effects read as the target's own behaviour. An empty list is a
useful answer.

Every request and response also reports `alteration: TAMPER` when a rule changed it and
`edited: true` when a person did. Neither field appears when there is nothing to report.

Note that setting a header a rule also sets produces a doubled value, `x-foo: a, b`, not an
override.

## Global Options

| Flag | Description |
|------|-------------|
| `--json-compact` | One-line JSON instead of indented, about a quarter fewer bytes on list output. Also `CAIDO_COMPACT_JSON=1` |
| `--delay <ms>` | Minimum gap between sends to one host, best-effort across processes via `~/.claude/config/caido-state.json`. Also `CAIDO_MIN_INTERVAL_MS`. `--delay 0` switches off the batch default |

## Backoff Reporting

Every send reports a `backoff` object when the response is one of `rate-limited` (429),
`challenge` (a `cf-mitigated` header), `service-unavailable` (503) or `retry-after`. The
reasons are kept apart rather than collapsed, because an unavailable service and a bot check
support different conclusions about a target. Batch runs stop on any of them.

Reads retry twice on transient transport failures (502/503/504, timeouts, dropped sockets).
Mutations never retry: a resend after an ambiguous failure would put a second request on the
target.

## Auth Environment Variables

- `CAIDO_URL`: Caido instance URL
- `CAIDO_PAT`: PAT for bootstrap auth
- `CAIDO_ACCESS_TOKEN`: direct bearer token override

Auth resolution order:

1. `CAIDO_ACCESS_TOKEN`
2. Valid cached access token
3. Cached refresh token
4. `CAIDO_PAT`
5. Stored PAT, if present

## Security Notes

- Prefer `setup ... --no-save-pat`.
- Do not commit `~/.claude/config/secrets.json`.
- This repository intentionally has no npm dependencies or install scripts.
- `download` writes raw bytes directly from Caido's stored raw data, so binary bodies are not converted through UTF-8.
- `evidence` writes `0600` files and refuses to write through a symlink even with `--force`.
- `~/.claude/config/caido-state.json` holds send timestamps only, never credentials.
