#!/usr/bin/env node
/** Purge stubborn global MCP sources under $HOME (dry-run default). Never project MCP. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const PLUGIN_IDS = ["cloudflare", "stripe"];
const DISABLE_MCP = ["cloudflare-docs", "MCP_DOCKER", "stripe"];
const CURSOR_SERVER = "MCP_DOCKER";
const STRIPE_PLUGIN = "stripe";

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

/** HOME, else USERPROFILE (Windows / env sim), else os.homedir(). */
export function resolveHome(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let apply = false;
  for (const a of args) {
    if (a === "--apply") {
      apply = true;
      continue;
    }
    return { ok: false, error: `unknown flag: ${a}` };
  }
  return { ok: true, apply };
}

export function grokConfigPath(home) {
  return path.join(path.resolve(home), ".grok", "config.toml");
}

export function cursorMcpPath(home) {
  return path.join(path.resolve(home), ".cursor", "mcp.json");
}

export function claudePluginsPath(home) {
  return path.join(path.resolve(home), ".claude", "plugins", "installed_plugins.json");
}

function isStripePluginKey(k) {
  return String(k).split("@")[0] === STRIPE_PLUGIN;
}

function strList(v, label) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error(`unreadable dest: ${label}`);
  return v.map((x) => String(x));
}

function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function writeText(abs, body) {
  const text = body.endsWith("\n") ? body : body + "\n";
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function reportLine(row) {
  return `${row.action} ${row.path} ${row.detail}`;
}

function planGrok(home) {
  const abs = grokConfigPath(home);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { abs, skip: true, detail: "noop (missing)", obj: null };
    }
    throw new Error(`unreadable dest: ${abs}`);
  }
  let obj;
  try {
    const v = parseToml(raw);
    if (!isPlainObject(v)) throw new Error("not a table");
    obj = v;
  } catch {
    throw new Error(`unreadable dest: ${abs}`);
  }

  const next = { ...obj };
  const details = [];
  let changed = false;

  const hadPlugins = isPlainObject(obj.plugins);
  if (obj.plugins != null && !hadPlugins) {
    throw new Error(`unreadable dest: ${abs}`);
  }
  const plugins = hadPlugins ? { ...obj.plugins } : {};
  const enabled = strList(plugins.enabled, abs);
  const disabled = strList(plugins.disabled, abs);
  const nextEnabled = enabled.filter((n) => !PLUGIN_IDS.includes(n));
  const nextDisabled = dedupe([...disabled, ...PLUGIN_IDS]);
  const enabledChanged = nextEnabled.join("\0") !== enabled.join("\0");
  const disabledChanged = nextDisabled.join("\0") !== disabled.join("\0");
  if (enabledChanged) {
    const removed = enabled.filter((n) => PLUGIN_IDS.includes(n));
    details.push(`remove ${removed.join(", ")} from [plugins].enabled`);
    changed = true;
  }
  if (disabledChanged) {
    const added = PLUGIN_IDS.filter((id) => !disabled.includes(id));
    details.push(`add ${added.join(", ")} to [plugins].disabled`);
    changed = true;
  }
  if (enabledChanged || disabledChanged) {
    if ("enabled" in plugins || enabledChanged) plugins.enabled = nextEnabled;
    plugins.disabled = nextDisabled;
    next.plugins = plugins;
  }

  const mcpKey = "disabled_mcp_servers";
  if (next[mcpKey] == null || Array.isArray(next[mcpKey])) {
    const cur = strList(next[mcpKey], abs);
    const mcpNext = dedupe([...cur, ...DISABLE_MCP]);
    if (mcpNext.join("\0") !== cur.join("\0")) {
      const added = mcpNext.filter((x) => !cur.includes(x));
      next[mcpKey] = mcpNext;
      details.push(`add ${added.join(", ")} to ${mcpKey}`);
      changed = true;
    }
  }

  return {
    abs,
    skip: !changed,
    detail: changed ? details.join("; ") : "noop (already clean)",
    obj: next,
    changed,
  };
}

