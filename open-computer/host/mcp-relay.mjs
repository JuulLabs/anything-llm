#!/usr/bin/env node
// Host-side MCP relay: mirrors host/llm-relay.mjs's per-agent isolation
// model (the guest never sees the real upstream URL/credentials — only this
// process does), but for MCP's actual wire shape rather than the OpenAI API,
// and with two DISTINCT credential boundaries instead of one:
//
//   guest <--[shared secret]--> this relay <--[OAuth / static token]--> upstream MCP server
//
// 1. Guest -> relay: a per-launch random secret (MCP_GUEST_SECRET, generated
//    fresh by host/launch-task.sh and never written to any persistent host
//    file — see that script). Binding to 127.0.0.1 keeps OTHER machines out,
//    but not other processes/agents on the SAME host; the shared secret is
//    what actually pairs one guest VM to one relay. Requests without it are
//    401ed before we even look at the upstream, and the header is stripped
//    (never forwarded) either way.
// 2. Relay -> upstream: per-user OAuth tokens from the host-side cache
//    written by host/mcp-oauth.mjs (interactive authorization_code + PKCE
//    login, run by host/launch-task.sh before this relay starts). This relay
//    never runs the interactive flow itself — it only reads the cache file
//    (MCP_TOKEN_CACHE_FILE) and performs refresh_token grants against the
//    cached token endpoint, adopting rotated refresh tokens. Static API keys
//    are deliberately NOT supported on this leg.
//
// Unlike the OpenAI API — a REST tree rooted at /v1 with many endpoints —
// MCP's Streamable HTTP transport exposes exactly ONE endpoint URL per
// server (e.g. https://example.com/mcp) that handles POST (JSON-RPC
// requests) and, depending on server/protocol-version, GET (opens an SSE
// stream) and DELETE (session termination). See:
// https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http
// There is no "/v1 prefix" convention to strip — every request is simply
// forwarded to the exact configured upstream URL, regardless of the path
// the guest happened to use to reach this relay. This is a deliberate
// design choice (verified against the spec above), not an oversight: it
// sidesteps entirely the class of path-doubling bug llm-relay.mjs hit.
//
// MCP protocol/session headers (Mcp-Session-Id, MCP-Protocol-Version,
// Mcp-Method, Mcp-Name, Accept, etc.) are passed through verbatim in both
// directions — this relay does not need to understand them, only forward
// them faithfully. Request bodies ARE buffered (not streamed) so a 401 from
// upstream can be retried once with a refreshed OAuth token using the same
// body; this is a deliberate trade-off given typical JSON-RPC body sizes.
// Response bodies remain piped unbuffered so SSE streams flow live.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { TokenStore, canonicalResource } from './mcp-oauth.mjs';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.MCP_RELAY_PORT ?? '4200', 10);
const UPSTREAM_MCP_URL = process.env.UPSTREAM_MCP_URL ?? '';
const MCP_GUEST_SECRET = process.env.MCP_GUEST_SECRET ?? '';
const MCP_TOKEN_CACHE_FILE = process.env.MCP_TOKEN_CACHE_FILE ?? '';

function parseUrl(raw, label) {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch (err) {
    console.error(`[mcp-relay] invalid ${label} '${raw}': ${err.message}`);
    return null;
  }
}

let upstream = parseUrl(UPSTREAM_MCP_URL, 'UPSTREAM_MCP_URL');
if (UPSTREAM_MCP_URL && !upstream) {
  console.error('[mcp-relay] starting anyway, but every request will fail until UPSTREAM_MCP_URL is valid.');
} else if (!UPSTREAM_MCP_URL) {
  console.error('[mcp-relay] UPSTREAM_MCP_URL is not set — every request will fail until it is configured.');
}

// upstream never changes after startup, so precompute its request shape once
// rather than on every request.
const upstreamIsHttps = upstream?.protocol === 'https:';
const upstreamTransport = upstreamIsHttps ? https : http;
const upstreamDefaultPort = upstreamIsHttps ? 443 : 80;
const upstreamTargetPath = upstream ? `${upstream.pathname}${upstream.search}` : '';
const upstreamTargetUrl = upstream ? `${upstream.protocol}//${upstream.host}${upstreamTargetPath}` : '';

function log(method, reqPath, target, status) {
  const suffix = status === undefined ? '' : ` (${status})`;
  console.log(`[mcp-relay] ${method} ${reqPath} -> ${target}${suffix}`);
}

// ── OAuth token sourcing (host-side per-user cache, refresh-only) ───────────

const upstreamResource = upstream ? canonicalResource(upstream.href) : '';
const tokenStore = MCP_TOKEN_CACHE_FILE ? new TokenStore(MCP_TOKEN_CACHE_FILE) : null;

