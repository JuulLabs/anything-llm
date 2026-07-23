#!/usr/bin/env node

import { createInterface, clearLine, cursorTo } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

function parseArgs(argv) {
  const opts = { url: "http://localhost:9800", agent: null, verbose: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--agent") opts.agent = argv[++i];
    else if (a === "--url") opts.url = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node host/chat.mjs [options]

Options:
  --agent <name>   Read agents/<name>/agent.json for app_port
  --url <url>      Interface service base URL (default: http://localhost:9800)
  --verbose, -v    Show agent_log lines
  --help, -h       Show this help
`);
}

function resolveBaseUrl(opts) {
  if (opts.agent) {
    const jsonPath = join(REPO_ROOT, "agents", opts.agent, "agent.json");
    if (!existsSync(jsonPath)) {
      console.error(`Agent not found: ${jsonPath}`);
      process.exit(1);
    }
    const data = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (!data.app_port) {
      console.error(`agent.json missing app_port for agent "${opts.agent}"`);
      process.exit(1);
    }
    return `http://localhost:${data.app_port}`;
  }
  return opts.url.replace(/\/+$/, "");
}

function wsUrl(baseUrl) {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws/events";
  u.search = "";
  u.hash = "";
  return u.toString();
}

async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || data.raw || `HTTP ${res.status}`);
  return data;
}

