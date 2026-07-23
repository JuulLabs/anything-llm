#!/usr/bin/env node
// Host-side LLM relay: the guest VM's OPENAI_BASE_URL always points at this
// process (via the 10.0.2.101 guestfwd pinhole), regardless of whether the
// real model is local (Ollama/LM Studio) or a remote cloud API. This process
// is the only thing that ever sees the real upstream URL/API key — the guest
// never does — so it can safely forward to any destination, local or remote.
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.RELAY_PORT ?? '4000', 10);
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL ?? '';
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY ?? '';

function parseUpstream(raw) {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch (err) {
    console.error(`[relay] invalid UPSTREAM_BASE_URL '${raw}': ${err.message}`);
    return null;
  }
}

let upstream = parseUpstream(UPSTREAM_BASE_URL);
if (UPSTREAM_BASE_URL && !upstream) {
  console.error('[relay] starting anyway, but every request will fail until UPSTREAM_BASE_URL is valid.');
} else if (!UPSTREAM_BASE_URL) {
  console.error('[relay] UPSTREAM_BASE_URL is not set — every request will fail until it is configured.');
}

function log(method, reqPath, target, status) {
  const suffix = status === undefined ? '' : ` (${status})`;
  console.log(`[relay] ${method} ${reqPath} -> ${target}${suffix}`);
}

// The guest's OPENAI_BASE_URL always points at this relay with a `/v1`
// suffix (e.g. http://localhost:<port>/v1), so incoming request paths are
// always prefixed with /v1 (e.g. /v1/chat/completions). UPSTREAM_BASE_URL
// carries its own real API-root suffix (also usually /v1), so strip the
// guest-side /v1 before appending — otherwise it doubles up.
function targetUrlFor(reqPath) {
  const stripped = reqPath.replace(/^\/v1(?=\/|$)/, '');
  const basePath = upstream.pathname.replace(/\/$/, '');
  const suffix = stripped.startsWith('/') ? stripped : `/${stripped}`;
  return `${basePath}${suffix}`;
}

const server = http.createServer((req, res) => {
  const reqPath = req.url ?? '/';

  if (!upstream) {
    log(req.method, reqPath, '(no upstream configured)', 502);
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end('LLM relay has no upstream configured (UPSTREAM_BASE_URL unset/invalid).\n');
    return;
  }

  const targetPath = targetUrlFor(reqPath);
  const isHttps = upstream.protocol === 'https:';
  const transport = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;
  const target = `${upstream.protocol}//${upstream.host}${targetPath}`;

  const headers = { ...req.headers, host: upstream.host };
  if (UPSTREAM_API_KEY) {
    // Overrides whatever the guest sent — it never has the real key.
    headers.authorization = `Bearer ${UPSTREAM_API_KEY}`;
  }
  // else: pass through the incoming Authorization header as-is (local
  // providers like Ollama/LM Studio typically ignore it, but some setups
  // still expect a placeholder).

  log(req.method, reqPath, target);

  const upstreamReq = transport.request({
    hostname: upstream.hostname,
    port: upstream.port || defaultPort,
    path: targetPath,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    log(req.method, reqPath, target, upstreamRes.statusCode);
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    console.error(`[relay] upstream error for ${target}: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Upstream error: ${err.message}\n`);
  });

  req.on('error', () => upstreamReq.destroy());
  req.pipe(upstreamReq);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[relay] llm relay listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_BASE_URL || '(unconfigured)'}`);
});
