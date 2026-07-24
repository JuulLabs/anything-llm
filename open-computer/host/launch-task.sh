#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PROXY_PORT=3128
PROXY_PIDFILE="$HERE/whitelist-proxy.pid"

usage() {
  cat <<'EOF'
Usage: host/launch-task.sh --name <agent> --repo <org/repo> [options]

Required:
  --name <agent-name>       Agent name (alphanumeric, dash, underscore)
  --repo <org/repo>         GitHub repository delivered to the agent as
                            shared/input.tar (cloned host-side to a temp dir)
  --mcp-url <url>           Upstream MCP server URL (Streamable HTTP) for the
                            HOST MCP relay to forward to (e.g.
                            https://mcp.atlassian.com/v1/mcp). The guest never
                            talks to this URL directly.

Optional:
  --branch <branch>         Branch to clone
  --gh-token <token>        GitHub token (exported as GH_TOKEN for gh; otherwise
                            ambient `gh auth` state is used)
  --ai-url <url>            Upstream LLM base URL for the HOST relay to forward
                            to (e.g. http://localhost:11434/v1, or a remote
                            cloud API like https://opencode.ai/zen/v1). The
                            guest never talks to this URL directly.
  --ai-api-key <key>        Upstream LLM API key. Kept host-side only: injected
                            by the relay as the Authorization header on
                            outbound requests, never written to the guest .env.
  --ai-model <model>        LLM OPENAI_MODEL (passed through to the guest as-is)
  --ai-context-length <n>   CONTEXT_WINDOW
  --ram <size>              VM memory, e.g. 12G (default 8G; persisted per agent)
  --help                    Show this help

Networking is always locked down: restrict=on, whitelist proxy pinhole at
10.0.2.100:3128, LLM pinhole at 10.0.2.101. Each agent gets its OWN host-side
LLM relay process (host/llm-relay.mjs) on its OWN port, allocated the same
way as ssh_port/app_port/vnc_port (persisted in agents/<name>/agent.json as
`relay_port`). The guest's OPENAI_BASE_URL always points at that agent's own
relay through the LLM pinhole; the relay forwards to whatever --ai-url
actually is (local or remote) and injects --ai-api-key server-side, so the
guest never sees the real upstream URL or key. Because each agent's relay is
independent, you can run multiple agents at once with completely different
models/upstreams/keys — no cross-talk, no shared state to reset between them.
Re-running this script for the SAME agent always restarts just that agent's
relay so a changed --ai-url/--ai-api-key takes effect immediately; it never
touches other agents' relays.

MCP forwarding works the same way as the LLM relay: every launch allocates
this agent an `mcp_port`, opens its own 10.0.2.102 pinhole, starts
host/mcp-relay.mjs (that agent's own process/port), and pushes a guest-side
~/.pi/agent/mcp.json pointing at the local pinhole — pi-mcp-adapter
(installed in the base image) reads that file to register MCP tools. The real
--mcp-url and OAuth credentials never reach the guest; the relay injects the
real Authorization header server-side, same pattern as the LLM relay.

Unlike the LLM relay's static API key, the MCP relay authenticates upstream
with per-USER OAuth (per the MCP authorization spec): before launching, this
script runs host/mcp-oauth.mjs, which discovers the server's authorization
server (RFC 9728/8414), dynamically registers a client if needed (RFC 7591),
and — only when no cached token for (current OS user, authorization server)
is still usable — opens your browser for an authorization_code + PKCE login.
Tokens are cached host-side under ~/.open-computer/mcp-auth (0700/0600) and
the relay refreshes them itself, adopting rotated refresh tokens. The
guest<->relay leg is protected separately: this script generates
a fresh random shared secret per launch, hands it to the relay as an env var
and to the guest inside ~/.pi/agent/mcp.json (over SSH, the same
provisioning channel as everything else — no files pass between host and
guest), so only THIS guest can use THIS relay.

Example:
  host/launch-task.sh --name kmp-build --repo myorg/my-kmp-app --branch main \
    --ai-url https://opencode.ai/zen/v1 --ai-api-key sk-... --ai-model qwen3-coder \
    --ai-context-length 128000 \
    --mcp-url https://mcp.atlassian.com/v1/mcp
EOF
}

NAME="" REPO="" BRANCH="" GH_TOKEN_FLAG="" AI_URL="" AI_API_KEY="" AI_MODEL="" AI_CONTEXT_LENGTH="" RAM="" MCP_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --name)               NAME="${2:?--name requires a value}"; shift 2 ;;
    --repo)               REPO="${2:?--repo requires a value}"; shift 2 ;;
    --branch)             BRANCH="${2:?--branch requires a value}"; shift 2 ;;
    --gh-token)           GH_TOKEN_FLAG="${2:?--gh-token requires a value}"; shift 2 ;;
    --ai-url)             AI_URL="${2:?--ai-url requires a value}"; shift 2 ;;
    --ai-api-key)         AI_API_KEY="${2:?--ai-api-key requires a value}"; shift 2 ;;
    --ai-model)           AI_MODEL="${2:?--ai-model requires a value}"; shift 2 ;;
    --ai-context-length)  AI_CONTEXT_LENGTH="${2:?--ai-context-length requires a value}"; shift 2 ;;
    --mcp-url)            MCP_URL="${2:?--mcp-url requires a value}"; shift 2 ;;
    --ram)                RAM="${2:?--ram requires a value}"; shift 2 ;;
    --help|-h)            usage; exit 0 ;;
    *) echo "Error: unknown flag '$1' (named flags only)." >&2; usage >&2; exit 1 ;;
  esac
