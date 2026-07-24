# Common Workflows

Quick reference for operating our Open Computer fork. All commands run from `open-computer/`.

## First-time setup (new machine)

```bash
# 1. Unzip the bundled QEMU (macOS ARM64)
tar -xzf master/qemu/qemu-darwin-arm64.tar.gz -C master/qemu/

# 2. Build the CLI
cd cli && npm install && npm run build && cd ..

# 3. Fetch the prebuilt base image (~2.9 GB)
scripts/fetch-base-image.sh

# 4. Apply our fork's provisioning (KMP toolchain, Chromium flags, shared-folder mount)
./open-computer base up && ./open-computer base provision && ./open-computer base compact
```

Rebuild the CLI (`cd cli && npm run build`) after any change under `cli/src/`.

## Install something into every future agent (base image rebuild)

1. Edit `master/setup/provision.sh` (add packages/config in the appropriate section).
2. Rebuild:
   ```bash
   ./open-computer base up
   ./open-computer base provision   # waits for SSH automatically
   ./open-computer base compact     # shuts down + shrinks base.qcow2
   ```
3. Verify with a throwaway agent:
   ```bash
   ./open-computer create check && ./open-computer ssh check "java -version"
   ./open-computer destroy check
   ```

## Launch a task agent

```bash
./host/launch-task.sh \
  --name mytask \
  --repo org/repo --branch main \
  --ai-url https://opencode.ai/zen/v1 --ai-api-key sk-... --ai-model my-model \
  --mcp-url https://mcp.atlassian.com/v1/mcp
```
- Clones the repo to a host temp dir and packs it into `agents/mytask/shared/input.tar`
  (shared into the VM at `/home/agent/shared`); after boot, the launch script extracts
  it over SSH into the guest's local `/home/agent/workspace` in one streaming read
  instead of a slow per-file 9p copy, so the repo is in place before any task prompt.
- Allocates the agent (if new) so it gets its own `ssh_port`/`app_port`/`vnc_port`/`relay_port`/`mcp_port`,
  writes `agents/mytask/.env`, starts the whitelist proxy (shared) and **this agent's own**
  LLM relay process, boots the VM, starts **this agent's own** MCP relay, and
  pushes guest MCP config.
- Task output: whatever the agent leaves in the shared folder — it's a live host folder.
  Code changes come back as `agents/mytask/shared/output.tar` (the changed repo dir,
  minus `.git`, dependency dirs, and build artifacts).
