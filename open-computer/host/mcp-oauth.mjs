#!/usr/bin/env node
// Interactive per-user OAuth for the host->backend MCP leg, implementing the
// MCP authorization spec the way mcp-remote does:
//
//   1. Hit the MCP URL; on 401, use WWW-Authenticate + protected resource
//      metadata (RFC 9728) to find the authorization server, then RFC 8414
//      metadata discovery to find its endpoints.
//   2. Dynamic client registration (RFC 7591) when no client is cached for
//      that authorization server.
//   3. authorization_code + PKCE (S256) through a temporary localhost
//      callback server, opening the user's browser.
//   4. Token persistence on the HOST only, keyed by (user, authorization
//      server), with refresh-token ROTATION: every token response's
//      refresh_token replaces the stored one (Atlassian rotates; reusing the
//      old one breaks the second refresh).
//
// Nothing here ever crosses into the guest — the guest leg stays the
// per-launch shared secret owned by host/launch-task.sh + host/mcp-relay.mjs.
//
// Usable both as a library (host/mcp-relay.mjs imports TokenStore) and as a
// CLI: `node host/mcp-oauth.mjs login --mcp-url <url>` runs the interactive
// login if needed (silent when cached tokens are still usable) and prints the
// cache file path on stdout — everything human-facing goes to stderr.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { URL, URLSearchParams } from 'node:url';

const CACHE_ROOT = path.join(os.homedir(), '.open-computer', 'mcp-auth');
// Refresh this many ms before expiry so a request started just under the
// wire doesn't race a token that expires mid-flight (same policy the old
// relay-side manager used).
const TOKEN_REFRESH_SKEW_MS = 30_000;
// RFC 6749 doesn't require expires_in; assume a conservative 5 minutes if a
// token endpoint omits it, rather than caching forever.
const DEFAULT_EXPIRES_IN_S = 300;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

// Single seam for future multi-user support: everything downstream keys off
// this value, so supporting other users is a matter of resolving a different
// name here, not restructuring the cache.
export function resolveUser() {
  return os.userInfo().username;
}

// RFC 8707 resource indicator: the canonical MCP server URL (no fragment).
export function canonicalResource(mcpUrl) {
  const u = new URL(mcpUrl);
  u.hash = '';
  return u.href;
}

export function cacheFilePath(user, authorizationServer) {
  const key = crypto.createHash('sha256').update(authorizationServer).digest('hex').slice(0, 16);
  return path.join(CACHE_ROOT, user, `${key}.json`);
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`could not read token cache ${file}: ${err.message}`);
  }
}

function writeJsonPrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Atomic replace so a concurrent reader never sees a torn file, and mode
  // 0600 from birth so the tokens are never world-readable even briefly.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} returned ${res.status}: ${body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`${url} response was not valid JSON: ${err.message}`);
  }
}

// ── Discovery (RFC 9728 + RFC 8414) ─────────────────────────────────────────

function wellKnownCandidates(baseUrl, suffix) {
  // RFC 8414 path insertion: /.well-known/<suffix> goes between host and any
  // path component; a root fallback covers servers that ignore the path rule.
  const u = new URL(baseUrl);
  const pathPart = u.pathname.replace(/\/$/, '');
  const candidates = [`${u.origin}/.well-known/${suffix}${pathPart}`];
  if (pathPart) candidates.push(`${u.origin}/.well-known/${suffix}`);
  return candidates;
}

async function firstJson(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('no discovery URLs to try');
}

export function parseResourceMetadataUrl(wwwAuthenticate) {
  if (!wwwAuthenticate) return null;
  const m = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate);
  return m ? m[1] : null;
}

