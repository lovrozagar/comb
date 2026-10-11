#!/usr/bin/env node
/** PreToolUse fat-gate + persist rewrite. Stop writes session receipt. SubagentStop intercepts need: search|exec|slice|fetch.
Fail-open: parse/crash → empty stdout, exit 0.
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_PROMPT_CHARS,
  rewriteSpawnToolInput,
  spawnCapReason,
} from "../../scripts/scrub-spawn-prompt.mjs";
import {
  denyResponse,
  fatHookOutput,
  processFatTools,
  rewriteGruntScratchPath,
} from "../../scripts/gate-fat-tools.mjs";
import { persistPlan } from "../../scripts/persist-plan.mjs";
import { persistHandoff } from "../../scripts/persist-handoff.mjs";
import { persistImplementation, isFullImplementationBody, validateImplementation } from "../../scripts/persist-implementation.mjs";
import { persistTmp } from "../../scripts/persist-tmp.mjs";
import { parseNeed } from "../../scripts/parse-need.mjs";
import { resolveJobCwd, runJob } from "../../scripts/grunt-job.mjs";
import { otherLines, recordHook } from "../../scripts/board.mjs";

export const ORCHESTRATOR_LOGS_DIR = ".tmp/grunt/orchestrator-logs";
/** One-release dual-read; drop next release. */
export const LEGACY_ORCHESTRATOR_LOGS_DIR = ".tmp/orchestrator-logs";
export const DENY_REASON = "denied";
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const SPAWN_TOOLS = new Set([
  "spawnsubagent",
  "task",
  "agent",
  "spawnagent",
]);
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "searchreplace",
  "replacefilecontent",
]);
const INTERCEPT_JOBS = new Set(["search", "exec", "slice", "fetch"]);
const MAX_INTERCEPT = 3;
const MAX_STOP = 3;
const AUTO_RE = /^\s*\/auto\s*$/;
const ASK_RE = /^\s*\/ask\s*$/;
export const SESSION_GATE_STAMP = "session-gate";
/** One-release dual-read of 0.5 leftover stamp. */
export const AUTO_ASK_STAMP = "auto-ask";
export const ASK_STOP_REASON = "ask after this step";
const WAIT_GRUNT = "[orchestrator]: wait grunt";

function main() {
  try {
    const data = readJsonValue();
    const event = eventKey(
      process.env.GROK_HOOK_EVENT ||
        (data && (data.hookEventName || data.hook_event_name)) ||
        "",
    );
    if (event === "pretooluse") return preToolUse(data || {});
    if (event === "userpromptsubmit") return userPromptSubmit(data || {});
    if (event === "stop") return stop(data || {});
    if (event === "subagentstop") return interceptNeed(data || {}, "SubagentStop");
    return 0;
  } catch {
    return 0;
  }
}

function preToolUse(data) {
  const toolName = String(data.toolName || data.tool_name || "");
  const toolKey = eventKey(toolName);
  let toolInput = data.toolInput;
  if (toolInput == null) toolInput = data.tool_input;

  if (SPAWN_TOOLS.has(toolKey)) {
    const updated = rewriteSpawn(toolInput, data);
    if (updated && updated.__denied) return 0;
    if (updated) {
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: updated,
        },
      });
      return 0;
    }
    return 0;
  }
  if (WRITE_TOOLS.has(toolKey)) {
    const persistCode = parentWrite(data, toolInput);
    if (persistCode !== null) return persistCode;
  }
  const fatCode = emitFat(data);
  if (fatCode !== null) return fatCode;
  return 0;
}

function emitFat(data) {
  const fat = fatHookOutput(processFatTools(data));
  if (!fat) return null;
  emit(fat);
  return 0;
}

