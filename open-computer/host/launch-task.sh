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
  --repo <org/repo>         GitHub repository to clone into the agent workspace

Optional:
  --branch <branch>         Branch to clone
  --gh-token <token>        GitHub token (exported as GH_TOKEN for gh; otherwise
                            ambient `gh auth` state is used)
  --ai-url <url>            LLM OPENAI_BASE_URL (e.g. http://localhost:1234/v1)
  --ai-api-key <key>        LLM OPENAI_API_KEY
  --ai-model <model>        LLM OPENAI_MODEL
  --ai-context-length <n>   CONTEXT_WINDOW
  --ram <size>              VM memory, e.g. 12G (default 8G; persisted per agent)
  --help                    Show this help

Networking is always locked down: restrict=on, whitelist proxy pinhole at
10.0.2.100:3128, LLM pinhole at 10.0.2.101 (localhost LLM endpoints only;
cloud LLM domains go through the allowlist proxy).

Example:
  host/launch-task.sh --name kmp-build --repo myorg/my-kmp-app --branch main \
    --ai-url http://localhost:1234/v1 --ai-api-key sk-local --ai-model qwen3-coder \
    --ai-context-length 128000
EOF
}

NAME="" REPO="" BRANCH="" GH_TOKEN_FLAG="" AI_URL="" AI_API_KEY="" AI_MODEL="" AI_CONTEXT_LENGTH="" RAM=""

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
    --ram)                RAM="${2:?--ram requires a value}"; shift 2 ;;
    --help|-h)            usage; exit 0 ;;
    *) echo "Error: unknown flag '$1' (named flags only)." >&2; usage >&2; exit 1 ;;
  esac
done

[ -n "$NAME" ] || { echo "Error: --name is required." >&2; usage >&2; exit 1; }
[ -n "$REPO" ] || { echo "Error: --repo is required." >&2; usage >&2; exit 1; }
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
REPO_DIR="$WORKSPACE/$REPO_NAME"
mkdir -p "$WORKSPACE"

[ -n "$GH_TOKEN_FLAG" ] && export GH_TOKEN="$GH_TOKEN_FLAG"

if [ -d "$REPO_DIR/.git" ]; then
  echo "Repo already cloned at $REPO_DIR — pulling latest."
  git -C "$REPO_DIR" pull --ff-only || {
    echo "Error: could not fast-forward existing clone at $REPO_DIR. Resolve manually or remove it." >&2
    exit 1
  }
elif [ -e "$REPO_DIR" ]; then
  echo "Error: $REPO_DIR exists but is not a git repo. Remove it and retry." >&2
  exit 1
else
  if [ -n "$BRANCH" ]; then
    gh repo clone "$REPO" "$REPO_DIR" -- --branch "$BRANCH"
  else
    gh repo clone "$REPO" "$REPO_DIR"
  fi
fi

ENV_FILE="$AGENT_DIR/.env"
{
  [ -n "$AI_URL" ]            && echo "OPENAI_BASE_URL=$AI_URL"
  [ -n "$AI_API_KEY" ]        && echo "OPENAI_API_KEY=$AI_API_KEY"
  [ -n "$AI_MODEL" ]          && echo "OPENAI_MODEL=$AI_MODEL"
  [ -n "$AI_CONTEXT_LENGTH" ] && echo "CONTEXT_WINDOW=$AI_CONTEXT_LENGTH"
  echo "SKIP_PLANNING=1"
  echo "PRUNE_KEEP_RECENT=1000"
  echo "PRUNE_MAX_RESULT_CHARS=100000"
  echo "TOOL_SELECT_TOP_N=200"
  echo "IDLE_DETECTOR=off"
} > "$ENV_FILE"
echo "Wrote $ENV_FILE"

if [ -f "$PROXY_PIDFILE" ] && kill -0 "$(cat "$PROXY_PIDFILE")" 2>/dev/null; then
  echo "Whitelist proxy already running (pid $(cat "$PROXY_PIDFILE"))."
else
  nohup node "$HERE/whitelist-proxy.mjs" >> "$HERE/whitelist-proxy.log" 2>&1 &
  echo $! > "$PROXY_PIDFILE"
  echo "Started whitelist proxy on 127.0.0.1:$PROXY_PORT (pid $(cat "$PROXY_PIDFILE"), log $HERE/whitelist-proxy.log)."
fi

cd "$ROOT"
# Dev mode: 9p-mounts the live services/ tree so the VM runs this fork's
# service code instead of the stale bundle baked into the prebuilt base image.
RAM_ARGS=()
[ -n "$RAM" ] && RAM_ARGS=(--ram "$RAM")
# ${arr[@]+...} guards against `set -u` + empty array on macOS bash 3.2.
if [ -f "$AGENT_DIR/agent.json" ]; then
  ./open-computer up "$NAME" --dev ${RAM_ARGS[@]+"${RAM_ARGS[@]}"}
else
  ./open-computer create "$NAME" --dev ${RAM_ARGS[@]+"${RAM_ARGS[@]}"}
fi

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
no_proxy=localhost,127.0.0.1,10.0.2.101
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
GUEST

echo ""
echo "=== Agent '$NAME' is up ==="
echo "  UI:         http://localhost:$APP_PORT"
echo "  Shared:     $WORKSPACE (mounted in guest at /home/agent/shared)"
echo "  SSH:        ssh -p $SSH_PORT agent@localhost"
echo ""
echo "To stop:"
echo "  ./open-computer down $NAME"
echo "  kill \$(cat $PROXY_PIDFILE) && rm -f $PROXY_PIDFILE   # whitelist proxy"
