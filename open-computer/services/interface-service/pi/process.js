const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const {
  settings,
  EXTENSIONS_DIR,
  LOGS_DIR,
  AGENT_NAME,
  PORT,
} = require("../config");
const { workspace } = require("../workspace");
const { resolveBaseUrlForGuest } = require("../utils/env");

// ─── System prompt ─────────────────────────────────────────────────────────
// Injected into every pi agent session.  Subagents get an abbreviated version
// built in session/subagent-run.js via buildSubagentPrompt().

const SYSTEM_PROMPT = `You are an autonomous AI agent running on a Linux XFCE desktop. Each user prompt is a standalone task; start fresh and work until the task is complete.

The user watches the desktop through a live stream. Use the provided tools to open browsers, inspect pages, control native apps, ask the user, and save deliverables. The tool descriptions are the source of truth for exact arguments and capabilities.

Operational rules:
- Prefer lightweight state/text tools before visual tools: page_state/page_read for browser pages, app_read_state for native apps.
- Do not take screenshots unless the user explicitly asks for a screenshot or image-based verification.
- Use open_browser for web pages and app_open/app_* tools for native desktop apps; do not launch GUI apps from bash.
- Use bash for CLI work, scripts, package installs, and file operations. GUI commands need DISPLAY=:0 if no dedicated tool exists.
- Use ask_user for any clarification or decision that needs the user.
- Network access goes through a strict domain whitelist. If a request fails in a way that looks like a blocked domain, do not repeatedly retry the same blocked domain — it is fine to try a reasonable alternative (different mirror, registry, or approach) if one exists, but if there is no good alternative, identify the exact URL or domain needed and why it is needed, stop execution, and use ask_user to ask the user to request it be whitelisted.
- File locations: /home/agent/shared is the shared task folder, a slow shared mount also visible to the user — never build or edit in place there, and never copy file trees to or from it file-by-file. The task repo is already extracted for you at /home/agent/workspace/<repo-dir> (local fast disk); do all work (builds, tests, edits) there. If the task produced code changes, export them when the task completes by writing a single archive to /home/agent/shared/output.tar containing the whole changed repo directory, excluding VCS metadata, dependency and build-artifact directories, e.g.: \`tar -cf /home/agent/shared/output.tar -C /home/agent/workspace --exclude='.git' --exclude='node_modules' --exclude='build' --exclude='dist' --exclude='out' --exclude='target' --exclude='.gradle' --exclude='.next' --exclude='__pycache__' --exclude='.venv' --exclude='*.o' <repo-dir>\`. Use /tmp for scratch files. Only call save_deliverable for the final output the user explicitly asked for — do not save intermediate or working files as deliverables.
- When working in a repository, first look for agent instruction files and follow them: AGENTS.md (root and subdirectories), CLAUDE.md, and Cursor rules (.cursor/rules/*.mdc, .cursorrules). Repo-specific instructions take precedence over these general rules.
- User-uploaded files are in ~/uploads.
- Ports 18790, 5900, 6080, 8090, and 9222 are reserved by system services. Never kill processes bound to them and never bind your own servers to them. Run dev servers on other ports (e.g. 3000, 5173, 8081).
- Never fabricate facts, titles, summaries, citations, or data. Fetch/read real content before reporting on it.
- MCP tools (Jira/Confluence) are available. When the user mentions something that looks like a Jira ticket key (e.g. ABC-123), treat it as a Jira issue and use the MCP tools to look it up rather than guessing.`;

// ─── Desktop cleanup ───────────────────────────────────────────────────────
// Kill GUI apps between tasks so the desktop resets cleanly.

let _cleanupInFlight = false;