function workspaceRootOf(data) {
  return (
    process.env.GROK_WORKSPACE_ROOT ||
    (data && (data.workspaceRoot || data.workspace_root)) ||
    (data && data.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd() ||
    ""
  );
}

function isUnderDir(filePath, workspaceRoot, segments) {
  if (!filePath || !workspaceRoot) return false;
  const abs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const dir = path.resolve(workspaceRoot, ...segments);
  const rel = path.relative(dir, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isUnderPlans(filePath, workspaceRoot) {
  return isUnderDir(filePath, workspaceRoot, [".tmp", "grunt", "plans"]);
}

export function isUnderHandoffs(filePath, workspaceRoot) {
  return isUnderDir(filePath, workspaceRoot, [".tmp", "grunt", "handoffs"]);
}

export function isUnderImplementations(filePath, workspaceRoot) {
  return isUnderDir(filePath, workspaceRoot, [".tmp", "grunt", "implementations"]);
}

export const TMP_RESERVED_DIRS = new Set([
  "plans",
  "handoffs",
  "implementations",
  "browser",
  "orchestrator-logs",
  "stash",
  "sessions",
]);

export function isUnderTmp(filePath, workspaceRoot) {
  if (!filePath || !workspaceRoot) return false;
  const abs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const root = path.resolve(workspaceRoot, ".tmp", "grunt");
  if (path.dirname(abs) !== root) return false;
  return !TMP_RESERVED_DIRS.has(path.basename(abs));
}

function parentWrite(data, toolInput) {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    emit(denyResponse(DENY_REASON));
    return 0;
  }
  const ws = workspaceRootOf(data);
  let rawPath =
    toolInput.file_path ||
    toolInput.filePath ||
    toolInput.path ||
    toolInput.target_file ||
    "";
  const rewritten = rewriteGruntScratchPath(rawPath, ws);
  if (rewritten) rawPath = rewritten;
  let persist;
  let invalid = "invalid plan";
  if (isUnderPlans(rawPath, ws)) {
    persist = persistPlan;
    invalid = "invalid plan";
  } else if (isUnderHandoffs(rawPath, ws)) {
    persist = persistHandoff;
    invalid = "invalid handoff";
  } else if (isUnderImplementations(rawPath, ws)) {
    persist = persistImplementation;
    invalid = "invalid implementation";
    const abs = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(ws, rawPath);
    const content = typeof toolInput.content === "string" ? toolInput.content : "";
    const named = /^\s*IMPL_NAME:/m.test(content);
    let exists = false;
    try {
      exists = fs.statSync(abs).isFile();
    } catch {
      exists = false;
    }
    if (!named && exists) {
      if (!isFullImplementationBody(content)) return null;
      const errors = validateImplementation(path.basename(abs), content);
      if (errors.length) {
        emit(denyResponse(errors.join("; ") || invalid));
        return 0;
      }
      const next = Object.assign({}, toolInput, {
        file_path: abs,
        content,
      });
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: next,
        },
      });
      return 0;
    }
  } else if (isUnderTmp(rawPath, ws)) {
    persist = persistTmp;
    invalid = "invalid tmp";
  } else {
    return null;
  }
  const content = typeof toolInput.content === "string" ? toolInput.content : "";
  const result = persist({ workspaceRoot: ws, content });
  if (!result.ok) {
    emit(denyResponse(result.error || invalid));
    return 0;
  }
  const next = Object.assign({}, toolInput, {
    file_path: result.path,
    content: result.content,
  });
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: next,
    },
  });
  return 0;
}

function rewriteSpawn(toolInput, data) {
  const updated = rewriteSpawnToolInput(toolInput, { defaultGrunt: true });
  const prompt =
    updated && typeof updated.prompt === "string"
      ? updated.prompt
      : toolInput && typeof toolInput.prompt === "string"
        ? toolInput.prompt
        : "";
  if (prompt.length > MAX_PROMPT_CHARS) {
    emit(denyResponse(spawnCapReason(workspaceRootOf(data))));
    return { __denied: true };
  }
  return updated;
}

function userPromptOf(data) {
  if (!data || typeof data !== "object") return "";
  return String(data.prompt ?? data.userPrompt ?? data.user_prompt ?? data.content ?? "");
}

function isHostStopBanner(prompt) {
  const p = String(prompt || "");
  if (/^\s*Stop hook feedback:/.test(p)) return true;
  if (/Blocked by stop hook/.test(p)) return true;
  if (/task[-_ ]?notification/i.test(p)) return true;
  return false;
}

function countLines(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

function sessionReceiptContext(data) {
  const sid = sessionIdOf(data);
  if (!sid || sid === "default") return "";
  const dir = path.join(
    workspaceRootOf(data),
    ".tmp",
    "grunt",
    "sessions",
    sid,
  );
  if (!fs.existsSync(dir)) return "";
  const wrote = countLines(path.join(dir, "wrote.txt"));
  const read = countLines(path.join(dir, "read.txt"));
  return `${wrote} wrote, ${read} read. session=.tmp/grunt/sessions/${sid}/`;
}

function writeSessionReceipt(data, msg) {
  const sid = sessionIdOf(data);
  if (!sid || sid === "default") return;
  const dir = path.join(
    workspaceRootOf(data),
    ".tmp",
    "grunt",
    "sessions",
    sid,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const wrote = countLines(path.join(dir, "wrote.txt"));
  const read = countLines(path.join(dir, "read.txt"));
  const first = firstNonEmptyStripped(msg).slice(0, 200);
  const lines = [
    first,
    `${wrote} wrote, ${read} read.`,
    `session=.tmp/grunt/sessions/${sid}/`,
  ].filter(Boolean);
  try {
    fs.writeFileSync(path.join(dir, "receipt.txt"), lines.join("\n") + "\n");
  } catch {
    /* fail-open */
  }
}

function userPromptSubmit(data) {
  const prompt = userPromptOf(data);
  if (isHostStopBanner(prompt)) return 0;
  unlinkStamp(data, "stop-block");
  applySessionGateSlash(data, prompt);
  let ctx = effectiveGruntContext(data);
  try {
    recordHook(data, process.env);
    const others = otherLines(data, process.env);
    if (others) ctx = ctx ? `${ctx}\n${others}` : others;
  } catch {
    // Board is best-effort. The session receipt still ships.
  }
  if (!ctx) return 0;
  emit({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: ctx,
    },
  });
  return 0;
}

export function isWaitGruntExact(msg) {
  const nonempty = String(msg || "")
    .split("\n")
    .filter((l) => l.trim());
  if (nonempty.length !== 1) return false;
  return nonempty[0].replace(/^[\s`*_>]+/, "") === WAIT_GRUNT;
}

export function hasStepAsk(msg) {
  if (isWaitGruntExact(msg)) return true;
  return String(msg || "")
    .split("\n")
    .map((l) => l.replace(/^[\s`*_>]+/, "").trim())
    .filter(Boolean)
    .some((l) => l.includes("?"));
}

