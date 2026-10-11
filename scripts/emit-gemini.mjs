#!/usr/bin/env node
/** Emit Gemini CLI GEMINI.md + .gemini/agents from .rulesync/subagents. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardedMarkdownDrift, writeMergedGuardedFile } from "./guarded-md.mjs";

export const AGENT_IDS = ["orchestrator", "grunt"];
const SSOT_REL = ".rulesync/subagents";
const GEMINI_MD_REL = "GEMINI.md";
const AGENTS_REL = ".gemini/agents";
const GEMINI_MD_BODY = "@AGENTS.md\n";

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

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

function unquoteYaml(raw) {
  const s = String(raw).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function yamlScalar(v) {
  const s = String(v);
  if (s === "") return '""';
  if (/^[A-Za-z0-9_./+-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function splitFrontmatter(text) {
  const src = String(text ?? "");
  if (!src.startsWith("---")) return { ok: false, error: "missing frontmatter" };
  const rest = src.slice(3).replace(/^\r?\n/, "");
  const m = rest.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (!m || m.index == null) return { ok: false, error: "missing frontmatter close" };
  return { ok: true, fm: rest.slice(0, m.index), body: rest.slice(m.index + m[0].length) };
}

function parseYamlBlock(fm) {
  const top = {};
  let cur = null;
  for (const line of String(fm).split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const nested = line.match(/^([ \t]+)([^:#\s][^:]*):\s*(.*?)\s*$/);
    if (nested && cur) {
      const key = nested[2].trim();
      const val = nested[3];
      if (!isPlainObject(top[cur])) top[cur] = {};
      if (val !== "") top[cur][key] = unquoteYaml(val);
      continue;
    }
    const topm = line.match(/^([^:#\s][^:]*):\s*(.*?)\s*$/);
    if (topm && !/^[ \t]/.test(line)) {
      const key = topm[1].trim();
      const val = topm[2];
      cur = key;
      top[key] = val === "" ? {} : unquoteYaml(val);
    }
  }
  return top;
}

function geminiModel(parsed) {
  if (parsed["geminicli.model"] != null && parsed["geminicli.model"] !== "") {
    return String(parsed["geminicli.model"]);
  }
  if (isPlainObject(parsed.geminicli) && parsed.geminicli.model != null && parsed.geminicli.model !== "") {
    return String(parsed.geminicli.model);
  }
  return null;
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function lstat(abs) {
  try {
    return fs.lstatSync(abs);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function agentMarkdown(name, description, model, body) {
  const fm = ["---", `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`, `model: ${yamlScalar(model)}`, "---"].join(
    "\n",
  );
  const b = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  return `${fm}\n${b}`;
}

function collisionRel(id) {
  return path.join(AGENTS_REL, `${id}.md`);
}

function ownedRel(id) {
  return path.join(AGENTS_REL, id, "agent.md");
}

export function emitGemini({ workspaceRoot, check = false } = {}) {
  const ws = workspaceRoot || process.cwd();
  const collisions = [];
  for (const id of AGENT_IDS) {
    const flat = path.join(ws, collisionRel(id));
    const dir = path.join(ws, AGENTS_REL, id);
    const stFlat = lstat(flat);
    if (stFlat && stFlat.isFile()) collisions.push(collisionRel(id));
    const stDir = lstat(dir);
    if (stDir && stDir.isFile()) collisions.push(path.join(AGENTS_REL, id));
  }
  if (collisions.length) {
    return {
      ok: false,
      check,
      error: `collision: ${collisions.join(", ")}`,
      collisions,
    };
  }

  const files = [{ rel: GEMINI_MD_REL, text: GEMINI_MD_BODY }];
  for (const id of AGENT_IDS) {
    const ssotAbs = path.join(ws, SSOT_REL, `${id}.md`);
    const raw = readText(ssotAbs);
    if (raw == null) {
      return { ok: false, check, error: `missing ${path.join(SSOT_REL, `${id}.md`)}` };
    }
    const split = splitFrontmatter(raw);
    if (!split.ok) {
      return { ok: false, check, error: `${id}: ${split.error}` };
    }
    const parsed = parseYamlBlock(split.fm);
    const model = geminiModel(parsed);
    if (!model) {
      return { ok: false, check, error: `${id}: missing geminicli.model` };
    }
    const name = parsed.name != null && parsed.name !== "" ? String(parsed.name) : id;
    const description = parsed.description != null ? String(parsed.description) : "";
    files.push({
      rel: ownedRel(id),
      text: agentMarkdown(name, description, model, split.body),
    });
  }

  if (check) {
    const drift = [];
    for (const f of files) {
      if (f.rel === GEMINI_MD_REL) {
        if (guardedMarkdownDrift(path.join(ws, f.rel), f.text)) drift.push(f.rel);
        continue;
      }
      const disk = readText(path.join(ws, f.rel));
      if (disk !== f.text) drift.push(f.rel);
    }
    if (drift.length) {
      return { ok: false, check: true, error: `drift: ${drift.join(", ")}`, drift };
    }
    return { ok: true, check: true, drift: [] };
  }

  for (const f of files) {
    const abs = path.join(ws, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (f.rel === GEMINI_MD_REL) writeMergedGuardedFile(abs, f.text);
    else fs.writeFileSync(abs, f.text);
  }
  return { ok: true, check: false };
}

function main() {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    if (!parsed.ok) {
      process.stderr.write((parsed.error || "invalid argv") + "\n");
      return 1;
    }
    const result = emitGemini({
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
