#!/usr/bin/env node
/**
 * Machine-local live agent board. One JSON file per session under ~/.grunt/board/.
 * A read prints lines whose host process is still alive and deletes the rest.
 * Fail-open: a probe or IO error skips the write and prints nothing.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORK_CAP = 80;
const MAX_WALK = 4;
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash", "busybox", "cmd", "powershell", "pwsh"]);

function field(value) {
  const s = String(value ?? "").replace(/\s+/g, "-").trim();
  return s || "-";
}

function oneLine(value, cap) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  const cut = cap ? s.slice(0, cap).trim() : s;
  return cut || "-";
}

function commBase(comm) {
  const base = String(comm || "").split(/[/\\]/).pop() || "";
  return base.replace(/\.exe$/i, "").toLowerCase();
}

function safe(value) {
  return field(value).replace(/[^\w.@+-]/g, "_") || "-";
}

export function formatLine(row) {
  return [
    field(row.time),
    field(row.provider),
    field(row.model),
    field(row.effort),
    field(row.session),
    oneLine(row.cwd),
    oneLine(row.work, WORK_CAP),
  ].join(" ");
}

export function boardHome(env = process.env) {
  return env.GRUNT_BOARD_HOME || os.homedir();
}

export function boardDir(home) {
  return path.join(home, ".grunt", "board");
}

function rowPath(dir, provider, session) {
  return path.join(dir, `${safe(provider)}-${safe(session)}.json`);
}

function readRow(file) {
  try {
    const row = JSON.parse(fs.readFileSync(file, "utf8"));
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows cannot always chmod a directory.
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows cannot always chmod a file.
  }
}

export function readBootId({ readFile = fs.readFileSync, platform = process.platform } = {}) {
  if (platform !== "linux") return "-";
  try {
    return String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || "-";
  } catch {
    return "-";
  }
}

/** Linux /proc/pid/stat. Field 22 is starttime. comm sits between the first "(" and the last ")". */
export function parseProcStat(text) {
  const s = String(text ?? "");
  const end = s.lastIndexOf(")");
  const open = s.indexOf("(");
  if (open < 0 || end < open) return null;
  const comm = s.slice(open + 1, end);
  const rest = s.slice(end + 1).trim().split(/\s+/);
  if (rest.length < 20) return null;
  const ppid = Number(rest[1]);
  if (!rest[19] || !Number.isFinite(ppid)) return null;
  return { comm, state: rest[0], ppid, start: rest[19] };
}

export function probeProcess(pid, deps = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return null;
  const platform = deps.platform || process.platform;
  const readFile = deps.readFile || fs.readFileSync;
  const spawn = deps.spawn || spawnSync;
  if (platform === "linux") {
    try {
      const parsed = parseProcStat(readFile(`/proc/${n}/stat`, "utf8"));
      if (!parsed || parsed.state === "Z") return null;
      return { pid: n, start: parsed.start, comm: parsed.comm, ppid: parsed.ppid };
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    const r = spawn("ps", ["-o", "ppid=,lstart=,comm=", "-p", String(n)], { encoding: "utf8" });
    if (!r || r.status !== 0) return null;
    const line = String(r.stdout || "").trim();
    const m = line.match(/^(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*$/);
    if (!m) return null;
    return { pid: n, start: m[2], comm: commBase(m[3]), ppid: Number(m[1]) };
  }
  if (platform === "win32") {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}"`,
      "if (-not $p) { exit 1 }",
      "$p.ParentProcessId",
      "$p.Name",
      "$p.CreationDate.ToUniversalTime().ToString('o')",
    ].join("; ");
    const r = spawn("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    if (!r || r.status !== 0) return null;
    const parts = String(r.stdout || "").trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const ppid = Number(parts[0]);
    if (!Number.isFinite(ppid) || !parts[2]) return null;
    return { pid: n, start: parts[2], comm: parts[1], ppid };
  }
  return null;
}

export function hostIdentity({ pid = process.pid, probe = probeProcess } = {}) {
  let current = probe(pid)?.ppid;
  for (let i = 0; i < MAX_WALK && current && current > 1; i++) {
    const info = probe(current);
    if (!info || !(info.pid > 1) || info.start == null || info.start === "") return null;
    const name = commBase(info.comm);
    if (!SHELLS.has(name)) return { pid: info.pid, start: String(info.start) };
    if (!(info.ppid > 1) || info.ppid === current) return null;
    current = info.ppid;
  }
  return null;
}

export function rowAlive(row, { boot, probe = probeProcess } = {}) {
  if (!row || row.pid == null || row.start == null || row.start === "") return false;
  if (String(row.boot ?? "") !== String(boot ?? "")) return false;
  let info;
  try {
    info = probe(row.pid);
  } catch {
    return false;
  }
  if (!info || info.start == null || info.start === "") return false;
  return String(info.start) === String(row.start);
}

export function sweep({ home, boot, probe = probeProcess } = {}) {
  const dir = boardDir(home);
  if (!fs.existsSync(dir)) return [];
  const kept = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!name.endsWith(".json")) continue;
    const row = readRow(file);
    if (!row || !rowAlive(row, { boot, probe })) {
      fs.rmSync(file, { force: true });
      continue;
    }
    kept.push(row);
  }
  kept.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return kept;
}

function nextWork(prev, opts) {
  if (opts.forceWork) return { work: oneLine(opts.work, WORK_CAP), sticky: true };
  if (prev?.sticky && prev.work) return { work: String(prev.work), sticky: true };
  if (opts.work != null && String(opts.work).trim()) return { work: oneLine(opts.work, WORK_CAP), sticky: false };
  if (prev?.work) return { work: String(prev.work), sticky: false };
  return { work: "active", sticky: false };
}

