import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// registry.ts derives AGENTS_DIR from config.ts at module-load time, so the
// env var override must be set before either module is first imported in
// this process. node --test runs each test file in its own subprocess, so
// setting it at the top of this file (before the dynamic imports in the
// `before` hook below) is safe.
const AGENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-registry-test-'));
process.env.OPEN_COMPUTER_AGENTS_DIR = AGENTS_DIR;

let writeAgentJson: (
  name: string, index: number, opts?: { ram?: string; mcp?: boolean },
) => { relay_port: number; mcp_port?: number };
let readAgentJson: (name: string) => { relay_port: number; mcp_port?: number };
let agentDir: (name: string) => string;
let RELAY_PORT_BASE: number;
let MCP_PORT_BASE: number;
let SSH_PORT_BASE: number;
let APP_PORT_BASE: number;

before(async () => {
  const registry = await import('./registry.js');
  const config = await import('./config.js');
  writeAgentJson = registry.writeAgentJson;
  readAgentJson = registry.readAgentJson;
  agentDir = registry.agentDir;
  RELAY_PORT_BASE = config.RELAY_PORT_BASE;
  MCP_PORT_BASE = config.MCP_PORT_BASE;
  SSH_PORT_BASE = config.SSH_PORT_BASE;
  APP_PORT_BASE = config.APP_PORT_BASE;
});

function makeAgentDir(name: string): void {
  fs.mkdirSync(agentDir(name), { recursive: true });
}

test('writeAgentJson: allocates relay_port = RELAY_PORT_BASE + index', () => {
  makeAgentDir('relay-a');
  const agent = writeAgentJson('relay-a', 0);
  assert.equal(agent.relay_port, RELAY_PORT_BASE);
});

test('writeAgentJson: each agent index gets its own unique relay_port', () => {
  makeAgentDir('relay-b');
  makeAgentDir('relay-c');
  const b = writeAgentJson('relay-b', 3);
  const c = writeAgentJson('relay-c', 7);
  assert.equal(b.relay_port, RELAY_PORT_BASE + 3);
  assert.equal(c.relay_port, RELAY_PORT_BASE + 7);
  assert.notEqual(b.relay_port, c.relay_port);
});

test('writeAgentJson: relay_port is persisted and readable via readAgentJson', () => {
  makeAgentDir('relay-d');
  writeAgentJson('relay-d', 2);
  const reloaded = readAgentJson('relay-d');
  assert.equal(reloaded.relay_port, RELAY_PORT_BASE + 2);
});

test('RELAY_PORT_BASE does not collide with other allocated port ranges', () => {
  // Every agent's relay_port/ssh_port/app_port share the same `index` axis,
  // so the bases must be spread far enough apart that no realistic agent
  // count causes ssh/app/relay ranges to overlap.
  assert.notEqual(RELAY_PORT_BASE, SSH_PORT_BASE);
  assert.notEqual(RELAY_PORT_BASE, APP_PORT_BASE);
  assert.ok(Math.abs(RELAY_PORT_BASE - APP_PORT_BASE) >= 1000);
});

test('writeAgentJson: mcp_port is NOT allocated by default (MCP is opt-in)', () => {
  makeAgentDir('mcp-off');
  const agent = writeAgentJson('mcp-off', 0);
  assert.equal(agent.mcp_port, undefined);
  const reloaded = readAgentJson('mcp-off');
  assert.equal('mcp_port' in reloaded, false);
});

test('writeAgentJson: mcp_port = MCP_PORT_BASE + index only when mcp: true', () => {
  makeAgentDir('mcp-on');
  const agent = writeAgentJson('mcp-on', 5, { mcp: true });
  assert.equal(agent.mcp_port, MCP_PORT_BASE + 5);
  const reloaded = readAgentJson('mcp-on');
  assert.equal(reloaded.mcp_port, MCP_PORT_BASE + 5);
});

test('writeAgentJson: ram and mcp opt-in compose independently', () => {
  makeAgentDir('mcp-and-ram');
  const agent = writeAgentJson('mcp-and-ram', 1, { ram: '12G', mcp: true }) as { relay_port: number; mcp_port?: number; ram?: string };
  assert.equal(agent.ram, '12G');
  assert.equal(agent.mcp_port, MCP_PORT_BASE + 1);
});

test('MCP_PORT_BASE does not collide with other allocated port ranges', () => {
  assert.notEqual(MCP_PORT_BASE, SSH_PORT_BASE);
  assert.notEqual(MCP_PORT_BASE, APP_PORT_BASE);
  assert.notEqual(MCP_PORT_BASE, RELAY_PORT_BASE);
  assert.ok(Math.abs(MCP_PORT_BASE - RELAY_PORT_BASE) >= 100);
});