- `--ai-url`/`--ai-api-key` configure **this agent's own host-side LLM relay's** upstream
  (`host/llm-relay.mjs`, one process per agent, each on its own port allocated from
  `RELAY_PORT_BASE` — see `agents/mytask/agent.json`'s `relay_port`) — the guest never talks
  to them directly. The relay works the same way whether the model is local
  (Ollama/LM Studio) or a remote cloud API; the guest's `OPENAI_BASE_URL` is
  always that agent's own relay's localhost address, and the real key is injected by the
  relay, never written to `agents/<name>/.env`. Because every agent has its own relay
  process/port, you can run multiple agents **simultaneously** with completely different
  models/upstreams/keys — no shared state, no cross-talk.

## MCP tools (required)

`--mcp-url` is required on every `launch-task.sh` invocation (e.g.
`https://mcp.atlassian.com/v1/mcp` for Jira/Confluence).
- This agent gets its own `mcp_port` (persisted in `agents/mytask/agent.json`,
  allocated from `MCP_PORT_BASE` the same way `relay_port` is), its own
  `host/mcp-relay.mjs` process (pidfile `agents/mytask/mcp-relay.pid`, log
  `agents/mytask/mcp-relay.log`), and its own `10.0.2.102` guestfwd pinhole —
  all independent per agent, same isolation model as the LLM relay (so parallel
  agents can point at different MCP servers with no cross-talk).
- The guest never sees the real `--mcp-url` or any OAuth credential. The relay
  injects the real `Authorization: Bearer <token>` header server-side; the guest's
  `~/.pi/agent/mcp.json` (read by the `pi-mcp-adapter` extension, installed in the
  base image) only ever points at `http://10.0.2.102:<mcp_port>/mcp` — the local
  pinhole.
- **Host→backend auth is interactive per-user OAuth, per the MCP authorization
  spec — no API keys, no client secrets to pass around.** `--mcp-url` is the only
  flag; before anything launches, `host/mcp-oauth.mjs` discovers the server's
  authorization server (`WWW-Authenticate` + RFC 9728 protected resource
  metadata, then RFC 8414 authorization server metadata), dynamically registers
  a client if none is cached (RFC 7591), and — **only when no usable cached
  token exists** — opens your browser for an authorization_code + PKCE login
  through a temporary localhost callback. With a valid cached token the launch
  is completely silent.
- **Tokens are cached host-side, per (OS user, authorization server)**, under
  `~/.open-computer/mcp-auth/<user>/` (directories `0700`, files `0600`). The
  relay reads that cache (via `MCP_TOKEN_CACHE_FILE`), refreshes access tokens
  itself just before expiry, retries once with a forced refresh on an upstream
  `401`, and **adopts rotated refresh tokens** on every token response (required
  by servers like Atlassian's `https://mcp.atlassian.com/v1/mcp` that rotate the
  refresh token on each use). If a refresh is ever rejected, re-run the launch —
  the login step falls back to the browser flow.
- **Guest→relay auth is a per-launch shared secret.** Every launch generates a
  fresh random secret (`openssl rand -hex 32`), hands it to the relay via env
  (`MCP_GUEST_SECRET`) and to the guest inside `~/.pi/agent/mcp.json` over the
  SSH control channel (never through the 9p share or any host↔guest file
  handoff). The relay `401`s any request that doesn't present it as a bearer
  token, so only that agent's own guest can use its relay — binding to
  `127.0.0.1` keeps other machines out, and the secret keeps other local
  processes/agents out.
- `mcp_port` is allocated at `create` time (`launch-task.sh` always passes
  `--mcp`). An agent created without it (e.g. via `./open-computer create`
  without `--mcp`) can't be launched via `launch-task.sh` — destroy/recreate it,
  or start it manually with `./open-computer up mytask --mcp-port <port>`.
- Manual override: `./open-computer up <name> --mcp-port <port>` (mirrors
  `--llm-port`) forces a specific pinhole port for that boot only.

## Chat with the agent from the terminal

```bash
node host/chat.mjs --agent mytask
```
Slash commands: `/abort` `/new` `/compact` `/status` `/usage` `/deliverables` `/quit`.
Web UI alternative: http://localhost:9800 (port from `./open-computer list`).

## Allow a new domain through the network lockdown

1. Add the domain to `host/allowlist.txt` (one per line; `example.com` covers subdomains).
2. Done — the proxy hot-reloads. No VM restart needed.

## Change LLM settings for an existing agent

1. To change the model name/context window: edit `agents/<name>/.env`
   (`OPENAI_MODEL`, `CONTEXT_WINDOW`), then `./open-computer restart <name>`
   (re-pushes .env, restarts the in-VM service; kills the current agent session).
2. To change the upstream URL/API key: those live only in that agent's own LLM relay
   process's environment (never written to disk, pidfile at `agents/<name>/relay.pid`).
   Just re-run `host/launch-task.sh --name <name> ...` with the new `--ai-url`/`--ai-api-key`
   — it always kills and restarts that agent's own relay on every invocation, so the change
   takes effect immediately. It never touches other agents' relays.

## Tear down

```bash
./open-computer down mytask      # graceful stop (shared-folder output stays on host); also stops this agent's LLM relay and MCP relay
./open-computer destroy mytask   # delete VM + agent dir (shared folder included — copy out first!); also stops its LLM relay and MCP relay
```

## Gotchas

- Provision changes do nothing until the base is rebuilt; existing agents keep their old image.
- Network lockdown is always on. The guest only ever talks to its own LLM relay's localhost address; cloud LLM URLs are reached by the *relay* on the host, not the guest, so no allowlist entry is needed for them.
- Each agent gets its own LLM relay process on its own port (`relay_port` in `agent.json`, allocated the same way as `ssh_port`/`app_port`/`vnc_port`). Unlike the LLM relay, the whitelist proxy (`host/whitelist-proxy.mjs`) is intentionally still a single shared host process — it's a domain-allowlist *policy*, not a per-agent credential, so sharing it across agents is safe and there's nothing agent-specific to isolate.
- MCP relaying (`host/mcp-relay.mjs`) follows the same per-agent isolation model as the LLM relay. `launch-task.sh` requires `--mcp-url` and always allocates `mcp_port` for new agents; direct `./open-computer create` without `--mcp` still omits `mcp_port` (not usable with `launch-task.sh` until recreated).
- Gradle builds are slow on the shared folder (9p). Tell the agent to copy to local disk, build, copy results back.
- Agent RAM/CPUs are constants in `cli/src/config.ts` (`CPUS`, `RAM`) — changing them needs `cd cli && npm run build`.
- Port allocation bases live in `cli/src/config.ts`: `SSH_PORT_BASE` (2222), `APP_PORT_BASE` (9800), `RELAY_PORT_BASE` (4100), `MCP_PORT_BASE` (4200), plus the fixed `3128` (whitelist proxy) and `5900+`/`6080` (VNC/noVNC). Each agent's actual port is `BASE + index`.