if (tokenStore) {
  console.log(`[mcp-relay] sourcing upstream credentials from the host token cache (${MCP_TOKEN_CACHE_FILE}); refreshes adopt rotated refresh tokens.`);
} else {
  console.log('[mcp-relay] no token cache configured (MCP_TOKEN_CACHE_FILE unset) — forwarding without an Authorization header.');
}

if (MCP_GUEST_SECRET) {
  console.log('[mcp-relay] guest requests must present MCP_GUEST_SECRET as a bearer token — mismatches get 401 before reaching upstream.');
} else {
  console.warn('[mcp-relay] MCP_GUEST_SECRET is not set — accepting ANY loopback request unauthenticated (fine for local testing only).');
}

async function resolveUpstreamToken() {
  if (tokenStore) return tokenStore.getAccessToken(upstreamResource);
  return null;
}

// ── Guest <-> relay shared-secret check ─────────────────────────────────────

function extractBearer(headerValue) {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1] : null;
}

// Constant-time comparison. Buffer.byteLength differing is itself not a
// meaningful secret leak for a 64-hex-char random value, but we still avoid
// a length-based short-circuit before calling timingSafeEqual.
function secretsMatch(provided, expected) {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// ── Request handling ────────────────────────────────────────────────────────

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Issues exactly one upstream HTTP call with the given bearer token (or none)
// and resolves with the raw http(s) response, so the caller can decide
// whether to retry (401 + OAuth) or pipe it straight through.
function forwardOnce(method, guestHeaders, bodyBuffer, bearerToken) {
  return new Promise((resolve, reject) => {
    const headers = { ...guestHeaders, host: upstream.host, 'content-length': String(bodyBuffer.length) };
    delete headers['transfer-encoding'];
    if (bearerToken) {
      headers.authorization = `Bearer ${bearerToken}`;
    } else {
      // Never forward the guest's shared secret (or anything else) upstream
      // when there's no real upstream credential configured.
      delete headers.authorization;
    }
    const upstreamReq = upstreamTransport.request({
      hostname: upstream.hostname,
      port: upstream.port || upstreamDefaultPort,
      path: upstreamTargetPath,
      method,
      headers,
    }, resolve);
    upstreamReq.on('error', reject);
    upstreamReq.end(bodyBuffer);
  });
}

async function handleRequest(req, res) {
  const reqPath = req.url ?? '/';

  if (!upstream) {
    log(req.method, reqPath, '(no upstream configured)', 502);
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end('MCP relay has no upstream configured (UPSTREAM_MCP_URL unset/invalid).\n');
    return;
  }

  if (MCP_GUEST_SECRET) {
    const provided = extractBearer(req.headers.authorization);
    if (!provided || !secretsMatch(provided, MCP_GUEST_SECRET)) {
      log(req.method, reqPath, '(missing/incorrect guest secret)', 401);
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized: missing or incorrect guest secret.\n');
      return;
    }
  }

  const bodyBuffer = await collectRequestBody(req);

  let bearerToken;
  try {
    bearerToken = await resolveUpstreamToken();
  } catch (err) {
    console.error(`[mcp-relay] failed to obtain an upstream OAuth token: ${err.message}`);
    log(req.method, reqPath, '(oauth token error)', 502);
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`MCP relay could not obtain an upstream OAuth token: ${err.message}\n`);
    return;
  }

  log(req.method, reqPath, upstreamTargetUrl);
  let upstreamRes = await forwardOnce(req.method, req.headers, bodyBuffer, bearerToken);

  if (upstreamRes.statusCode === 401 && tokenStore) {
    console.log('[mcp-relay] upstream returned 401 — refreshing OAuth token and retrying once.');
    upstreamRes.resume(); // discard the 401 body; we're not forwarding it
    let freshToken;
    try {
      freshToken = await tokenStore.getAccessToken(upstreamResource, { forceRefresh: true });
    } catch (err) {
      console.error(`[mcp-relay] OAuth refresh-on-401 failed: ${err.message}`);
      log(req.method, reqPath, upstreamTargetUrl, 401);
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Upstream rejected the request and the OAuth token refresh also failed.\n');
      return;
    }
    upstreamRes = await forwardOnce(req.method, req.headers, bodyBuffer, freshToken);
  }

  log(req.method, reqPath, upstreamTargetUrl, upstreamRes.statusCode);
  res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
  // Unbuffered pipe: keeps SSE (text/event-stream) responses streaming live.
  upstreamRes.pipe(res);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[mcp-relay] unhandled error for ${req.method} ${req.url}: ${err.stack || err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    if (!res.writableEnded) res.end(`Relay error: ${err.message}\n`);
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[mcp-relay] mcp relay listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_MCP_URL || '(unconfigured)'}`);
});