function planClaudePlugins(home) {
  const abs = claudePluginsPath(home);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { abs, skip: true, detail: "noop (missing)", json: null };
    }
    throw new Error(`unreadable dest: ${abs}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`unreadable dest: ${abs}`);
  }
  if (!isPlainObject(obj)) throw new Error(`unreadable dest: ${abs}`);
  const plugins = obj.plugins;
  if (plugins == null) {
    return { abs, skip: true, detail: "noop (already clean)", json: null };
  }
  if (!isPlainObject(plugins)) throw new Error(`unreadable dest: ${abs}`);
  const keys = Object.keys(plugins).filter(isStripePluginKey);
  if (!keys.length) {
    return { abs, skip: true, detail: "noop (already clean)", json: null };
  }
  const nextPlugins = { ...plugins };
  for (const k of keys) delete nextPlugins[k];
  return {
    abs,
    skip: false,
    detail: `remove ${keys.join(", ")} from plugins`,
    json: { ...obj, plugins: nextPlugins },
    changed: true,
  };
}

function planCursor(home) {
  const abs = cursorMcpPath(home);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { abs, skip: true, detail: "noop (missing)", json: null };
    }
    throw new Error(`unreadable dest: ${abs}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`unreadable dest: ${abs}`);
  }
  if (!isPlainObject(obj)) throw new Error(`unreadable dest: ${abs}`);
  const servers = obj.mcpServers;
  if (servers == null) {
    return { abs, skip: true, detail: "noop (already clean)", json: null };
  }
  if (!isPlainObject(servers)) throw new Error(`unreadable dest: ${abs}`);
  if (!Object.prototype.hasOwnProperty.call(servers, CURSOR_SERVER)) {
    return { abs, skip: true, detail: "noop (already clean)", json: null };
  }
  const nextServers = { ...servers };
  delete nextServers[CURSOR_SERVER];
  const json = { ...obj, mcpServers: nextServers };
  return {
    abs,
    skip: false,
    detail: `remove ${CURSOR_SERVER} from mcpServers`,
    json,
    changed: true,
  };
}

export function purgeGlobalMcps({ home, apply = false } = {}) {
  const report = [];
  const action = apply ? "apply" : "dry-run";
  try {
    if (!home) throw new Error("HOME required");
    const grok = planGrok(home);
    const cursor = planCursor(home);
    const claude = planClaudePlugins(home);
    if (apply) {
      if (!grok.skip && grok.obj) {
        writeText(grok.abs, stringifyToml(grok.obj));
      }
      if (!cursor.skip && cursor.json) {
        writeText(cursor.abs, JSON.stringify(cursor.json, null, 2));
      }
      if (!claude.skip && claude.json) {
        writeText(claude.abs, JSON.stringify(claude.json, null, 2));
      }
    }
    for (const row of [
      { action, path: grok.abs, detail: grok.detail },
      { action, path: cursor.abs, detail: cursor.detail },
      { action, path: claude.abs, detail: claude.detail },
    ]) {
      report.push({ ...row, line: reportLine(row) });
    }
    return { ok: true, report };
  } catch (err) {
    const error = String(err && err.message ? err.message : err);
    return { ok: false, report, error };
  }
}

function main() {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    if (!parsed.ok) {
      process.stderr.write((parsed.error || "invalid argv") + "\n");
      return 1;
    }
    const home = resolveHome();
    if (!home) {
      process.stderr.write("HOME required\n");
      return 1;
    }
    const result = purgeGlobalMcps({ home, apply: parsed.apply });
    for (const row of result.report || []) {
      process.stdout.write((row.line || reportLine(row)) + "\n");
    }
    if (!result.ok) {
      process.stderr.write((result.error || "purge failed") + "\n");
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
