// Run with: node --test host/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  TokenStore, cacheFilePath, canonicalResource, discover, parseResourceMetadataUrl, resolveUser,
} from './mcp-oauth.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-test-'));
  return path.join(dir, 'user', 'cache.json');
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('canonicalResource strips fragments and keeps path/query', () => {
  assert.equal(canonicalResource('https://mcp.example.com/v1/mcp#frag'), 'https://mcp.example.com/v1/mcp');
  assert.equal(canonicalResource('https://mcp.example.com/v1/mcp?x=1'), 'https://mcp.example.com/v1/mcp?x=1');
});

test('cacheFilePath keys by (user, authorization server)', () => {
  const a = cacheFilePath('alice', 'https://auth.example.com');
  const b = cacheFilePath('bob', 'https://auth.example.com');
  const c = cacheFilePath('alice', 'https://other.example.com');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, cacheFilePath('alice', 'https://auth.example.com'));
  assert.ok(a.includes(`${path.sep}alice${path.sep}`));
});

test('resolveUser returns the current OS user', () => {
  assert.equal(resolveUser(), os.userInfo().username);
});

test('parseResourceMetadataUrl extracts the RFC 9728 pointer', () => {
  assert.equal(
    parseResourceMetadataUrl('Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp"'),
    'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp',
  );
  assert.equal(parseResourceMetadataUrl('Bearer realm="mcp"'), null);
  assert.equal(parseResourceMetadataUrl(undefined), null);
});

test('TokenStore.write creates 0700 dirs and a 0600 file', () => {
  const file = tmpFile();
  const store = new TokenStore(file);
  store.write({ hello: 'world' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('saveTokenResponse adopts a rotated refresh token, keeps the old one if omitted', () => {
  const store = new TokenStore(tmpFile());
  const resource = 'https://mcp.example.com/v1/mcp';
  const first = store.saveTokenResponse(resource, { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 });
  assert.equal(first.refresh_token, 'r1');
  const rotated = store.saveTokenResponse(resource, { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }, first);
  assert.equal(rotated.refresh_token, 'r2');
  const noRotation = store.saveTokenResponse(resource, { access_token: 'a3', expires_in: 3600 }, rotated);
  assert.equal(noRotation.refresh_token, 'r2');
  assert.equal(store.tokensFor(store.read(), resource).access_token, 'a3');
});

test('getAccessToken returns a fresh cached token without hitting the network', async () => {
  const store = new TokenStore(tmpFile());
  const resource = 'https://mcp.example.com/v1/mcp';
  store.write({ token_endpoint: 'http://127.0.0.1:1/unreachable', client: { client_id: 'c' } });
  store.saveTokenResponse(resource, { access_token: 'fresh', refresh_token: 'r', expires_in: 3600 });
  assert.equal(await store.getAccessToken(resource), 'fresh');
});

test('getAccessToken refreshes an expired token and persists the rotated refresh token', async () => {
  const refreshBodies = [];
  const { server, base } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      refreshBodies.push(new URLSearchParams(body));
      const n = refreshBodies.length;
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600 }));
    });
  });
  try {
    const store = new TokenStore(tmpFile());
    const resource = 'https://mcp.example.com/v1/mcp';
    store.write({
      token_endpoint: `${base}/token`,
      client: { client_id: 'client-1' },
      resources: { [resource]: { access_token: 'stale', refresh_token: 'rt0', expires_at: Date.now() - 1000 } },
    });

    assert.equal(await store.getAccessToken(resource), 'at1');
    assert.equal(refreshBodies[0].get('grant_type'), 'refresh_token');
    assert.equal(refreshBodies[0].get('refresh_token'), 'rt0');
    assert.equal(refreshBodies[0].get('client_id'), 'client-1');
    assert.equal(refreshBodies[0].get('resource'), resource);
    assert.equal(store.tokensFor(store.read(), resource).refresh_token, 'rt1');

    // Rotation actually adopted: the second (forced) refresh must present rt1.
    assert.equal(await store.getAccessToken(resource, { forceRefresh: true }), 'at2');
    assert.equal(refreshBodies[1].get('refresh_token'), 'rt1');
    assert.equal(store.tokensFor(store.read(), resource).refresh_token, 'rt2');
  } finally {
    server.close();
  }
});

test('getAccessToken fails with a login hint when nothing is cached', async () => {
  const store = new TokenStore(tmpFile());
  await assert.rejects(
    store.getAccessToken('https://mcp.example.com/v1/mcp'),
    /mcp-oauth\.mjs login/,
  );
});

test('discover follows WWW-Authenticate -> PRM -> AS metadata', async () => {
  let handlers;
  const { server, base } = await listen((req, res) => handlers(req, res));
  const authBase = base;
  handlers = (req, res) => {
    if (req.url === '/v1/mcp') {
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/v1/mcp"` }).end();
    } else if (req.url === '/.well-known/oauth-protected-resource/v1/mcp') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ resource: `${base}/v1/mcp`, authorization_servers: [authBase], scopes_supported: ['read:jira-work', 'offline_access'] }));
    } else if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({
          issuer: authBase,
          authorization_endpoint: `${authBase}/authorize`,
          token_endpoint: `${authBase}/token`,
          registration_endpoint: `${authBase}/register`,
        }));
    } else {
      res.writeHead(404).end();
    }
  };
  try {
    const d = await discover(`${base}/v1/mcp`);
    assert.equal(d.resource, `${base}/v1/mcp`);
    assert.equal(d.authorizationServer, authBase);
    assert.equal(d.authorizationEndpoint, `${authBase}/authorize`);
    assert.equal(d.tokenEndpoint, `${authBase}/token`);
    assert.equal(d.registrationEndpoint, `${authBase}/register`);
    assert.equal(d.scope, 'read:jira-work offline_access');
  } finally {
    server.close();
  }
});

test('discover falls back to the MCP origin as authorization server when PRM is absent entirely', async () => {
  let handlers;
  const { server, base } = await listen((req, res) => handlers(req, res));
  handlers = (req, res) => {
    if (req.url === '/v1/mcp') {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="OAuth", error="invalid_token"' }).end();
    } else if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({
          authorization_endpoint: `${base}/v1/authorize`,
          token_endpoint: `${base}/v1/token`,
          registration_endpoint: `${base}/v1/register`,
        }));
    } else {
      res.writeHead(404).end('Not Found');
    }
  };
  try {
    const d = await discover(`${base}/v1/mcp`);
    assert.equal(d.authorizationServer, base);
    assert.equal(d.authorizationEndpoint, `${base}/v1/authorize`);
    assert.equal(d.tokenEndpoint, `${base}/v1/token`);
    assert.equal(d.registrationEndpoint, `${base}/v1/register`);
    assert.equal(d.scope, null);
  } finally {
    server.close();
  }
});

test('discover falls back to RFC 9728 well-known path insertion without a WWW-Authenticate hint', async () => {
  let handlers;
  const { server, base } = await listen((req, res) => handlers(req, res));
  handlers = (req, res) => {
    if (req.url === '/v1/mcp') {
      res.writeHead(401).end();
    } else if (req.url === '/.well-known/oauth-protected-resource/v1/mcp') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ authorization_servers: [base] }));
    } else if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` }));
    } else {
      res.writeHead(404).end();
    }
  };
  try {
    const d = await discover(`${base}/v1/mcp`);
    assert.equal(d.authorizationServer, base);
    assert.equal(d.registrationEndpoint, null);
    assert.equal(d.scope, null);
  } finally {
    server.close();
  }
});