function firstNonEmptyStripped(msg) {
  for (const line of String(msg || "").split("\n")) {
    if (!line.trim()) continue;
    return line.replace(/^[\s`*_>]+/, "");
  }
  return "";
}

function payloadAssistantMessage(data) {
  if (!data || typeof data !== "object") return "";
  const camel = data.lastAssistantMessage;
  if (camel != null && String(camel) !== "") return String(camel);
  const snake = data.last_assistant_message;
  if (snake != null && String(snake) !== "") return String(snake);
  return "";
}

function isAssistantRecord(obj) {
  if (!obj || typeof obj !== "object") return false;
  const type = String(obj.type || "").toLowerCase();
  if (type === "user" || type === "human" || type === "tool" || type === "tool_result") {
    return false;
  }
  if (type === "assistant") return true;
  const role = String(
    obj.role || (obj.message && obj.message.role) || "",
  ).toLowerCase();
  if (role === "user" || role === "human") return false;
  return role === "assistant";
}

function assistantTextFromRecord(obj) {
  if (!isAssistantRecord(obj)) return null;
  const msg = obj.message && typeof obj.message === "object" ? obj.message : obj;
  const content = msg.content ?? obj.content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const pt = String(part.type || "");
      if (pt === "tool_use" || pt === "tool_result" || pt === "function_call") continue;
      if (typeof part.text === "string" && part.text) texts.push(part.text);
    }
    const joined = texts.join("\n").trim();
    return joined ? joined : null;
  }
  if (typeof content === "string" && content.trim()) return content;
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  return null;
}

export function lastAssistantFromTranscript(filePath) {
  try {
    if (!filePath) return "";
    const st = fs.statSync(filePath);
    const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      if (start > 0 && lines.length) lines.shift();
      let last = "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let rec;
        try {
          rec = JSON.parse(t);
        } catch {
          continue;
        }
        const extracted = assistantTextFromRecord(rec);
        if (extracted) last = extracted;
      }
      return last;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function stop(data) {
  if (data.subagentType || data.subagent_type) {
    return interceptNeed(data, "Stop");
  }
  if (data.stopHookActive || data.stop_hook_active) {
    return 0;
  }
  const reason = String(data.reason || "");
  if (reason && reason !== "end_turn") return 0;

  const payloadMsg = payloadAssistantMessage(data);
  let msg = payloadMsg;
  if (!msg) {
    const tp = data.transcript_path || data.transcriptPath || "";
    msg = lastAssistantFromTranscript(tp);
  }
  writeSessionReceipt(data, msg);
  if (isWaitGruntExact(msg)) return 0;
  if (sessionGateOf(data) === "ask" && !hasStepAsk(msg)) {
    let n = readStampInt(data, "stop-block");
    if (n >= MAX_STOP) return 0;
    writeStamp(data, "stop-block", String(n + 1));
    emit({ decision: "block", reason: ASK_STOP_REASON });
    return 0;
  }
  return 0;
}

function interceptNeed(data, hookEventName) {
  const ws = workspaceRootOf(data);
  if (data.stopHookActive || data.stop_hook_active) {
    return 0;
  }
  const msg = data.lastAssistantMessage || data.last_assistant_message || "";
  const parsed = parseNeed(msg);
  if (!parsed.ok) {
    return 0;
  }
  const jobs = parsed.jobs;
  if (
    jobs.length > 4 ||
    !jobs.every((j) => INTERCEPT_JOBS.has(j.job))
  ) {
    return 0;
  }

  let n = readStampInt(data, "need-intercept");
  if (n >= MAX_INTERCEPT) {
    return 0;
  }

  const cwd = ws || process.cwd();
  const parts = [];
  for (const job of jobs) {
    let result;
    try {
      const jobCwd = job.cwd ? resolveJobCwd(job.cwd, cwd) : cwd;
      if (job.cwd && !jobCwd) {
        result = { fallback: true, text: "FALLBACK\n" };
      } else {
        result = runJob({
          job: job.job,
          query: job.query,
          cwd: jobCwd || cwd,
          path: job.path,
          glob: job.glob,
          stash: job.stash,
          from: job.from,
          to: job.to,
        });
      }
    } catch {
      result = { fallback: true, text: "FALLBACK\n" };
    }
    if (!result || result.fallback) {
      return 0;
    }
    parts.push(String(result.text || "").trimEnd());
  }
  writeStamp(data, "need-intercept", String(n + 1));
  const reason = parts.join("\n");
  emit({
    decision: "block",
    hookSpecificOutput: {
      hookEventName,
      additionalContext: reason,
    },
  });
  return 0;
}

function stampPath(data, prefix) {
  const root = workspaceRootOf(data);
  const sid = sessionIdOf(data) || "default";
  if (!root) return null;
  return path.join(root, ORCHESTRATOR_LOGS_DIR, prefix + "-" + sid);
}

function legacyStampPath(data, prefix) {
  const root = workspaceRootOf(data);
  const sid = sessionIdOf(data) || "default";
  if (!root) return null;
  return path.join(root, LEGACY_ORCHESTRATOR_LOGS_DIR, prefix + "-" + sid);
}

function resolveStamp(data, prefix) {
  const neu = stampPath(data, prefix);
  if (neu && fs.existsSync(neu)) return neu;
  const old = legacyStampPath(data, prefix);
  if (old && fs.existsSync(old)) return old;
  return null;
}

function writeStamp(data, prefix, body) {
  const p = stampPath(data, prefix);
  if (!p) return null;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

function readStampInt(data, prefix) {
  const p = resolveStamp(data, prefix);
  if (!p) return 0;
  const n = parseInt(fs.readFileSync(p, "utf8"), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function sessionIdOf(data) {
  return String(
    process.env.GROK_SESSION_ID ||
      (data && (data.sessionId || data.session_id)) ||
      "",
  );
}

function unlinkQuiet(p) {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    /* missing is fine */
  }
}

function unlinkStamp(data, prefix) {
  unlinkQuiet(stampPath(data, prefix));
  unlinkQuiet(legacyStampPath(data, prefix));
}

function sessionGateStampPath(data, prefix) {
  const root = workspaceRootOf(data);
  const sid = sessionIdOf(data);
  if (!root || !sid || sid === "default") return null;
  return path.join(root, ORCHESTRATOR_LOGS_DIR, prefix + "-" + sid);
}

function resolveSessionGateStamp(data) {
  for (const prefix of [SESSION_GATE_STAMP, AUTO_ASK_STAMP]) {
    const neu = sessionGateStampPath(data, prefix);
    if (neu && fs.existsSync(neu)) return neu;
    const old = path.join(
      workspaceRootOf(data),
      LEGACY_ORCHESTRATOR_LOGS_DIR,
      prefix + "-" + sessionIdOf(data),
    );
    if (sessionIdOf(data) && fs.existsSync(old)) return old;
  }
  return null;
}

function applySessionGateSlash(data, prompt) {
  let slash = "";
  if (AUTO_RE.test(prompt)) slash = "auto";
  else if (ASK_RE.test(prompt)) slash = "ask";
  if (!slash) return;
  const p = sessionGateStampPath(data, SESSION_GATE_STAMP);
  if (!p) return;
  unlinkQuiet(sessionGateStampPath(data, AUTO_ASK_STAMP));
  if (slash === "auto") {
    unlinkQuiet(p);
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, slash);
}

export function sessionGateOf(data) {
  try {
    const p = resolveSessionGateStamp(data);
    if (p) {
      const body = fs.readFileSync(p, "utf8").trim();
      if (body === "auto" || body === "ask") return body;
    }
  } catch {
    /* fall through */
  }
  return "auto";
}

export function effectiveGruntContext(data) {
  const gate = sessionGateOf(data);
  const receipt = sessionReceiptContext(data);
  return receipt ? `sessionGate=${gate}. ${receipt}` : `sessionGate=${gate}`;
}

function eventKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function readJsonValue() {
  let buf = Buffer.alloc(0);
  const tmp = Buffer.alloc(8192);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, tmp, 0, tmp.length, null);
    } catch {
      break;
    }
    if (n === 0) break;
    buf = Buffer.concat([buf, tmp.subarray(0, n)]);
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      // incomplete
    }
  }
  if (!buf.length) return undefined;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