function cleanupDesktop() {
  if (_cleanupInFlight) return;
  _cleanupInFlight = true;

  const browsers = ["chromium", "chromium-browser", "google-chrome", "firefox"];
  const otherApps = [
    "thunar",
    "mousepad",
    "xfce4-terminal",
    "libreoffice",
    "eog",
    "evince",
    "gedit",
    "nemo",
  ];

  const browserPattern = browsers.join("|");
  execFile(
    "pkill",
    ["--oldest", "-f", "--signal", "TERM", browserPattern],
    (err) => {
      if (!err)
        console.log(
          `[cleanup] Sent SIGTERM to browser (oldest, pattern: ${browserPattern})`,
        );
      else if (err.code !== 1)
        console.error(`[cleanup] browser SIGTERM error: ${err.message}`);
    },
  );

  execFile("pkill", ["-f", otherApps.join("|")], (err) => {
    if (!err) console.log(`[cleanup] Killed other apps`);
    else if (err.code !== 1)
      console.error(`[cleanup] pkill error: ${err.message}`);
  });

  // Force-kill browsers if still alive after 2 s
  setTimeout(() => {
    execFile("pkill", ["-KILL", "-f", browserPattern], (err) => {
      if (!err) console.log(`[cleanup] Force-killed remaining browsers`);
      else if (err.code !== 1)
        console.error(`[cleanup] browser SIGKILL error: ${err.message}`);
    });
    console.log("[cleanup] Desktop apps cleaned up");
    _cleanupInFlight = false;
  }, 2000);
}

// ─── Trace logging ─────────────────────────────────────────────────────────
// Writes a JSON-lines trace entry scoped to a session.
// Each session gets its own file: /home/agent/logs/<sessionId>.jsonl
// A cron job removes files older than 3 hours so the directory never bloats.

function writeTrace(entry, sessionId) {
  const sid = sessionId || workspace.currentSessionId || AGENT_NAME;
  const logFile = path.join(LOGS_DIR, `${sid}.jsonl`);
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch {}
}

// ─── RPC communication ─────────────────────────────────────────────────────
// Writes a follow-up prompt to the active hypervisor pi process via stdin RPC.

function sendRpcPrompt(prompt) {
  if (!workspace.piRpc) return;
  workspace.piRpc.write(
    JSON.stringify({
      id: `prompt-${Date.now()}`,
      type: "prompt",
      message: prompt,
      streamingBehavior: "followUp",
    }) + "\n",
  );
  console.log(`[pi] RPC prompt sent: ${prompt}`);
}

// Injects a message into an already-running turn via the "steer" RPC command.
// Unlike sendRpcPrompt (followUp), this is delivered after the current tool
// call finishes but before the next LLM call — a fast interjection that
// doesn't wait for the agent to go fully idle.
function sendRpcSteer(message) {
  if (!workspace.piRpc) return;
  workspace.piRpc.write(
    JSON.stringify({
      id: `steer-${Date.now()}`,
      type: "steer",
      message,
    }) + "\n",
  );
  console.log(`[pi] RPC steer sent: ${message}`);
}

// ─── Models configuration ──────────────────────────────────────────────────
// Writes ~/.pi/agent/models.json so the pi agent uses our LLM proxy instead
// of the real provider directly.  This lets us optimize context before forwarding.

function writeModelsJson(guestBaseUrl, model) {
  const piDir = "/home/agent/.pi/agent";
  const modelsJsonPath = path.join(piDir, "models.json");
  try {
    fs.mkdirSync(piDir, { recursive: true });
  } catch {}

  if (!guestBaseUrl) {
    settings.LLM_PROXY_TARGET = "";
    try {
      fs.unlinkSync(modelsJsonPath);
    } catch {}
    return;
  }

  settings.LLM_PROXY_TARGET = guestBaseUrl;
  const proxyBaseUrl = `http://localhost:${PORT}/llm-proxy/v1`;

  const modelsJson = {
    providers: {
      local: {
        baseUrl: proxyBaseUrl,
        api: "openai-completions",
        apiKey: settings.OPENAI_API_KEY || "sk-local-no-key-required",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
          supportsStrictMode: false,
        },
        models: [{ id: model, contextWindow: settings.CONTEXT_WINDOW }],
      },
    },
  };

  fs.writeFileSync(modelsJsonPath, JSON.stringify(modelsJson, null, 2), "utf8");
  console.log(
    `[pi] Wrote models.json: provider=local, baseUrl=${proxyBaseUrl} (proxy → ${guestBaseUrl}), model=${model}`,
  );
}