done

[ -n "$NAME" ] || { echo "Error: --name is required." >&2; usage >&2; exit 1; }
[ -n "$REPO" ] || { echo "Error: --repo is required." >&2; usage >&2; exit 1; }
[ -n "$MCP_URL" ] || { echo "Error: --mcp-url is required." >&2; usage >&2; exit 1; }
case "$NAME" in
  *[!a-zA-Z0-9_-]*) echo "Error: --name must be alphanumeric, dash, underscore." >&2; exit 1 ;;
esac
case "$REPO" in
  */*) ;;
  *) echo "Error: --repo must look like org/repo." >&2; exit 1 ;;
esac
if [ -n "$RAM" ] && ! [[ "$RAM" =~ ^[0-9]+[GgMm]$ ]]; then
  echo "Error: --ram must be a number followed by G or M (e.g. 12G, 4096M)." >&2
  exit 1
fi
command -v gh >/dev/null || { echo "Error: gh CLI not found (brew install gh)." >&2; exit 1; }

AGENT_DIR="$ROOT/agents/$NAME"
WORKSPACE="$AGENT_DIR/shared"
REPO_NAME="${REPO##*/}"
INPUT_TAR="$WORKSPACE/input.tar"
mkdir -p "$WORKSPACE"

[ -n "$GH_TOKEN_FLAG" ] && export GH_TOKEN="$GH_TOKEN_FLAG"

# Clone to a host temp dir and hand the repo to the guest as a single
# input.tar in the shared folder. Extracting one large sequential file over
# 9p is fast; a raw clone tree there forces per-file 9p round-trips when the
# guest copies it to its local workspace (observed cp -r timeouts).
CLONE_TMP="$(mktemp -d)"
trap 'rm -rf "$CLONE_TMP"' EXIT
REPO_DIR="$CLONE_TMP/$REPO_NAME"
if [ -n "$BRANCH" ]; then
  gh repo clone "$REPO" "$REPO_DIR" -- --branch "$BRANCH"
else
  gh repo clone "$REPO" "$REPO_DIR"
fi
tar --no-xattrs --no-mac-metadata -cf "$INPUT_TAR" -C "$CLONE_TMP" "$REPO_NAME"
rm -rf "$CLONE_TMP"
trap - EXIT
echo "Wrote $INPUT_TAR ($(du -h "$INPUT_TAR" | cut -f1 | tr -d ' ')) — extracts to $REPO_NAME/."

cd "$ROOT"
RAM_ARGS=()
[ -n "$RAM" ] && RAM_ARGS=(--ram "$RAM")
MCP_CREATE_ARGS=(--mcp)
# ${arr[@]+...} guards against `set -u` + empty array on macOS bash 3.2.

# Ensure the agent exists (allocating its own ssh_port/app_port/vnc_port AND
# relay_port and mcp_port) before writing .env /
# starting relays below — those need this agent's relay_port/mcp_port, which
# only exist once agent.json does. --no-start defers the actual VM boot to
# the `up` call at the end, after the relays are ready to receive guest
# traffic.
if [ -f "$AGENT_DIR/agent.json" ]; then
  echo "Agent '$NAME' already exists — reusing its allocated ports."