function indent(text, prefix = "  ") {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

function formatStatus(data) {
  const lines = [
    `workspace: ${data.name ?? data.workspace_id ?? "?"}`,
    `status: ${data.status ?? "?"}`,
    `agent_status: ${data.agent_status ?? "?"}`,
    `last_exit_code: ${data.last_exit_code ?? "null"}`,
  ];
  if (data.subagent_run) {
    const r = data.subagent_run;
    lines.push(
      `subagent_run: ${r.id} (${r.status}) step ${r.active_index + 1}/${r.total}`,
    );
  }
  return lines.join("\n");
}

function formatUsage(u) {
  const lines = [
    `turns: ${u.turns ?? 0}  tools: ${u.toolCalls ?? 0}`,
    `elapsed: ${Math.round((u.elapsedMs ?? 0) / 1000)}s`,
    `reported tokens: in=${u.inputTokensReported ?? 0} out=${u.outputTokensReported ?? 0}`,
    `estimated tokens: in=${u.inputTokensEstimated ?? 0} out=${u.outputTokensEstimated ?? 0}`,
    `proxy calls: ${u.proxyCalls ?? 0}  context window: ${u.contextWindow ?? 0}`,
  ];
  const breakdown = Object.entries(u.toolCallsByName || {});
  if (breakdown.length) {
    lines.push(`tools: ${breakdown.map(([k, v]) => `${k}:${v}`).join(" ")}`);
  }
  return lines.join("\n");
}

function formatDeliverables(data) {
  const items = data.deliverables || [];
  if (!items.length) return "(no deliverables)";
  return items
    .map((d, i) => {
      const parts = [d.filename || d.name || `item ${i + 1}`];
      if (d.size != null) parts.push(`${d.size} bytes`);
      if (d.saved_at || d.ts) parts.push(d.saved_at || d.ts);
      return `  - ${parts.join(" · ")}`;
    })
    .join("\n");
}

const opts = parseArgs(process.argv);
if (opts.help) {
  printHelp();
  process.exit(0);
}

const baseUrl = resolveBaseUrl(opts);
const rl = createInterface({ input: process.stdin, output: process.stdout });

let ws = null;
let wsAttempts = 0;
let reconnectTimer = null;
let quitting = false;
let promptReady = false;
let statusLineActive = false;
let agentLineOpen = false;
let lastAssistantChunk = "";
let pendingPlan = null;
let planResolving = false;
let inputPaused = false;
const seenChat = new Set();

function isPromptVisible() {
  return promptReady && !quitting && !inputPaused && !planResolving;
}

function clearCurrentLine() {
  clearLine(process.stdout, 0);
  cursorTo(process.stdout, 0);
}

function clearPromptLine() {
  if (!isPromptVisible()) return;
  clearCurrentLine();
}

function clearStatusLine() {
  if (!statusLineActive) return;
  clearCurrentLine();
  statusLineActive = false;
}

function writeStatusLine(text) {
  if (isPromptVisible()) {
    clearPromptLine();
    promptReady = false;
  }
  clearStatusLine();
  process.stdout.write(text);
  statusLineActive = true;
}

function safePrint(writeFn) {
  const restorePrompt = isPromptVisible();
  if (restorePrompt) clearPromptLine();
  else clearStatusLine();
  writeFn();
  if (restorePrompt) rl.prompt(true);
}

function safeLog(...args) {
  safePrint(() => console.log(...args));
}

function safeError(...args) {
  safePrint(() => console.error(...args));
}

function closeAgentLine() {
  if (agentLineOpen) {
    process.stdout.write("\n");
    agentLineOpen = false;
    lastAssistantChunk = "";
    if (isPromptVisible()) showPrompt();
  }
}

function printRole(role, content) {
  closeAgentLine();
  const prefix = role === "user" ? `${CYAN}you>${RESET} ` : `${GREEN}agent>${RESET} `;
  safeLog(`${prefix}${content}`);
}

function printAgentDelta(content) {
  if (!content) return;
  if (!agentLineOpen) {
    if (isPromptVisible()) clearPromptLine();
    rl.pause();
    process.stdout.write(`\n${GREEN}agent>${RESET} `);
    agentLineOpen = true;
  } else {
    process.stdout.write(" ");
  }
  process.stdout.write(content);
  lastAssistantChunk = content;
  if (!inputPaused) rl.resume();
}

function printAgentLog(content) {
  if (!opts.verbose) return;
  closeAgentLine();
  safeLog(`${DIM}${content}${RESET}`);
}

function printHelpBanner(evt) {
  closeAgentLine();
  const title = evt.title || "Agent Question";
  const body = evt.content || "The agent needs your help.";
  safePrint(() => {
    console.log(`\n${BOLD}${YELLOW}━━━ ${title} ━━━${RESET}`);
    console.log(`${BOLD}${body}${RESET}`);
    console.log(`${DIM}(type your answer at the prompt below)${RESET}\n`);
  });
}

function printPlanReview(plan) {
  closeAgentLine();
  pendingPlan = plan;
  const title = plan.title || "Execution Plan";
  safePrint(() => {
    console.log(`\n${BOLD}${YELLOW}━━━ Plan Review: ${title} ━━━${RESET}`);
    if (plan.attempt) console.log(`${DIM}attempt ${plan.attempt}${RESET}`);
    if (plan.reason) console.log(indent(plan.reason));
    const items = Array.isArray(plan.items) && plan.items.length
      ? plan.items
      : ["Review the task and proceed carefully."];
    items.forEach((item, i) => console.log(`  ${i + 1}. ${item}`));
    const questions = (plan.questions || []).filter(Boolean);
    if (questions.length) {
      console.log(`${DIM}Questions:${RESET}`);
      questions.forEach((q, i) => console.log(`  Q${i + 1}. ${q}`));
    }
  });
  promptPlanDecision();
}

function promptPlanDecision() {
  if (planResolving || !pendingPlan) return;
  planResolving = true;
  inputPaused = true;
  rl.pause();
  rl.question(
    `${YELLOW}approve/deny (feedback)?${RESET} `,
    async (answer) => {
      planResolving = false;
      inputPaused = false;
      const trimmed = (answer || "").trim();
      if (!pendingPlan) {
        rl.resume();
        showPrompt();
        return;
      }
      const lower = trimmed.toLowerCase();
      let action;
      let feedback;
      if (lower === "approve" || lower === "a" || lower === "yes" || lower === "y") {
        action = "approve";
      } else if (lower.startsWith("deny") || lower === "d" || lower === "no" || lower === "n") {
        action = "deny";
        const m = trimmed.match(/^deny\s*:?\s*(.*)$/i);
        feedback = m?.[1]?.trim() || undefined;
      } else if (lower === "") {
        safeError(`${RED}Enter 'approve' or 'deny' (optionally 'deny: reason')${RESET}`);
        promptPlanDecision();
        return;
      } else {
        action = "deny";
        feedback = trimmed;
      }
      const plan = pendingPlan;
      pendingPlan = null;
      try {
        const body = {
          requestId: plan.requestId,
          action,
          items: plan.items,
        };
        if (feedback) body.feedback = feedback;
        const res = await api(baseUrl, "POST", "/api/v1/plan-response", body);
        safeLog(
          `${GREEN}Plan ${action}d${res.requestId ? ` (new id: ${res.requestId})` : ""}${RESET}`,
        );
      } catch (err) {
        safeError(`${RED}Plan response failed: ${err.message}${RESET}`);
        pendingPlan = plan;
        promptPlanDecision();
        return;
      }
      rl.resume();
      showPrompt();
    },
  );
}

function chatKey(role, content) {
  return `${role}:${content}`;
}

const sentPrompts = new Set();

function handleEvent(msg, fromReplay = false) {
  switch (msg.type) {
    case "connected": {
      clearStatusLine();
      safePrint(() => {
        console.log(
          `${DIM}connected to ${msg.name ?? msg.workspace_id ?? "workspace"} (agent: ${msg.agent_status ?? "?"})${RESET}`,
        );
      });
      promptReady = true;
      showPrompt();
      return;
    }
    case "log_replay":
      for (const entry of msg.entries || []) handleEvent(entry, true);
      if ((msg.entries || []).length) safeLog(`${DIM}--- live ---${RESET}`);
      return;
    case "vm_log_replay":
    case "vm_log":
      return;
    case "chat_message": {
      if (msg.role === "user" && sentPrompts.has(msg.content)) {
        sentPrompts.delete(msg.content);
        return;
      }
      const key = chatKey(msg.role, msg.content);
      if (fromReplay && seenChat.has(key)) return;
      seenChat.add(key);
      if (msg.role === "assistant" && agentLineOpen && msg.content === lastAssistantChunk) {
        closeAgentLine();
        return;
      }
      if (msg.role === "assistant" && agentLineOpen) {
        closeAgentLine();
      }
      printRole(msg.role || "assistant", msg.content);
      return;
    }
    case "agent_delta":
      if (!fromReplay) printAgentDelta(msg.content);
      return;
    case "agent_log":
      printAgentLog(msg.content);
      return;
    case "ask_for_help":
      printHelpBanner(msg);
      return;
    case "plan_review":
      printPlanReview(msg);
      return;
    case "plan_resolved":
      safeLog(`${DIM}plan ${msg.requestId}: ${msg.status}${RESET}`);
      if (pendingPlan?.requestId === msg.requestId) pendingPlan = null;
      return;
    case "agent_done":
      closeAgentLine();
      safeLog(
        `\n${msg.code === 0 ? GREEN : RED}● Agent finished (exit ${msg.code})${RESET}`,
      );
      return;
    case "agent_error":
      closeAgentLine();
      safeLog(`${RED}✗ ${msg.errorType ?? "error"}: ${msg.content}${RESET}`);
      return;
    case "deliverable_saved":
      safeLog(`${GREEN}📎 Deliverable saved${RESET}`);
      return;
    case "task_usage":
    case "proxy_usage":
    case "llm_status":
    case "chat_tool_hint":
    case "subagent_log":
      return;
    default:
      if (opts.verbose && msg.content) printAgentLog(String(msg.content));
  }
}

function showPrompt() {
  if (!promptReady || quitting || inputPaused || planResolving) return;
  rl.prompt();
}

function connectWs() {
  if (quitting) return;
  const url = wsUrl(baseUrl);
  try {
    ws = new WebSocket(url);
  } catch (err) {
    scheduleReconnect(`WebSocket error: ${err.message}`);
    return;
  }

  ws.addEventListener("open", () => {
    wsAttempts = 0;
  });

  ws.addEventListener("message", (ev) => {
    try {
      handleEvent(JSON.parse(ev.data));
    } catch (err) {
      if (opts.verbose) safeError(`${DIM}[ws parse] ${err.message}${RESET}`);
    }
  });

  ws.addEventListener("error", () => {});

  ws.addEventListener("close", () => {
    ws = null;
    if (quitting) return;
    wsAttempts++;
    if (wsAttempts > 20) {
      clearStatusLine();
      safeError(`${RED}Disconnected — gave up reconnecting${RESET}`);
      promptReady = false;
      return;
    }
    const delay = Math.min(1000 * 1.5 ** wsAttempts, 30000);
    writeStatusLine(
      `${YELLOW}Disconnected — reconnecting in ${Math.round(delay / 1000)}s...${RESET}`,
    );
    scheduleReconnect(null, delay);
  });
}

function scheduleReconnect(reason, delay = 2000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (reason) writeStatusLine(`${RED}${reason}${RESET}`);
    connectWs();
  }, delay);
}