export async function discover(mcpUrl) {
  const resource = canonicalResource(mcpUrl);

  let resourceMetadataUrl = null;
  try {
    const probe = await fetch(resource, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' } });
    probe.body?.cancel?.();
    if (probe.status === 401) {
      resourceMetadataUrl = parseResourceMetadataUrl(probe.headers.get('www-authenticate'));
    }
  } catch {
    // Unreachable server surfaces as a discovery failure below with a
    // clearer message than the raw probe error.
  }

  // Preferred path: RFC 9728 protected resource metadata names the
  // authorization server. Some servers (Atlassian's hosted MCP among them)
  // predate PRM and serve no resource_metadata hint and no
  // oauth-protected-resource document — for those, fall back to the older
  // MCP auth spec behavior mcp-remote uses: the MCP server's own origin IS
  // the authorization server, and RFC 8414 discovery runs rooted there.
  let authorizationServer;
  let prm = null;
  try {
    prm = await firstJson(
      resourceMetadataUrl
        ? [resourceMetadataUrl]
        : wellKnownCandidates(resource, 'oauth-protected-resource'),
    );
  } catch {
    authorizationServer = new URL(resource).origin;
  }
  if (prm) {
    authorizationServer = prm.authorization_servers?.[0];
    if (!authorizationServer) {
      throw new Error(`protected resource metadata for ${resource} lists no authorization_servers`);
    }
  }

  const asMetadata = await firstJson([
    ...wellKnownCandidates(authorizationServer, 'oauth-authorization-server'),
    ...wellKnownCandidates(authorizationServer, 'openid-configuration'),
  ]);
  for (const field of ['authorization_endpoint', 'token_endpoint']) {
    if (!asMetadata[field]) throw new Error(`authorization server metadata for ${authorizationServer} has no ${field}`);
  }

  return {
    resource,
    authorizationServer,
    authorizationEndpoint: asMetadata.authorization_endpoint,
    tokenEndpoint: asMetadata.token_endpoint,
    registrationEndpoint: asMetadata.registration_endpoint ?? null,
    scope: prm?.scopes_supported?.join(' ') ?? null,
  };
}

// ── Token store (host-side cache, rotation-aware) ───────────────────────────

export class TokenStore {
  constructor(file) {
    this.file = file;
    // Dedupes concurrent callers into a single in-flight refresh instead of
    // a thundering herd that would burn the rotating refresh token.
    this.inFlight = null;
  }

  read() {
    return readJsonIfExists(this.file);
  }

  write(data) {
    writeJsonPrivate(this.file, data);
  }

  tokensFor(data, resource) {
    return data?.resources?.[resource] ?? null;
  }

  saveTokenResponse(resource, tokenResponse, previous = null) {
    const data = this.read() ?? {};
    const expiresInS = Number(tokenResponse.expires_in) > 0 ? Number(tokenResponse.expires_in) : DEFAULT_EXPIRES_IN_S;
    data.resources ??= {};
    data.resources[resource] = {
      access_token: tokenResponse.access_token,
      // Rotation: adopt the new refresh_token whenever the server returns
      // one; only fall back to the previous token when the response omits it
      // (servers that don't rotate).
      refresh_token: tokenResponse.refresh_token ?? previous?.refresh_token ?? null,
      expires_at: Date.now() + expiresInS * 1000,
    };
    this.write(data);
    return data.resources[resource];
  }

  async getAccessToken(resource, { forceRefresh = false } = {}) {
    if (!this.inFlight) {
      this.inFlight = this.#acquire(resource, forceRefresh).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async #acquire(resource, forceRefresh) {
    // Always re-read: another relay sharing this cache may have rotated the
    // refresh token since we last looked.
    const data = this.read();
    const tokens = this.tokensFor(data, resource);
    if (!tokens) {
      throw new Error(`no cached tokens for ${resource} in ${this.file} — run: node host/mcp-oauth.mjs login --mcp-url ${resource}`);
    }
    if (!forceRefresh && tokens.access_token && Date.now() < tokens.expires_at - TOKEN_REFRESH_SKEW_MS) {
      return tokens.access_token;
    }
    if (!tokens.refresh_token) {
      throw new Error(`access token for ${resource} expired and no refresh token is cached — run: node host/mcp-oauth.mjs login --mcp-url ${resource}`);
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: data.client.client_id,
      resource,
    });
    const tokenResponse = await fetchJson(data.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!tokenResponse.access_token) throw new Error('refresh response had no access_token field');
    return this.saveTokenResponse(resource, tokenResponse, tokens).access_token;
  }
}

// ── Dynamic client registration (RFC 7591) ──────────────────────────────────

async function registerClient(registrationEndpoint, redirectUri) {
  if (!registrationEndpoint) {
    throw new Error('authorization server offers no registration_endpoint and no client is cached — pre-register a client manually');
  }
  const registration = await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'open-computer',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!registration.client_id) throw new Error('client registration response had no client_id');
  return { client_id: registration.client_id, redirect_uri: redirectUri };
}

// ── Interactive authorization_code + PKCE flow ──────────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {}); // headless hosts fall back to the printed URL
  child.unref();
}