else
  ./open-computer create "$NAME" --no-start ${RAM_ARGS[@]+"${RAM_ARGS[@]}"} ${MCP_CREATE_ARGS[@]+"${MCP_CREATE_ARGS[@]}"}
fi

RELAY_PORT=$(sed -n 's/.*"relay_port": *\([0-9]*\).*/\1/p' "$AGENT_DIR/agent.json")
[ -n "$RELAY_PORT" ] || { echo "Error: could not read relay_port from $AGENT_DIR/agent.json" >&2; exit 1; }

MCP_PORT=$(sed -n 's/.*"mcp_port": *\([0-9]*\).*/\1/p' "$AGENT_DIR/agent.json")
if [ -z "$MCP_PORT" ]; then
  echo "Error: agent '$NAME' has no persisted mcp_port (it was created without MCP)." >&2
  echo "  Destroy and recreate it, or start it manually with:" >&2
  echo "  ./open-computer up $NAME --mcp-port <port>" >&2
  exit 1
fi

# The guest always talks to THIS agent's own host relay on localhost, never
# to the real --ai-url — that stays host-only. OPENAI_API_KEY is
# intentionally omitted: auth now happens at the relay, which injects the
# real key server-side.
ENV_FILE="$AGENT_DIR/.env"
{
  echo "OPENAI_BASE_URL=http://localhost:$RELAY_PORT/v1"
  [ -n "$AI_MODEL" ]          && echo "OPENAI_MODEL=$AI_MODEL"
  [ -n "$AI_CONTEXT_LENGTH" ] && echo "CONTEXT_WINDOW=$AI_CONTEXT_LENGTH"
  echo "SKIP_PLANNING=1"
  echo "PRUNE_KEEP_RECENT=1000"
  echo "PRUNE_MAX_RESULT_CHARS=100000"
  echo "TOOL_SELECT_TOP_N=200"
  echo "IDLE_DETECTOR=off"
} > "$ENV_FILE"
echo "Wrote $ENV_FILE"

# Whitelist proxy is a shared, domain-allowlist policy (not a credential), so
# it stays a single process across all agents — unlike the LLM relay below.
if [ -f "$PROXY_PIDFILE" ] && kill -0 "$(cat "$PROXY_PIDFILE")" 2>/dev/null; then
  echo "Whitelist proxy already running (pid $(cat "$PROXY_PIDFILE"))."
else
  nohup node "$HERE/whitelist-proxy.mjs" >> "$HERE/whitelist-proxy.log" 2>&1 &
  echo $! > "$PROXY_PIDFILE"
  echo "Started whitelist proxy on 127.0.0.1:$PROXY_PORT (pid $(cat "$PROXY_PIDFILE"), log $HERE/whitelist-proxy.log)."
fi

# LLM relay: one process per agent, on that agent's own relay_port, pidfile
# and log scoped to the agent's own directory (not shared across agents).
# UPSTREAM_BASE_URL/UPSTREAM_API_KEY are passed as env vars to the spawned
# process only — never written to disk or to the guest .env — so the real
# upstream URL/key stay host-only.
#
# Always kill-and-restart THIS agent's relay on every invocation (rather than
# "already running, skip"): the relay is a stateless HTTP forwarder with no
# in-flight state worth preserving across a task launch, so this is cheap and
# guarantees a changed --ai-url/--ai-api-key takes effect immediately. This
# never touches any other agent's relay process.
RELAY_PIDFILE="$AGENT_DIR/relay.pid"
RELAY_LOG="$AGENT_DIR/relay.log"
if [ -f "$RELAY_PIDFILE" ] && kill -0 "$(cat "$RELAY_PIDFILE")" 2>/dev/null; then
  echo "Restarting LLM relay for '$NAME' (pid $(cat "$RELAY_PIDFILE"))..."
  kill "$(cat "$RELAY_PIDFILE")" 2>/dev/null || true
  rm -f "$RELAY_PIDFILE"
fi
RELAY_PORT="$RELAY_PORT" UPSTREAM_BASE_URL="$AI_URL" UPSTREAM_API_KEY="$AI_API_KEY" \
  nohup node "$HERE/llm-relay.mjs" >> "$RELAY_LOG" 2>&1 &
