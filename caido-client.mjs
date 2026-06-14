#!/usr/bin/env node
/*
 * Dependency-free Caido CLI.
 *
 * Uses Node's built-in fetch and WebSocket instead of @caido/sdk-client,
 * graphql-tag, tsx, urql, or graphql-ws. Requires modern Node with global
 * fetch and WebSocket support; this skill documents Node 24+.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";

const DEBUG = process.env.DEBUG === "1";
const DEFAULT_CAIDO_URL = "http://localhost:8080";
const DEFAULT_CLOUD_API_URL = "https://api.caido.io";
const SECRETS_PATH = join(homedir(), ".claude", "config", "secrets.json");

const DEFAULT_OUTPUT_OPTS = {
  maxBodyLines: 200,
  maxBodyChars: 5000,
  noRequest: false,
  headersOnly: false,
};

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
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
    throw new Error(`GraphQL returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
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

  async graphql(query, variables = {}) {
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

function writeBinaryFile(filePath, data, force) {
  const absolutePath = resolve(filePath);
  if (existsSync(absolutePath) && !force) {
    die(`Error: ${absolutePath} already exists. Pass --force to overwrite.`);
  }
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  writeFileSync(absolutePath, data);
  return absolutePath;
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
    if (entry.raw) output.raw = formatHttpRaw(decodeRaw(entry.raw), opts);
    if (request?.raw) output.request.raw = formatHttpRaw(decodeRaw(request.raw), opts);
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
    if (result.entry.request?.response) output.response = responseOutput(result.entry.request.response, opts);
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

async function createReplaySession(client, requestSource, collectionId) {
  const version = await client.getServerVersion();
  const isV057 = versionGte(version, CAIDO_V057);
  const input = { requestSource };
  if (collectionId) input.collectionId = collectionId;
  if (isV057) input.kind = "HTTP";
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

async function sendReplay(client, sessionId, raw, connection) {
  const version = await client.getServerVersion();
  if (versionGte(version, CAIDO_V057)) {
    return sendReplayV057(client, sessionId, raw, connection);
  }
  return sendReplayV056(client, sessionId, raw, connection);
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

async function cmdSearch(filter, limit, after, idsOnly, desc) {
  const client = await getClient();
  const data = await client.graphql(REQUESTS_QUERY, {
    first: limit,
    after,
    filter: filter ? { code: filter } : undefined,
    order: desc ? { by: "ID", ordering: "DESC" } : undefined,
    includeRequestRaw: false,
    includeResponseRaw: false,
  });
  const edges = data.requests.edges;
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
    cursor: e.cursor,
  }));
  printJson({ results, pageInfo: data.requests.pageInfo, count: results.length });
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

async function cmdReplay(requestId, rawOverride, opts, overrides, collectionId) {
  const client = await getClient();
  const original = await getRequest(client, requestId, true, false);
  if (!original) die(`Request ${requestId} not found`);
  const session = await createReplaySession(client, { id: requestId }, collectionId);
  const raw = rawOverride ? await resolveRaw(rawOverride) : decodeRaw(original.raw);
  if (!raw) die("No raw data for this request");
  const connection = buildConnection(original.host, original.port, original.isTls, overrides);
  const result = await sendReplay(client, session.id, raw, connection);
  printJson(buildReplayOutput(session.id, result, opts));
}

async function cmdSendRaw(host, port, tls, raw, opts, overrides, collectionId, sessionName) {
  const client = await getClient();
  raw = await resolveRaw(raw);
  const connection = buildConnection(host, port, tls, overrides);
  const session = await createReplaySession(client, { raw: { connectionInfo: connection, raw: encodeRaw(raw) } }, collectionId);
  const finalSession = sessionName ? await renameReplaySession(client, session.id, sessionName) : session;
  const result = await sendReplay(client, finalSession.id, raw, connection);
  printJson(buildReplayOutput(finalSession.id, result, opts));
}

async function cmdEdit(requestId, edits, opts, overrides, collectionId) {
  const client = await getClient();
  const original = await getRequest(client, requestId, true, false);
  if (!original) die(`Request ${requestId} not found`);
  const raw = decodeRaw(original.raw);
  if (!raw) die("No raw data for this request");
  const modifiedRaw = applyRawEdits(raw, edits);
  const session = edits.sessionId
    ? { id: edits.sessionId }
    : await createReplaySession(client, { id: requestId }, collectionId);
  const connection = buildConnection(original.host, original.port, original.isTls, overrides);
  const result = await sendReplay(client, session.id, modifiedRaw, connection);
  printJson(buildReplayOutput(session.id, result, opts, modifiedRaw));
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

async function cmdCreateSession(requestId, collectionId) {
  const session = await createReplaySession(await getClient(), { id: requestId }, collectionId);
  printJson(sessionOutput(session));
}

async function cmdRenameSession(sessionId, name) {
  const session = await renameReplaySession(await getClient(), sessionId, name);
  printJson({ ...sessionOutput(session), renamed: true });
}

async function cmdMoveSession(sessionId, collectionId) {
  const client = await getClient();
  const version = await client.getServerVersion();
  const mutation = versionGte(version, CAIDO_V057) ? MOVE_REPLAY_SESSION_V057 : MOVE_REPLAY_SESSION;
  const data = await client.graphql(mutation, { id: sessionId, collectionId });
  const session = requirePayload(data.moveReplaySession, "session", "moveReplaySession");
  printJson({ ...sessionOutput(session), moved: true });
}

async function cmdDeleteSessions(ids) {
  const data = await (await getClient()).graphql(DELETE_REPLAY_SESSIONS, { ids });
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

async function cmdRenameCollection(collectionId, name) {
  const data = await (await getClient()).graphql(RENAME_REPLAY_COLLECTION, { id: collectionId, name });
  const collection = requirePayload(data.renameReplaySessionCollection, "collection", "renameReplaySessionCollection");
  printJson({ id: collection.id, name: collection.name, renamed: true });
}

async function cmdDeleteCollection(collectionId) {
  await (await getClient()).graphql(DELETE_REPLAY_COLLECTION, { id: collectionId });
  printJson({ deleted: collectionId });
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

async function cmdSelectProject(projectId) {
  const data = await (await getClient()).graphql(SELECT_PROJECT, { id: projectId });
  const err = firstPayloadError(data.selectProject);
  if (err) throw new Error(`selectProject failed: ${err}`);
  printJson({ selected: projectId });
}

async function cmdHostedFiles() {
  printJson((await (await getClient()).graphql(HOSTED_FILES_QUERY)).hostedFiles);
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
    printJson({
      authenticated: true,
      authMode,
      hasPat,
      hasAccessToken,
      hasRefreshToken,
      cachedTokenExpiresAt: cachedExpiresAt,
      cachedTokenValid,
      url: client.url,
      user: viewer,
      health,
    });
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
  search <filter> [--limit n] [--after cursor] [--ids-only] [--desc|--latest]
  recent [--limit n]
  get <request-id> [output options]
  get-response <request-id> [output options]
  download <request-id> --out file [--response|--request] [--body-only|--raw] [--force]
  export-curl <request-id>

Replay:
  replay <request-id> [--raw str|@file|-] [--collection id] [connection options] [output options]
  send-raw --host host --raw str|@file|- [--port n] [--tls|--no-tls] [--name name] [--collection id] [connection options] [output options]
  edit <request-id> [--method M] [--path p] [--set-header "N: V"] [--remove-header N] [--body b] [--replace from:::to] [--session id] [--collection id] [connection options] [output options]
  get-session <id-or-name> [output options]
  replay-entries <id-or-name> [--limit n] [--raw] [output options]
  edit-session <id-or-name> [edit options] [connection options] [output options]

Sessions and collections:
  create-session <request-id> [--collection id]
  rename-session <id> <name>
  move-session <id> <collection-id>
  replay-sessions [--limit n]
  delete-sessions <id,id,...>
  replay-collections [--limit n]
  create-collection <name>
  rename-collection <id> <name>
  delete-collection <id>

Other:
  findings | get-finding | create-finding | update-finding
  scopes | create-scope | update-scope | delete-scope
  filters | create-filter | update-filter | delete-filter
  envs | create-env | select-env | env-set | delete-env
  projects | select-project | hosted-files | delete-hosted-file
  tasks | cancel-task | intercept-status | intercept-enable | intercept-disable
  viewer | plugins | health | setup | auth-status

Output options:
  --max-body <n> --max-body-chars <n> --no-request --headers-only --compact

Connection options:
  --sni <host> --connect-host <host> --connect-port <port> --connect-tls --connect-no-tls

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
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
        else if (args[i] === "--after" && args[i + 1]) { after = args[i + 1]; i++; }
        else if (args[i] === "--ids-only") idsOnly = true;
        else if (args[i] === "--desc" || args[i] === "--latest") desc = true;
      }
      await cmdSearch(filter, limit, after, idsOnly, desc);
      break;
    }
    case "recent": {
      let limit = 20;
      for (let i = 1; i < args.length; i++) if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
      await cmdRecent(limit);
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
      await cmdReplay(args[1], rawOverride, parseOutputOpts(args, 2), parseConnectionOverrides(args, 2), parseCollectionId(args, 2));
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
      }
      await cmdEdit(args[1], { method, path, body, setHeaders, removeHeaders, replacements, sessionId }, parseOutputOpts(args, 2), parseConnectionOverrides(args, 2), parseCollectionId(args, 2));
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
      await cmdCreateSession(args[1], parseCollectionId(args, 2));
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
      if (!args[1]) die("Error: project id required");
      await cmdSelectProject(args[1]);
      break;
    }
    case "scopes": await cmdScopes(); break;
    case "create-scope": {
      if (!args[1]) die("Error: scope name required");
      let allow = [];
      let denyList = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--allow" && args[i + 1]) { allow = args[i + 1].split(",").map((s) => s.trim()).filter(Boolean); i++; }
        else if (args[i] === "--deny" && args[i + 1]) { denyList = args[i + 1].split(",").map((s) => s.trim()).filter(Boolean); i++; }
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
        else if (args[i] === "--allow" && args[i + 1]) { allow = args[i + 1].split(",").map((s) => s.trim()).filter(Boolean); i++; }
        else if (args[i] === "--deny" && args[i + 1]) { denyList = args[i + 1].split(",").map((s) => s.trim()).filter(Boolean); i++; }
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
    case "hosted-files": await cmdHostedFiles(); break;
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

const REQUEST_FULL_FRAGMENT = `
fragment ResponseFull on Response {
  id
  statusCode
  roundtripTime
  length
  createdAt
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

const HOSTED_FILES_QUERY = `
query HostedFiles {
  hostedFiles { id name path size status createdAt updatedAt }
}`;

const DELETE_HOSTED_FILE = `mutation DeleteHostedFile($id: ID!) { deleteHostedFile(id: $id) { deletedId } }`;

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