function listenOnLocalhost(preferredPort) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', () => {
      // Preferred port (from a cached registration) taken — a fresh
      // registration on an ephemeral port replaces it.
      const fallback = http.createServer();
      fallback.listen(0, '127.0.0.1', () => resolve({ server: fallback, reused: false }));
    });
    server.listen(preferredPort ?? 0, '127.0.0.1', () => resolve({ server, reused: preferredPort != null }));
  });
}

function waitForCallback(server, expectedState) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`timed out after ${CALLBACK_TIMEOUT_MS / 1000}s waiting for the browser authorization to complete`));
    }, CALLBACK_TIMEOUT_MS);
    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const finish = (msg, err) => {
        res.writeHead(err ? 400 : 200, { 'Content-Type': 'text/html' })
          .end(`<html><body><p>${msg}</p><p>You can close this tab.</p></body></html>`);
        clearTimeout(timer);
        server.close();
        if (err) reject(err); else resolve(u.searchParams.get('code'));
      };
      if (u.searchParams.get('state') !== expectedState) {
        finish('Login failed: state mismatch.', new Error('authorization callback state mismatch'));
      } else if (u.searchParams.get('error')) {
        const desc = u.searchParams.get('error_description') ?? u.searchParams.get('error');
        finish(`Login failed: ${desc}`, new Error(`authorization server returned error: ${desc}`));
      } else if (!u.searchParams.get('code')) {
        finish('Login failed: no authorization code in callback.', new Error('authorization callback had no code'));
      } else {
        finish('Login complete — open-computer has been authorized.');
      }
    });
  });
}

async function interactiveLogin(store, discovery) {
  const cached = store.read();
  const preferredPort = cached?.client?.redirect_uri ? Number(new URL(cached.client.redirect_uri).port) : null;
  const { server, reused } = await listenOnLocalhost(preferredPort);
  const redirectUri = `http://localhost:${server.address().port}/callback`;

  let client = reused && cached?.client ? cached.client : null;
  if (!client) {
    client = await registerClient(discovery.registrationEndpoint, redirectUri);
    console.error(`[mcp-oauth] registered OAuth client ${client.client_id} with ${discovery.authorizationServer}`);
  }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authorizeUrl = new URL(discovery.authorizationEndpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('resource', discovery.resource);
  if (discovery.scope) authorizeUrl.searchParams.set('scope', discovery.scope);

  console.error(`[mcp-oauth] opening your browser to authorize open-computer with ${discovery.authorizationServer}`);
  console.error(`[mcp-oauth] if it does not open, visit: ${authorizeUrl.href}`);
  openBrowser(authorizeUrl.href);

  const code = await waitForCallback(server, state);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: discovery.resource,
  });
  const tokenResponse = await fetchJson(discovery.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!tokenResponse.access_token) throw new Error('token response had no access_token field');

  store.write({
    ...(store.read() ?? {}),
    user: resolveUser(),
    authorization_server: discovery.authorizationServer,
    token_endpoint: discovery.tokenEndpoint,
    client,
  });
  store.saveTokenResponse(discovery.resource, tokenResponse);
  console.error('[mcp-oauth] login complete; tokens cached host-side.');
}

// Silent when the cache already has a usable access or refresh token for
// this (user, authorization server, resource); interactive otherwise.
// Returns the cache file path.
export async function ensureLogin(mcpUrl) {
  const discovery = await discover(mcpUrl);
  const user = resolveUser();
  const file = cacheFilePath(user, discovery.authorizationServer);
  const store = new TokenStore(file);

  const tokens = store.tokensFor(store.read(), discovery.resource);
  if (tokens?.access_token && Date.now() < tokens.expires_at - TOKEN_REFRESH_SKEW_MS) {
    return file;
  }
  if (tokens?.refresh_token) {
    try {
      await store.getAccessToken(discovery.resource, { forceRefresh: true });
      return file;
    } catch (err) {
      console.error(`[mcp-oauth] cached refresh token rejected (${err.message}) — falling back to interactive login.`);
    }
  }

  await interactiveLogin(store, discovery);
  return file;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'login') {
    console.error('Usage: mcp-oauth.mjs login --mcp-url <url>');
    process.exit(2);
  }
  let mcpUrl = null;
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--mcp-url') mcpUrl = rest[i + 1];
    else {
      console.error(`Unknown flag '${rest[i]}'`);
      process.exit(2);
    }
  }
  if (!mcpUrl) {
    console.error('Error: --mcp-url is required.');
    process.exit(2);
  }
  const file = await ensureLogin(mcpUrl);
  process.stdout.write(`${file}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[mcp-oauth] ${err.message}`);
    process.exit(1);
  });
}
