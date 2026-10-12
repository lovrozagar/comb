#!/usr/bin/env node
/** Merge repo Grok global settings into $HOME/.grok/config.toml (dry-run default). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const HOST_IDS = new Set(["grok", "claude", "codex", "antigravity", "all"]);
const MANIFEST_REL = ".rulesync/global-settings/manifest.json";

export function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let apply = false;
  let host = "all";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (a === "--host") {
      const v = args[++i];
      if (!v || !HOST_IDS.has(v)) {
        return { ok: false, error: `unknown host: ${v || ""}` };
      }
      host = v;
      continue;
    }
    if (typeof a === "string" && a.startsWith("--host=")) {
      const v = a.slice("--host=".length);
      if (!HOST_IDS.has(v)) {
        return { ok: false, error: `unknown host: ${v}` };
      }
      host = v;
      continue;
    }
    return { ok: false, error: `unknown flag: ${a}` };
  }
  return { ok: true, apply, host };
}

export function resolveDest(home, dest) {
  if (!home) throw new Error("home required");
  if (dest == null || dest === "") throw new Error("dest required");
  const resolvedHome = path.resolve(home);
  const resolved = path.resolve(resolvedHome, dest);
  const prefix = resolvedHome.endsWith(path.sep)
    ? resolvedHome
    : resolvedHome + path.sep;
  if (resolved !== resolvedHome && !resolved.startsWith(prefix)) {
    throw new Error(`dest not under home: ${dest}`);
  }
  return resolved;
}

export function shouldSkip(segment, skipRe) {
  if (!skipRe) return false;
  return skipRe.test(String(segment));
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

export function deepMerge(dest, source, skipRe, keyPath = []) {
  const out = isPlainObject(dest) ? { ...dest } : {};
  if (!isPlainObject(source)) return out;
  for (const [k, v] of Object.entries(source)) {
    const nextPath = [...keyPath, k];
    if (nextPath.some((seg) => shouldSkip(seg, skipRe))) continue;
    const prev = out[k];
    if (isPlainObject(v) && isPlainObject(prev)) {
      out[k] = deepMerge(prev, v, skipRe, nextPath);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadManifest(workspaceRoot) {
  const p = path.join(workspaceRoot, MANIFEST_REL);
  const raw = fs.readFileSync(p, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest !== "object") {
    throw new Error("invalid manifest");
  }
  if (typeof manifest.skipKeyPattern !== "string") {
    throw new Error("manifest skipKeyPattern required");
  }
  if (!Array.isArray(manifest.hosts)) {
    throw new Error("manifest hosts required");
  }
  return manifest;
}

function parseTomlText(raw, label) {
  const s = String(raw ?? "");
  if (!s.trim()) return {};
  try {
    const v = parseToml(s);
    return isPlainObject(v) ? v : {};
  } catch (err) {
    throw new Error(`unreadable dest: ${label}`);
  }
}

function readTomlDest(destAbs, label) {
  let raw;
  try {
    raw = fs.readFileSync(destAbs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw new Error(`unreadable dest: ${label}`);
  }
  return parseTomlText(raw, label);
}

function reportLine({ action, id, mode, dest }) {
  const destCol = mode === "noop" || !dest ? "noop" : dest;
  return `${action} ${id} ${mode} ${destCol}`;
}

export function syncGlobals({
  workspaceRoot,
  home,
  apply = false,
  host = "all",
} = {}) {
  const report = [];
  const action = apply ? "apply" : "dry-run";
  try {
    const ws = workspaceRoot || process.cwd();
    if (!HOST_IDS.has(host)) {
      return { ok: false, report, error: `unknown host: ${host}` };
    }
    const manifest = loadManifest(ws);
    const skipRe = new RegExp(manifest.skipKeyPattern, "i");
    const hosts = manifest.hosts.filter((h) => host === "all" || h.id === host);
    if (!hosts.length) {
      return { ok: false, report, error: `unknown host: ${host}` };
    }
    for (const h of hosts) {
      const payloadRel = h.payload;
      const payloadPath = path.join(ws, payloadRel);
      if (!fs.existsSync(payloadPath)) {
        return {
          ok: false,
          report,
          error: `missing payload: ${payloadRel}`,
        };
      }
      if (h.mode === "noop") {
        report.push({
          action,
          id: h.id,
          mode: "noop",
          dest: "noop",
          line: reportLine({ action, id: h.id, mode: "noop", dest: "noop" }),
        });
        continue;
      }
      const destAbs = resolveDest(home, h.dest);
      const sourceRaw = fs.readFileSync(payloadPath, "utf8");
      let source;
      try {
        source = parseTomlText(sourceRaw, payloadRel);
      } catch {
        return { ok: false, report, error: `unreadable payload: ${payloadRel}` };
      }
      const destObj = fs.existsSync(destAbs)
        ? readTomlDest(destAbs, h.dest)
        : {};
      const merged = deepMerge(destObj, source, skipRe);
      if (apply) {
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        const body = stringifyToml(merged);
        fs.writeFileSync(
          destAbs,
          body.endsWith("\n") ? body : body + "\n",
        );
      }
      report.push({
        action,
        id: h.id,
        mode: h.mode,
        dest: h.dest,
        line: reportLine({
          action,
          id: h.id,
          mode: h.mode,
          dest: h.dest,
        }),
      });
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
    const home = process.env.HOME;
    if (!home) {
      process.stderr.write("HOME required\n");
      return 1;
    }
    const result = syncGlobals({
      workspaceRoot: process.cwd(),
      home,
      apply: parsed.apply,
      host: parsed.host,
    });
    for (const row of result.report || []) {
      process.stdout.write((row.line || reportLine(row)) + "\n");
    }
    if (!result.ok) {
      process.stderr.write((result.error || "sync failed") + "\n");
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