async function handleSlash(cmd) {
  closeAgentLine();
  const [name, ...rest] = cmd.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  try {
    switch (name) {
      case "help":
        safeLog(`Slash commands:
  /abort        Kill running agent
  /new          Start new session
  /compact      Trigger context compaction
  /status       Show agent status
  /usage        Show token usage
  /deliverables List saved deliverables
  /steer <msg>  Inject a message into the currently-running turn
  /quit         Exit
  /help         Show this help`);
        break;
      case "abort":
        safeLog(await api(baseUrl, "POST", "/api/v1/abort"));
        break;
      case "steer":
        if (!arg) {
          safeLog(`${RED}Usage: /steer <message>${RESET}`);
          break;
        }
        await sendSteer(arg);
        break;
      case "new":
        safeLog(await api(baseUrl, "POST", "/api/v1/new-session"));
        seenChat.clear();
        break;
      case "compact":
        safeLog(await api(baseUrl, "POST", "/api/v1/compact"));
        break;
      case "status":
        safeLog(formatStatus(await api(baseUrl, "GET", "/api/v1/status")));
        break;
      case "usage":
        safeLog(formatUsage(await api(baseUrl, "GET", "/api/v1/usage")));
        break;
      case "deliverables":
        safeLog(formatDeliverables(await api(baseUrl, "GET", "/api/v1/deliverables")));
        break;
      case "quit":
      case "exit":
        quitting = true;
        if (ws) ws.close();
        rl.close();
        process.exit(0);
        break;
      default:
        safeLog(`${RED}Unknown command: /${name}${RESET} (try /help)`);
        if (arg) safeLog(`${DIM}ignored args: ${arg}${RESET}`);
    }
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED" || err.message.includes("fetch failed")) {
      safeError(`${RED}Cannot reach ${baseUrl} — is the agent running?${RESET}`);
    } else {
      safeError(`${RED}${err.message}${RESET}`);
    }
  }
}

