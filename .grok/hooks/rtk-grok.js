#!/usr/bin/env node
/** Grok PreToolUse: rewrite Bash/run_terminal_command through `rtk rewrite`.

Fail-open: parse error, missing rtk, timeout, no rewrite → empty stdout, exit 0.
Keep the full toolInput (Grok needs `description`); only replace `command`.
*/
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const RTK_TIMEOUT_MS = 3000;

const ULTRA_SUBS = new Set([
  "grep",
  "rg",
  "curl",
  "wget",
  "vitest",
  "jest",
  "pytest",
  "test",
  "lint",
  "tsc",
  "npm",
  "npx",
  "read",
  "find",
  "diff",
  "json",
  "log",
  "playwright",
  "cargo",
  "ruff",
  "prettier",
  "format",
]);

function main() {
  try {
    const data = readJsonValue();
    if (data === undefined) return 0;
    if (!data || typeof data !== "object" || Array.isArray(data)) return 0;
    let toolInput = data.toolInput;
    if (toolInput == null) toolInput = data.tool_input;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return 0;
    const cmdRaw = toolInput.command;
    if (typeof cmdRaw !== "string") return 0;
    const cmd = cmdRaw.trim();
    if (!cmd) return 0;

    const first = cmd.split(/\s+/, 1)[0] || "";
    const already = first === "rtk" || first.endsWith("/rtk");
    let rewritten;
    if (already) {
      rewritten = injectUltra(cmd);
      if (rewritten === cmd) return 0;
    } else {
      rewritten = rewrite(cmd);
      if (!rewritten) return 0;
    }

    const updated = Object.assign({}, toolInput, { command: rewritten });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecisionReason: "RTK auto-rewrite",
          updatedInput: updated,
        },
      }),
    );
    return 0;
  } catch {
    return 0;
  }
}

function injectUltra(rewritten) {
  if (rewritten.includes("--ultra-compact")) return rewritten;
  const m = rewritten.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/);
  if (!m || m[1] !== "rtk") return rewritten;
  if (!ULTRA_SUBS.has(m[2])) return rewritten;
  const rest = m[3] || "";
  return "rtk " + m[2] + " --ultra-compact" + (rest ? " " + rest : "");
}

function whichRtk() {
  const rtk = spawnSync("sh", ["-c", "command -v rtk"], { encoding: "utf8" });
  const path = (rtk.stdout || "").trim();
  return path || null;
}

function rewrite(cmd) {
  const rtk = whichRtk();
  if (!rtk) return null;
  try {
    const proc = spawnSync(rtk, ["rewrite", "--ultra-compact", cmd], {
      encoding: "utf8",
      timeout: RTK_TIMEOUT_MS,
    });
    const out = (proc.stdout || "").trim();
    if (!out || out === cmd) return null;
    return injectUltra(out);
  } catch {
    return null;
  }
}

/** Read one JSON value (Python json.load): stop when parseable, do not wait for EOF. */
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

process.exit(main());
