#!/usr/bin/env node
/** After rulesync subagent emit: Claude grunt body uses Bash; other targets keep run_terminal_command. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SSOT_REL = ".rulesync/subagents/grunt.md";
export const CLAUDE_GRUNT_REL = ".claude/agents/grunt.md";

export const GENERIC_TOOL_LIST =
  "read_file, grep, list_dir, run_terminal_command, write, search_replace, web_search, web_fetch";
export const CLAUDE_TOOL_LIST = "Read, Grep, Glob, Bash, Write, Edit, Web";

export function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let check = false;
  for (const a of args) {
    if (a === "--check") {
      check = true;
      continue;
    }
    return { ok: false, error: `unknown flag: ${a}` };
  }
  return { ok: true, check };
}

export function splitFrontmatter(text) {
  const src = String(text ?? "");
  if (!src.startsWith("---")) return { ok: false, error: "missing frontmatter" };
  const rest = src.slice(3).replace(/^\r?\n/, "");
  const m = rest.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (!m || m.index == null) return { ok: false, error: "missing frontmatter close" };
  return { ok: true, fm: rest.slice(0, m.index), body: rest.slice(m.index + m[0].length) };
}

export function toClaudeShellBody(body) {
  return String(body)
    .split(GENERIC_TOOL_LIST)
    .join(CLAUDE_TOOL_LIST)
    .split("web_search/web_fetch")
    .join("WebSearch/WebFetch")
    .split("run_terminal_command")
    .join("Bash");
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function joinMarkdown(fm, body) {
  const b = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  return `---\n${fm}\n---\n${b}`;
}

export function emitAgentShellTools({ workspaceRoot, check = false } = {}) {
  const ws = workspaceRoot || process.cwd();
  const ssotAbs = path.join(ws, SSOT_REL);
  const claudeAbs = path.join(ws, CLAUDE_GRUNT_REL);
  const ssotRaw = readText(ssotAbs);
  if (ssotRaw == null) {
    return { ok: false, check, error: `missing ${SSOT_REL}` };
  }
  const ssot = splitFrontmatter(ssotRaw);
  if (!ssot.ok) {
    return { ok: false, check, error: `ssot: ${ssot.error}` };
  }
  const claudeRaw = readText(claudeAbs);
  if (claudeRaw == null) {
    return { ok: false, check, error: `missing ${CLAUDE_GRUNT_REL}` };
  }
  const claude = splitFrontmatter(claudeRaw);
  if (!claude.ok) {
    return { ok: false, check, error: `claude grunt: ${claude.error}` };
  }
  const next = joinMarkdown(claude.fm, toClaudeShellBody(ssot.body));
  if (check) {
    if (claudeRaw !== next) {
      return { ok: false, check: true, error: `drift: ${CLAUDE_GRUNT_REL}`, drift: [CLAUDE_GRUNT_REL] };
    }
    return { ok: true, check: true, drift: [] };
  }
  fs.mkdirSync(path.dirname(claudeAbs), { recursive: true });
  fs.writeFileSync(claudeAbs, next);
  return { ok: true, check: false };
}

function main() {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    if (!parsed.ok) {
      process.stderr.write((parsed.error || "invalid argv") + "\n");
      return 1;
    }
    const result = emitAgentShellTools({
      workspaceRoot: process.cwd(),
      check: parsed.check,
    });
    if (!result.ok) {
      process.stderr.write((result.error || "emit failed") + "\n");
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(String(err && err.message ? err.message : err) + "\n");
    return 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