echo $! > "$RELAY_PIDFILE"
echo "Started LLM relay for '$NAME' on 127.0.0.1:$RELAY_PORT -> ${AI_URL:-<unconfigured>} (pid $(cat "$RELAY_PIDFILE"), log $RELAY_LOG)."

# MCP relay: one process per agent, same restart-on-every-launch policy as the
# LLM relay above. Two distinct credential boundaries:
#   1. relay -> upstream: per-user OAuth. host/mcp-oauth.mjs runs first —
#      silent when the host token cache already has a usable token for
#      (current OS user, this server's authorization server), a browser
#      login otherwise — and prints the cache file path, which the relay
#      gets as MCP_TOKEN_CACHE_FILE so it can refresh (and persist rotated
#      refresh tokens) on its own. Tokens live only in that 0600 host-side
#      cache file; nothing OAuth-related ever reaches the guest.
#   2. guest -> relay: MCP_GUEST_SECRET, a fresh random value generated here
#      on every launch, given to the relay via env and to the guest via SSH
#      (inside ~/.pi/agent/mcp.json, below). The relay 401s anything that
#      doesn't present it, so a restarted VM needs a re-launch (which mints
#      a new secret) — that's intentional pairing, not a bug.
echo "Checking MCP OAuth login for $MCP_URL (browser opens only if needed)..."
MCP_TOKEN_CACHE_FILE="$(node "$HERE/mcp-oauth.mjs" login --mcp-url "$MCP_URL")"
[ -n "$MCP_TOKEN_CACHE_FILE" ] || { echo "Error: MCP OAuth login failed for $MCP_URL." >&2; exit 1; }

MCP_RELAY_PIDFILE="$AGENT_DIR/mcp-relay.pid"
MCP_RELAY_LOG="$AGENT_DIR/mcp-relay.log"
if [ -f "$MCP_RELAY_PIDFILE" ] && kill -0 "$(cat "$MCP_RELAY_PIDFILE")" 2>/dev/null; then
  echo "Restarting MCP relay for '$NAME' (pid $(cat "$MCP_RELAY_PIDFILE"))..."
  kill "$(cat "$MCP_RELAY_PIDFILE")" 2>/dev/null || true
  rm -f "$MCP_RELAY_PIDFILE"
fi
MCP_GUEST_SECRET="$(openssl rand -hex 32)"
MCP_RELAY_PORT="$MCP_PORT" UPSTREAM_MCP_URL="$MCP_URL" \
  MCP_GUEST_SECRET="$MCP_GUEST_SECRET" \
  MCP_TOKEN_CACHE_FILE="$MCP_TOKEN_CACHE_FILE" \
  nohup node "$HERE/mcp-relay.mjs" >> "$MCP_RELAY_LOG" 2>&1 &
echo $! > "$MCP_RELAY_PIDFILE"
echo "Started MCP relay for '$NAME' on 127.0.0.1:$MCP_PORT -> $MCP_URL (pid $(cat "$MCP_RELAY_PIDFILE"), log $MCP_RELAY_LOG)."
echo "  Upstream auth: per-user OAuth tokens from $MCP_TOKEN_CACHE_FILE. Guest auth: per-launch shared secret (env-only, never written to disk)."

# Dev mode: 9p-mounts the live services/ tree so the VM runs this fork's
# service code instead of the stale bundle baked into the prebuilt base image.
# agent.json (and its relay_port) already exists by this point, so `up`
# always picks up this agent's own relay through the LLM pinhole.
./open-computer up "$NAME" ${RAM_ARGS[@]+"${RAM_ARGS[@]}"}

SSH_PORT=$(sed -n 's/.*"ssh_port": *\([0-9]*\).*/\1/p' "$AGENT_DIR/agent.json")
APP_PORT=$(sed -n 's/.*"app_port": *\([0-9]*\).*/\1/p' "$AGENT_DIR/agent.json")

echo "Waiting for SSH on port $SSH_PORT to push guest proxy config..."
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$SSH_PORT")
for _ in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" agent@localhost true 2>/dev/null; then break; fi
  sleep 2
