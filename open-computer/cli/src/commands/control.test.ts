import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Same subprocess-per-test-file isolation as registry.test.ts: the env var
// override must land before config.js is first imported in this process.
const AGENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-control-test-'));
process.env.OPEN_COMPUTER_AGENTS_DIR = AGENTS_DIR;

let resolveLlmPort: (
  explicitLlmPort: number | undefined,
  agent: { relay_port: number },
  name: string,
) => number | undefined;
let resolveMcpPort: (
  explicitMcpPort: number | undefined,
  agent: { mcp_port?: number },
) => number | undefined;
let agentDir: (name: string) => string;
let agentEnvPath: (name: string) => string;

before(async () => {
  const control = await import('./control.js');
  const registry = await import('../registry.js');
  resolveLlmPort = control.resolveLlmPort;
  resolveMcpPort = control.resolveMcpPort;
  agentDir = registry.agentDir;
  agentEnvPath = registry.agentEnvPath;
});

test('resolveLlmPort: explicit --llm-port override wins over relay_port', () => {
  const agent = { relay_port: 4100 };
  assert.equal(resolveLlmPort(9999, agent, 'whatever'), 9999);
});

test('resolveLlmPort: defaults to the persisted relay_port when no override', () => {
  const agent = { relay_port: 4123 };
  assert.equal(resolveLlmPort(undefined, agent, 'agent-with-relay-port'), 4123);
});

test('resolveLlmPort: falls back to llmPortFromAgentEnv when relay_port is absent (pre-existing agent.json)', () => {
  const name = 'agent-legacy-no-relay-port';
  fs.mkdirSync(agentDir(name), { recursive: true });
  fs.writeFileSync(agentEnvPath(name), 'OPENAI_BASE_URL=http://localhost:5555/v1\n');
  const agentWithoutRelayPort = {} as { relay_port: number };
  assert.equal(resolveLlmPort(undefined, agentWithoutRelayPort, name), 5555);
});

test('resolveLlmPort: undefined when no override, no relay_port, and no env file', () => {
  const agentWithoutRelayPort = {} as { relay_port: number };
  assert.equal(resolveLlmPort(undefined, agentWithoutRelayPort, 'agent-with-nothing'), undefined);
});

test('resolveMcpPort: explicit --mcp-port override wins over mcp_port', () => {
  assert.equal(resolveMcpPort(9999, { mcp_port: 4200 }), 9999);
});

test('resolveMcpPort: defaults to the persisted mcp_port when no override', () => {
  assert.equal(resolveMcpPort(undefined, { mcp_port: 4207 }), 4207);
});

test('resolveMcpPort: undefined when no override and agent never opted into MCP', () => {
  assert.equal(resolveMcpPort(undefined, {}), undefined);
});
