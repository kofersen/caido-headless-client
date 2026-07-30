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
