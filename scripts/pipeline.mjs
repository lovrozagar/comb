#!/usr/bin/env node
/** Inner generate/check/watch chain. Called by guarded-roots; not a public npm script. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc } from "./jsonc.mjs";

export const PIPELINE_CONFIG_REL = ".rulesync/grunt.pipeline.jsonc";

export const COMMANDS = {
  generate: [
    "rulesync generate -t claudecode,codexcli,antigravity-cli,grokcli -f rules,subagents,skills",
    "rulesync generate -t claudecode,codexcli,antigravity-cli -f hooks",
    "node scripts/emit-mcp-policy.mjs",
    "node scripts/emit-gemini.mjs",
    "node scripts/emit-agent-shell-tools.mjs",
    "node scripts/emit-maps.mjs",
    "node scripts/hooks-union.mjs",
  ],
  check: [
    "rulesync generate -t claudecode,codexcli,antigravity-cli,grokcli -f rules,skills --check",
    "rulesync generate -t codexcli,antigravity-cli,grokcli -f subagents --check",
    "rulesync generate -t claudecode,codexcli,antigravity-cli -f hooks --check",
    "node scripts/emit-mcp-policy.mjs --check",
    "node scripts/emit-gemini.mjs --check",
    "node scripts/emit-agent-shell-tools.mjs --check",
    "node scripts/emit-maps.mjs --check",
    "node scripts/check-globals.mjs",
    "node scripts/hooks-union.mjs --check",
  ],
  watch: [
    "node scripts/emit-mcp-policy.mjs",
    "node scripts/emit-gemini.mjs",
    "node scripts/emit-agent-shell-tools.mjs",
    "rulesync generate -t claudecode,codexcli,antigravity-cli,grokcli -f rules,subagents,skills --watch",
  ],
};

export function envWithLocalBin(cwd, env = process.env) {
  const binDir = path.join(cwd, "node_modules", ".bin");
  const merged = { ...env };
  const key = Object.keys(merged).find((k) => k.toLowerCase() === "path") || "PATH";
  merged[key] = `${binDir}${path.delimiter}${merged[key] || ""}`;
  return merged;
}

function asStringList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
}

export function quotedCommandsInBlock(src, key) {
  const m = String(src ?? "").match(new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!m) return [];
  const out = [];
  for (const line of m[1].split(/\r?\n/)) {
    const code = line.replace(/\/\/.*$/, "").trim();
    if (!code) continue;
    for (const x of code.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
      out.push(x[1].replace(/\\"/g, '"'));
    }
  }
  return out;
}

export function inferPipelineSkip(src, mode) {
  const stock = COMMANDS[mode];
  if (!stock || !src || !new RegExp(`${mode}:\\s*\\[`).test(src)) return [];
  const active = new Set(quotedCommandsInBlock(src, mode));
  return stock.filter((c) => !active.has(c));
}

export function loadPipelineOverlay(cwd, mode, warn = (m) => process.stderr.write(`${m}\n`)) {
  const abs = path.join(cwd, PIPELINE_CONFIG_REL);
  if (!fs.existsSync(abs)) return { skip: [], extra: [] };
  let raw;
  try {
    raw = JSON.parse(stripJsonc(fs.readFileSync(abs, "utf8")));
  } catch (err) {
    warn(`pipeline: ignoring ${PIPELINE_CONFIG_REL}: ${err.message}`);
    return { skip: [], extra: [] };
  }
  const section = raw && typeof raw === "object" && !Array.isArray(raw) ? raw[mode] : null;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { skip: [], extra: [] };
  }
  return { skip: asStringList(section.skip), extra: asStringList(section.extra) };
}

export function resolvePipelineCommands(mode, cwd, warn) {
  const stock = COMMANDS[mode];
  if (!stock) return null;
  const { skip, extra } = loadPipelineOverlay(cwd, mode, warn);
  const skipSet = new Set(skip);
  return [...stock.filter((c) => !skipSet.has(c)), ...extra];
}

export function formatCheckFailures(failures) {
  const n = failures.length;
  const lines = [`pipeline check failed (${n} step${n === 1 ? "" : "s"}):`];
  for (const { cmd, err } of failures) {
    lines.push(`- ${cmd}`);
    const msg = err && err.message ? err.message : String(err);
    for (const line of msg.split(/\r?\n/)) {
      if (line) lines.push(`  ${line}`);
    }
  }
  lines.push(
    "If a consumer post-step rewrites this output (hooks-union, codex-sync), add the stock command to check.skip in .rulesync/grunt.pipeline.jsonc",
  );
  return lines.join("\n");
}

export function runPipeline(mode, { cwd = process.cwd(), exec = execSync, warn } = {}) {
  const cmds = resolvePipelineCommands(mode, cwd, warn);
  if (!cmds) {
    throw new Error("usage: pipeline.mjs generate|check|watch");
  }
  const env = envWithLocalBin(cwd);
  if (mode === "check") {
    const failures = [];
    for (const cmd of cmds) {
      try {
        exec(cmd, { cwd, stdio: "inherit", shell: true, env });
      } catch (err) {
        failures.push({ cmd, err });
      }
    }
    if (failures.length) throw new Error(formatCheckFailures(failures));
    return;
  }
  for (const cmd of cmds) {
    exec(cmd, { cwd, stdio: "inherit", shell: true, env });
  }
}

function main() {
  try {
    runPipeline(process.argv[2] || "");
    return 0;
  } catch (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    return 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile) process.exit(main());