done
ssh "${SSH_OPTS[@]}" agent@localhost 'bash -s' <<'GUEST'
set -e
# Idempotent: strip any prior proxy entries before appending, so repeated
# launches don't accumulate duplicates in /etc/environment.
sudo sed -i -E '/^(http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|no_proxy|NO_PROXY)=/d' /etc/environment
sudo tee -a /etc/environment >/dev/null <<'ENVEOF'
http_proxy=http://10.0.2.100:3128
https_proxy=http://10.0.2.100:3128
HTTP_PROXY=http://10.0.2.100:3128
HTTPS_PROXY=http://10.0.2.100:3128
no_proxy=localhost,127.0.0.1,10.0.2.101,10.0.2.102
ENVEOF
mkdir -p ~/.gradle
cat > ~/.gradle/gradle.properties <<'GRADLEEOF'
systemProp.http.proxyHost=10.0.2.100
systemProp.http.proxyPort=3128
systemProp.https.proxyHost=10.0.2.100
systemProp.https.proxyPort=3128
GRADLEEOF
echo "Guest proxy config written (/etc/environment, ~/.gradle/gradle.properties)."
# Base images provisioned before the workspace→shared rename still ship
# open-computer-workspace-mount.service, which mounts tag open-computer_workspace
# and silently fails now that the CLI exports the 9p share as open-computer_shared.
# Mount it here (idempotent) and ensure /home/agent/workspace exists as a plain
# local working dir until the base image is re-provisioned.
if ! mountpoint -q /home/agent/shared; then
  sudo mkdir -p /home/agent/shared
  sudo mount -t 9p -o trans=virtio,version=9p2000.L,msize=104857600 open-computer_shared /home/agent/shared 2>/dev/null || true
  sudo chown agent:agent /home/agent/shared
fi
sudo mkdir -p /home/agent/workspace
sudo chown agent:agent /home/agent/workspace
echo "Guest shared mount ensured (/home/agent/shared) and local workspace dir created."
# Extract the task repo host-pushed as input.tar into the guest's local
# workspace now, before any task prompt reaches the agent, so the agent never
# has to touch the slow 9p share for input.
tar --warning=no-unknown-keyword -xf /home/agent/shared/input.tar -C /home/agent/workspace
echo "Extracted /home/agent/shared/input.tar into /home/agent/workspace."
GUEST

# Guest-side MCP config: pi-mcp-adapter (installed by provisioning) reads
# ~/.pi/agent/mcp.json for its server list. We push it directly over SSH —
# same as the proxy config above — rather than through the interface
# service's env layer, since pi-mcp-adapter reads this file itself and has
# no dependency on the open-computer service's settings. Only the LOCAL
# pinhole address and the per-launch guest<->relay shared secret ever reach
# the guest; the real --mcp-url and OAuth credentials stay host-side. The
# secret travels over the SSH control channel (stdin), never through the 9p
# share or any other host<->guest file handoff.
echo "Pushing MCP config for '$NAME' (pointing at local relay pinhole)..."
MCP_GUEST_CONFIG=$(cat <<EOF
{
  "mcpServers": {
    "gateway": {
      "url": "http://10.0.2.102:${MCP_PORT}/mcp",
      "auth": "bearer",
      "bearerToken": "${MCP_GUEST_SECRET}"
    }
  }
}
EOF
)
ssh "${SSH_OPTS[@]}" agent@localhost 'umask 077 && mkdir -p ~/.pi/agent && cat > ~/.pi/agent/mcp.json' <<< "$MCP_GUEST_CONFIG"
echo "Guest MCP config written (~/.pi/agent/mcp.json, mode 600)."

echo ""
echo "=== Agent '$NAME' is up ==="
echo "  UI:         http://localhost:$APP_PORT"
echo "  Shared:     $WORKSPACE (mounted in guest at /home/agent/shared)"
echo "  SSH:        ssh -p $SSH_PORT agent@localhost"
echo "  LLM relay:  127.0.0.1:$RELAY_PORT -> ${AI_URL:-<unconfigured>} (this agent only)"
echo "  MCP relay:  127.0.0.1:$MCP_PORT -> $MCP_URL (this agent only)"
echo ""
echo "To stop:"
echo "  ./open-computer down $NAME      # also stops this agent's LLM relay and MCP relay"
echo "  ./open-computer destroy $NAME   # deletes the agent; also stops its LLM relay and MCP relay"
echo "  kill \$(cat $PROXY_PIDFILE) && rm -f $PROXY_PIDFILE   # whitelist proxy (shared across all agents)"
