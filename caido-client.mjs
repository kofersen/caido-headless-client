#!/usr/bin/env node
/*
 * Dependency-free Caido CLI.
 *
 * Uses Node's built-in fetch and WebSocket instead of @caido/sdk-client,
 * graphql-tag, tsx, urql, or graphql-ws. Requires modern Node with global
 * fetch and WebSocket support; this skill documents Node 24+.
 *
 * Schema target: Caido v0.57.x. Every embedded operation is field-checked
 * against the canonical documents @caido/sdk-client generates from
 * @caido/schema-proxy 0.57.0 (src/transport/latest/documents/), and the
 * *_V056 constants against that SDK's v0.56 transport fork. The CAIDO_V057
 * branch below sits on the same threshold the SDK uses (TransportVersion.V0_57).
 * Auth is checked against @caido/server-auth. Intercept and Automate have no
 * SDK coverage and are verified against a live instance instead.
 *
 * Last verified 2026-07-30 against sdk-client 0.5.0.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve, join } from "node:path";

const DEBUG = process.env.DEBUG === "1";
const DEFAULT_CAIDO_URL = "http://localhost:8080";
const DEFAULT_CLOUD_API_URL = "https://api.caido.io";
const SECRETS_PATH = join(homedir(), ".claude", "config", "secrets.json");
const STATE_PATH = join(homedir(), ".claude", "config", "caido-state.json");

const DEFAULT_OUTPUT_OPTS = {
  maxBodyLines: 200,
  maxBodyChars: 5000,
  noRequest: false,
  headersOnly: false,
};

// Two retries at these delays; a third would outlast the 30s GraphQL timeout
// it is meant to paper over.
const RETRY_DELAYS_MS = [300, 900];

// Batch sends pace themselves even when no delay was asked for: a rate-limited
// response teaches the caller the wrong thing about the target.
const DEFAULT_BATCH_DELAY_MS = 250;

// Refuse absurd --values lists rather than hammering a target by typo.
const MAX_BATCH_VALUES = 1000;

// A pace, not a pause: past this a caller wants a different command, and huge
// values only invite timer overflow.
const MAX_DELAY_MS = 300_000;

// The PwnFox workflow stores these values in Request.metadata.color. HTTPQL
// cannot address that metadata, so --color scans bounded GraphQL pages and
// compares the stored value client-side.
const PWNFOX_COLORS = Object.freeze({
  yellow: "#d99e4a",
  red: "#e70606",
  orange: "#e79106",
  green: "#6ce706",
  magenta: "#b406e7",
  cyan: "#31cd6f",
  blue: "#4094bf",
});
const DEFAULT_COLOR_SCAN_LIMIT = 5000;
const MAX_COLOR_UPDATES = 1000;

// Response headers that differ on every response and would otherwise fill the
// compare output with noise. --all-headers keeps them.
const VOLATILE_HEADERS = new Set([
  "date",
  "age",
  "cf-ray",
  "x-request-id",
  "x-amz-cf-id",
  "x-amz-request-id",
  "report-to",
  "nel",
  "alt-svc",
  "server-timing",
]);

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function globalFlagValue(name) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

/**
 * Value for a flag that must have one. None of these flags take a value
 * starting with `--`, so swallowing the next flag is always a typo — and a
 * silent one: `evidence 1 --out --force` would write into a directory named
 * `--force`, and `edit 1 --values --compact` would send `--compact` as a value.
 */
function requireFlagValue(args, idx, name) {
  const value = args[idx + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    die(`Error: ${name} needs a value`);
  }
  return value;
}

const COMPACT_JSON = process.env.CAIDO_COMPACT_JSON === "1" || process.argv.slice(2).includes("--json-compact");

// Minimum gap between two outbound sends to the same host, best-effort across
// processes. null when not asked for, which is distinct from an explicit 0:
// `--delay 0` has to be able to switch off the batch default.
const MIN_INTERVAL_MS = (() => {
  const raw = globalFlagValue("--delay") ?? process.env.CAIDO_MIN_INTERVAL_MS;
  if (raw === undefined) return null;
  const ms = parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms < 0) die("Error: --delay / CAIDO_MIN_INTERVAL_MS must be a non-negative integer (milliseconds)");
  if (ms > MAX_DELAY_MS) die(`Error: --delay / CAIDO_MIN_INTERVAL_MS above ${MAX_DELAY_MS}ms is not a pace, it is a stop`);
  return ms;
})();

function printJson(value) {
  console.log(COMPACT_JSON ? JSON.stringify(value) : JSON.stringify(value, null, 2));
}

function compactUndefined(value) {
  if (Array.isArray(value)) return value.map(compactUndefined);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) out[key] = compactUndefined(child);
    }
    return out;
  }
  return value;
}

function pwnfoxColorValue(name) {
  const normalized = String(name || "").toLowerCase();
  const value = PWNFOX_COLORS[normalized];
  if (!value) die(`Error: unknown PwnFox color "${name}". One of: ${Object.keys(PWNFOX_COLORS).join(", ")}`);
  return { name: normalized, value };
}

function requestColorName(value) {
  if (!value) return undefined;
  const normalized = String(value).toLowerCase();
  return Object.entries(PWNFOX_COLORS).find(([, hex]) => hex === normalized)?.[0] || value;
}

function parseOutputOpts(args, startIdx) {
  const opts = { ...DEFAULT_OUTPUT_OPTS };
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--max-body" && args[i + 1]) {
      opts.maxBodyLines = parseInt(args[i + 1], 10);
      if (!Number.isFinite(opts.maxBodyLines)) die("Error: --max-body must be an integer");
      if (opts.maxBodyLines === 0) opts.maxBodyChars = 0;
      i++;
    } else if (args[i] === "--max-body-chars" && args[i + 1]) {
      opts.maxBodyChars = parseInt(args[i + 1], 10);
      if (!Number.isFinite(opts.maxBodyChars)) die("Error: --max-body-chars must be an integer");
      i++;
    } else if (args[i] === "--no-request") {
      opts.noRequest = true;
    } else if (args[i] === "--headers-only") {
      opts.headersOnly = true;
    } else if (args[i] === "--compact") {
      opts.noRequest = true;
      opts.maxBodyLines = 50;
      opts.maxBodyChars = 5000;
    }
  }
  return opts;
}

function parseConnectionOverrides(args, startIdx) {
  const overrides = {};
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--sni" && args[i + 1]) {
      overrides.sni = args[i + 1];
      i++;
    } else if (args[i] === "--connect-host" && args[i + 1]) {
      overrides.connectHost = args[i + 1];
      i++;
    } else if (args[i] === "--connect-port" && args[i + 1]) {
      overrides.connectPort = parseInt(args[i + 1], 10);
      if (!Number.isFinite(overrides.connectPort)) die("Error: --connect-port must be an integer");
      i++;
    } else if (args[i] === "--connect-tls") {
      overrides.connectTls = true;
    } else if (args[i] === "--connect-no-tls") {
      overrides.connectTls = false;
    }
  }
  return overrides;
}

/** `--allow "a,b, c"` is one argument holding a list; three places parse it. */
function splitList(value) {
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function parseCollectionId(args, startIdx) {
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--collection" && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

function parseSessionName(args, startIdx) {
  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

function baseUrl(url) {
  return url.replace(/\/$/, "");
}

function graphqlUrl(url) {
  return `${baseUrl(url)}/graphql`;
}

function websocketUrl(url) {
  const parsed = new URL(baseUrl(url));
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws/graphql";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function readSecretsFile() {
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function readCaidoSecrets() {
  return readSecretsFile().caido ?? {};
}

function writeCaidoSecrets(caidoSecrets) {
  const dir = dirname(SECRETS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secrets = readSecretsFile();
  secrets.caido = caidoSecrets;
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  try {
    chmodSync(SECRETS_PATH, 0o600);
  } catch {}
}

function isCachedTokenValid(token) {
  if (!token?.accessToken || !token.expiresAt) return false;
  const exp = Date.parse(token.expiresAt);
  return Number.isFinite(exp) && exp > Date.now() + 30_000;
}

// Send pacing lives beside the secrets file but never in it: this holds
// timestamps, not credentials, and separate processes have to see each other's.
function readStateFile() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Falls back to this when the state file cannot be written, so pacing inside one
// process survives a read-only config directory.
const lastSendByHost = new Map();

function writeStateFile(state) {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    if (DEBUG) console.error(`State file write failed: ${err.message}`);
  }
}

/**
 * Wait until at least minIntervalMs has passed since the last send to this
 * host. Best-effort: two processes racing can both read the same timestamp,
 * which costs one unpaced request rather than a lock.
 */
async function throttleHost(host, minIntervalMs) {
  if (!minIntervalMs || !host) return;
  const key = `lastSend:${host}`;
  const state = readStateFile();
  const persisted = Number(state[key]);
  const inMemory = lastSendByHost.get(host);
  const last = Math.max(Number.isFinite(persisted) ? persisted : 0, inMemory ?? 0);
  const waitMs = last ? last + minIntervalMs - Date.now() : 0;
  if (waitMs > 0) await sleep(Math.min(waitMs, minIntervalMs));
  const now = Date.now();
  lastSendByHost.set(host, now);
  state[key] = now;
  writeStateFile(state);
}

/**
 * Anywhere in the document, not just at line start: several operations here are
 * built as `${FRAGMENT} mutation Name(...)` on one line, and treating those as
 * reads would let a retry create a scope or switch a project twice.
 * A query misread as a mutation only loses its retry, so err that way.
 */
function isReadOnlyDocument(query) {
  return !/\bmutation\b/.test(query);
}

function isTransientError(err) {
  if (err?.status === 502 || err?.status === 503 || err?.status === 504) return true;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return true;
  const text = String(err?.message || "").toLowerCase();
  return text.includes("fetch failed") || text.includes("econnreset") || text.includes("socket hang up");
}

/**
 * The GraphQL multipart request spec, which is the only way to pass an Upload
 * scalar. `operations` carries the document with a null where the file goes,
 * `map` says which form part fills that null, and the part itself follows.
 * FormData builds the boundaries, so nothing here is hand-rolled.
 */
async function rawGraphqlUpload(url, query, variables, filePath, timeoutMs = 120_000) {
  const bytes = readFileSync(filePath);
  const form = new FormData();
  form.append("operations", JSON.stringify({ query, variables }));
  form.append("map", JSON.stringify({ "0": ["variables.input.file"] }));
  form.append("0", new Blob([bytes]), basename(filePath));

  const headers = { accept: "application/json" };
  if (this?.token) headers.authorization = `Bearer ${this.token}`;
  const response = await fetch(graphqlUrl(url), {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch {
    const err = new Error(`GraphQL upload returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  if (!response.ok || payload.errors) {
    const message = payload?.errors?.map((e) => e.message).join("; ") || response.statusText;
    const err = new Error(`GraphQL upload HTTP ${response.status}: ${message}`);
    err.status = response.status;
    throw err;
  }
  return payload.data;
}

async function rawGraphql(url, query, variables = {}, accessToken, timeoutMs = 30_000) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const response = await fetch(graphqlUrl(url), {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: compactUndefined(variables) }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let payload;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    // Carries the status so a proxy's HTML 502/503 page still reads as transient.
    const err = new Error(`GraphQL returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }

  if (!response.ok) {
    const message = payload?.errors?.map((e) => e.message).join("; ") || response.statusText;
    const err = new Error(`GraphQL HTTP ${response.status}: ${message}`);
    err.status = response.status;
    err.errors = payload?.errors;
    throw err;
  }

  if (payload.errors?.length) {
    const err = new Error(payload.errors.map((e) => e.message).join("; "));
    err.errors = payload.errors;
    throw err;
  }

  if (!("data" in payload)) throw new Error("GraphQL returned no data");
  return payload.data;
}

function looksLikeAuthError(err) {
  if (err?.status === 401 || err?.status === 403) return true;
  const text = `${err?.message || ""} ${JSON.stringify(err?.errors || [])}`.toLowerCase();
  return text.includes("authorization") || text.includes("unauthorized") || text.includes("forbidden") || text.includes("token");
}

function messageDataToString(data) {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data).toString("utf-8"));
  if (ArrayBuffer.isView(data)) return Promise.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8"));
  if (data?.text) return data.text();
  return Promise.resolve(String(data));
}

let webSocketImplPromise;

function resolveWebSocketImpl() {
  if (!webSocketImplPromise) {
    webSocketImplPromise = (async () => {
      if (typeof WebSocket !== "undefined") return WebSocket;
      try {
        const mod = await import("ws");
        return mod.WebSocket || mod.default;
      } catch {
        throw new Error(
          "Global WebSocket is not available (requires Node 22.4+; this skill documents Node 24+).\n" +
          "Either upgrade Node (e.g. `nvm install 24`) or install the optional `ws` fallback:\n" +
          "  cd skills/caido-mode/client && npm install ws",
        );
      }
    })();
  }
  return webSocketImplPromise;
}

async function createGraphqlWebSocket(url, accessToken) {
  const WebSocketImpl = await resolveWebSocketImpl();
  const ws = new WebSocketImpl(websocketUrl(url), "graphql-transport-ws");
  ws.addEventListener("open", () => {
    const payload = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    ws.send(JSON.stringify({ type: "connection_init", payload }));
  });
  return ws;
}

async function graphqlSubscribeFirst(url, accessToken, query, variables, match, timeoutMs) {
  const ws = await createGraphqlWebSocket(url, accessToken);
  return new Promise((resolvePromise, rejectPromise) => {
    const id = "1";
    let settled = false;
    let subscribed = false;

    const cleanup = () => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const timeout = setTimeout(() => {
      settle(rejectPromise, new Error("Timed out waiting for GraphQL subscription event"));
    }, timeoutMs);

    ws.addEventListener("message", async (event) => {
      let msg;
      try {
        msg = JSON.parse(await messageDataToString(event.data));
      } catch (err) {
        settle(rejectPromise, err);
        return;
      }

      if (msg.type === "connection_ack" && !subscribed) {
        subscribed = true;
        ws.send(JSON.stringify({ id, type: "subscribe", payload: { query, variables } }));
        return;
      }

      if (msg.type === "next" && msg.id === id) {
        if (msg.payload?.errors?.length) {
          settle(rejectPromise, new Error(msg.payload.errors.map((e) => e.message).join("; ")));
          return;
        }
        const value = msg.payload?.data;
        if (!match || match(value)) settle(resolvePromise, value);
        return;
      }

      if (msg.type === "error") {
        settle(rejectPromise, new Error(JSON.stringify(msg.payload)));
        return;
      }

      if (msg.type === "complete" && msg.id === id) {
        settle(rejectPromise, new Error("GraphQL subscription completed without a matching event"));
      }
    });

    ws.addEventListener("error", () => {
      settle(rejectPromise, new Error("WebSocket error"));
    });

    ws.addEventListener("close", () => {
      if (!settled) settle(rejectPromise, new Error("WebSocket closed before a matching event"));
    });
  });
}

async function createFinishedTaskWatcher(url, accessToken, timeoutMs = 300_000) {
  const ws = await createGraphqlWebSocket(url, accessToken);
  return new Promise((resolveReady, rejectReady) => {
    const id = "1";
    const events = [];
    const waiters = new Map();
    let ready = false;
    let closed = false;

    const readyTimeout = setTimeout(() => {
      const err = new Error("Timed out while opening GraphQL task subscription");
      rejectReady(err);
      close();
    }, 30_000);

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimeout);
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("Task subscription closed before a matching event"));
      }
      waiters.clear();
      try {
        ws.close();
      } catch {}
    };

    const fail = (err) => {
      if (!ready) rejectReady(err);
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(err);
      }
      waiters.clear();
      close();
    };

    const deliver = (finishedTask) => {
      const taskId = finishedTask?.task?.id;
      if (!taskId) return;
      const waiter = waiters.get(taskId);
      if (!waiter) {
        events.push(finishedTask);
        return;
      }
      clearTimeout(waiter.timeout);
      waiters.delete(taskId);
      waiter.resolve(finishedTask);
    };

    const waitForTask = (taskId) => {
      if (closed) return Promise.reject(new Error("Task subscription is closed"));
      const eventIdx = events.findIndex((event) => event?.task?.id === taskId);
      if (eventIdx >= 0) {
        const [event] = events.splice(eventIdx, 1);
        return Promise.resolve(event);
      }

      return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          waiters.delete(taskId);
          rejectPromise(new Error(`Timed out waiting for task ${taskId}`));
        }, timeoutMs);
        waiters.set(taskId, { resolve: resolvePromise, reject: rejectPromise, timeout });
      });
    };

    ws.addEventListener("message", async (event) => {
      let msg;
      try {
        msg = JSON.parse(await messageDataToString(event.data));
      } catch (err) {
        fail(err);
        return;
      }

      if (msg.type === "connection_ack" && !ready) {
        ws.send(JSON.stringify({ id, type: "subscribe", payload: { query: TASK_FINISHED_SUBSCRIPTION, variables: {} } }));
        ready = true;
        clearTimeout(readyTimeout);
        resolveReady({ waitForTask, close });
        return;
      }

      if (msg.type === "next" && msg.id === id) {
        if (msg.payload?.errors?.length) {
          fail(new Error(msg.payload.errors.map((e) => e.message).join("; ")));
          return;
        }
        deliver(msg.payload?.data?.finishedTask);
        return;
      }

      if (msg.type === "error") {
        fail(new Error(JSON.stringify(msg.payload)));
      }
    });

    ws.addEventListener("error", () => {
      fail(new Error("WebSocket error"));
    });

    ws.addEventListener("close", () => {
      if (!closed) fail(new Error("WebSocket closed"));
    });
  });
}

async function getDeviceInformation(pat, userCode, cloudApiUrl = DEFAULT_CLOUD_API_URL) {
  const url = new URL(`${cloudApiUrl.replace(/\/$/, "")}/oauth2/device/information`);
  url.searchParams.set("user_code", userCode);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${pat}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Failed to get device information: ${await response.text()}`);
  return response.json();
}

async function approveDevice(pat, userCode, scopes, cloudApiUrl = DEFAULT_CLOUD_API_URL) {
  const url = new URL(`${cloudApiUrl.replace(/\/$/, "")}/oauth2/device/approve`);
  url.searchParams.set("user_code", userCode);
  url.searchParams.set("scope", scopes.join(","));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Failed to approve device: ${await response.text()}`);
}

async function authenticateWithPat(url, pat) {
  const started = await rawGraphql(url, AUTH_START, {});
  const payload = started.startAuthenticationFlow;
  if (payload?.error) throw new Error(`Authentication flow failed: ${payload.error.__typename}`);
  const request = payload?.request;
  if (!request) throw new Error("Authentication flow returned no request");

  const info = await getDeviceInformation(pat, request.userCode);
  const scopes = (info.scopes || []).map((scope) => scope.name);
  await approveDevice(pat, request.userCode, scopes);

  const expiresAt = Date.parse(request.expiresAt);
  const timeoutMs = Number.isFinite(expiresAt) ? Math.max(10_000, expiresAt - Date.now()) : 300_000;
  const tokenEvent = await graphqlSubscribeFirst(
    url,
    undefined,
    AUTH_CREATED_TOKEN,
    { requestId: request.id },
    (data) => !!data?.createdAuthenticationToken?.token || !!data?.createdAuthenticationToken?.error,
    timeoutMs,
  );

  const tokenPayload = tokenEvent.createdAuthenticationToken;
  if (tokenPayload.error) throw new Error(`Authentication token failed: ${tokenPayload.error.__typename}`);
  if (!tokenPayload.token) throw new Error("Authentication token subscription returned no token");
  return tokenPayload.token;
}

async function refreshAuthenticationToken(url, refreshToken) {
  const data = await rawGraphql(url, AUTH_REFRESH, { refreshToken });
  const payload = data.refreshAuthenticationToken;
  if (payload?.error) throw new Error(`Token refresh failed: ${payload.error.__typename}`);
  if (!payload?.token) throw new Error("Token refresh returned no token");
  return payload.token;
}

class CaidoClient {
  constructor(url, token, refreshToken) {
    this.url = url;
    this.token = token;
    this.refreshToken = refreshToken;
  }

