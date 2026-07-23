#!/usr/bin/env node
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.PROXY_PORT ?? '3128', 10);
const ALLOWLIST_FILE = process.env.ALLOWLIST_FILE ?? path.join(HERE, 'allowlist.txt');

function loadAllowlist() {
  const domains = new Set();
  try {
    for (const line of fs.readFileSync(ALLOWLIST_FILE, 'utf8').split('\n')) {
      const d = line.replace(/#.*$/, '').trim().toLowerCase();
      if (d) domains.add(d);
    }
  } catch (err) {
    console.error(`[proxy] cannot read allowlist ${ALLOWLIST_FILE}: ${err.message}`);
  }
  return domains;
}

let allowlist = loadAllowlist();
fs.watchFile(ALLOWLIST_FILE, { interval: 5000 }, () => {
  allowlist = loadAllowlist();
  console.log(`[proxy] allowlist reloaded (${allowlist.size} domains)`);
});

function isAllowed(host) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (allowlist.has(h)) return true;
  for (const entry of allowlist) {
    if (!entry.startsWith('*.')) continue;
    const suffix = entry.slice(1);
    if (h.endsWith(suffix) && h.length > suffix.length) {
      return true;
    }
  }
  return false;
}

function log(verdict, method, target) {
  console.log(`[proxy] ${verdict} ${method} ${target}`);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end('Bad request\n');
    return;
  }
  if (!isAllowed(url.hostname)) {
    log('DENY', req.method, url.hostname);
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`Blocked by whitelist proxy: ${url.hostname}\n`);
    return;
  }
  log('ALLOW', req.method, url.hostname);
  const upstream = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: url.host },
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    res.writeHead(502).end(`Upstream error: ${err.message}\n`);
  });
  req.pipe(upstream);
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = (req.url ?? '').split(':');
  const port = parseInt(portStr ?? '443', 10) || 443;
  if (!isAllowed(host)) {
    log('DENY', 'CONNECT', `${host}:${port}`);
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  log('ALLOW', 'CONNECT', `${host}:${port}`);
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', (err) => {
    log('ERROR', 'CONNECT', `${host}:${port} (${err.message})`);
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[proxy] whitelist proxy listening on ${LISTEN_HOST}:${LISTEN_PORT} (${allowlist.size} allowed domains)`);
});