async function sendPrompt(text) {
  try {
    const res = await api(baseUrl, "POST", "/api/v1/prompt", { prompt: text });
    if (res.status && res.status !== "prompt_sent") {
      safeLog(`${DIM}[${res.status}]${RESET}`);
    }
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED" || err.message.includes("fetch failed")) {
      safeError(`${RED}Cannot reach ${baseUrl} — is the agent running?${RESET}`);
    } else {
      safeError(`${RED}Prompt failed: ${err.message}${RESET}`);
    }
  }
}

async function sendSteer(text) {
  sentPrompts.add(text);
  try {
    const res = await api(baseUrl, "POST", "/api/v1/prompt", { prompt: text, mode: "steer" });
    if (res.status && res.status !== "steer_sent") {
      safeLog(`${DIM}[${res.status}]${RESET}`);
    }
  } catch (err) {
    sentPrompts.delete(text);
    if (err.cause?.code === "ECONNREFUSED" || err.message.includes("fetch failed")) {
      safeError(`${RED}Cannot reach ${baseUrl} — is the agent running?${RESET}`);
    } else {
      safeError(`${RED}Steer failed: ${err.message}${RESET}`);
    }
  }
}

rl.setPrompt(`${CYAN}you>${RESET} `);

rl.on("line", async (line) => {
  if (!promptReady || planResolving) return;
  const text = line.trim();
  if (!text) {
    showPrompt();
    return;
  }
  if (text.startsWith("/")) {
    await handleSlash(text);
    showPrompt();
    return;
  }
  if (pendingPlan) {
    safeLog(`${YELLOW}Respond to the plan review first (approve/deny)${RESET}`);
    promptPlanDecision();
    return;
  }
  sentPrompts.add(text);
  await sendPrompt(text);
  showPrompt();
});

rl.on("close", () => {
  quitting = true;
  if (ws) ws.close();
  process.exit(0);
});

console.log(`${DIM}Open Computer chat → ${baseUrl}${RESET}`);
console.log(`${DIM}Type /help for commands${RESET}\n`);

connectWs();

fetch(`${baseUrl}/api/v1/ping`)
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  })
  .catch((err) => {
    if (err.cause?.code === "ECONNREFUSED" || err.message.includes("fetch failed")) {
      writeStatusLine(
        `${YELLOW}Warning: cannot reach ${baseUrl} — is the agent running?${RESET}`,
      );
    }
  });