export function note(opts = {}) {
  const session = String(opts.session ?? "").trim();
  if (!session || session === "default") return null;
  if (opts.pid == null || opts.start == null || opts.start === "") return null;
  const home = opts.home ?? boardHome(opts.env);
  const dir = boardDir(home);
  ensureDir(dir);
  const provider = field(opts.provider);
  const file = rowPath(dir, provider, session);
  const prev = readRow(file);
  const chosen = nextWork(prev, opts);
  const row = {
    time: opts.now instanceof Date ? opts.now.toISOString().replace(/\.\d{3}Z$/, "Z") : opts.now ? String(opts.now) : new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    provider,
    model: opts.model == null || String(opts.model).trim() === "" ? "-" : String(opts.model),
    effort: opts.effort == null || String(opts.effort).trim() === "" ? "-" : String(opts.effort),
    session,
    cwd: oneLine(opts.cwd),
    work: chosen.work,
    sticky: chosen.sticky,
    pid: Number(opts.pid),
    start: String(opts.start),
    boot: String(opts.boot ?? ""),
  };
  atomicWrite(file, `${JSON.stringify(row)}\n`);
  sweep({ home, boot: row.boot, probe: opts.probe });
  if (!fs.existsSync(file)) return null;
  return row;
}

export function lines(opts = {}) {
  const home = opts.home ?? boardHome(opts.env);
  const boot = opts.boot ?? readBootId();
  return sweep({ home, boot, probe: opts.probe }).map(formatLine);
}

export function digest(opts = {}) {
  const home = opts.home ?? boardHome(opts.env);
  const boot = opts.boot ?? readBootId();
  const selfP = field(opts.provider);
  const selfS = field(opts.session);
  return sweep({ home, boot, probe: opts.probe })
    .filter((row) => !(field(row.provider) === selfP && field(row.session) === selfS))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))
    .slice(0, opts.cap ?? 8)
    .map(formatLine)
    .join("\n");
}

function providerOf(data, env) {
  if (env.GRUNT_BOARD_PROVIDER) return env.GRUNT_BOARD_PROVIDER;
  if (env.GROK_WORKSPACE_ROOT || env.GROK_SESSION_ID || env.GROK_HOOK_EVENT) return "grok";
  if (env.CLAUDE_PROJECT_DIR) return "claude";
  if (data && data.model) return "codex";
  return "-";
}

function modelOf(data) {
  if (!data || data.model == null || String(data.model).trim() === "") return "-";
  return String(data.model);
}

function effortOf(data, env) {
  const level = data && data.effort && typeof data.effort === "object" ? data.effort.level : data?.effort;
  if (level != null && String(level).trim() !== "") return String(level);
  if (env.CLAUDE_EFFORT && String(env.CLAUDE_EFFORT).trim() !== "") return String(env.CLAUDE_EFFORT);
  return "-";
}

function sessionOf(data, env) {
  const value = (data && (data.session_id || data.sessionId)) || env.GROK_SESSION_ID || "";
  return String(value).trim();
}

function cwdOf(data, env) {
  return (
    env.GROK_WORKSPACE_ROOT ||
    (data && (data.workspaceRoot || data.workspace_root || data.cwd)) ||
    env.CLAUDE_PROJECT_DIR ||
    process.cwd()
  );
}

function promptOf(data) {
  if (!data || typeof data !== "object") return "";
  return String(data.prompt ?? data.userPrompt ?? data.user_prompt ?? "");
}

export function recordHook(data, env = process.env, deps = {}) {
  try {
    const session = sessionOf(data, env);
    if (!session || session === "default") return null;
    const ident = deps.identity || hostIdentity({ probe: deps.probe || probeProcess });
    if (!ident) return null;
    const boot = deps.boot || readBootId();
    return note({
      home: boardHome(env),
      env,
      provider: providerOf(data, env),
      model: modelOf(data),
      effort: effortOf(data, env),
      session,
      cwd: cwdOf(data, env),
      work: promptOf(data),
      pid: ident.pid,
      start: ident.start,
      boot,
      now: deps.now,
      probe: deps.probe,
    });
  } catch {
    return null;
  }
}

export function otherLines(data, env = process.env, deps = {}) {
  try {
    return digest({
      home: boardHome(env),
      env,
      provider: providerOf(data, env),
      session: sessionOf(data, env),
      boot: deps.boot || readBootId(),
      probe: deps.probe,
    });
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const out = { set: false, work: null, home: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "set") out.set = true;
    else if (arg === "--work") out.work = argv[++i] ?? "";
    else if (arg.startsWith("--work=")) out.work = arg.slice("--work=".length);
    else if (arg === "--home") out.home = argv[++i] ?? "";
    else if (arg.startsWith("--home=")) out.home = arg.slice("--home=".length);
  }
  return out;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const env = { ...process.env };
    if (args.home) env.GRUNT_BOARD_HOME = args.home;
    const home = boardHome(env);
    if (args.set) {
      const ident = hostIdentity();
      if (!ident) return 0;
      const provider = providerOf({}, env);
      const session =
        env.GRUNT_BOARD_SESSION || env.GROK_SESSION_ID || env.CLAUDE_SESSION_ID || String(ident.pid);
      note({
        home,
        env,
        provider: provider === "-" ? "antigravity" : provider,
        model: "-",
        effort: env.CLAUDE_EFFORT || "-",
        session,
        cwd: cwdOf({}, env),
        work: args.work ?? "",
        forceWork: true,
        pid: ident.pid,
        start: ident.start,
        boot: readBootId(),
      });
      return 0;
    }
    const printed = lines({ home, env });
    if (printed.length) process.stdout.write(`${printed.join("\n")}\n`);
    return 0;
  } catch {
    return 0;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