function buildPiArgs({ sessionId, extensions, systemPrompt }) {
  const guestBaseUrl = resolveBaseUrlForGuest(settings.OPENAI_BASE_URL);
  const isLocalProvider = !!guestBaseUrl;
  writeModelsJson(guestBaseUrl, settings.OPENAI_MODEL);

  const args = [
    "--mode",
    "rpc",
    "--provider",
    isLocalProvider ? "local" : "openai",
    "--model",
    settings.OPENAI_MODEL,
    "--session-id",
    sessionId,
    "--approve",
  ];

  for (const extension of extensions || []) {
    args.push("--extension", path.join(EXTENSIONS_DIR, extension));
  }
  args.push("--system-prompt", systemPrompt);

  return { args, guestBaseUrl, isLocalProvider };
}

// /etc/environment is only applied by PAM at login; this service runs under
// systemd, so proxy vars pushed by host/launch-task.sh never reach process.env.
// Load them here so agent-spawned commands can use the whitelist proxy.
function loadSystemEnvironment() {
  const env = {};
  try {
    const lines = fs.readFileSync("/etc/environment", "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[m[1]] = value;
    }
  } catch {
    // No /etc/environment (e.g. non-VM dev) — nothing to load.
  }
  return env;
}

// ─── Pi process launcher ───────────────────────────────────────────────────
// Spawns a pi agent in RPC mode and wires up stdio line-buffering, error
// logging, and a deferred prompt send.  Returns the ChildProcess.

function launchPiProcess({
  label,
  sessionId,
  extensions,
  systemPrompt,
  prompt,
  onEvent,
  onClose,
  onSpawn,
  autoCompaction = false,
  autoRetry = true,
}) {
  const { args, guestBaseUrl, isLocalProvider } = buildPiArgs({
    sessionId,
    extensions,
    systemPrompt,
  });

  console.log(
    `[${label}] Launching Pi — provider=${isLocalProvider ? "local" : "openai"}, model=${settings.OPENAI_MODEL}, base_url=${settings.OPENAI_BASE_URL || "(default)"}, resolved=${guestBaseUrl || "(default)"}`,
  );

  const agentEnv = {
    ...process.env,
    ...loadSystemEnvironment(),
    HOME: "/home/agent",
    DISPLAY: ":0",
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/1000/bus`,
  };
  if (settings.OPENAI_API_KEY)
    agentEnv.OPENAI_API_KEY = settings.OPENAI_API_KEY;

  const proc = spawn("pi", args, {
    env: agentEnv,
    cwd: "/home/agent",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (onSpawn) onSpawn(proc);

  let stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) onEvent(line, proc);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[${label}:err] ${text}`);
  });

  proc.on("close", (code) => {
    console.log(`[${label}] Pi exited with code ${code}`);
    if (onClose) onClose(code, proc);
  });

  // Defer RPC init messages until pi has had time to start its stdin reader.
  setTimeout(() => {
    if (!proc.stdin.writable) {
      console.error(
        `[${label}] Pi exited before RPC init — cannot send prompt`,
      );
      return;
    }
    if (autoCompaction) {
      proc.stdin.write(
        JSON.stringify({ type: "set_auto_compaction", enabled: true }) + "\n",
      );
    }
    if (autoRetry) {
      proc.stdin.write(
        JSON.stringify({ type: "set_auto_retry", enabled: true }) + "\n",
      );
    }
    if (prompt) {
      proc.stdin.write(
        JSON.stringify({
          id: `${label}-prompt-${Date.now()}`,
          type: "prompt",
          message: prompt,
          streamingBehavior: "followUp",
        }) + "\n",
      );
    }
  }, 1000);

  return proc;
}

module.exports = {
  SYSTEM_PROMPT,
  cleanupDesktop,
  writeTrace,
  sendRpcPrompt,
  sendRpcSteer,
  writeModelsJson,
  buildPiArgs,
  launchPiProcess,
};
