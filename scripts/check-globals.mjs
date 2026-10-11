#!/usr/bin/env node
/** Assert home Grok globals match SSOT; project config has no [features]/[agent]. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { detectPackageManager, runScriptLine } from "./package-manager.mjs";

function applyHint(workspaceRoot) {
  const { manager } = detectPackageManager({
    cwd: workspaceRoot || process.cwd(),
    env: process.env,
  });
  return runScriptLine(manager, "sync:globals:apply");
}
const PROJECT_REL = ".grok/config.toml";
const HOME_REL = ".grok/config.toml";

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function parseTomlFile(abs, label) {
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, error: `unreadable ${label}` };
  }
  try {
    const v = parseToml(raw);
    if (!isPlainObject(v)) return { ok: false, error: `invalid ${label}` };
    return { ok: true, value: v };
  } catch {
    return { ok: false, error: `unreadable ${label}` };
  }
}

export function checkGlobals({ home, workspaceRoot } = {}) {
  const homeDir = home || process.env.HOME;
  const ws = workspaceRoot || process.cwd();
  const hint = applyHint(ws);
  if (!homeDir) {
    return { ok: false, error: `HOME required; ${hint}` };
  }
  const homeConfig = path.resolve(homeDir, HOME_REL);
  const homeParsed = parseTomlFile(homeConfig, "home ~/.grok/config.toml");
  if (!homeParsed.ok) {
    if (homeParsed.missing) {
      return { ok: false, error: `missing ~/.grok/config.toml; ${hint}` };
    }
    return { ok: false, error: `${homeParsed.error}; ${hint}` };
  }
  const agentName = homeParsed.value.agent && homeParsed.value.agent.name;
  const compaction =
    homeParsed.value.features && homeParsed.value.features.two_pass_compaction;
  if (agentName !== "orchestrator" || compaction !== true) {
    return {
      ok: false,
      error: `home [agent].name must be orchestrator and [features].two_pass_compaction must be true; ${hint}`,
    };
  }

  const projectConfig = path.resolve(ws, PROJECT_REL);
  if (projectConfig === homeConfig) {
    return { ok: true };
  }
  const projectParsed = parseTomlFile(projectConfig, "project .grok/config.toml");
  if (!projectParsed.ok) {
    if (projectParsed.missing) {
      return { ok: false, error: "missing project .grok/config.toml" };
    }
    return { ok: false, error: projectParsed.error };
  }
  if (
    Object.prototype.hasOwnProperty.call(projectParsed.value, "features") ||
    Object.prototype.hasOwnProperty.call(projectParsed.value, "agent")
  ) {
    return {
      ok: false,
      error: "project .grok/config.toml must not set [features] or [agent]",
    };
  }
  return { ok: true };
}

function main() {
  try {
    const result = checkGlobals({
      home: process.env.HOME,
      workspaceRoot: process.cwd(),
    });
    if (!result.ok) {
      process.stderr.write((result.error || "check-globals failed") + "\n");
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
