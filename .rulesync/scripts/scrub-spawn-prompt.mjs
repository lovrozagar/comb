#!/usr/bin/env node
/** PreToolUse: intent-scrub spawn `prompt`. Fail-open: unchanged/error → empty stdout, exit 0. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scrubText } from "./scrub-text-lib.mjs";
import { denyResponse } from "./gate-fat-tools.mjs";

const ALLOWED_TYPES = new Set(["grunt"]);
export const MAX_PROMPT_CHARS = 100000;
export const TRUNCATE_SUFFIX = "…[truncated]";
/** `router` is a legacy transcript prefix; keep matching it to strip old pastes. */
const TRANSCRIPT_PREFIX =
  /^\s*(?:\[(?:orchestrator|router|implementer|thinker|grunt)\]:|Human:|Assistant:)\s*/i;
const YOU_ARE_SUBAGENT =
  /^\s*You are (?:grunt|implementer|thinker) subagent\b/;

export function stripTranscripts(text) {
  const lines = String(text).split(/\n/);
  const out = [];
  let keptYouAre = false;
  for (const line of lines) {
    if (TRANSCRIPT_PREFIX.test(line)) continue;
    if (YOU_ARE_SUBAGENT.test(line)) {
      if (keptYouAre) continue;
      keptYouAre = true;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function truncatePrompt(text, _max = MAX_PROMPT_CHARS) {
  return String(text);
}

export function workspaceRootOf(data) {
  return (
    process.env.GROK_WORKSPACE_ROOT ||
    (data && (data.workspaceRoot || data.workspace_root || data.cwd)) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd() ||
    ""
  );
}

export function spawnCapReason(workspaceRoot) {
  const root = workspaceRoot || process.cwd() || "";
  return (
    `spawn prompt exceeds ${MAX_PROMPT_CHARS} chars after scrub; write it under ${root}/.tmp/grunt/plans/ and re-spawn with that abs path`
  );
}

const INLINE_TRANSCRIPT =
  /\s*(?:\[(?:orchestrator|router|implementer|thinker|grunt)\]:|Human:|Assistant:)\s*/gi;
const EXTRA_YOU_ARE =
  /\s*You are (?:grunt|implementer|thinker) subagent\b[^.]*\.?/g;

export function stripInlineTranscripts(text) {
  let s = String(text);
  const first = s.match(
    /^\s*You are (?:grunt|implementer|thinker) subagent\b[^.]*\.?\s*/,
  );
  const prefix = first ? first[0] : "";
  let rest = first ? s.slice(first[0].length) : s;
  rest = rest.replace(INLINE_TRANSCRIPT, " ");
  rest = rest.replace(EXTRA_YOU_ARE, " ");
  return (prefix + rest).replace(/[ \t]{2,}/g, " ").trim();
}

export function capSpawnPrompt(prompt) {
  let s = stripTranscripts(String(prompt));
  s = scrubText(s, { intent: true });
  s = stripTranscripts(s);
  s = stripInlineTranscripts(s);
  return s.trim();
}

const SPAWN_TYPE_KEYS = ["subagent_type", "subagentType", "name", "type", "agent"];
const FORBIDDEN_SPAWN_TYPES = new Set([
  "explore",
  "plan",
  "general-purpose",
  "orchestrator",
]);

function spawnTypeCandidate(toolInput) {
  for (const k of SPAWN_TYPE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(toolInput, k)) continue;
    if (toolInput[k] == null) continue;
    const v = String(toolInput[k]).trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (ALLOWED_TYPES.has(key)) return key;
    if (FORBIDDEN_SPAWN_TYPES.has(key)) return "";
    return "";
  }
  return "";
}

export function rewriteSpawnToolInput(toolInput, { defaultGrunt = false } = {}) {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return defaultGrunt ? { subagent_type: "grunt" } : null;
  }

  const next = Object.assign({}, toolInput);
  let changed = false;

  if (defaultGrunt) {
    const cur = spawnTypeCandidate(toolInput);
    if (ALLOWED_TYPES.has(cur)) {
      if (String(next.subagent_type || "") !== cur) {
        next.subagent_type = cur;
        changed = true;
      }
    } else {
      next.subagent_type = "grunt";
      if (Object.prototype.hasOwnProperty.call(toolInput, "subagentType")) {
        next.subagentType = "grunt";
      }
      changed = true;
    }
  }

  if (typeof next.prompt === "string") {
    const scrubbed = capSpawnPrompt(next.prompt);
    if (scrubbed !== next.prompt) {
      next.prompt = scrubbed;
      changed = true;
    }
  }

  return changed ? next : null;
}

export function grokDefaultGrunt() {
  return Boolean(process.env.GROK_HOOK_EVENT);
}

export function processHookPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  let toolInput = data.toolInput;
  if (toolInput == null) toolInput = data.tool_input;
  const updated = rewriteSpawnToolInput(toolInput, {
    defaultGrunt: grokDefaultGrunt(),
  });
  const prompt =
    updated && typeof updated.prompt === "string"
      ? updated.prompt
      : toolInput && typeof toolInput.prompt === "string"
        ? toolInput.prompt
        : "";
  if (prompt.length > MAX_PROMPT_CHARS) {
    return denyResponse(spawnCapReason(workspaceRootOf(data)));
  }
  return updated;
}

export function hookResponse(updated) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: updated,
    },
  };
}

function main() {
  try {
    const data = readJsonValue();
    const updated = processHookPayload(data);
    if (!updated) return 0;
    if (updated.decision === "block") {
      process.stdout.write(JSON.stringify(updated));
      return 0;
    }
    process.stdout.write(JSON.stringify(hookResponse(updated)));
    return 0;
  } catch {
    return 0;
  }
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