  /**
   * Reads retry on transient transport failures; mutations never do. Resending
   * a replay mutation after an ambiguous failure would put a second request on
   * the target, which is not a cost this client gets to decide to pay.
   */
  async graphql(query, variables = {}) {
    const retriable = isReadOnlyDocument(query);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.graphqlOnce(query, variables);
      } catch (err) {
        if (!retriable || attempt >= RETRY_DELAYS_MS.length || !isTransientError(err)) throw err;
        if (DEBUG) console.error(`Transient GraphQL failure (${err.message}), retrying in ${RETRY_DELAYS_MS[attempt]}ms`);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  async graphqlOnce(query, variables = {}) {
    try {
      return await rawGraphql(this.url, query, variables, this.token);
    } catch (err) {
      if (!this.refreshToken || !looksLikeAuthError(err)) throw err;
      const token = await refreshAuthenticationToken(this.url, this.refreshToken);
      this.token = token.accessToken;
      this.refreshToken = token.refreshToken;
      const secrets = readCaidoSecrets();
      secrets.cachedToken = token;
      writeCaidoSecrets(secrets);
      return rawGraphql(this.url, query, variables, this.token);
    }
  }

  /** Uploads never retry: a resend would leave a second copy hosted. */
  async graphqlUpload(query, variables, filePath) {
    return rawGraphqlUpload.call(this, this.url, query, variables, filePath);
  }

  async health() {
    const response = await fetch(`${baseUrl(this.url)}/health`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Health HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async getServerVersion() {
    if (!this._versionPromise) {
      this._versionPromise = (async () => {
        const info = await this.health();
        return parseSemver(info?.version);
      })();
    }
    return this._versionPromise;
  }
}

function parseSemver(value) {
  const match = String(value || "").match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { major: 0, minor: 0, patch: 0, raw: String(value || "") };
  return { major: +match[1], minor: +match[2], patch: +match[3], raw: String(value) };
}

function versionGte(actual, target) {
  if (actual.major !== target.major) return actual.major > target.major;
  if (actual.minor !== target.minor) return actual.minor > target.minor;
  return actual.patch >= target.patch;
}

const CAIDO_V057 = { major: 0, minor: 57, patch: 0 };

async function getClient() {
  const explicitEnvUrl = process.env.CAIDO_URL || process.env.CAIDO_INSTANCE_URL;
  const envUrl = explicitEnvUrl || DEFAULT_CAIDO_URL;
  const secrets = readCaidoSecrets();
  const url = explicitEnvUrl || secrets.url || envUrl;
  const envToken = process.env.CAIDO_ACCESS_TOKEN;
  const envPat = process.env.CAIDO_PAT;

  if (envToken) return new CaidoClient(url, envToken, undefined);

  if (isCachedTokenValid(secrets.cachedToken)) {
    return new CaidoClient(url, secrets.cachedToken.accessToken, secrets.cachedToken.refreshToken);
  }

  if (secrets.cachedToken?.refreshToken) {
    try {
      const token = await refreshAuthenticationToken(url, secrets.cachedToken.refreshToken);
      secrets.cachedToken = token;
      writeCaidoSecrets(secrets);
      return new CaidoClient(url, token.accessToken, token.refreshToken);
    } catch (err) {
      if (DEBUG) console.error(err.stack || err.message);
    }
  }

  const pat = envPat || secrets.pat;
  if (pat) {
    const token = await authenticateWithPat(url, pat);
    secrets.url = url;
    if (secrets.pat) secrets.pat = pat;
    secrets.cachedToken = token;
    writeCaidoSecrets(secrets);
    return new CaidoClient(url, token.accessToken, token.refreshToken);
  }

  die([
    "Error: No Caido auth found.",
    "  - Set CAIDO_PAT for PAT bootstrap, or",
    "  - Set CAIDO_ACCESS_TOKEN for a direct access token, or",
    "  - Run: node caido-client.mjs setup <pat>",
  ].join("\n"));
}

function decodeRaw(raw) {
  return rawToBuffer(raw).toString("utf-8");
}

function rawToBuffer(raw) {
  if (!raw) return Buffer.alloc(0);
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  return Buffer.from(raw, "base64");
}

function encodeRaw(raw) {
  return Buffer.from(raw, "utf-8").toString("base64");
}

function splitHttpRawBytes(raw) {
  const crlf = Buffer.from("\r\n\r\n", "ascii");
  const lf = Buffer.from("\n\n", "ascii");
  const crlfIdx = raw.indexOf(crlf);
  const lfIdx = raw.indexOf(lf);

  if (crlfIdx >= 0 && (lfIdx < 0 || crlfIdx <= lfIdx)) {
    return {
      headers: raw.subarray(0, crlfIdx),
      body: raw.subarray(crlfIdx + crlf.length),
    };
  }

  if (lfIdx >= 0) {
    return {
      headers: raw.subarray(0, lfIdx),
      body: raw.subarray(lfIdx + lf.length),
    };
  }

  throw new Error("Could not find HTTP header/body separator in raw data");
}

function writeBinaryFile(filePath, data, force, mode) {
  const absolutePath = resolve(filePath);
  assertWritableTarget(absolutePath, force);
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  writeFileSync(absolutePath, data, mode === undefined ? undefined : { mode });
  if (mode !== undefined) {
    try {
      chmodSync(absolutePath, mode);
    } catch {}
  }
  return absolutePath;
}

/**
 * Refuses to clobber an existing file without --force, and refuses a symlink
 * even with it: --force is permission to overwrite the named file, not to
 * follow a link and write somewhere else entirely.
 */
function assertWritableTarget(absolutePath, force) {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) die(`Error: ${absolutePath} is a symlink; refusing to write through it.`);
  if (!force) die(`Error: ${absolutePath} already exists. Pass --force to overwrite.`);
}

function extractHeaders(decoded) {
  const doubleCrlf = decoded.indexOf("\r\n\r\n");
  const doubleLf = decoded.indexOf("\n\n");
  if (doubleCrlf >= 0 && (doubleLf < 0 || doubleCrlf <= doubleLf)) return decoded.substring(0, doubleCrlf);
  if (doubleLf >= 0) return decoded.substring(0, doubleLf);
  return decoded;
}

function formatHttpRaw(decoded, opts) {
  if (opts.headersOnly) return extractHeaders(decoded);
  return truncateBody(decoded, opts.maxBodyLines, opts.maxBodyChars);
}

function truncateBody(decoded, maxLines, maxChars) {
  const noLineLimit = maxLines <= 0;
  const noCharLimit = maxChars <= 0;
  if (noLineLimit && noCharLimit) return decoded;

  const doubleCrlf = decoded.indexOf("\r\n\r\n");
  const doubleLf = decoded.indexOf("\n\n");
  let splitIndex;
  let separator;
  if (doubleCrlf >= 0 && (doubleLf < 0 || doubleCrlf <= doubleLf)) {
    splitIndex = doubleCrlf;
    separator = "\r\n\r\n";
  } else if (doubleLf >= 0) {
    splitIndex = doubleLf;
    separator = "\n\n";
  } else {
    return decoded;
  }

  const headers = decoded.substring(0, splitIndex);
  let body = decoded.substring(splitIndex + separator.length);
  if (!noCharLimit && body.length > maxChars) {
    body = body.substring(0, maxChars) + `\n\n[TRUNCATED at ${maxChars} chars, total ${decoded.length - splitIndex - separator.length}]`;
  }
  if (!noLineLimit) {
    const lines = body.split("\n");
    if (lines.length > maxLines) {
      body = lines.slice(0, maxLines).join("\n") + `\n\n[TRUNCATED at ${maxLines} lines, total ${lines.length}]`;
    }
  }
  return headers + separator + body;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function rawToCurl(rawRequest, host, port, isTls) {
  const lines = rawRequest.split(/\r?\n/);
  if (!lines.length) return "";
  const [method, path = "/"] = lines[0].split(" ");
  const scheme = isTls ? "https" : "http";
  const portSuffix = (isTls && port === 443) || (!isTls && port === 80) ? "" : `:${port}`;
  const parts = [`curl -X ${method} ${shellSingleQuote(`${scheme}://${host}${portSuffix}${path}`)}`];

  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || line === "\r") break;
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const name = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      if (name.toLowerCase() === "host") continue;
      if (name.toLowerCase() === "content-length") continue;
      parts.push(`  -H ${shellSingleQuote(`${name}: ${value}`)}`);
    }
  }

  const body = lines.slice(i + 1).join("\n").trim();
  if (body) parts.push(`  -d ${shellSingleQuote(body)}`);
  return parts.join(" \\\n");
}

function buildConnection(host, port, isTLS, overrides = {}) {
  const connection = {
    host: overrides.connectHost ?? host,
    port: overrides.connectPort ?? port,
    isTLS: overrides.connectTls ?? isTLS,
  };
  if (overrides.sni) connection.SNI = overrides.sni;
  return connection;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

async function resolveRaw(raw) {
  if (raw === "-") return readStdin();
  if (raw.startsWith("@")) return readFile(resolve(raw.slice(1)), "utf-8");
  return normalizeRaw(raw);
}

function normalizeRaw(raw) {
  if (raw.includes("\r\n")) return raw;
  return raw.replace(/\\([rnt\\])/g, (_, ch) => {
    switch (ch) {
      case "r": return "\r";
      case "n": return "\n";
      case "t": return "\t";
      case "\\": return "\\";
      default: return ch;
    }
  });
}

function applyRawEdits(raw, edits) {
  for (const rep of edits.replacements) {
    const [from, to] = rep.split(":::");
    if (from && to !== undefined) raw = raw.replaceAll(from, to);
  }

  const lineEnd = raw.includes("\r\n") ? "\r\n" : "\n";
  const separator = lineEnd + lineEnd;
  const parts = raw.split(separator);
  const headerBlock = parts[0];
  let bodyPart = parts.slice(1).join(separator);
  const headerLines = headerBlock.split(lineEnd);
  let requestLine = headerLines[0];
  let headers = headerLines.slice(1);

  if (edits.method) {
    const spaceIdx = requestLine.indexOf(" ");
    if (spaceIdx > 0) requestLine = edits.method + requestLine.substring(spaceIdx);
  }

  if (edits.path) {
    const firstSpace = requestLine.indexOf(" ");
    const lastSpace = requestLine.lastIndexOf(" ");
    if (firstSpace > 0 && lastSpace > firstSpace) {
      requestLine = requestLine.substring(0, firstSpace + 1) + edits.path + requestLine.substring(lastSpace);
    }
  }

  for (const name of edits.removeHeaders) {
    headers = headers.filter((h) => !h.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  }

  for (const header of edits.setHeaders) {
    const colonIdx = header.indexOf(":");
    if (colonIdx > 0) {
      const name = header.substring(0, colonIdx).trim();
      headers = headers.filter((h) => !h.toLowerCase().startsWith(`${name.toLowerCase()}:`));
      headers.push(header.trim());
    }
  }

  if (edits.body !== undefined) {
    bodyPart = edits.body;
    headers = headers.filter((h) => !h.toLowerCase().startsWith("content-length:"));
    headers.push(`Content-Length: ${Buffer.byteLength(bodyPart, "utf-8")}`);
  }

  return [requestLine, ...headers].join(lineEnd) + separator + bodyPart;
}

/**
 * Only surfaced when there is something to say: no `alteration` field means
 * NONE, no `edited` means false. Documented, so absence is an answer too.
 */
function alterationFields(node) {
  return {
    alteration: node?.alteration && node.alteration !== "NONE" ? node.alteration : undefined,
    edited: node?.edited || undefined,
  };
}

function requestOutput(node, opts, includeResponse = true) {
  if (!node) return undefined;
  const output = {
    id: node.id,
    method: node.method,
    host: node.host,
    path: node.path,
    port: node.port,
    isTls: node.isTls,
    createdAt: node.createdAt,
    color: requestColorName(node.metadata?.color),
    ...alterationFields(node),
  };
  if (!opts.noRequest && node.raw) output.raw = formatHttpRaw(decodeRaw(node.raw), opts);
  if (includeResponse && node.response) {
    output.response = responseOutput(node.response, opts);
  }
  return output;
}

function responseOutput(response, opts) {
  const output = {
    statusCode: response.statusCode,
    roundtrip: response.roundtripTime,
    length: response.length,
    ...alterationFields(response),
  };
  if (response.raw) output.raw = formatHttpRaw(decodeRaw(response.raw), opts);
  return output;
}

function sessionOutput(session) {
  if (!session) return undefined;
  return {
    id: session.id,
    name: session.name,
    collectionId: session.collection?.id,
    activeEntryId: session.activeEntry?.id,
  };
}

function formatReplayEntry(entry, opts, includeRaw) {
  const request = entry.request;
  const response = request?.response;
  const output = {
    id: entry.id,
    sessionId: entry.session?.id,
    createdAt: entry.createdAt,
    error: entry.error,
    connection: entry.connection ? {
      host: entry.connection.host,
      port: entry.connection.port,
      isTLS: entry.connection.isTLS,
      ...(entry.connection.SNI ? { SNI: entry.connection.SNI } : {}),
    } : undefined,
  };

  if (request) {
    output.request = {
      id: request.id,
      method: request.method,
      host: request.host,
      port: request.port,
      path: request.path,
      query: request.query || undefined,
      isTls: request.isTls,
    };
  }

  if (response) {
    output.response = {
      statusCode: response.statusCode,
      roundtrip: response.roundtripTime,
      length: response.length,
    };
  }

  if (includeRaw) {
    // --no-request, and so --compact, suppress the request side here as they do
    // everywhere else. It matters more here than anywhere: a replay entry's raw
    // is a full authenticated request, and its Cookie header is the one thing
    // no body limit touches.
    if (!opts.noRequest) {
      if (entry.raw) output.raw = formatHttpRaw(decodeRaw(entry.raw), opts);
      if (request?.raw) output.request.raw = formatHttpRaw(decodeRaw(request.raw), opts);
    }
    if (response?.raw) output.response.raw = formatHttpRaw(decodeRaw(response.raw), opts);
  }

  return output;
}

function buildReplayOutput(sessionId, result, opts, modifiedRaw) {
  const output = {
    sessionId,
    status: result.status,
    error: result.error,
  };

  if (modifiedRaw !== undefined && !opts.noRequest) output.modifiedRequest = formatHttpRaw(modifiedRaw, opts);
  if (result.entry) {
    output.entryId = result.entry.id;
    if (result.entry.request) output.requestId = result.entry.request.id;
    if (result.entry.request?.response) {
      output.response = responseOutput(result.entry.request.response, opts);
      const backoff = backoffInfo(result.entry.request.response);
      if (backoff) output.backoff = backoff;
    }
  }
  return output;
}

function firstPayloadError(payload) {
  if (!payload?.error) return undefined;
  return payload.error.__typename || JSON.stringify(payload.error);
}

function requirePayload(payload, field, op) {
  const err = firstPayloadError(payload);
  if (err) throw new Error(`${op} failed: ${err}`);
  if (!payload?.[field]) throw new Error(`${op} returned no ${field}`);
  return payload[field];
}

async function getRequest(client, id, includeRequestRaw, includeResponseRaw) {
  const data = await client.graphql(REQUEST_QUERY, { id, includeRequestRaw, includeResponseRaw });
  return data.request;
}

async function createReplaySession(client, requestSource, collectionId, kind = "HTTP") {
  const version = await client.getServerVersion();
  const isV057 = versionGte(version, CAIDO_V057);
  const input = { requestSource };
  if (collectionId) input.collectionId = collectionId;
  if (isV057) input.kind = kind;
  else if (kind !== "HTTP") die(`WebSocket replay needs Caido 0.57 or newer; this instance is ${version}`);
  const mutation = isV057 ? CREATE_REPLAY_SESSION_V057 : CREATE_REPLAY_SESSION;
  const data = await client.graphql(mutation, { input });
  return requirePayload(data.createReplaySession, "session", "createReplaySession");
}

async function renameReplaySession(client, id, name) {
  const version = await client.getServerVersion();
  const mutation = versionGte(version, CAIDO_V057) ? RENAME_REPLAY_SESSION_V057 : RENAME_REPLAY_SESSION;
  const data = await client.graphql(mutation, { id, name });
  return requirePayload(data.renameReplaySession, "session", "renameReplaySession");
}

async function getReplayEntry(client, id, includeReplayRaw = true, includeRequestRaw = true, includeResponseRaw = true) {
  const version = await client.getServerVersion();
  if (versionGte(version, CAIDO_V057)) {
    const data = await client.graphql(REPLAY_ENTRY_QUERY_V057, {
      id,
      sessionKind: "HTTP",
      includeReplayRaw,
      includeRequestRaw,
      includeResponseRaw,
    });
    return data.replayEntry;
  }
  const data = await client.graphql(REPLAY_ENTRY_QUERY, { id, includeReplayRaw, includeRequestRaw, includeResponseRaw });
  return data.replayEntry;
}

async function sendReplay(client, sessionId, raw, connection, { minIntervalMs = MIN_INTERVAL_MS ?? 0 } = {}) {
  await throttleHost(connection?.host, minIntervalMs);
  const version = await client.getServerVersion();
  if (versionGte(version, CAIDO_V057)) {
    return sendReplayV057(client, sessionId, raw, connection);
  }
  return sendReplayV056(client, sessionId, raw, connection);
}

/**
 * Backoff signals the caller must not read as a normal result: a 429 recorded
 * as "blocked" is a wrong verdict that outlives the request. Each reason is
 * named rather than collapsed, because a bare 503 is an unavailable service and
 * a challenge is a bot check — different conclusions about the target.
 */
function backoffInfo(response) {
  if (!response) return undefined;
  const code = response.statusCode;
  const headers = response.raw ? extractHeaders(decodeRaw(response.raw)) : "";
  const retryAfter = headers.match(/^retry-after:[ \t]*(.+)$/im)?.[1]?.trim();
  const challenged = /^cf-mitigated:/im.test(headers);

  let reason;
  if (code === 429) reason = "rate-limited";
  else if (challenged) reason = "challenge";
  else if (code === 503) reason = "service-unavailable";
  else if (retryAfter) reason = "retry-after";
  if (!reason) return undefined;

  return compactUndefined({ reason, statusCode: code, retryAfter, challenge: challenged || undefined });
}

async function sendReplayV056(client, sessionId, raw, connection) {
  const input = {
    connection,
    raw: encodeRaw(raw),
    settings: {
      connectionClose: false,
      updateContentLength: true,
      placeholders: [],
    },
  };
  return runReplayTask(client, START_REPLAY_TASK_V056, { sessionId, input });
}

async function sendReplayV057(client, sessionId, raw, connection) {
  const sessionData = await client.graphql(REPLAY_SESSION_FOR_SEND_V057, { id: sessionId });
  const session = sessionData.replaySession;
  if (!session) throw new Error(`Replay session ${sessionId} not found`);
  if (session.__typename !== "ReplaySessionHttp") {
    throw new Error(`Replay session ${sessionId} is not an HTTP session (${session.__typename})`);
  }

  const entryId =
    session.activeEntry?.id ||
    session.entries?.edges?.[session.entries.edges.length - 1]?.node?.id;
  if (!entryId) throw new Error(`Replay session ${sessionId} has no entry to update`);

  const encoded = encodeRaw(raw);
  await client.graphql(UPDATE_REPLAY_ENTRY_DRAFT_V057, {
    id: entryId,
    input: {
      http: {
        connection,
        editorState: encoded,
        raw: encoded,
        settings: { placeholders: [] },
      },
    },
  });

  const current = session.settings || {};
  if (current.connectionClose !== false || current.updateContentLength !== true) {
    await client.graphql(UPDATE_REPLAY_SESSION_SETTINGS_V057, {
      id: sessionId,
      input: { http: { connectionClose: false, updateContentLength: true } },
    });
  }

  return runReplayTask(client, START_REPLAY_TASK_V057, { sessionId });
}

async function runReplayTask(client, mutation, variables) {
  const watcher = await createFinishedTaskWatcher(client.url, client.token);
  let task;
  let finished;
  try {
    const started = await client.graphql(mutation, variables);
    task = requirePayload(started.startReplayTask, "task", "startReplayTask");
    finished = await watcher.waitForTask(task.id);
  } finally {
    watcher.close();
  }
  const entryId = finished.task?.replayEntry?.id || task.replayEntry?.id;
  const entry = entryId ? await getReplayEntry(client, entryId, true, true, true) : undefined;
  return {
    entry,
    status: finished.status,
    error: finished.error,
  };
}

async function resolveSession(client, idOrName) {
  const version = await client.getServerVersion();
  const isV057 = versionGte(version, CAIDO_V057);
  const sessionQuery = isV057 ? REPLAY_SESSION_QUERY_V057 : REPLAY_SESSION_QUERY;
  const sessionsQuery = isV057 ? REPLAY_SESSIONS_QUERY_V057 : REPLAY_SESSIONS_QUERY;

  try {
    const direct = await client.graphql(sessionQuery, { id: idOrName });
    if (direct.replaySession) return direct.replaySession;
  } catch {}

  let after;
  while (true) {
    const page = await client.graphql(sessionsQuery, { first: 100, after });
    for (const edge of page.replaySessions.edges) {
      if (edge.node.name === idOrName) return edge.node;
    }
    if (!page.replaySessions.pageInfo.hasNextPage) break;
    after = page.replaySessions.pageInfo.endCursor;
  }
  return undefined;
}

/**
 * Accepts a replay collection's id or its name. Collections are created by hand
 * and referred to by the name on the tab, so requiring an id here meant a lookup
 * before every send, which is why grouping got skipped.
 */
async function resolveCollectionId(client, idOrName) {
  if (!idOrName) return undefined;
  const nodes = [];
  let after;
  while (true) {
    const page = await client.graphql(REPLAY_COLLECTIONS_QUERY, { first: 100, after });
    for (const edge of page.replaySessionCollections.edges) nodes.push(edge.node);
    if (!page.replaySessionCollections.pageInfo.hasNextPage) break;
    after = page.replaySessionCollections.pageInfo.endCursor;
  }
  const match = nodes.find((n) => n.id === idOrName) || nodes.find((n) => n.name === idOrName);
  if (!match) die(`Collection "${idOrName}" not found. Run: caido-client.mjs replay-collections`);
  return match.id;
}

/** Accepts a session's id or its name, and fails with the id, not a GraphQL error. */
async function resolveSessionId(client, idOrName) {
  const session = await resolveSession(client, idOrName);
  if (!session) die(`Replay session "${idOrName}" not found. Run: caido-client.mjs replay-sessions`);
  return session.id;
}

/**
 * A session created unnamed is a tab nobody can find later, so every command
 * that creates one takes --name and applies it before the first send.
 */
async function createNamedReplaySession(client, requestSource, collectionId, name, kind = "HTTP") {
  const session = await createReplaySession(client, requestSource, collectionId, kind);
  return name ? await renameReplaySession(client, session.id, name) : session;
}

/** Accepts a scope id or its name, so callers do not have to look the id up first. */
async function resolveScopeId(client, idOrName) {
  const scopes = (await client.graphql(SCOPES_QUERY, {})).scopes || [];
  const match = scopes.find((s) => s.id === idOrName) || scopes.find((s) => s.name === idOrName);
  if (!match) die(`Scope "${idOrName}" not found. Run: caido-client.mjs scopes`);
  return match.id;
}

async function cmdSearch(filter, limit, after, idsOnly, desc, scope, color, scanLimit) {
  const client = await getClient();
  const scopeId = scope ? await resolveScopeId(client, scope) : undefined;
  let edges;
  let pageInfo;
  let scanned;
  let scanLimitReached = false;
  let selectedColor;

  if (!color) {
    const data = await client.graphql(REQUESTS_QUERY, {
      first: limit,
      after,
      filter: filter ? { code: filter } : undefined,
      order: desc ? { by: "ID", ordering: "DESC" } : undefined,
      scopeId,
      includeRequestRaw: false,
      includeResponseRaw: false,
    });
    edges = data.requests.edges;
    pageInfo = data.requests.pageInfo;
  } else {
    selectedColor = pwnfoxColorValue(color);
    const matches = [];
    let cursor = after;
    let startCursor;
    let hasPreviousPage = false;
    let hasNextPage = false;
    scanned = 0;

    search: while (scanned < scanLimit && matches.length < limit) {
      const data = await client.graphql(REQUESTS_QUERY, {
        first: Math.min(100, scanLimit - scanned),
        after: cursor,
        filter: filter ? { code: filter } : undefined,
        order: desc ? { by: "ID", ordering: "DESC" } : undefined,
        scopeId,
        includeRequestRaw: false,
        includeResponseRaw: false,
      });
      const page = data.requests;
      hasPreviousPage ||= page.pageInfo.hasPreviousPage;
      if (!page.edges.length) break;

      for (let index = 0; index < page.edges.length; index++) {
        const edge = page.edges[index];
        startCursor ??= edge.cursor;
        cursor = edge.cursor;
        scanned++;
        if (String(edge.node.metadata?.color || "").toLowerCase() === selectedColor.value) matches.push(edge);
        if (matches.length === limit || scanned === scanLimit) {
          hasNextPage = index < page.edges.length - 1 || page.pageInfo.hasNextPage;
          scanLimitReached = scanned === scanLimit && hasNextPage;
          break search;
        }
      }

      hasNextPage = page.pageInfo.hasNextPage;
      if (!hasNextPage) break;
    }

    edges = matches;
    pageInfo = {
      hasNextPage,
      hasPreviousPage,
      startCursor: startCursor || null,
      endCursor: cursor || null,
    };
  }

  if (scanLimitReached) {
    console.error(`Warning: --color ${selectedColor.name} scanned ${scanLimit} rows; continue with --after ${pageInfo.endCursor} or raise --scan-limit.`);
  }
  if (idsOnly) {
    console.log(JSON.stringify(edges.map((e) => e.node.id)));
    return;
  }
  const results = edges.map((e) => ({
    id: e.node.id,
    method: e.node.method,
    host: e.node.host,
    path: e.node.path,
    query: e.node.query || undefined,
    isTls: e.node.isTls,
    port: e.node.port,
    statusCode: e.node.response?.statusCode,
    roundtrip: e.node.response?.roundtripTime,
    responseLength: e.node.response?.length,
    createdAt: e.node.createdAt,
    color: requestColorName(e.node.metadata?.color),
    ...alterationFields(e.node),
    cursor: e.cursor,
  }));
  printJson(compactUndefined({
    results,
    pageInfo,
    count: results.length,
    color: selectedColor?.name,
    scanned,
    scanLimitReached: color ? scanLimitReached : undefined,
  }));
}

async function requestIdsForColorUpdate(client, filter, scopeId, limit) {
  const ids = [];
  let after;

  while (ids.length <= limit) {
    const data = await client.graphql(REQUESTS_QUERY, {
      first: Math.min(100, limit + 1 - ids.length),
      after,
      filter: { code: filter },
      scopeId,
      includeRequestRaw: false,
      includeResponseRaw: false,
    });
    for (const edge of data.requests.edges) ids.push(edge.node.id);
    if (ids.length > limit || !data.requests.pageInfo.hasNextPage) break;
    after = data.requests.pageInfo.endCursor;
  }

  if (ids.length > limit) {
    die(`Error: filter matches more than --limit ${limit}; narrow the row window or raise --limit.`);
  }
  return ids;
}

function updateRequestColorDocument(count) {
  const variables = Array.from({ length: count }, (_, index) => `$id${index}: ID!`).join(", ");
  const fields = Array.from({ length: count }, (_, index) =>
    `r${index}: updateRequestMetadata(id: $id${index}, input: { color: $color }) { metadata { id color } }`
  ).join("\n");
  return `mutation SetRequestColors(${variables}, $color: String) {\n${fields}\n}`;
}

async function cmdSetColor(color, ids, filter, scope, limit) {
  const selectedColor = color === "clear" ? { name: null, value: null } : pwnfoxColorValue(color);
  const client = await getClient();
  const scopeId = scope ? await resolveScopeId(client, scope) : undefined;
  const selectedIds = ids || await requestIdsForColorUpdate(client, filter, scopeId, limit);
  if (!selectedIds.length) {
    printJson({ color: selectedColor.name, updated: [], count: 0 });
    return;
  }

  const updated = [];
  for (let offset = 0; offset < selectedIds.length; offset += 100) {
    const chunk = selectedIds.slice(offset, offset + 100);
    const variables = { color: selectedColor.value };
    for (let index = 0; index < chunk.length; index++) variables[`id${index}`] = chunk[index];
    const data = await client.graphql(updateRequestColorDocument(chunk.length), variables);
    for (let index = 0; index < chunk.length; index++) {
      if (data[`r${index}`]?.metadata) updated.push(chunk[index]);
    }
  }
  printJson({ color: selectedColor.name, updated, count: updated.length });
}

async function cmdRecent(limit) {
  const client = await getClient();
  const data = await client.graphql(REQUESTS_QUERY, {
    first: limit,
    order: { by: "ID", ordering: "DESC" },
    includeRequestRaw: false,
    includeResponseRaw: false,
  });
  const results = data.requests.edges.map((e) => ({
    id: e.node.id,
    method: e.node.method,
    host: e.node.host,
    path: e.node.path,
    statusCode: e.node.response?.statusCode,
    roundtrip: e.node.response?.roundtripTime,
    createdAt: e.node.createdAt,
    color: requestColorName(e.node.metadata?.color),
  }));
  printJson({ results, count: results.length });
}

async function cmdGet(requestId, opts) {
  const request = await getRequest(await getClient(), requestId, !opts.noRequest, true);
  if (!request) die(`Request ${requestId} not found`);
  printJson(requestOutput(request, opts));
}

async function cmdGetResponse(requestId, opts) {
  const request = await getRequest(await getClient(), requestId, false, true);
  if (!request) die(`Request ${requestId} not found`);
  if (!request.response) {
    console.log(JSON.stringify({ error: "No response for this request" }));
    return;
  }
  printJson(responseOutput(request.response, opts));
}

async function cmdDownload(requestId, opts) {
  const source = opts.source || "response";
  const mode = opts.raw ? "raw" : "body";
  const request = await getRequest(await getClient(), requestId, source === "request", source === "response");
  if (!request) die(`Request ${requestId} not found`);

  let raw;
  let metadata;
  if (source === "request") {
    raw = request.raw;
    metadata = {
      method: request.method,
      host: request.host,
      requestPath: request.path,
    };
  } else {
    if (!request.response) die(`Request ${requestId} has no response`);
    raw = request.response.raw;
    metadata = {
      statusCode: request.response.statusCode,
      length: request.response.length,
    };
  }

  const rawBytes = rawToBuffer(raw);
  if (!rawBytes.length && mode === "raw") die(`No raw ${source} data for request ${requestId}`);
  const bytes = opts.raw ? rawBytes : splitHttpRawBytes(rawBytes).body;
  const outputPath = writeBinaryFile(opts.out, bytes, opts.force);
  printJson({
    requestId,
    source,
    mode,
    outputPath,
    bytesWritten: bytes.length,
    ...metadata,
  });
}

async function cmdExportCurl(requestId) {
  const request = await getRequest(await getClient(), requestId, true, false);
  if (!request) die(`Request ${requestId} not found`);
  const raw = decodeRaw(request.raw);
  if (!raw) die("No raw data for this request");
  console.log(rawToCurl(raw, request.host, request.port, request.isTls));
}

async function cmdReplay(requestId, rawOverride, opts, overrides, collection, sessionName) {
  const client = await getClient();
  const original = await getRequest(client, requestId, true, false);
  if (!original) die(`Request ${requestId} not found`);
  const collectionId = await resolveCollectionId(client, collection);
  const session = await createNamedReplaySession(client, { id: requestId }, collectionId, sessionName);
  const raw = rawOverride ? await resolveRaw(rawOverride) : decodeRaw(original.raw);
  if (!raw) die("No raw data for this request");
  const connection = buildConnection(original.host, original.port, original.isTls, overrides);
  const result = await sendReplay(client, session.id, raw, connection);
  printJson(buildReplayOutput(session.id, result, opts));
}

async function cmdSendRaw(host, port, tls, raw, opts, overrides, collection, sessionName) {
  const client = await getClient();
  raw = await resolveRaw(raw);
  const connection = buildConnection(host, port, tls, overrides);
  const collectionId = await resolveCollectionId(client, collection);
  const source = { raw: { connectionInfo: connection, raw: encodeRaw(raw) } };
  const session = await createNamedReplaySession(client, source, collectionId, sessionName);
  const result = await sendReplay(client, session.id, raw, connection);
  printJson(buildReplayOutput(session.id, result, opts));
}

async function cmdEdit(requestId, edits, opts, overrides, collection, sessionName) {
  const client = await getClient();
  const original = await getRequest(client, requestId, true, false);
  if (!original) die(`Request ${requestId} not found`);
  const raw = decodeRaw(original.raw);
  if (!raw) die("No raw data for this request");
  const modifiedRaw = applyRawEdits(raw, edits);
  const session = edits.sessionId
    ? { id: await resolveSessionId(client, edits.sessionId) }
    : await createNamedReplaySession(client, { id: requestId }, await resolveCollectionId(client, collection), sessionName);
  const connection = buildConnection(original.host, original.port, original.isTls, overrides);
  const result = await sendReplay(client, session.id, modifiedRaw, connection);
  printJson(buildReplayOutput(session.id, result, opts, modifiedRaw));
}

const VALUE_PLACEHOLDER = "{}";

function parseValueSpec(spec) {
  if (spec.startsWith("@")) {
    const path = resolve(spec.slice(1));
    if (!existsSync(path)) die(`Error: values file ${path} not found`);
    return readFileSync(path, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean);
  }
  const range = spec.match(/^(\d+)-(\d+)$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    // Size-check the range before expanding it: 1-1000000000 would otherwise
    // exhaust memory before reaching the cap, and endpoints past the safe
    // integer limit never terminate the loop.
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) die("Error: --values range endpoints are too large");
    if (to < from) die("Error: --values range must ascend, e.g. 1-100");
    if (to - from + 1 > MAX_BATCH_VALUES) die(`Error: --values range covers ${to - from + 1} entries, over the ${MAX_BATCH_VALUES} cap`);
    const values = [];
    for (let n = from; n <= to; n++) values.push(String(n));
    return values;
  }
  return spec.split(",").map((value) => value.trim()).filter(Boolean);
}

function substituteEdits(edits, value) {
  const sub = (text) => (typeof text === "string" ? text.split(VALUE_PLACEHOLDER).join(value) : text);
  return {
    ...edits,
    method: sub(edits.method),
    path: sub(edits.path),
    body: sub(edits.body),
    setHeaders: edits.setHeaders.map(sub),
    replacements: edits.replacements.map(sub),
  };
}

function editsContainPlaceholder(edits) {
  const fields = [edits.method, edits.path, edits.body, ...edits.setHeaders, ...edits.replacements];
  return fields.some((field) => typeof field === "string" && field.includes(VALUE_PLACEHOLDER));
}

/**
 * Send one edited request per value through a single replay session, reporting
 * a row each instead of full bodies. Stops on the first backoff signal or send
 * error rather than working through the rest of the list against a target that
 * has started refusing.
 */
async function cmdEditBatch(requestId, edits, values, opts, overrides, collection, delayMs, sessionName) {
  if (!editsContainPlaceholder(edits)) {
    die(`Error: --values needs a ${VALUE_PLACEHOLDER} placeholder in --method, --path, --body, --set-header or --replace`);
  }
  if (!values.length) die("Error: --values resolved to no values");
  if (values.length > MAX_BATCH_VALUES) die(`Error: --values holds ${values.length} entries, over the ${MAX_BATCH_VALUES} cap`);

  const client = await getClient();
  const original = await getRequest(client, requestId, true, false);
  if (!original) die(`Request ${requestId} not found`);
  const raw = decodeRaw(original.raw);
  if (!raw) die("No raw data for this request");

  const session = edits.sessionId
    ? { id: await resolveSessionId(client, edits.sessionId) }
    : await createNamedReplaySession(client, { id: requestId }, await resolveCollectionId(client, collection), sessionName);
  const connection = buildConnection(original.host, original.port, original.isTls, overrides);

  const results = [];
  let stopped;
  for (const value of values) {
    const modifiedRaw = applyRawEdits(raw, substituteEdits(edits, value));
    let result;
    try {
      result = await sendReplay(client, session.id, modifiedRaw, connection, { minIntervalMs: delayMs });
    } catch (err) {
      stopped = `send failed at "${value}": ${err.message}`;
      break;
    }
    const response = result.entry?.request?.response;
    const backoff = backoffInfo(response);
    results.push(compactUndefined({
      value,
      status: result.status,
      statusCode: response?.statusCode,
      length: response?.length,
      roundtrip: response?.roundtripTime,
      requestId: result.entry?.request?.id,
      entryId: result.entry?.id,
      error: result.error ? String(result.error.code || result.error) : undefined,
      backoff,
    }));
    // Any backoff reason ends the run: a challenge or an unavailable service is
    // as much a reason to stop sending as a 429, and the remaining values would
    // only produce more of the same wrong answer.
    if (backoff) {
      stopped = `${backoff.reason} at "${value}"`;
      break;
    }
    if (result.error) {
      stopped = `replay error at "${value}"`;
      break;
    }
  }

  printJson(compactUndefined({
    sessionId: session.id,
    requested: values.length,
    sent: results.length,
    delayMs,
    stopped,
    results,
  }));
}

function parseHeaderMap(rawText) {
  const map = new Map();
  const lines = extractHeaders(rawText).split(/\r?\n/).slice(1);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    // Repeated names (Set-Cookie) keep every value, so a dropped cookie shows up.
    map.set(name, map.has(name) ? `${map.get(name)}, ${value}` : value);
  }
  return map;
}

/** Body bytes, or an empty buffer when the message carries no separator. */
function splitBodyBytes(bytes) {
  try {
    return splitHttpRawBytes(bytes).body;
  } catch {
    return Buffer.alloc(0);
  }
}

function diffHeaders(aMap, bMap, allHeaders) {
  const onlyInA = [];
  const onlyInB = [];
  const changed = [];
  const ignored = [];
  for (const name of [...new Set([...aMap.keys(), ...bMap.keys()])].sort()) {
    const a = aMap.get(name);
    const b = bMap.get(name);
    if (a === b) continue;
    if (!allHeaders && VOLATILE_HEADERS.has(name)) {
      ignored.push(name);
    } else if (a === undefined) {
      onlyInB.push(name);
    } else if (b === undefined) {
      onlyInA.push(name);
    } else {
      changed.push({ name, a, b });
    }
  }
  return compactUndefined({
    onlyInA: onlyInA.length ? onlyInA : undefined,
    onlyInB: onlyInB.length ? onlyInB : undefined,
    changed: changed.length ? changed : undefined,
    ignored: ignored.length ? ignored : undefined,
  });
}

function truncateLine(line, maxChars) {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)}…[+${line.length - maxChars} chars]`;
}

/**
 * Minified bodies arrive as one line thousands of characters wide, where the
 * head is identical boilerplate and the difference sits in the middle. Window
 * around the first differing character instead of printing the head.
 */
function charWindow(a, b, maxChars) {
  let offset = 0;
  while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
  const from = Math.max(0, offset - Math.floor(maxChars / 2));
  const cut = (text) => {
    const head = from > 0 ? `…[${from} identical chars]` : "";
    const tail = from + maxChars < text.length ? `…[+${text.length - from - maxChars} chars]` : "";
    return `${head}${text.slice(from, from + maxChars)}${tail}`;
  };
  return { firstDiffOffset: offset, a: cut(a), b: cut(b) };
}

/**
 * Common prefix and suffix are trimmed and the differing middle reported.
 * Cheaper than a real diff and enough to answer the question the caller has:
 * did this response change, and where.
 */
function diffLines(aText, bText, maxLines, maxLineChars) {
  const a = aText.split("\n");
  const b = bText.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;

  const aDiff = a.slice(prefix, a.length - suffix);
  const bDiff = b.slice(prefix, b.length - suffix);
  const longest = Math.max(a.length, b.length);
  const identical = aDiff.length === 0 && bDiff.length === 0;

  const wide = aDiff.length === 1 && bDiff.length === 1 &&
    (aDiff[0].length > maxLineChars || bDiff[0].length > maxLineChars);
  const window = wide ? charWindow(aDiff[0], bDiff[0], maxLineChars) : undefined;

  return compactUndefined({
    identical,
    similarity: longest === 0 ? 1 : Math.round(((prefix + suffix) / longest) * 100) / 100,
    linesA: a.length,
    linesB: b.length,
    firstDiffLine: identical ? undefined : prefix + 1,
    firstDiffOffset: window?.firstDiffOffset,
    differingLinesA: aDiff.length || undefined,
    differingLinesB: bDiff.length || undefined,
    truncated: aDiff.length > maxLines || bDiff.length > maxLines || undefined,
    a: window ? [window.a] : aDiff.length ? aDiff.slice(0, maxLines).map((line) => truncateLine(line, maxLineChars)) : undefined,
    b: window ? [window.b] : bDiff.length ? bDiff.slice(0, maxLines).map((line) => truncateLine(line, maxLineChars)) : undefined,
  });
}

async function cmdCompare(idA, idB, opts) {
  const client = await getClient();
  const useRequest = opts.source === "request";
  const [a, b] = await Promise.all([
    getRequest(client, idA, useRequest, !useRequest),
    getRequest(client, idB, useRequest, !useRequest),
  ]);
  if (!a) die(`Request ${idA} not found`);
  if (!b) die(`Request ${idB} not found`);

  const summarize = (request) => compactUndefined({
    id: request.id,
    method: request.method,
    host: request.host,
    path: request.path,
    statusCode: request.response?.statusCode,
    length: request.response?.length,
    roundtrip: request.response?.roundtripTime,
  });

  const output = { comparing: useRequest ? "request" : "response", a: summarize(a), b: summarize(b) };

  if (!useRequest) {
    const codeA = a.response?.statusCode;
    const codeB = b.response?.statusCode;
    const lenA = a.response?.length;
    const lenB = b.response?.length;
    output.status = { same: codeA === codeB, a: codeA, b: codeB };
    output.length = compactUndefined({
      same: lenA === lenB,
      a: lenA,
      b: lenB,
      delta: Number.isFinite(lenA) && Number.isFinite(lenB) ? lenB - lenA : undefined,
    });
  }

  const bytesOf = (request) => {
    const raw = useRequest ? request.raw : request.response?.raw;
    return raw ? rawToBuffer(raw) : undefined;
  };
  const bytesA = bytesOf(a);
  const bytesB = bytesOf(b);
  if (bytesA === undefined || bytesB === undefined) {
    output.error = `No ${useRequest ? "request" : "response"} raw data for ${bytesA === undefined ? idA : idB}`;
    printJson(compactUndefined(output));
    return;
  }

  const rawA = bytesA.toString("utf-8");
  const rawB = bytesB.toString("utf-8");
  output.headers = diffHeaders(parseHeaderMap(rawA), parseHeaderMap(rawB), opts.allHeaders);

  // Body comparison is decided on bytes, then described in text. Decoding first
  // would turn every invalid byte into U+FFFD and report two different binary
  // bodies as identical.
  const bodyBytesA = splitBodyBytes(bytesA);
  const bodyBytesB = splitBodyBytes(bytesB);
  const byteIdentical = bodyBytesA.equals(bodyBytesB);
  const capped = bodyBytesA.length > opts.maxBytes || bodyBytesB.length > opts.maxBytes;

  output.body = diffLines(
    bodyBytesA.subarray(0, opts.maxBytes).toString("utf-8"),
    bodyBytesB.subarray(0, opts.maxBytes).toString("utf-8"),
    opts.maxDiffLines,
    opts.maxLineChars,
  );
  output.body.bytesA = bodyBytesA.length;
  output.body.bytesB = bodyBytesB.length;
  if (capped) output.body.comparedBytes = opts.maxBytes;
  if (output.body.identical && !byteIdentical && !capped) {
    // Same text, different bytes: the difference is outside what UTF-8 decoding preserves.
    output.body.identical = false;
    output.body.binaryOnlyDifference = true;
  }

  printJson(compactUndefined(output));
}

/**
 * Write one request's evidence as files a report can reference: the raw bytes
 * of both sides, a runnable curl, and a manifest.
 */
async function cmdEvidence(requestIdArg, opts) {
  const client = await getClient();
  let requestId = requestIdArg;
  let findingId;

  if (opts.finding) {
    const finding = (await client.graphql(FINDING_QUERY, { id: opts.finding })).finding;
    if (!finding) die(`Finding ${opts.finding} not found`);
    if (!finding.request?.id) die(`Finding ${opts.finding} has no linked request`);
    findingId = finding.id;
    requestId = finding.request.id;
  }
  if (!requestId) die("Error: request-id or --finding <id> required");

  const request = await getRequest(client, requestId, true, true);
  if (!request) die(`Request ${requestId} not found`);

  const dir = resolve(opts.out);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Everything this bundle will contain, built before anything is written: a
  // conflict on the third file must not leave the first two on disk.
  const planned = [];
  const requestBytes = rawToBuffer(request.raw);
  if (requestBytes.length) planned.push({ name: "request.http", data: requestBytes });
  const responseBytes = rawToBuffer(request.response?.raw);
  if (responseBytes.length) planned.push({ name: "response.http", data: responseBytes });
  const rawText = decodeRaw(request.raw);
  if (rawText) {
    planned.push({
      name: "curl.sh",
      data: Buffer.from(`#!/bin/sh\n${rawToCurl(rawText, request.host, request.port, request.isTls)}\n`, "utf-8"),
    });
  }

  const meta = compactUndefined({
    requestId: request.id,
    findingId,
    method: request.method,
    host: request.host,
    port: request.port,
    isTls: request.isTls,
    path: request.path,
    query: request.query || undefined,
    createdAt: request.createdAt,
    statusCode: request.response?.statusCode,
    responseLength: request.response?.length,
    roundtrip: request.response?.roundtripTime,
    files: [...planned.map((file) => file.name), "meta.json"],
    // request.http and response.http are the bytes Caido stored; curl.sh is a
    // reconstruction and is not byte-exact for bodies.
    authoritative: ["request.http", "response.http"],
  });
  planned.push({ name: "meta.json", data: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf-8") });

  for (const file of planned) assertWritableTarget(join(dir, file.name), opts.force);

  const files = planned.map((file) => ({
    name: file.name,
    // 0600: these carry session cookies and authorization headers, and the
    // caller may have pointed --out at a directory others can read.
    path: writeBinaryFile(join(dir, file.name), file.data, opts.force, 0o600),
    bytes: file.data.length,
  }));

  printJson(compactUndefined({ requestId: request.id, findingId, outputDir: dir, files }));
}

async function cmdStreams(limit, scope, filter) {
  const client = await getClient();
  const scopeId = scope ? await resolveScopeId(client, scope) : undefined;
  const data = await client.graphql(STREAMS_QUERY, { first: limit, scopeId, filter: filter ? { code: filter } : undefined });
  const results = data.streams.edges.map((e) => compactUndefined({
    id: e.node.id,
    protocol: e.node.protocol,
    host: e.node.host,
    port: e.node.port,
    path: e.node.path,
    isTls: e.node.isTls,
    direction: e.node.direction,
    source: e.node.source,
    createdAt: e.node.createdAt,
    cursor: e.cursor,
  }));
  printJson({ results, pageInfo: data.streams.pageInfo, count: results.length });
}

async function cmdStreamMessages(streamId, limit, includeRaw, filter, opts) {
  const client = await getClient();
  const data = await client.graphql(STREAM_MESSAGES_QUERY, {
    streamId,
    first: limit,
    includeRaw,
    filter: filter ? { code: filter } : undefined,
  });
  const results = data.streamWsMessages.edges.map((e) => {
    const head = e.node.head || {};
    const row = compactUndefined({
      id: e.node.id,
      direction: head.direction,
      format: head.format,
      length: head.length,
      createdAt: head.createdAt,
      ...alterationFields(head),
      cursor: e.cursor,
    });
    if (includeRaw && head.raw) {
      const bytes = rawToBuffer(head.raw);
      // Binary frames are not text; say so rather than printing mojibake.
      row.raw = head.format === "BINARY"
        ? `[${bytes.length} binary bytes]`
        : truncateBody(bytes.toString("utf-8"), opts.maxBodyLines, opts.maxBodyChars);
    }
    return row;
  });
  printJson({ streamId, results, pageInfo: data.streamWsMessages.pageInfo, count: results.length });
}

/**
 * Caido's own deduplicated view of what has been seen on a host, which is the
 * coverage question ("which paths do I know here") answered without paging
 * through history and deduplicating by hand.
 */
async function cmdSitemap(target, opts) {
  const client = await getClient();
  const scopeId = opts.scope ? await resolveScopeId(client, opts.scope) : undefined;
  const roots = (await client.graphql(SITEMAP_ROOTS_QUERY, { scopeId })).sitemapRootEntries.edges.map((e) => e.node);

  if (!target) {
    const listed = roots.slice(0, opts.limit);
    printJson(compactUndefined({
      roots: listed.map((r) => compactUndefined({ id: r.id, label: r.label, kind: r.kind, hasDescendants: r.hasDescendants || undefined })),
      count: listed.length,
      total: roots.length,
      truncated: roots.length > listed.length || undefined,
    }));
    return;
  }

  const root = roots.find((r) => r.id === target) || roots.find((r) => r.label === target);
  if (!root) die(`No sitemap root matching "${target}". Run: caido-client.mjs sitemap`);

  const depth = opts.all ? "ALL" : "DIRECT";
  const nodes = (await client.graphql(SITEMAP_DESCENDANTS_QUERY, { parentId: root.id, depth })).sitemapDescendantEntries.edges.map((e) => e.node);

  // Entries come back flat. Where a node has a request, that request's own path
  // is authoritative — reconstructing from labels loses the distinction between
  // /admin and /admin/, which are two different entries here. Only directories,
  // which have no request, are rebuilt from the parent chain.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const directoryPath = (node) => {
    const parts = [];
    let current = node;
    while (current && current.id !== root.id) {
      if (current.label) parts.unshift(current.label);
      current = byId.get(current.parentId);
    }
    return `/${parts.join("/")}/`;
  };

  const entries = nodes
    .map((n) => compactUndefined({
      path: n.request?.path ?? directoryPath(n),
      query: n.request?.query || undefined,
      kind: n.kind,
      method: n.request?.method,
      requestId: n.request?.id,
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || (a.query || "").localeCompare(b.query || ""));
  const listed = entries.slice(0, opts.limit);

  printJson(compactUndefined({
    root: { id: root.id, label: root.label },
    depth,
    entries: listed,
    count: listed.length,
    total: entries.length,
    truncated: entries.length > listed.length || undefined,
  }));
}

// CLI name -> the @oneOf key in TamperSectionInput. Header sections take
// add/update/remove as well as raw; everything else is raw only.
const TAMPER_SECTIONS = {
  "request-method": { key: "requestMethod" },
  "request-path": { key: "requestPath" },
  "request-query": { key: "requestQuery" },
  "request-body": { key: "requestBody" },
  "request-first-line": { key: "requestFirstLine" },
  "request-header": { key: "requestHeader", header: true },
  "request-all": { key: "requestAll" },
  "request-sni": { key: "requestSNI" },
  "response-header": { key: "responseHeader", header: true },
  "response-body": { key: "responseBody" },
  "response-status-code": { key: "responseStatusCode" },
  "response-first-line": { key: "responseFirstLine" },
  "response-all": { key: "responseAll" },
  "ws-upstream": { key: "streamWsMessageUpstream", stream: true },
  "ws-downstream": { key: "streamWsMessageDownstream", stream: true },
};

const TAMPER_SOURCES = ["AUTOMATE", "IMPORT", "INTERCEPT", "PLUGIN", "REPLAY", "SAMPLE", "WORKFLOW"];

/**
 * Turns the flags into the section input Caido expects. Kept strict rather than
 * permissive: a rule that silently rewrites something other than what was asked
 * for is the failure this whole area exists to prevent.
 */
function buildTamperSection(sectionName, op, matcher, replaceTerm) {
  const section = TAMPER_SECTIONS[sectionName];
  if (!section) die(`Error: unknown --section "${sectionName}". One of: ${Object.keys(TAMPER_SECTIONS).join(", ")}`);
  if (!section.header && op !== "raw") {
    die(`Error: --op ${op} is only available on request-header and response-header; ${sectionName} takes raw`);
  }

  let operation;
  if (op === "remove") {
    if (!matcher?.name) die("Error: --op remove needs --match-name <header>");
    operation = { remove: { matcher: { name: matcher.name } } };
  } else if (op === "add" || op === "update") {
    if (!matcher?.name) die(`Error: --op ${op} needs --match-name <header>`);
    if (replaceTerm === undefined) die(`Error: --op ${op} needs --replace <value>`);
    operation = { [op]: { matcher: { name: matcher.name }, replacer: { term: { term: replaceTerm } } } };
  } else {
    if (!matcher || matcher.name) die("Error: raw operations need --match, --match-regex or --match-full");
    if (replaceTerm === undefined) die("Error: raw operations need --replace <value>");
    operation = { raw: { matcher: matcher.raw, replacer: { term: { term: replaceTerm } } } };
  }

  return { input: { [section.key]: { operation } }, isStream: !!section.stream };
}

function parseTamperSources(value) {
  const sources = value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const source of sources) {
    if (!TAMPER_SOURCES.includes(source)) die(`Error: unknown source "${source}". One of: ${TAMPER_SOURCES.join(", ").toLowerCase()}`);
  }
  return sources;
}

function tamperRuleOutput(rule) {
  if (!rule) return undefined;
  return compactUndefined({
    id: rule.id,
    name: rule.name,
    enabled: !!rule.enable,
    sources: rule.sources,
    section: humanTamperName(rule.section?.__typename, "TamperSection"),
    condition: rule.condition?.code || undefined,
    collection: rule.collection ? { id: rule.collection.id, name: rule.collection.name } : undefined,
  });
}

async function cmdCreateRule(name, opts) {
  const client = await getClient();
  const { input: section, isStream } = buildTamperSection(opts.section, opts.op, opts.matcher, opts.replace);
  const collectionId = opts.collection || (await firstTamperCollectionId(client));
  const input = compactUndefined({
    collectionId,
    name,
    section,
    sources: opts.sources,
    condition: opts.condition ? (isStream ? { streamQL: { code: opts.condition } } : { HTTPQL: { code: opts.condition } }) : undefined,
  });
  const data = await client.graphql(CREATE_TAMPER_RULE, { input });
  const rule = requirePayload(data.createTamperRule, "rule", "createTamperRule");
  printJson({
    created: tamperRuleOutput(rule),
    note: "New rules start disabled. Enable with: toggle-rule <id> --on",
  });
}

async function firstTamperCollectionId(client) {
  const collections = (await client.graphql(TAMPER_RULES_QUERY, {})).tamperRuleCollections || [];
  if (!collections.length) die("Error: no rule collection exists. Create one: create-rule-collection <name>");
  return collections[0].id;
}

async function cmdUpdateRule(id, opts) {
  const client = await getClient();
  const existing = (await client.graphql(TAMPER_RULE_QUERY, { id })).tamperRule;
  if (!existing) die(`Rule ${id} not found`);
  const { input: section, isStream } = buildTamperSection(opts.section, opts.op, opts.matcher, opts.replace);
  // Name and sources are required by the schema, so anything not passed keeps
  // its current value rather than being silently reset.
  const condition = opts.condition ?? existing.condition?.code;
  const input = compactUndefined({
    name: opts.name ?? existing.name,
    section,
    sources: opts.sources ?? existing.sources,
    condition: condition ? (isStream ? { streamQL: { code: condition } } : { HTTPQL: { code: condition } }) : undefined,
  });
  const data = await client.graphql(UPDATE_TAMPER_RULE, { id, input });
  printJson({ updated: tamperRuleOutput(requirePayload(data.updateTamperRule, "rule", "updateTamperRule")) });
}

async function cmdToggleRule(id, enabled) {
  const data = await (await getClient()).graphql(TOGGLE_TAMPER_RULE, { id, enabled });
  printJson({ toggled: tamperRuleOutput(requirePayload(data.toggleTamperRule, "rule", "toggleTamperRule")) });
}

async function cmdRenameRule(id, name) {
  const data = await (await getClient()).graphql(RENAME_TAMPER_RULE, { id, name });
  printJson({ renamed: tamperRuleOutput(data.renameTamperRule?.rule) });
}

async function cmdMoveRule(id, collectionId) {
  const data = await (await getClient()).graphql(MOVE_TAMPER_RULE, { id, collectionId });
  printJson({ moved: tamperRuleOutput(data.moveTamperRule?.rule) });
}

async function cmdDeleteRule(id) {
  const client = await getClient();
  const existing = (await client.graphql(TAMPER_RULE_QUERY, { id })).tamperRule;
  if (!existing) die(`Rule ${id} not found`);
  const data = await client.graphql(DELETE_TAMPER_RULE, { id });
  // Echo what was removed: a deleted rewrite is as much a change to traffic as
  // an added one, and nothing else will remember it.
  printJson({ deleted: data.deleteTamperRule?.deletedId || id, was: tamperRuleOutput(existing) });
}

async function cmdCreateRuleCollection(name) {
  const data = await (await getClient()).graphql(CREATE_TAMPER_COLLECTION, { input: { name } });
  const collection = requirePayload(data.createTamperRuleCollection, "collection", "createTamperRuleCollection");
  printJson({ id: collection.id, name: collection.name });
}

async function cmdRenameRuleCollection(id, name) {
  const data = await (await getClient()).graphql(RENAME_TAMPER_COLLECTION, { id, name });
  const collection = requirePayload(data.renameTamperRuleCollection, "collection", "renameTamperRuleCollection");
  printJson({ id: collection.id, name: collection.name, renamed: true });
}

async function cmdDeleteRuleCollection(id) {
  const data = await (await getClient()).graphql(DELETE_TAMPER_COLLECTION, { id });
  printJson({ deleted: data.deleteTamperRuleCollection?.deletedId || id });
}

function humanTamperName(typename, prefix) {
  return String(typename || "")
    .replace(prefix, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase() || undefined;
}

function tamperMatcher(matcher) {
  if (!matcher) return undefined;
  if (matcher.name !== undefined) return { name: matcher.name };
  if (matcher.value !== undefined) return { value: matcher.value };
  if (matcher.regex !== undefined) return { regex: matcher.regex };
  if (matcher.full !== undefined) return { full: matcher.full };
  return { kind: matcher.__typename };
}

function tamperReplacer(replacer) {
  if (!replacer) return undefined;
  if (replacer.term !== undefined) return { term: replacer.term };
  if (replacer.__typename === "TamperReplacerWorkflow") return { workflowId: replacer.id };
  return { kind: replacer.__typename };
}

/**
 * Lists Caido's match-and-replace rules. Read-only and deliberately literal:
 * what a rule does to traffic is the caller's conclusion, not this command's.
 * An empty list is a useful answer too - it rules the explanation out.
 */
async function cmdRules() {
  const data = await (await getClient()).graphql(TAMPER_RULES_QUERY, {});
  let total = 0;
  let enabled = 0;

  const collections = (data.tamperRuleCollections || []).map((collection) => ({
    id: collection.id,
    name: collection.name,
    rules: (collection.rules || []).map((rule) => {
      total++;
      // A rank is what Caido stores for an active rule; null means switched off.
      const isEnabled = !!rule.enable;
      if (isEnabled) enabled++;
      const operation = rule.section?.operation;
      return compactUndefined({
        id: rule.id,
        name: rule.name,
        enabled: isEnabled,
        sources: rule.sources,
        section: humanTamperName(rule.section?.__typename, "TamperSection"),
        condition: rule.condition?.code || undefined,
        operation: operation ? humanTamperName(operation.__typename, /^TamperOperation(Header|Body)/) : undefined,
        matcher: tamperMatcher(operation?.matcher),
        replacer: tamperReplacer(operation?.replacer),
      });
    }),
  }));

  printJson({
    collections,
    total,
    enabled,
    note: enabled
      ? "Enabled rules rewrite traffic before it reaches the target or you. Requests they touched carry alteration: TAMPER."
      : "No enabled rules; traffic is not being rewritten by match-and-replace.",
  });
}

async function cmdGetSession(sessionIdOrName, opts) {
  const client = await getClient();
  const session = await resolveSession(client, sessionIdOrName);
  if (!session) die(`Replay session "${sessionIdOrName}" not found`);
  const output = sessionOutput(session);
  if (session.activeEntry?.id) {
    const entry = await getReplayEntry(client, session.activeEntry.id, true, true, true);
    if (entry) output.activeEntry = formatReplayEntry(entry, opts, true);
  }
  printJson(output);
}

async function cmdReplayEntries(sessionIdOrName, limit, opts, includeRaw) {
  const client = await getClient();
  const session = await resolveSession(client, sessionIdOrName);
  if (!session) die(`Replay session "${sessionIdOrName}" not found`);
  const version = await client.getServerVersion();
  const query = versionGte(version, CAIDO_V057) ? REPLAY_SESSION_ENTRIES_QUERY_V057 : REPLAY_SESSION_ENTRIES_QUERY;
  const data = await client.graphql(query, {
    id: session.id,
    first: limit,
    includeReplayRaw: includeRaw,
    includeRequestRaw: includeRaw,
    includeResponseRaw: includeRaw,
  });
  const results = data.replaySession.entries.edges.map((e) => formatReplayEntry(e.node, opts, includeRaw));
  printJson({
    sessionId: session.id,
    sessionName: session.name,
    activeEntryId: session.activeEntry?.id,
    results,
    count: results.length,
  });
}

async function cmdEditSession(sessionIdOrName, edits, opts, overrides) {
  const client = await getClient();
  const session = await resolveSession(client, sessionIdOrName);
  if (!session) die(`Replay session "${sessionIdOrName}" not found`);
  if (!session.activeEntry?.id) die(`Session ${session.id} has no active entry`);
  const entry = await getReplayEntry(client, session.activeEntry.id, true, true, true);
  if (!entry?.raw) die(`Could not get raw data for active entry ${session.activeEntry.id}`);
  const raw = decodeRaw(entry.raw);
  if (!raw) die("No raw data for the active entry");
  const modifiedRaw = applyRawEdits(raw, edits);
  const connection = buildConnection(entry.connection.host, entry.connection.port, entry.connection.isTLS, overrides);
  const result = await sendReplay(client, session.id, modifiedRaw, connection);
  printJson(buildReplayOutput(session.id, result, opts, modifiedRaw));
}

async function cmdReplaySessions(limit) {
  const client = await getClient();
  const version = await client.getServerVersion();
  const query = versionGte(version, CAIDO_V057) ? REPLAY_SESSIONS_QUERY_V057 : REPLAY_SESSIONS_QUERY;
  const data = await client.graphql(query, { first: limit });
  const results = data.replaySessions.edges.map((e) => sessionOutput(e.node));
  printJson({ results, count: results.length });
}

async function cmdCreateSession(requestId, collection, sessionName) {
  const client = await getClient();
  const collectionId = await resolveCollectionId(client, collection);
  const session = await createNamedReplaySession(client, { id: requestId }, collectionId, sessionName);
  printJson(sessionOutput(session));
}

async function cmdRenameSession(sessionIdOrName, name) {
  const client = await getClient();
  const session = await renameReplaySession(client, await resolveSessionId(client, sessionIdOrName), name);
  printJson({ ...sessionOutput(session), renamed: true });
}

async function cmdMoveSession(sessionIdOrName, collection) {
  const client = await getClient();
  const sessionId = await resolveSessionId(client, sessionIdOrName);
  const collectionId = await resolveCollectionId(client, collection);
  const version = await client.getServerVersion();
  const mutation = versionGte(version, CAIDO_V057) ? MOVE_REPLAY_SESSION_V057 : MOVE_REPLAY_SESSION;
  const data = await client.graphql(mutation, { id: sessionId, collectionId });
  const session = requirePayload(data.moveReplaySession, "session", "moveReplaySession");
  printJson({ ...sessionOutput(session), moved: true });
}

async function cmdDeleteSessions(idsOrNames) {
  const client = await getClient();
  const ids = [];
  for (const one of idsOrNames) ids.push(await resolveSessionId(client, one));
  const data = await client.graphql(DELETE_REPLAY_SESSIONS, { ids });
  printJson({ deleted: data.deleteReplaySessions.deletedIds || ids });
}

async function cmdReplayCollections(limit) {
  const data = await (await getClient()).graphql(REPLAY_COLLECTIONS_QUERY, { first: limit });
  const results = data.replaySessionCollections.edges.map((e) => ({ id: e.node.id, name: e.node.name }));
  printJson({ results, count: results.length });
}

async function cmdCreateCollection(name) {
  const data = await (await getClient()).graphql(CREATE_REPLAY_COLLECTION, { input: { name } });
  const collection = requirePayload(data.createReplaySessionCollection, "collection", "createReplaySessionCollection");
  printJson({ id: collection.id, name: collection.name });
}

async function cmdRenameCollection(collectionIdOrName, name) {
  const client = await getClient();
  const id = await resolveCollectionId(client, collectionIdOrName);
  const data = await client.graphql(RENAME_REPLAY_COLLECTION, { id, name });
  const collection = requirePayload(data.renameReplaySessionCollection, "collection", "renameReplaySessionCollection");
  printJson({ id: collection.id, name: collection.name, renamed: true });
}

async function cmdDeleteCollection(collectionIdOrName) {
  const client = await getClient();
  const id = await resolveCollectionId(client, collectionIdOrName);
  await client.graphql(DELETE_REPLAY_COLLECTION, { id });
  printJson({ deleted: id });
}

async function cmdCreateAutomateSession(requestId) {
  const data = await (await getClient()).graphql(CREATE_AUTOMATE_SESSION, { input: { requestSource: { id: requestId } } });
  printJson(data.createAutomateSession.session);
}

async function cmdFuzz(sessionId) {
  const client = await getClient();
  const check = await client.graphql(GET_AUTOMATE_SESSION, { id: sessionId });
  if (!check.automateSession) die(`Automate session ${sessionId} not found`);
  printJson({
    note: "Starting automate task with existing session settings. Configure payloads in Caido UI.",
    sessionId,
  });
  const startResult = await client.graphql(START_AUTOMATE_TASK, { automateSessionId: sessionId });
  const task = startResult.startAutomateTask.automateTask;
  printJson({ sessionId, taskId: task.id, status: "started" });
}

async function cmdFindings(limit) {
  const data = await (await getClient()).graphql(FINDINGS_QUERY, { first: limit });
  const results = data.findings.edges.map((e) => ({
    id: e.node.id,
    title: e.node.title,
    reporter: e.node.reporter,
    host: e.node.host,
    path: e.node.path,
    hidden: e.node.hidden,
    dedupeKey: e.node.dedupeKey,
    createdAt: e.node.createdAt,
  }));
  printJson({ results, count: results.length });
}

async function cmdGetFinding(findingId) {
  const data = await (await getClient()).graphql(FINDING_QUERY, { id: findingId });
  if (!data.finding) die(`Finding ${findingId} not found`);
  printJson(data.finding);
}

/**
 * Both fields of the input are optional, so an empty one asks the server to
 * delete on no criteria at all. That is the case worth refusing, not `reporter`
 * itself: this client stamps every finding it files with `caido-mode`, which
 * makes `--reporter caido-mode` the precise "undo what the agent filed" and
 * leaves Caido's own scanner findings alone.
 */
async function cmdDeleteFindings(ids, reporter) {
  if (!ids?.length && !reporter) die("Error: delete-findings needs <id,id,...> or --reporter <name>");
  const data = await (await getClient()).graphql(DELETE_FINDINGS, {
    input: compactUndefined({ ids: ids?.length ? ids : undefined, reporter }),
  });
  printJson({ deleted: data.deleteFindings?.deletedIds || ids || [] });
}

async function cmdCreateFinding(requestId, title, description, reporter, dedupeKey) {
  const data = await (await getClient()).graphql(CREATE_FINDING, {
    requestId,
    input: { title, reporter: reporter || "caido-mode", description, dedupeKey },
  });
  printJson(requirePayload(data.createFinding, "finding", "createFinding"));
}

async function cmdUpdateFinding(findingId, title, description, hidden) {
  const client = await getClient();
  const existing = (await client.graphql(FINDING_QUERY, { id: findingId })).finding;
  if (!existing) die(`Finding ${findingId} not found`);
  const data = await client.graphql(UPDATE_FINDING, {
    id: findingId,
    input: {
      title: title ?? existing.title,
      description: description ?? existing.description ?? "",
      hidden: hidden ?? existing.hidden,
    },
  });
  printJson(requirePayload(data.updateFinding, "finding", "updateFinding"));
}

async function cmdScopes() {
  printJson((await (await getClient()).graphql(SCOPES_QUERY)).scopes);
}

async function cmdCreateScope(name, allow, deny) {
  const data = await (await getClient()).graphql(CREATE_SCOPE, { input: { name, allowlist: allow, denylist: deny } });
  printJson(requirePayload(data.createScope, "scope", "createScope"));
}

async function cmdUpdateScope(scopeId, name, allow, deny) {
  const client = await getClient();
  const existing = (await client.graphql(SCOPE_QUERY, { id: scopeId })).scope;
  if (!existing) die(`Scope ${scopeId} not found`);
  const data = await client.graphql(UPDATE_SCOPE, {
    id: scopeId,
    input: {
      name: name ?? existing.name,
      allowlist: allow ?? existing.allowlist,
      denylist: deny ?? existing.denylist,
    },
  });
  printJson(requirePayload(data.updateScope, "scope", "updateScope"));
}

async function cmdDeleteScope(scopeId) {
  await (await getClient()).graphql(DELETE_SCOPE, { id: scopeId });
  printJson({ deleted: scopeId });
}

function filterClause(code) {
  return { HTTPQL: { code } };
}

async function cmdFilters() {
  printJson((await (await getClient()).graphql(FILTERS_QUERY)).filterPresets);
}

async function cmdCreateFilter(name, query, alias) {
  const data = await (await getClient()).graphql(CREATE_FILTER, { input: { name, clause: filterClause(query), alias } });
  printJson(requirePayload(data.createFilterPreset, "filter", "createFilterPreset"));
}

async function cmdUpdateFilter(filterId, name, query, alias) {
  const client = await getClient();
  const existing = (await client.graphql(FILTER_QUERY, { id: filterId })).filterPreset;
  if (!existing) die(`Filter ${filterId} not found`);
  const data = await client.graphql(UPDATE_FILTER, {
    id: filterId,
    input: {
      name: name ?? existing.name,
      clause: filterClause(query ?? existing.clause?.code ?? ""),
      alias: alias ?? existing.alias,
    },
  });
  printJson(requirePayload(data.updateFilterPreset, "filter", "updateFilterPreset"));
}

async function cmdDeleteFilter(filterId) {
  await (await getClient()).graphql(DELETE_FILTER, { id: filterId });
  printJson({ deleted: filterId });
}

async function cmdEnvs() {
  printJson((await (await getClient()).graphql(ENVS_QUERY)).environments);
}

async function cmdCreateEnv(name) {
  const data = await (await getClient()).graphql(CREATE_ENV, { input: { name, variables: [] } });
  const env = requirePayload(data.createEnvironment, "environment", "createEnvironment");
  printJson({ id: env.id, name: env.name });
}

async function cmdSelectEnv(envId) {
  const data = await (await getClient()).graphql(SELECT_ENV, { id: envId });
  const err = firstPayloadError(data.selectEnvironment);
  if (err) throw new Error(`selectEnvironment failed: ${err}`);
  printJson({ selected: data.selectEnvironment.environment?.id || null });
}

async function cmdEnvSet(envId, varName, value) {
  const client = await getClient();
  const env = (await client.graphql(ENV_QUERY, { id: envId })).environment;
  if (!env) die(`Environment ${envId} not found`);
  const existing = env.variables.find((v) => v.name === varName);
  const variables = existing
    ? env.variables.map((v) => v.name === varName ? { ...v, value } : v)
    : [...env.variables, { name: varName, value, kind: "PLAIN" }];
  const data = await client.graphql(UPDATE_ENV, {
    id: envId,
    input: { name: env.name, variables, version: env.version },
  });
  requirePayload(data.updateEnvironment, "environment", "updateEnvironment");
  printJson({ envId, variable: varName, value, action: existing ? "updated" : "created" });
}

async function cmdDeleteEnv(envId) {
  const data = await (await getClient()).graphql(DELETE_ENV, { id: envId });
  const err = firstPayloadError(data.deleteEnvironment);
  if (err) throw new Error(`deleteEnvironment failed: ${err}`);
  printJson({ deleted: envId });
}

async function cmdProjects() {
  printJson((await (await getClient()).graphql(PROJECTS_QUERY)).projects);
}

async function cmdSelectProject(idOrName) {
  const client = await getClient();
  const id = await resolveProjectId(client, idOrName);
  const data = await client.graphql(SELECT_PROJECT, { id });
  const err = firstPayloadError(data.selectProject);
  if (err) throw new Error(`selectProject failed: ${err}`);
  printJson({ selected: id });
}

async function cmdHostedFiles() {
  printJson((await (await getClient()).graphql(HOSTED_FILES_QUERY)).hostedFiles);
}

/**
 * A DNS rewrite resolves a hostname to somewhere of your choosing before the
 * request leaves, so the Host header, SNI and certificate all stay honest. That
 * is the difference from --connect-host, which only redirects this client's own
 * sends: a rewrite also moves the browser's traffic.
 */
async function cmdDnsRewrites() {
  printJson((await (await getClient()).graphql(DNS_REWRITES_QUERY)).dnsRewrites);
}

async function cmdDnsUpstreams() {
  printJson((await (await getClient()).graphql(DNS_UPSTREAMS_QUERY)).dnsUpstreams);
}

/** Accepts an upstream resolver's id or its name. */
async function resolveUpstreamId(client, idOrName) {
  const list = (await client.graphql(DNS_UPSTREAMS_QUERY)).dnsUpstreams || [];
  const match = list.find((u) => u.id === idOrName) || list.find((u) => u.name === idOrName);
  if (!match) die(`DNS upstream "${idOrName}" not found. Run: caido-client.mjs dns-upstreams`);
  return match.id;
}

async function buildDnsResolution(client, ip, upstream) {
  if (ip && upstream) die("Error: --ip and --upstream are alternatives, not both");
  if (ip) return { ip: { ip } };
  if (upstream) return { upstream: { id: await resolveUpstreamId(client, upstream) } };
  return undefined;
}

async function cmdCreateDnsRewrite(allow, deny, ip, upstream) {
  const client = await getClient();
  const resolution = await buildDnsResolution(client, ip, upstream);
  if (!resolution) die("Error: one of --ip <address> or --upstream <id-or-name> is required");
  if (!allow?.length) die("Error: --allow <host,host> is required; a rewrite with no allowlist matches nothing");
  const data = await client.graphql(CREATE_DNS_REWRITE, {
    input: { resolution, allowlist: allow, denylist: deny || [] },
  });
  printJson(requirePayload(data.createDnsRewrite, "rewrite", "createDnsRewrite"));
}

/**
 * Every field of the update input is required, so a partial edit has to read the
 * rewrite first. Sending only --ip would otherwise clear the allowlist and leave
 * a rewrite that matches nothing.
 */
async function cmdUpdateDnsRewrite(rewriteId, allow, deny, ip, upstream) {
  const client = await getClient();
  const existing = ((await client.graphql(DNS_REWRITES_QUERY)).dnsRewrites || []).find((r) => r.id === rewriteId);
  if (!existing) die(`DNS rewrite ${rewriteId} not found. Run: caido-client.mjs dns-rewrites`);
  const resolution = (await buildDnsResolution(client, ip, upstream)) ?? (
    existing.resolution.__typename === "DNSIpResolver"
      ? { ip: { ip: existing.resolution.ip } }
      : { upstream: { id: existing.resolution.id } }
  );
  const data = await client.graphql(UPDATE_DNS_REWRITE, {
    id: rewriteId,
    input: { resolution, allowlist: allow ?? existing.allowlist, denylist: deny ?? existing.denylist },
  });
  printJson(requirePayload(data.updateDnsRewrite, "rewrite", "updateDnsRewrite"));
}

async function cmdToggleDnsRewrite(rewriteId, enabled) {
  const data = await (await getClient()).graphql(TOGGLE_DNS_REWRITE, { id: rewriteId, enabled });
  printJson(requirePayload(data.toggleDnsRewrite, "rewrite", "toggleDnsRewrite"));
}

async function cmdDeleteDnsRewrite(rewriteId) {
  await (await getClient()).graphql(DELETE_DNS_REWRITE, { id: rewriteId });
  printJson({ deleted: rewriteId });
}

async function cmdCreateDnsUpstream(name, ip) {
  const data = await (await getClient()).graphql(CREATE_DNS_UPSTREAM, { input: { name, ip } });
  printJson(requirePayload(data.createDnsUpstream, "upstream", "createDnsUpstream"));
}

async function cmdUpdateDnsUpstream(idOrName, name, ip) {
  const client = await getClient();
  const list = (await client.graphql(DNS_UPSTREAMS_QUERY)).dnsUpstreams || [];
  const existing = list.find((u) => u.id === idOrName) || list.find((u) => u.name === idOrName);
  if (!existing) die(`DNS upstream "${idOrName}" not found. Run: caido-client.mjs dns-upstreams`);
  const data = await client.graphql(UPDATE_DNS_UPSTREAM, {
    id: existing.id,
    input: { name: name ?? existing.name, ip: ip ?? existing.ip },
  });
  printJson(requirePayload(data.updateDnsUpstream, "upstream", "updateDnsUpstream"));
}

async function cmdDeleteDnsUpstream(idOrName) {
  const client = await getClient();
  const id = await resolveUpstreamId(client, idOrName);
  await client.graphql(DELETE_DNS_UPSTREAM, { id });
  printJson({ deleted: id });
}

/** Accepts a project's id or its name. */
async function resolveProjectId(client, idOrName) {
  const list = (await client.graphql(PROJECTS_QUERY)).projects || [];
  const match = list.find((p) => p.id === idOrName) || list.find((p) => p.name === idOrName);
  if (!match) die(`Project "${idOrName}" not found. Run: caido-client.mjs projects`);
  return match.id;
}

/**
 * A temporary project is discarded when Caido restarts, which is right for a
 * throwaway look and wrong for an engagement, so the flag is explicit rather
 * than a default either way. `persist-project` promotes one afterwards.
 */
async function cmdCreateProject(name, temporary) {
  const data = await (await getClient()).graphql(CREATE_PROJECT, { input: { name, temporary } });
  printJson(requirePayload(data.createProject, "project", "createProject"));
}

async function cmdRenameProject(idOrName, name) {
  const client = await getClient();
  const data = await client.graphql(RENAME_PROJECT, { id: await resolveProjectId(client, idOrName), name });
  printJson({ ...requirePayload(data.renameProject, "project", "renameProject"), renamed: true });
}

async function cmdPersistProject(idOrName) {
  const client = await getClient();
  const data = await client.graphql(PERSIST_PROJECT, { id: await resolveProjectId(client, idOrName) });
  printJson({ ...requirePayload(data.persistProject, "project", "persistProject"), persisted: true });
}

async function cmdDeleteProject(idOrName) {
  const client = await getClient();
  const id = await resolveProjectId(client, idOrName);
  const current = (await client.graphql(CURRENT_PROJECT_QUERY)).currentProject?.project;
  if (current?.id === id) die(`Project ${id} is the selected one. Select another first: caido-client.mjs select-project <id>`);
  const data = await client.graphql(DELETE_PROJECT, { id });
  const err = firstPayloadError(data.deleteProject);
  if (err) die(`deleteProject failed: ${err}`);
  printJson({ deleted: data.deleteProject?.deletedId || id });
}

async function cmdUploadHostedFile(filePath, name) {
  const path = resolve(filePath);
  if (!existsSync(path)) die(`File ${path} not found`);
  const client = await getClient();
  const data = await client.graphqlUpload(UPLOAD_HOSTED_FILE, { input: { name: name || basename(path), file: null } }, path);
  const file = requirePayload(data.uploadHostedFile, "hostedFile", "uploadHostedFile");
  printJson({ ...file, uploaded: true });
}

/**
 * A WebSocket replay session is opened from the HTTP upgrade request that
 * started the stream, then a task holds the socket open. The task id is what
 * every later send needs, so it is the thing this prints.
 */
async function cmdWsConnect(requestId, collection, sessionName) {
  const client = await getClient();
  const collectionId = await resolveCollectionId(client, collection);
  const session = await createNamedReplaySession(client, { id: requestId }, collectionId, sessionName, "WS");
  const data = await client.graphql(START_REPLAY_TASK, { sessionId: session.id });
  const payload = data.startReplayTask;
  if (payload?.error) die(`Could not start the WebSocket task: ${payload.error.__typename}`);
  const task = requirePayload(payload, "task", "startReplayTask");
  printJson({ sessionId: session.id, sessionName: session.name, taskId: task.id, sessionKind: task.sessionKind });
}

async function cmdWsSend(taskId, data, direction, format) {
  const client = await getClient();
  const text = await resolveRaw(data);
  const result = await client.graphql(SEND_REPLAY_TASK_MESSAGE, {
    task: taskId,
    input: { ws: { direction, format, data: encodeRaw(text) } },
  });
  const payload = result.sendReplayTaskMessage;
  if (payload?.error) die(`Send refused: ${payload.error.__typename}`);
  printJson({ taskId, direction, format, message: payload?.message });
}

async function cmdWsStop(taskIds) {
  const data = await (await getClient()).graphql(STOP_REPLAY_WS_TASKS, { taskIds });
  printJson({ stopped: data.stopReplayWsTasks?.taskIds || taskIds });
}

async function cmdDeleteHostedFile(fileId) {
  await (await getClient()).graphql(DELETE_HOSTED_FILE, { id: fileId });
  printJson({ deleted: fileId });
}

async function cmdTasks() {
  printJson((await (await getClient()).graphql(TASKS_QUERY)).tasks);
}

async function cmdCancelTask(taskId) {
  const data = await (await getClient()).graphql(CANCEL_TASK, { id: taskId });
  const err = firstPayloadError(data.cancelTask);
  if (err) throw new Error(`cancelTask failed: ${err}`);
  printJson({ cancelled: data.cancelTask.cancelledId || taskId });
}

async function cmdInterceptStatus() {
  try {
    const result = await (await getClient()).graphql(INTERCEPT_OPTIONS_QUERY, {});
    printJson(result.interceptOptions);
  } catch (err) {
    printJson({ error: err.message, hint: "Intercept may not be available" });
  }
}

async function cmdInterceptSet(enabled) {
  try {
    const result = await (await getClient()).graphql(enabled ? RESUME_INTERCEPT : PAUSE_INTERCEPT, {});
    printJson(enabled ? result.resumeIntercept : result.pauseIntercept);
  } catch (err) {
    throw new Error(`Failed to ${enabled ? "enable" : "disable"} intercept: ${err.message}`);
  }
}

async function cmdViewer() {
  printJson((await (await getClient()).graphql(VIEWER_QUERY)).viewer);
}

async function cmdPlugins() {
  printJson((await (await getClient()).graphql(PLUGIN_PACKAGES_QUERY)).pluginPackages);
}

async function cmdHealth() {
  printJson(await (await getClient()).health());
}

async function cmdSetup(pat, url, savePat = true) {
  console.log(`Connecting to ${url}...`);
  const token = await authenticateWithPat(url, pat);
  const client = new CaidoClient(url, token.accessToken, token.refreshToken);
  const viewer = (await client.graphql(VIEWER_QUERY)).viewer;
  console.log(`Authenticated as: ${viewer?.profile?.identity?.email || viewer?.id || JSON.stringify(viewer)}`);

  const secrets = readCaidoSecrets();
  secrets.url = url;
  if (savePat) secrets.pat = pat;
  else delete secrets.pat;
  secrets.cachedToken = token;
  writeCaidoSecrets(secrets);

  console.log(`\nSaved to ${SECRETS_PATH}`);
  console.log(`URL: ${url}`);
  console.log(`PAT: ${savePat ? "stored" : "not stored"}`);
  console.log("Access token: cached");
}

async function cmdAuthStatus() {
  const secrets = readCaidoSecrets();
  const explicitEnvUrl = process.env.CAIDO_URL || process.env.CAIDO_INSTANCE_URL;
  const url = explicitEnvUrl || secrets.url || DEFAULT_CAIDO_URL;
  const cachedExpiresAt = secrets.cachedToken?.expiresAt ?? null;
  const cachedTokenValid = isCachedTokenValid(secrets.cachedToken);
  const hasPat = !!secrets.pat || !!process.env.CAIDO_PAT;
  const hasAccessToken = !!process.env.CAIDO_ACCESS_TOKEN || !!secrets.cachedToken?.accessToken;
  const hasRefreshToken = !!secrets.cachedToken?.refreshToken;
  const authMode = process.env.CAIDO_ACCESS_TOKEN
    ? "access-token"
    : cachedTokenValid
      ? "cached-token"
      : hasRefreshToken
        ? "refresh-token"
        : hasPat
          ? "pat"
          : "none";

  if (!hasPat && !hasAccessToken && !hasRefreshToken) {
    printJson({
      authenticated: false,
      authMode,
      hasPat,
      hasAccessToken,
      hasRefreshToken,
      cachedTokenExpiresAt: cachedExpiresAt,
      cachedTokenValid,
      url,
      error: "No Caido auth found",
    });
    return;
  }

  try {
    const client = await getClient();
    const viewer = (await client.graphql(VIEWER_QUERY)).viewer;
    const health = await client.health();
    // History, findings, sitemap, streams and rules are all project data, so
    // "which project is selected" decides what every other command can see.
    const project = (await client.graphql(CURRENT_PROJECT_QUERY)).currentProject?.project;
    printJson(compactUndefined({
      authenticated: true,
      authMode,
      hasPat,
      hasAccessToken,
      hasRefreshToken,
      cachedTokenExpiresAt: cachedExpiresAt,
      cachedTokenValid,
      url: client.url,
      project: project ? { id: project.id, name: project.name } : undefined,
      user: viewer,
      health,
    }));
  } catch (err) {
    printJson({
      authenticated: false,
      authMode,
      hasPat,
      hasAccessToken,
      hasRefreshToken,
      cachedTokenExpiresAt: cachedExpiresAt,
      cachedTokenValid,
      url,
      error: err.message,
    });
  }
}

function printUsage() {
  console.log(`
Caido Client - dependency-free direct GraphQL mode

Usage:
  caido-client.mjs <command> [options]

HTTP history:
  search <filter> [--limit n] [--after cursor] [--ids-only] [--desc|--latest] [--scope id-or-name] [--color name] [--scan-limit n]
  set-color <name|clear> (--ids id,id | --filter httpql) [--scope id-or-name] [--limit n]
  recent [--limit n]
  get <request-id> [output options]
  get-response <request-id> [output options]
  download <request-id> --out file [--response|--request] [--body-only|--raw] [--force]
  export-curl <request-id>
  compare <id-a> <id-b> [--request|--response] [--all-headers] [--max-diff-lines n] [--max-bytes n]
  evidence <request-id> --out dir [--finding id] [--force]

Replay:
  replay <request-id> [--raw str|@file|-] [--name name] [--collection id-or-name] [connection options] [output options]
  send-raw --host host --raw str|@file|- [--port n] [--tls|--no-tls] [--name name] [--collection id-or-name] [connection options] [output options]
  edit <request-id> [--method M] [--path p] [--set-header "N: V"] [--remove-header N] [--body b] [--replace from:::to] [--session id-or-name] [--name name] [--collection id-or-name] [--values 1-100|a,b,c|@file] [connection options] [output options]
  get-session <id-or-name> [output options]
  replay-entries <id-or-name> [--limit n] [--raw] [output options]
  edit-session <id-or-name> [edit options] [connection options] [output options]

Sessions and collections:
  create-session <request-id> [--name name] [--collection id-or-name]
  rename-session <id-or-name> <new-name>
  move-session <id-or-name> <collection-id-or-name>
  replay-sessions [--limit n]
  delete-sessions <id-or-name,id-or-name,...>
  replay-collections [--limit n]
  create-collection <name>
  rename-collection <id-or-name> <new-name>
  delete-collection <id-or-name>

Other:
  sitemap [host] [--scope s] [--all] [--limit n]   what has been seen on a host
  streams [--limit n] [--scope s] [--filter streamql]
  stream-messages <stream-id> [--limit n] [--raw] [--filter streamql] [output options]
  ws-connect <upgrade-request-id> [--name name] [--collection id-or-name]
  ws-send <task-id> <str|@file|-> [--direction client|server] [--format text|binary|ping|pong|close]
  ws-stop <task-id,task-id,...>
  rules                   list match-and-replace rules rewriting traffic
  create-rule <name> --section <s> [--op raw|add|update|remove]
              [--match v | --match-regex re | --match-full | --match-name h]
              [--replace v] [--condition q] [--sources a,b] [--collection id]
  update-rule <id> ... (same flags; unset fields keep their value)
  toggle-rule <id> --on|--off | rename-rule <id> <name> | move-rule <id> <coll>
  delete-rule <id>
  create-rule-collection <name> | rename-rule-collection <id> <name>
  delete-rule-collection <id>
  findings | get-finding | create-finding | update-finding | delete-findings <id,id,...>|--reporter name
  scopes | create-scope | update-scope | delete-scope
  filters | create-filter | update-filter | delete-filter
  envs | create-env | select-env | env-set | delete-env
  projects | select-project <id-or-name> | hosted-files | upload-hosted-file <path> [--name n] | delete-hosted-file
  create-project <name> [--temporary] | rename-project <id-or-name> <new> | persist-project <id-or-name> | delete-project <id-or-name>

DNS:
  dns-rewrites | dns-upstreams
  create-dns-rewrite --allow host,host [--deny host,host] (--ip addr | --upstream id-or-name)
  update-dns-rewrite <id> [--allow h,h] [--deny h,h] [--ip addr | --upstream id-or-name]
  toggle-dns-rewrite <id> --on|--off
  delete-dns-rewrite <id>
  create-dns-upstream <name> --ip addr | update-dns-upstream <id-or-name> [--name n] [--ip a] | delete-dns-upstream <id-or-name>
  tasks | cancel-task | intercept-status | intercept-enable | intercept-disable
  viewer | plugins | health | setup | auth-status

Output options:
  --max-body <n> --max-body-chars <n> --no-request --headers-only --compact

Connection options:
  --sni <host> --connect-host <host> --connect-port <port> --connect-tls --connect-no-tls

Global options:
  --json-compact          one-line JSON instead of indented (also CAIDO_COMPACT_JSON=1)
  --delay <ms>            minimum gap between sends to one host (also CAIDO_MIN_INTERVAL_MS)
                          batch --values paces at ${DEFAULT_BATCH_DELAY_MS}ms unless set

Batch sends:
  edit ... --values 1-100 with {} in --path/--body/--method/--set-header/--replace.
  One row per value; stops on the first 429/503 or send error.

Auth:
  setup <pat> [url] [--no-save-pat]
  env: CAIDO_PAT, CAIDO_ACCESS_TOKEN, CAIDO_URL
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  switch (command) {
    case "search": {
      const filter = args[1] || "";
      let limit = 20;
      let after;
      let idsOnly = false;
      let desc = false;
      let scope;
      let color;
      let scanLimit = DEFAULT_COLOR_SCAN_LIMIT;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--limit") { limit = parseInt(requireFlagValue(args, i, "--limit"), 10); i++; }
        else if (args[i] === "--after") { after = requireFlagValue(args, i, "--after"); i++; }
        else if (args[i] === "--ids-only") idsOnly = true;
        else if (args[i] === "--desc" || args[i] === "--latest") desc = true;
        else if (args[i] === "--scope") { scope = requireFlagValue(args, i, "--scope"); i++; }
        else if (args[i] === "--color") { color = requireFlagValue(args, i, "--color"); i++; }
        else if (args[i] === "--scan-limit") { scanLimit = parseInt(requireFlagValue(args, i, "--scan-limit"), 10); i++; }
      }
      if (!Number.isFinite(limit) || limit <= 0) die("Error: --limit must be a positive integer");
      if (!Number.isFinite(scanLimit) || scanLimit <= 0) die("Error: --scan-limit must be a positive integer");
      await cmdSearch(filter, limit, after, idsOnly, desc, scope, color, scanLimit);
      break;
    }
    case "recent": {
      let limit = 20;
      for (let i = 1; i < args.length; i++) if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      await cmdRecent(limit);
      break;
    }
    case "set-color": {
      if (!args[1]) die("Error: color required");
      let ids;
      let filter;
      let scope;
      let limit = MAX_COLOR_UPDATES;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--ids") {
          ids = splitList(requireFlagValue(args, i, "--ids"));
          i++;
        } else if (args[i] === "--filter") {
          filter = requireFlagValue(args, i, "--filter");
          i++;
        } else if (args[i] === "--scope") {
          scope = requireFlagValue(args, i, "--scope");
          i++;
        } else if (args[i] === "--limit") {
          limit = parseInt(requireFlagValue(args, i, "--limit"), 10);
          i++;
        }
      }
      if (!!ids === !!filter) die("Error: pass exactly one of --ids or --filter");
      if (ids && !ids.length) die("Error: --ids needs at least one request id");
      if (ids && scope) die("Error: --scope applies only to --filter; explicit ids are already exact");
      if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_COLOR_UPDATES) {
        die(`Error: --limit must be between 1 and ${MAX_COLOR_UPDATES}`);
      }
      if (ids && ids.length > MAX_COLOR_UPDATES) die(`Error: --ids accepts at most ${MAX_COLOR_UPDATES} request ids`);
      await cmdSetColor(args[1].toLowerCase(), ids, filter, scope, limit);
      break;
    }
    case "get": {
      if (!args[1]) die("Error: request-id required");
      await cmdGet(args[1], parseOutputOpts(args, 2));
      break;
    }
    case "get-response": {
      if (!args[1]) die("Error: request-id required");
      await cmdGetResponse(args[1], parseOutputOpts(args, 2));
      break;
    }
    case "download": {
      if (!args[1]) die("Error: request-id required");
      const opts = { source: "response", raw: false, force: false };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--request") opts.source = "request";
        else if (args[i] === "--response") opts.source = "response";
        else if (args[i] === "--raw") opts.raw = true;
        else if (args[i] === "--body-only") opts.raw = false;
        else if (args[i] === "--force") opts.force = true;
        else if (args[i] === "--out" && args[i + 1]) { opts.out = args[i + 1]; i++; }
        else if (!args[i].startsWith("--") && !opts.out) opts.out = args[i];
      }
      if (!opts.out) die("Error: --out file required");
      await cmdDownload(args[1], opts);
      break;
    }
    case "replay": {
      if (!args[1]) die("Error: request-id required");
      let rawOverride;
      for (let i = 2; i < args.length; i++) if (args[i] === "--raw" && args[i + 1]) { rawOverride = args[i + 1]; i++; }
      await cmdReplay(args[1], rawOverride, parseOutputOpts(args, 2), parseConnectionOverrides(args, 2), parseCollectionId(args, 2), parseSessionName(args, 2));
      break;
    }
    case "send-raw": {
      let host;
      let port = 443;
      let tls = true;
      let raw;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--host" && args[i + 1]) { host = args[i + 1]; i++; }
        else if (args[i] === "--port" && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
        else if (args[i] === "--tls") tls = true;
        else if (args[i] === "--no-tls") tls = false;
        else if (args[i] === "--raw" && args[i + 1]) { raw = args[i + 1]; i++; }
      }
      if (!host || !raw) die("Error: --host and --raw are required");
      await cmdSendRaw(host, port, tls, raw, parseOutputOpts(args, 1), parseConnectionOverrides(args, 1), parseCollectionId(args, 1), parseSessionName(args, 1));
      break;
    }
    case "edit": {
      if (!args[1]) die("Error: request-id required");
      let method;
      let path;
      let body;
      let sessionId;
      let valueSpec;
      const setHeaders = [];
      const removeHeaders = [];
      const replacements = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--method" && args[i + 1]) { method = args[i + 1]; i++; }
        else if (args[i] === "--path" && args[i + 1]) { path = args[i + 1]; i++; }
        else if (args[i] === "--body" && args[i + 1]) { body = args[i + 1]; i++; }
        else if (args[i] === "--set-header" && args[i + 1]) { setHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--remove-header" && args[i + 1]) { removeHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--replace" && args[i + 1]) { replacements.push(args[i + 1]); i++; }
        else if (args[i] === "--session" && args[i + 1]) { sessionId = args[i + 1]; i++; }
        else if (args[i] === "--values") { valueSpec = requireFlagValue(args, i, "--values"); i++; }
      }
      const edits = { method, path, body, setHeaders, removeHeaders, replacements, sessionId };
      const sessionName = parseSessionName(args, 2);
      // --name names the tab this command opens. With --session the tab already
      // exists, so a name there would be a silent rename of someone else's tab.
      if (sessionName && sessionId) die("Error: --name names a new session; with --session use rename-session");
      if (valueSpec !== undefined) {
        await cmdEditBatch(
          args[1],
          edits,
          parseValueSpec(valueSpec),
          parseOutputOpts(args, 2),
          parseConnectionOverrides(args, 2),
          parseCollectionId(args, 2),
          MIN_INTERVAL_MS ?? DEFAULT_BATCH_DELAY_MS,
          sessionName,
        );
      } else {
        await cmdEdit(args[1], edits, parseOutputOpts(args, 2), parseConnectionOverrides(args, 2), parseCollectionId(args, 2), sessionName);
      }
      break;
    }
    case "compare": {
      if (!args[1] || !args[2]) die("Error: two request ids required");
      const opts = { source: "response", allHeaders: false, maxDiffLines: 20, maxLineChars: 300, maxBytes: 262144 };
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--request") opts.source = "request";
        else if (args[i] === "--response") opts.source = "response";
        else if (args[i] === "--all-headers") opts.allHeaders = true;
        else if (args[i] === "--max-diff-lines") {
          opts.maxDiffLines = parseInt(requireFlagValue(args, i, "--max-diff-lines"), 10);
          if (!Number.isFinite(opts.maxDiffLines) || opts.maxDiffLines < 0) die("Error: --max-diff-lines must be a non-negative integer");
          i++;
        } else if (args[i] === "--max-line-chars") {
          opts.maxLineChars = parseInt(requireFlagValue(args, i, "--max-line-chars"), 10);
          if (!Number.isFinite(opts.maxLineChars) || opts.maxLineChars <= 0) die("Error: --max-line-chars must be a positive integer");
          i++;
        } else if (args[i] === "--max-bytes") {
          opts.maxBytes = parseInt(requireFlagValue(args, i, "--max-bytes"), 10);
          if (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) die("Error: --max-bytes must be a positive integer");
          i++;
        }
      }
      await cmdCompare(args[1], args[2], opts);
      break;
    }
    case "evidence": {
      const opts = { force: false };
      const positional = [];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--out") { opts.out = requireFlagValue(args, i, "--out"); i++; }
        else if (args[i] === "--finding") { opts.finding = requireFlagValue(args, i, "--finding"); i++; }
        else if (args[i] === "--force") opts.force = true;
        else if (!args[i].startsWith("--")) positional.push(args[i]);
      }
      if (!opts.out) die("Error: --out <dir> required");
      await cmdEvidence(positional[0], opts);
      break;
    }
    case "export-curl": {
      if (!args[1]) die("Error: request-id required");
      await cmdExportCurl(args[1]);
      break;
    }
    case "get-session": {
      if (!args[1]) die("Error: session id or name required");
      await cmdGetSession(args[1], parseOutputOpts(args, 2));
      break;
    }
    case "replay-entries":
    case "session-entries": {
      if (!args[1]) die("Error: session id or name required");
      let limit = 20;
      let includeRaw = false;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
        else if (args[i] === "--raw") includeRaw = true;
      }
      await cmdReplayEntries(args[1], limit, parseOutputOpts(args, 2), includeRaw);
      break;
    }
    case "edit-session": {
      if (!args[1]) die("Error: session id or name required");
      let method;
      let path;
      let body;
      const setHeaders = [];
      const removeHeaders = [];
      const replacements = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--method" && args[i + 1]) { method = args[i + 1]; i++; }
        else if (args[i] === "--path" && args[i + 1]) { path = args[i + 1]; i++; }
        else if (args[i] === "--body" && args[i + 1]) { body = args[i + 1]; i++; }
        else if (args[i] === "--set-header" && args[i + 1]) { setHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--remove-header" && args[i + 1]) { removeHeaders.push(args[i + 1]); i++; }
        else if (args[i] === "--replace" && args[i + 1]) { replacements.push(args[i + 1]); i++; }
      }
      await cmdEditSession(args[1], { method, path, body, setHeaders, removeHeaders, replacements }, parseOutputOpts(args, 2), parseConnectionOverrides(args, 2));
      break;
    }
    case "create-session": {
      if (!args[1]) die("Error: request-id required");
      await cmdCreateSession(args[1], parseCollectionId(args, 2), parseSessionName(args, 2));
      break;
    }
    case "rename-session": {
      if (!args[1] || !args[2]) die("Error: session-id and name required");
      await cmdRenameSession(args[1], args[2]);
      break;
    }
    case "move-session": {
      if (!args[1] || !args[2]) die("Error: session-id and collection-id required");
      await cmdMoveSession(args[1], args[2]);
      break;
    }
    case "replay-sessions": {
      let limit = 20;
      for (let i = 1; i < args.length; i++) if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      await cmdReplaySessions(limit);
      break;
    }
    case "delete-sessions": {
      if (!args[1]) die("Error: comma-separated session IDs required");
      await cmdDeleteSessions(args[1].split(",").map((s) => s.trim()).filter(Boolean));
      break;
    }
    case "replay-collections": {
      let limit = 20;
      for (let i = 1; i < args.length; i++) if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      await cmdReplayCollections(limit);
      break;
    }
    case "create-collection": {
      if (!args[1]) die("Error: collection name required");
      await cmdCreateCollection(args[1]);
      break;
    }
    case "rename-collection": {
      if (!args[1] || !args[2]) die("Error: collection-id and name required");
      await cmdRenameCollection(args[1], args[2]);
      break;
    }
    case "delete-collection": {
      if (!args[1]) die("Error: collection-id required");
      await cmdDeleteCollection(args[1]);
      break;
    }
    case "create-automate-session": {
      if (!args[1]) die("Error: request-id required");
      await cmdCreateAutomateSession(args[1]);
      break;
    }
    case "fuzz": {
      if (!args[1]) die("Error: session-id required");
      await cmdFuzz(args[1]);
      break;
    }
    case "findings": {
      let limit = 20;
      for (let i = 1; i < args.length; i++) if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      await cmdFindings(limit);
      break;
    }
    case "get-finding": {
      if (!args[1]) die("Error: finding-id required");
      await cmdGetFinding(args[1]);
      break;
    }
    case "create-finding": {
      if (!args[1]) die("Error: request-id required");
      let title;
      let desc;
      let reporter;
      let dedupeKey;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--title" && args[i + 1]) { title = args[i + 1]; i++; }
        else if (args[i] === "--description" && args[i + 1]) { desc = args[i + 1]; i++; }
        else if (args[i] === "--reporter" && args[i + 1]) { reporter = args[i + 1]; i++; }
        else if (args[i] === "--dedupe-key" && args[i + 1]) { dedupeKey = args[i + 1]; i++; }
      }
      if (!title) die("Error: --title required");
      await cmdCreateFinding(args[1], title, desc, reporter, dedupeKey);
      break;
    }
    case "delete-findings": {
      let reporter;
      for (let i = 1; i < args.length; i++) if (args[i] === "--reporter" && args[i + 1]) { reporter = args[i + 1]; i++; }
      const ids = args[1] && !args[1].startsWith("--") ? splitList(args[1]) : [];
      await cmdDeleteFindings(ids, reporter);
      break;
    }
    case "update-finding": {
      if (!args[1]) die("Error: finding-id required");
      let title;
      let desc;
      let hidden;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--title" && args[i + 1]) { title = args[i + 1]; i++; }
        else if (args[i] === "--description" && args[i + 1]) { desc = args[i + 1]; i++; }
        else if (args[i] === "--hidden") hidden = true;
        else if (args[i] === "--visible") hidden = false;
      }
      await cmdUpdateFinding(args[1], title, desc, hidden);
      break;
    }
    case "projects": await cmdProjects(); break;
    case "select-project": {
      if (!args[1]) die("Error: project id or name required");
      await cmdSelectProject(args[1]);
      break;
    }
    case "scopes": await cmdScopes(); break;
    case "create-scope": {
      if (!args[1]) die("Error: scope name required");
      let allow = [];
      let denyList = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--allow" && args[i + 1]) { allow = splitList(args[i + 1]); i++; }
        else if (args[i] === "--deny" && args[i + 1]) { denyList = splitList(args[i + 1]); i++; }
      }
      await cmdCreateScope(args[1], allow, denyList);
      break;
    }
    case "update-scope": {
      if (!args[1]) die("Error: scope id required");
      let name;
      let allow;
      let denyList;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
        else if (args[i] === "--allow" && args[i + 1]) { allow = splitList(args[i + 1]); i++; }
        else if (args[i] === "--deny" && args[i + 1]) { denyList = splitList(args[i + 1]); i++; }
      }
      await cmdUpdateScope(args[1], name, allow, denyList);
      break;
    }
    case "delete-scope": {
      if (!args[1]) die("Error: scope id required");
      await cmdDeleteScope(args[1]);
      break;
    }
    case "filters": await cmdFilters(); break;
    case "create-filter": {
      if (!args[1]) die("Error: filter name required");
      let query;
      let alias;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--query" && args[i + 1]) { query = args[i + 1]; i++; }
        else if (args[i] === "--alias" && args[i + 1]) { alias = args[i + 1]; i++; }
      }
      if (!query) die("Error: --query required");
      await cmdCreateFilter(args[1], query, alias);
      break;
    }
    case "update-filter": {
      if (!args[1]) die("Error: filter id required");
      let name;
      let query;
      let alias;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
        else if (args[i] === "--query" && args[i + 1]) { query = args[i + 1]; i++; }
        else if (args[i] === "--alias" && args[i + 1]) { alias = args[i + 1]; i++; }
      }
      await cmdUpdateFilter(args[1], name, query, alias);
      break;
    }
    case "delete-filter": {
      if (!args[1]) die("Error: filter id required");
      await cmdDeleteFilter(args[1]);
      break;
    }
    case "envs": await cmdEnvs(); break;
    case "create-env": {
      if (!args[1]) die("Error: environment name required");
      await cmdCreateEnv(args[1]);
      break;
    }
    case "select-env": await cmdSelectEnv(args[1]); break;
    case "env-set": {
      if (!args[1] || !args[2] || args[3] === undefined) die("Error: env-set requires <env-id> <var-name> <value>");
      await cmdEnvSet(args[1], args[2], args[3]);
      break;
    }
    case "delete-env": {
      if (!args[1]) die("Error: environment id required");
      await cmdDeleteEnv(args[1]);
      break;
    }
    case "dns-rewrites": await cmdDnsRewrites(); break;
    case "dns-upstreams": await cmdDnsUpstreams(); break;
    case "create-dns-rewrite": {
      let allow, deny, ip, upstream;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--allow" && args[i + 1]) { allow = splitList(args[i + 1]); i++; }
        else if (args[i] === "--deny" && args[i + 1]) { deny = splitList(args[i + 1]); i++; }
        else if (args[i] === "--ip" && args[i + 1]) { ip = args[i + 1]; i++; }
        else if (args[i] === "--upstream" && args[i + 1]) { upstream = args[i + 1]; i++; }
      }
      await cmdCreateDnsRewrite(allow, deny, ip, upstream);
      break;
    }
    case "update-dns-rewrite": {
      if (!args[1]) die("Error: rewrite id required");
      let allow, deny, ip, upstream;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--allow" && args[i + 1]) { allow = splitList(args[i + 1]); i++; }
        else if (args[i] === "--deny" && args[i + 1]) { deny = splitList(args[i + 1]); i++; }
        else if (args[i] === "--ip" && args[i + 1]) { ip = args[i + 1]; i++; }
        else if (args[i] === "--upstream" && args[i + 1]) { upstream = args[i + 1]; i++; }
      }
      await cmdUpdateDnsRewrite(args[1], allow, deny, ip, upstream);
      break;
    }
    case "toggle-dns-rewrite": {
      if (!args[1]) die("Error: rewrite id required");
      const on = args.includes("--on");
      if (on === args.includes("--off")) die("Error: one of --on or --off");
      await cmdToggleDnsRewrite(args[1], on);
      break;
    }
    case "delete-dns-rewrite": {
      if (!args[1]) die("Error: rewrite id required");
      await cmdDeleteDnsRewrite(args[1]);
      break;
    }
    case "create-dns-upstream": {
      if (!args[1]) die("Error: upstream name required");
      let ip;
      for (let i = 2; i < args.length; i++) if (args[i] === "--ip" && args[i + 1]) { ip = args[i + 1]; i++; }
      if (!ip) die("Error: --ip <address> required");
      await cmdCreateDnsUpstream(args[1], ip);
      break;
    }
    case "update-dns-upstream": {
      if (!args[1]) die("Error: upstream id or name required");
      let name, ip;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
        else if (args[i] === "--ip" && args[i + 1]) { ip = args[i + 1]; i++; }
      }
      await cmdUpdateDnsUpstream(args[1], name, ip);
      break;
    }
    case "delete-dns-upstream": {
      if (!args[1]) die("Error: upstream id or name required");
      await cmdDeleteDnsUpstream(args[1]);
      break;
    }
    case "create-project": {
      if (!args[1]) die("Error: project name required");
      await cmdCreateProject(args[1], args.includes("--temporary"));
      break;
    }
    case "rename-project": {
      if (!args[1] || !args[2]) die("Error: project id-or-name and new name required");
      await cmdRenameProject(args[1], args[2]);
      break;
    }
    case "persist-project": {
      if (!args[1]) die("Error: project id or name required");
      await cmdPersistProject(args[1]);
      break;
    }
    case "delete-project": {
      if (!args[1]) die("Error: project id or name required");
      await cmdDeleteProject(args[1]);
      break;
    }
    case "hosted-files": await cmdHostedFiles(); break;
    case "upload-hosted-file": {
      if (!args[1]) die("Error: file path required");
      let name;
      for (let i = 2; i < args.length; i++) if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
      await cmdUploadHostedFile(args[1], name);
      break;
    }
    case "ws-connect": {
      if (!args[1]) die("Error: request-id of the WebSocket upgrade required");
      await cmdWsConnect(args[1], parseCollectionId(args, 2), parseSessionName(args, 2));
      break;
    }
    case "ws-send": {
      if (!args[1] || !args[2]) die("Error: task-id and data required (str, @file or - for stdin)");
      let direction = "CLIENT";
      let format = "TEXT";
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--direction" && args[i + 1]) { direction = args[i + 1].toUpperCase(); i++; }
        else if (args[i] === "--format" && args[i + 1]) { format = args[i + 1].toUpperCase(); i++; }
      }
      if (!["CLIENT", "SERVER"].includes(direction)) die("Error: --direction is client or server");
      if (!["TEXT", "BINARY", "PING", "PONG", "CLOSE"].includes(format)) die("Error: --format is text, binary, ping, pong or close");
      await cmdWsSend(args[1], args[2], direction, format);
      break;
    }
    case "ws-stop": {
      if (!args[1]) die("Error: comma-separated task ids required");
      await cmdWsStop(args[1].split(",").map((t) => t.trim()).filter(Boolean));
      break;
    }
    case "delete-hosted-file": {
      if (!args[1]) die("Error: hosted file id required");
      await cmdDeleteHostedFile(args[1]);
      break;
    }
    case "tasks": await cmdTasks(); break;
    case "cancel-task": {
      if (!args[1]) die("Error: task id required");
      await cmdCancelTask(args[1]);
      break;
    }
    case "streams": {
      let limit = 20;
      let scope;
      let filter;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit") { limit = parseInt(requireFlagValue(args, i, "--limit"), 10); i++; }
        else if (args[i] === "--scope") { scope = requireFlagValue(args, i, "--scope"); i++; }
        else if (args[i] === "--filter") { filter = requireFlagValue(args, i, "--filter"); i++; }
      }
      if (!Number.isFinite(limit) || limit <= 0) die("Error: --limit must be a positive integer");
      await cmdStreams(limit, scope, filter);
      break;
    }
    case "stream-messages": {
      if (!args[1]) die("Error: stream id required");
      let limit = 50;
      let includeRaw = false;
      let filter;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--limit") { limit = parseInt(requireFlagValue(args, i, "--limit"), 10); i++; }
        else if (args[i] === "--filter") { filter = requireFlagValue(args, i, "--filter"); i++; }
        else if (args[i] === "--raw") includeRaw = true;
      }
      if (!Number.isFinite(limit) || limit <= 0) die("Error: --limit must be a positive integer");
      await cmdStreamMessages(args[1], limit, includeRaw, filter, parseOutputOpts(args, 2));
      break;
    }
    case "sitemap": {
      const opts = { limit: 200, all: false };
      let target;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--scope") { opts.scope = requireFlagValue(args, i, "--scope"); i++; }
        else if (args[i] === "--limit") {
          opts.limit = parseInt(requireFlagValue(args, i, "--limit"), 10);
          if (!Number.isFinite(opts.limit) || opts.limit <= 0) die("Error: --limit must be a positive integer");
          i++;
        } else if (args[i] === "--all") opts.all = true;
        else if (!args[i].startsWith("--") && target === undefined) target = args[i];
      }
      await cmdSitemap(target, opts);
      break;
    }
    case "create-rule":
    case "update-rule": {
      const isCreate = command === "create-rule";
      if (!args[1]) die(isCreate ? "Error: rule name required" : "Error: rule id required");
      const opts = { op: "raw", sources: undefined, matcher: undefined };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--section") { opts.section = requireFlagValue(args, i, "--section"); i++; }
        else if (args[i] === "--op") { opts.op = requireFlagValue(args, i, "--op"); i++; }
        else if (args[i] === "--match") { opts.matcher = { raw: { value: { value: requireFlagValue(args, i, "--match") } } }; i++; }
        else if (args[i] === "--match-regex") { opts.matcher = { raw: { regex: { regex: requireFlagValue(args, i, "--match-regex") } } }; i++; }
        else if (args[i] === "--match-name") { opts.matcher = { name: requireFlagValue(args, i, "--match-name") }; i++; }
        else if (args[i] === "--match-full") opts.matcher = { raw: { full: { full: true } } };
        else if (args[i] === "--replace") { opts.replace = requireFlagValue(args, i, "--replace"); i++; }
        else if (args[i] === "--condition") { opts.condition = requireFlagValue(args, i, "--condition"); i++; }
        else if (args[i] === "--sources") { opts.sources = parseTamperSources(requireFlagValue(args, i, "--sources")); i++; }
        else if (args[i] === "--collection") { opts.collection = requireFlagValue(args, i, "--collection"); i++; }
        else if (args[i] === "--name") { opts.name = requireFlagValue(args, i, "--name"); i++; }
      }
      if (!opts.section) die(`Error: --section required. One of: ${Object.keys(TAMPER_SECTIONS).join(", ")}`);
      if (isCreate) {
        // Both the browser's traffic and this client's own sends, which is what
        // a program-required header has to cover. Narrow it with --sources.
        opts.sources = opts.sources ?? ["INTERCEPT", "REPLAY"];
        await cmdCreateRule(args[1], opts);
      } else {
        await cmdUpdateRule(args[1], opts);
      }
      break;
    }
    case "toggle-rule": {
      if (!args[1]) die("Error: rule id required");
      let enabled;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--on") enabled = true;
        else if (args[i] === "--off") enabled = false;
      }
      if (enabled === undefined) die("Error: --on or --off required");
      await cmdToggleRule(args[1], enabled);
      break;
    }
    case "rename-rule": {
      if (!args[1] || !args[2]) die("Error: rule id and new name required");
      await cmdRenameRule(args[1], args[2]);
      break;
    }
    case "move-rule": {
      if (!args[1] || !args[2]) die("Error: rule id and collection id required");
      await cmdMoveRule(args[1], args[2]);
      break;
    }
    case "delete-rule": {
      if (!args[1]) die("Error: rule id required");
      await cmdDeleteRule(args[1]);
      break;
    }
    case "create-rule-collection": {
      if (!args[1]) die("Error: collection name required");
      await cmdCreateRuleCollection(args[1]);
      break;
    }
    case "rename-rule-collection": {
      if (!args[1] || !args[2]) die("Error: collection id and new name required");
      await cmdRenameRuleCollection(args[1], args[2]);
      break;
    }
    case "delete-rule-collection": {
      if (!args[1]) die("Error: collection id required");
      await cmdDeleteRuleCollection(args[1]);
      break;
    }
    case "rules": await cmdRules(); break;
    case "intercept-status": await cmdInterceptStatus(); break;
    case "intercept-enable": await cmdInterceptSet(true); break;
    case "intercept-disable": await cmdInterceptSet(false); break;
    case "viewer": await cmdViewer(); break;
    case "plugins": await cmdPlugins(); break;
    case "health": await cmdHealth(); break;
    case "setup": {
      const pat = args[1];
      if (!pat) die("Usage: node caido-client.mjs setup <pat> [url] [--no-save-pat]");
      const url = args.find((a, i) => i > 1 && !a.startsWith("--")) || process.env.CAIDO_URL || process.env.CAIDO_INSTANCE_URL || DEFAULT_CAIDO_URL;
      await cmdSetup(pat, url, !args.includes("--no-save-pat"));
      break;
    }
    case "auth-status": await cmdAuthStatus(); break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// alteration and edited answer "did something rewrite this before I saw it":
// TAMPER means a match-and-replace rule changed it, MANUAL means a person did.
// Without them a rule's effect reads as the target's own behaviour.
const REQUEST_FULL_FRAGMENT = `
fragment ResponseFull on Response {
  id
  statusCode
  roundtripTime
  length
  createdAt
  alteration
  edited
  raw @include(if: $includeResponseRaw)
}
fragment RequestFull on Request {
  id
  host
  port
  method
  path
  query
  isTls
  createdAt
  alteration
  edited
  metadata { color }
  raw @include(if: $includeRequestRaw)
  response {
    ...ResponseFull
  }
}`;

const REQUEST_QUERY = `
${REQUEST_FULL_FRAGMENT}
query Request($id: ID!, $includeRequestRaw: Boolean!, $includeResponseRaw: Boolean!) {
  request(id: $id) {
    ...RequestFull
  }
}`;

const REQUESTS_QUERY = `
${REQUEST_FULL_FRAGMENT}
query Requests($first: Int, $after: String, $last: Int, $before: String, $filter: HTTPQLInput, $order: RequestResponseOrderInput, $scopeId: ID, $includeRequestRaw: Boolean!, $includeResponseRaw: Boolean!) {
  requests(first: $first, after: $after, last: $last, before: $before, filter: $filter, order: $order, scopeId: $scopeId) {
    edges {
      cursor
      node {
        ...RequestFull
      }
    }
    pageInfo {
      hasNextPage
      hasPreviousPage
      startCursor
      endCursor
    }
  }
}`;

const CONNECTION_FRAGMENT = `
fragment ConnectionInfoFull on ConnectionInfo {
  __typename
  host
  port
  isTLS
  SNI
}`;

const REPLAY_SESSION_FRAGMENT = `
fragment ReplaySessionMeta on ReplaySession {
  id
  name
  collection { id }
  activeEntry { id }
}`;

const REPLAY_ENTRY_FRAGMENT = `
${CONNECTION_FRAGMENT}
${REQUEST_FULL_FRAGMENT}
fragment ReplayEntryFull on ReplayEntry {
  connection { ...ConnectionInfoFull }
  createdAt
  error
  id
  raw @include(if: $includeReplayRaw)
  request { ...RequestFull }
  session { id }
}`;

const REPLAY_ENTRY_QUERY = `
${REPLAY_ENTRY_FRAGMENT}
query ReplayEntry($id: ID!, $includeReplayRaw: Boolean!, $includeRequestRaw: Boolean!, $includeResponseRaw: Boolean!) {
  replayEntry(id: $id) {
    ...ReplayEntryFull
  }
}`;

const REPLAY_SESSION_QUERY = `
${REPLAY_SESSION_FRAGMENT}
query ReplaySession($id: ID!) {
  replaySession(id: $id) {
    ...ReplaySessionMeta
  }
}`;

const REPLAY_SESSIONS_QUERY = `
${REPLAY_SESSION_FRAGMENT}
query ReplaySessions($first: Int, $after: String, $last: Int, $before: String) {
  replaySessions(first: $first, after: $after, last: $last, before: $before) {
    edges { cursor node { ...ReplaySessionMeta } }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}`;

const REPLAY_SESSION_ENTRIES_QUERY = `
${REPLAY_ENTRY_FRAGMENT}
query ReplaySessionEntries($id: ID!, $after: String, $before: String, $first: Int, $last: Int, $includeReplayRaw: Boolean!, $includeRequestRaw: Boolean!, $includeResponseRaw: Boolean!) {
  replaySession(id: $id) {
    entries(after: $after, before: $before, first: $first, last: $last) {
      edges { cursor node { ...ReplayEntryFull } }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
}`;

const CREATE_REPLAY_SESSION = `
${REPLAY_SESSION_FRAGMENT}
mutation CreateReplaySession($input: CreateReplaySessionInput!) {
  createReplaySession(input: $input) {
    session { ...ReplaySessionMeta }
  }
}`;

const RENAME_REPLAY_SESSION = `
${REPLAY_SESSION_FRAGMENT}
mutation RenameReplaySession($id: ID!, $name: String!) {
  renameReplaySession(id: $id, name: $name) {
    session { ...ReplaySessionMeta }
  }
}`;

const MOVE_REPLAY_SESSION = `
${REPLAY_SESSION_FRAGMENT}
mutation MoveReplaySession($id: ID!, $collectionId: ID!) {
  moveReplaySession(id: $id, collectionId: $collectionId) {
    session { ...ReplaySessionMeta }
  }
}`;

const DELETE_REPLAY_SESSIONS = `
mutation DeleteReplaySessions($ids: [ID!]!) {
  deleteReplaySessions(ids: $ids) { deletedIds }
}`;

const REPLAY_COLLECTIONS_QUERY = `
query ReplaySessionCollections($first: Int, $after: String, $last: Int, $before: String) {
  replaySessionCollections(first: $first, after: $after, last: $last, before: $before) {
    edges { cursor node { id name } }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}`;

const CREATE_REPLAY_COLLECTION = `
mutation CreateReplaySessionCollection($input: CreateReplaySessionCollectionInput!) {
  createReplaySessionCollection(input: $input) {
    collection { id name }
  }
}`;

const RENAME_REPLAY_COLLECTION = `
mutation RenameReplaySessionCollection($id: ID!, $name: String!) {
  renameReplaySessionCollection(id: $id, name: $name) {
    collection { id name }
  }
}`;

const DELETE_REPLAY_COLLECTION = `
mutation DeleteReplaySessionCollection($id: ID!) {
  deleteReplaySessionCollection(id: $id) { deletedId }
}`;

const START_REPLAY_TASK_V056 = `
mutation StartReplayTask($sessionId: ID!, $input: StartReplayTaskInput!) {
  startReplayTask(sessionId: $sessionId, input: $input) {
    error { __typename }
    task {
      __typename
      id
      createdAt
      ... on ReplayTask { replayEntry { id } }
    }
  }
}`;

const START_REPLAY_TASK_V057 = `
mutation StartReplayTask($sessionId: ID!) {
  startReplayTask(sessionId: $sessionId) {
    error { __typename }
    task {
      __typename
      id
      createdAt
      ... on ReplayTask { replayEntry { id } }
    }
  }
}`;

const UPDATE_REPLAY_ENTRY_DRAFT_V057 = `
mutation UpdateReplayEntryDraft($id: ID!, $input: UpdateReplayEntryDraftInput!) {
  updateReplayEntryDraft(id: $id, input: $input) { entry { id } }
}`;

const UPDATE_REPLAY_SESSION_SETTINGS_V057 = `
mutation UpdateReplaySessionSettings($id: ID!, $input: ReplaySessionSettingsInput!) {
  updateReplaySessionSettings(id: $id, input: $input) { session { id } }
}`;

const REPLAY_SESSION_FOR_SEND_V057 = `
query ReplaySessionForSend($id: ID!) {
  replaySession(id: $id) {
    __typename
    ... on ReplaySessionHttp {
      id
      activeEntry { id }
      entries(last: 1) { edges { node { id } } }
      settings { connectionClose updateContentLength }
    }
  }
}`;

const REPLAY_SESSION_META_INLINE_V057 = `
  __typename
  ... on ReplaySessionHttp {
    id
    name
    collection { id }
    activeEntry { id }
  }
  ... on ReplaySessionWs {
    id
    name
    collection { id }
    activeEntry { id }
  }`;

const REPLAY_ENTRY_HTTP_INLINE_V057 = `
  __typename
  ... on ReplayEntryHttp {
    connection { ...ConnectionInfoFull }
    createdAt
    error
    id
    raw @include(if: $includeReplayRaw)
    request { ...RequestFull }
    session { id }
  }`;

const REPLAY_ENTRY_QUERY_V057 = `
${CONNECTION_FRAGMENT}
${REQUEST_FULL_FRAGMENT}
query ReplayEntry($id: ID!, $sessionKind: ReplaySessionKind!, $includeReplayRaw: Boolean!, $includeRequestRaw: Boolean!, $includeResponseRaw: Boolean!) {
  replayEntry(id: $id, sessionKind: $sessionKind) {${REPLAY_ENTRY_HTTP_INLINE_V057}
  }
}`;

const REPLAY_SESSION_QUERY_V057 = `
query ReplaySession($id: ID!) {
  replaySession(id: $id) {${REPLAY_SESSION_META_INLINE_V057}
  }
}`;

const REPLAY_SESSIONS_QUERY_V057 = `
query ReplaySessions($first: Int, $after: String, $last: Int, $before: String) {
  replaySessions(first: $first, after: $after, last: $last, before: $before) {
    edges { cursor node {${REPLAY_SESSION_META_INLINE_V057}
    } }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}`;

const REPLAY_SESSION_ENTRIES_QUERY_V057 = `
${CONNECTION_FRAGMENT}
${REQUEST_FULL_FRAGMENT}
query ReplaySessionEntries($id: ID!, $after: String, $before: String, $first: Int, $last: Int, $includeReplayRaw: Boolean!, $includeRequestRaw: Boolean!, $includeResponseRaw: Boolean!) {
  replaySession(id: $id) {
    ... on ReplaySessionHttp {
      entries(after: $after, before: $before, first: $first, last: $last) {
        edges { cursor node {${REPLAY_ENTRY_HTTP_INLINE_V057}
        } }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
}`;

const CREATE_REPLAY_SESSION_V057 = `
mutation CreateReplaySession($input: CreateReplaySessionInput!) {
  createReplaySession(input: $input) {
    session {${REPLAY_SESSION_META_INLINE_V057}
    }
  }
}`;

const RENAME_REPLAY_SESSION_V057 = `
mutation RenameReplaySession($id: ID!, $name: String!) {
  renameReplaySession(id: $id, name: $name) {
    session {${REPLAY_SESSION_META_INLINE_V057}
    }
  }
}`;

const MOVE_REPLAY_SESSION_V057 = `
mutation MoveReplaySession($id: ID!, $collectionId: ID!) {
  moveReplaySession(id: $id, collectionId: $collectionId) {
    session {${REPLAY_SESSION_META_INLINE_V057}
    }
  }
}`;

const TASK_FINISHED_SUBSCRIPTION = `
subscription FinishedTask {
  finishedTask {
    task {
      __typename
      id
      createdAt
      ... on ReplayTask { replayEntry { id } }
    }
    status
    error { code }
  }
}`;

const TASKS_QUERY = `
query Tasks {
  tasks {
    __typename
    id
    createdAt
    ... on ReplayTask { replayEntry { id } }
  }
}`;

const CANCEL_TASK = `
mutation cancelTask($id: ID!) {
  cancelTask(id: $id) {
    cancelledId
    error { __typename }
  }
}`;

const FINDING_FRAGMENT = `
fragment FindingFull on Finding {
  id
  request { id }
  title
  reporter
  description
  dedupeKey
  host
  path
  hidden
  createdAt
}`;

const FINDINGS_QUERY = `
${FINDING_FRAGMENT}
query Findings($first: Int, $after: String, $last: Int, $before: String, $filter: FilterClauseFindingInput, $order: FindingOrderInput) {
  findings(first: $first, after: $after, last: $last, before: $before, filter: $filter, order: $order) {
    edges { cursor node { ...FindingFull } }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}`;

const FINDING_QUERY = `
${FINDING_FRAGMENT}
query Finding($id: ID!) {
  finding(id: $id) { ...FindingFull }
}`;

const DELETE_FINDINGS = `
mutation DeleteFindings($input: DeleteFindingsInput!) {
  deleteFindings(input: $input) { deletedIds }
}`;

const CREATE_FINDING = `
${FINDING_FRAGMENT}
mutation CreateFinding($requestId: ID!, $input: CreateFindingInput!) {
  createFinding(requestId: $requestId, input: $input) {
    error { __typename }
    finding { ...FindingFull }
  }
}`;

const UPDATE_FINDING = `
${FINDING_FRAGMENT}
mutation UpdateFinding($id: ID!, $input: UpdateFindingInput!) {
  updateFinding(id: $id, input: $input) {
    error { __typename }
    finding { ...FindingFull }
  }
}`;

const SCOPE_FRAGMENT = `
fragment ScopeFull on Scope {
  id
  name
  allowlist
  denylist
  indexed
}`;

const SCOPES_QUERY = `${SCOPE_FRAGMENT} query Scopes { scopes { ...ScopeFull } }`;
const SCOPE_QUERY = `${SCOPE_FRAGMENT} query Scope($id: ID!) { scope(id: $id) { ...ScopeFull } }`;
const CREATE_SCOPE = `${SCOPE_FRAGMENT} mutation CreateScope($input: CreateScopeInput!) { createScope(input: $input) { error { __typename } scope { ...ScopeFull } } }`;
const UPDATE_SCOPE = `${SCOPE_FRAGMENT} mutation UpdateScope($id: ID!, $input: UpdateScopeInput!) { updateScope(id: $id, input: $input) { error { __typename } scope { ...ScopeFull } } }`;
const DELETE_SCOPE = `mutation DeleteScope($id: ID!) { deleteScope(id: $id) { deletedId } }`;

const FILTER_FRAGMENT = `
fragment FilterPresetFull on FilterPreset {
  id
  name
  alias
  clause {
    ... on HTTPQL { __typename code }
    ... on StreamQL { __typename code }
  }
}`;

const FILTERS_QUERY = `${FILTER_FRAGMENT} query FilterPresets { filterPresets { ...FilterPresetFull } }`;
const FILTER_QUERY = `${FILTER_FRAGMENT} query FilterPreset($id: ID!) { filterPreset(id: $id) { ...FilterPresetFull } }`;
const CREATE_FILTER = `${FILTER_FRAGMENT} mutation CreateFilterPreset($input: CreateFilterPresetInput!) { createFilterPreset(input: $input) { error { __typename } filter { ...FilterPresetFull } } }`;
const UPDATE_FILTER = `${FILTER_FRAGMENT} mutation UpdateFilterPreset($id: ID!, $input: UpdateFilterPresetInput!) { updateFilterPreset(id: $id, input: $input) { error { __typename } filter { ...FilterPresetFull } } }`;
const DELETE_FILTER = `mutation DeleteFilterPreset($id: ID!) { deleteFilterPreset(id: $id) { deletedId } }`;

const ENV_FRAGMENT = `
fragment EnvironmentFull on Environment {
  id
  name
  variables { name value kind }
  version
}`;

const ENVS_QUERY = `${ENV_FRAGMENT} query Environments { environments { ...EnvironmentFull } }`;
const ENV_QUERY = `${ENV_FRAGMENT} query EnvironmentQuery($id: ID!) { environment(id: $id) { ...EnvironmentFull } }`;
const CREATE_ENV = `${ENV_FRAGMENT} mutation CreateEnvironment($input: CreateEnvironmentInput!) { createEnvironment(input: $input) { error { __typename } environment { ...EnvironmentFull } } }`;
const UPDATE_ENV = `${ENV_FRAGMENT} mutation UpdateEnvironment($id: ID!, $input: UpdateEnvironmentInput!) { updateEnvironment(id: $id, input: $input) { error { __typename } environment { ...EnvironmentFull } } }`;
const DELETE_ENV = `mutation DeleteEnvironment($id: ID!) { deleteEnvironment(id: $id) { deletedId error { __typename } } }`;
const SELECT_ENV = `${ENV_FRAGMENT} mutation SelectEnvironment($id: ID) { selectEnvironment(id: $id) { error { __typename } environment { ...EnvironmentFull } } }`;

const PROJECT_FRAGMENT = `
fragment ProjectFull on Project {
  id
  name
  path
  status
  temporary
  createdAt
  updatedAt
  version
  size
  readOnly
}`;

const PROJECTS_QUERY = `${PROJECT_FRAGMENT} query Projects { projects { ...ProjectFull } }`;
const SELECT_PROJECT = `${PROJECT_FRAGMENT} mutation SelectProject($id: ID!) { selectProject(id: $id) { currentProject { project { ...ProjectFull } } error { __typename } } }`;

const CURRENT_PROJECT_QUERY = `
query CurrentProject {
  currentProject { project { id name } }
}`;

const HOSTED_FILES_QUERY = `
query HostedFiles {
  hostedFiles { id name path size status createdAt updatedAt }
}`;

const DELETE_HOSTED_FILE = `mutation DeleteHostedFile($id: ID!) { deleteHostedFile(id: $id) { deletedId } }`;

const UPLOAD_HOSTED_FILE = `
mutation UploadHostedFile($input: UploadHostedFileInput!) {
  uploadHostedFile(input: $input) {
    hostedFile { id name path size status createdAt updatedAt }
  }
}`;

const START_REPLAY_TASK = `
mutation StartReplayTask($sessionId: ID!) {
  startReplayTask(sessionId: $sessionId) {
    task { id createdAt sessionKind replayEntry { id error } }
    error { __typename ... on OtherUserError { code } }
  }
}`;

const SEND_REPLAY_TASK_MESSAGE = `
mutation SendReplayTaskMessage($task: ID!, $input: SendReplayTaskMessageInput!) {
  sendReplayTaskMessage(task: $task, input: $input) {
    message { ... on StreamWsMessage { id direction format length createdAt } }
    error { __typename ... on OtherUserError { code } }
  }
}`;

const STOP_REPLAY_WS_TASKS = `
mutation StopReplayWsTasks($taskIds: [ID!]!) {
  stopReplayWsTasks(taskIds: $taskIds) { taskIds }
}`;

const DNS_REWRITE_FIELDS = `
  id
  enabled
  allowlist
  denylist
  resolution {
    __typename
    ... on DNSIpResolver { ip }
    ... on DNSUpstreamResolver { id }
  }`;

const DNS_REWRITES_QUERY = `query DnsRewrites { dnsRewrites { ${DNS_REWRITE_FIELDS} } }`;
const DNS_UPSTREAMS_QUERY = `query DnsUpstreams { dnsUpstreams { id name ip } }`;

const CREATE_DNS_REWRITE = `
mutation CreateDnsRewrite($input: CreateDNSRewriteInput!) {
  createDnsRewrite(input: $input) { rewrite { ${DNS_REWRITE_FIELDS} } error { __typename } }
}`;

const UPDATE_DNS_REWRITE = `
mutation UpdateDnsRewrite($id: ID!, $input: UpdateDNSRewriteInput!) {
  updateDnsRewrite(id: $id, input: $input) { rewrite { ${DNS_REWRITE_FIELDS} } error { __typename } }
}`;

const TOGGLE_DNS_REWRITE = `
mutation ToggleDnsRewrite($id: ID!, $enabled: Boolean!) {
  toggleDnsRewrite(id: $id, enabled: $enabled) { rewrite { ${DNS_REWRITE_FIELDS} } }
}`;

const DELETE_DNS_REWRITE = `mutation DeleteDnsRewrite($id: ID!) { deleteDnsRewrite(id: $id) { deletedId } }`;

const CREATE_DNS_UPSTREAM = `
mutation CreateDnsUpstream($input: CreateDNSUpstreamInput!) {
  createDnsUpstream(input: $input) { upstream { id name ip } error { __typename } }
}`;

const UPDATE_DNS_UPSTREAM = `
mutation UpdateDnsUpstream($id: ID!, $input: UpdateDNSUpstreamInput!) {
  updateDnsUpstream(id: $id, input: $input) { upstream { id name ip } error { __typename } }
}`;

const DELETE_DNS_UPSTREAM = `mutation DeleteDnsUpstream($id: ID!) { deleteDnsUpstream(id: $id) { deletedId } }`;

const CREATE_PROJECT = `
mutation CreateProject($input: CreateProjectInput!) {
  createProject(input: $input) { project { id name temporary status path size createdAt } error { __typename } }
}`;

const RENAME_PROJECT = `
mutation RenameProject($id: ID!, $name: String!) {
  renameProject(id: $id, name: $name) { project { id name temporary } error { __typename } }
}`;

const PERSIST_PROJECT = `
mutation PersistProject($id: ID!) {
  persistProject(id: $id) { project { id name temporary } error { __typename } }
}`;

const DELETE_PROJECT = `mutation DeleteProject($id: ID!) { deleteProject(id: $id) { deletedId error { __typename } } }`;

const VIEWER_QUERY = `
query Viewer {
  viewer {
    ... on CloudUser {
      __typename
      id
      profile {
        identity { email name }
        subscription {
          plan { name }
          entitlements { name }
        }
      }
    }
    ... on GuestUser { __typename id }
    ... on ScriptUser { __typename id }
  }
}`;

const INTERCEPT_OPTIONS_QUERY = `
query {
  interceptOptions {
    request {
      enabled
      filter {
        ... on HTTPQL { code }
        ... on StreamQL { code }
      }
    }
    response {
      enabled
      filter {
        ... on HTTPQL { code }
        ... on StreamQL { code }
      }
    }
    scope { scopeId }
  }
}`;

const PAUSE_INTERCEPT = `mutation { pauseIntercept { status } }`;
const RESUME_INTERCEPT = `mutation { resumeIntercept { status } }`;

const PLUGIN_PACKAGES_QUERY = `
query {
  pluginPackages {
    id
    manifestId
    name
    version
    plugins {
      ... on PluginBackend { id manifestId name enabled state { running error } }
      ... on PluginFrontend { id manifestId name enabled }
      ... on PluginWorkflow { id manifestId name enabled }
    }
  }
}`;

const CREATE_AUTOMATE_SESSION = `
mutation($input: CreateAutomateSessionInput!) {
  createAutomateSession(input: $input) {
    session { id name connection { host port isTLS } raw }
  }
}`;

const GET_AUTOMATE_SESSION = `
query($id: ID!) {
  automateSession(id: $id) {
    id
    name
    connection { host port isTLS }
    raw
    settings { payloads { options { ... on AutomateSimpleListPayload { list } } } }
  }
}`;

const START_AUTOMATE_TASK = `
mutation($automateSessionId: ID!) {
  startAutomateTask(automateSessionId: $automateSessionId) {
    automateTask { id paused }
  }
}`;

// WebSocket and SSE traffic lives outside the request tables entirely, so
// search and recent are blind to it: a stream is not a request.
const STREAMS_QUERY = `
query Streams($first: Int, $after: String, $scopeId: ID, $filter: StreamQLInput) {
  streams(first: $first, after: $after, scopeId: $scopeId, filter: $filter) {
    edges {
      cursor
      node { id host port path isTls direction source protocol createdAt }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STREAM_MESSAGES_QUERY = `
query StreamWsMessages($streamId: ID, $first: Int, $after: String, $includeRaw: Boolean!, $filter: StreamQLInput) {
  streamWsMessages(streamId: $streamId, first: $first, after: $after, filter: $filter) {
    edges {
      cursor
      node {
        id
        head {
          id
          direction
          format
          length
          createdAt
          alteration
          raw @include(if: $includeRaw)
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SITEMAP_ENTRY_FRAGMENT = `
fragment SitemapEntryFull on SitemapEntry {
  id
  label
  kind
  parentId
  hasDescendants
  request { id method path query }
}`;

const SITEMAP_ROOTS_QUERY = `
${SITEMAP_ENTRY_FRAGMENT}
query SitemapRootEntries($scopeId: ID) {
  sitemapRootEntries(scopeId: $scopeId) {
    edges { node { ...SitemapEntryFull } }
  }
}`;

const SITEMAP_DESCENDANTS_QUERY = `
${SITEMAP_ENTRY_FRAGMENT}
query SitemapDescendantEntries($parentId: ID!, $depth: SitemapDescendantsDepth!) {
  sitemapDescendantEntries(parentId: $parentId, depth: $depth) {
    edges { node { ...SitemapEntryFull } }
  }
}`;

// Match-and-replace rules rewrite traffic the client never issued, so their
// effects otherwise read as the target's behaviour. Header and body operations
// are reported in full because those change meaning silently; the remaining
// sections report which part they rewrite.
const TAMPER_RULES_QUERY = `
fragment MatcherRawFull on TamperMatcherRaw {
  __typename
  ... on TamperMatcherValue { value }
  ... on TamperMatcherRegex { regex }
  ... on TamperMatcherFull { full }
}
fragment ReplacerFull on TamperReplacer {
  __typename
  ... on TamperReplacerTerm { term }
  ... on TamperReplacerWorkflow { id }
}
fragment HeaderOperation on TamperOperationHeader {
  __typename
  ... on TamperOperationHeaderRaw { matcher { ...MatcherRawFull } replacer { ...ReplacerFull } }
  ... on TamperOperationHeaderAdd { matcher { name } replacer { ...ReplacerFull } }
  ... on TamperOperationHeaderUpdate { matcher { name } replacer { ...ReplacerFull } }
  ... on TamperOperationHeaderRemove { matcher { name } }
}
fragment BodyOperation on TamperOperationBody {
  __typename
  ... on TamperOperationBodyRaw { matcher { ...MatcherRawFull } replacer { ...ReplacerFull } }
}
query TamperRules {
  tamperRuleCollections {
    id
    name
    rules {
      id
      name
      sources
      enable { rank }
      condition {
        __typename
        ... on HTTPQL { code }
        ... on StreamQL { code }
      }
      section {
        __typename
        ... on TamperSectionRequestHeader { operation { ...HeaderOperation } }
        ... on TamperSectionResponseHeader { operation { ...HeaderOperation } }
        ... on TamperSectionRequestBody { operation { ...BodyOperation } }
        ... on TamperSectionResponseBody { operation { ...BodyOperation } }
      }
    }
  }
}`;

const TAMPER_RULE_RESULT = `
    id
    name
    sources
    enable { rank }
    condition { __typename ... on HTTPQL { code } ... on StreamQL { code } }
    section { __typename }
    collection { id name }`;

const CREATE_TAMPER_RULE = `
mutation CreateTamperRule($input: CreateTamperRuleInput!) {
  createTamperRule(input: $input) {
    error { __typename }
    rule {${TAMPER_RULE_RESULT}
    }
  }
}`;

const UPDATE_TAMPER_RULE = `
mutation UpdateTamperRule($id: ID!, $input: UpdateTamperRuleInput!) {
  updateTamperRule(id: $id, input: $input) {
    error { __typename }
    rule {${TAMPER_RULE_RESULT}
    }
  }
}`;

const RENAME_TAMPER_RULE = `
mutation RenameTamperRule($id: ID!, $name: String!) {
  renameTamperRule(id: $id, name: $name) {
    rule {${TAMPER_RULE_RESULT}
    }
  }
}`;

const TOGGLE_TAMPER_RULE = `
mutation ToggleTamperRule($id: ID!, $enabled: Boolean!) {
  toggleTamperRule(id: $id, enabled: $enabled) {
    error { __typename }
    rule {${TAMPER_RULE_RESULT}
    }
  }
}`;

const MOVE_TAMPER_RULE = `
mutation MoveTamperRule($id: ID!, $collectionId: ID!) {
  moveTamperRule(id: $id, collectionId: $collectionId) {
    rule {${TAMPER_RULE_RESULT}
    }
  }
}`;

const DELETE_TAMPER_RULE = `mutation DeleteTamperRule($id: ID!) { deleteTamperRule(id: $id) { deletedId } }`;

const TAMPER_RULE_QUERY = `
query TamperRule($id: ID!) {
  tamperRule(id: $id) {${TAMPER_RULE_RESULT}
  }
}`;

const CREATE_TAMPER_COLLECTION = `
mutation CreateTamperRuleCollection($input: CreateTamperRuleCollectionInput!) {
  createTamperRuleCollection(input: $input) { collection { id name } }
}`;

const RENAME_TAMPER_COLLECTION = `
mutation RenameTamperRuleCollection($id: ID!, $name: String!) {
  renameTamperRuleCollection(id: $id, name: $name) { collection { id name } }
}`;

const DELETE_TAMPER_COLLECTION = `
mutation DeleteTamperRuleCollection($id: ID!) {
  deleteTamperRuleCollection(id: $id) { deletedId }
}`;

const AUTH_START = `
mutation StartAuthenticationFlow {
  startAuthenticationFlow {
    request { id userCode verificationUrl expiresAt }
    error { __typename }
  }
}`;

const AUTH_CREATED_TOKEN = `
subscription CreatedAuthenticationToken($requestId: ID!) {
  createdAuthenticationToken(requestId: $requestId) {
    token { accessToken expiresAt refreshToken scopes }
    error { __typename }
  }
}`;

const AUTH_REFRESH = `
mutation RefreshAuthenticationToken($refreshToken: Token!) {
  refreshAuthenticationToken(refreshToken: $refreshToken) {
    token { accessToken expiresAt refreshToken scopes }
    error { __typename }
  }
}`;

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  if (DEBUG && err.stack) console.error(err.stack);
  process.exit(1);
});
