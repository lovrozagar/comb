#!/usr/bin/env node
/**
 * Durable driver overlay after `rulesync generate -f hooks`.
 * Union, never replace: keep Stop / UserPromptSubmit / SubagentStop / mcp deny.
 *
 * Claude/Codex native event is UserPromptSubmit (mapped from SoT beforeSubmitPrompt).
 * Antigravity has neither beforeSubmitPrompt nor subagentStop.
 * Grok SessionStart stays empty on orchestrate-parent.json.
 * Grunt SessionStart: session-map.mjs (folder map) when shipped, first in the group;
 * Claude/Codex only (rulesync emits no Antigravity sessionStart).
 *
 * Consumer extras (if those scripts exist): SessionStart, check-behind,
 * validate+sim. Path deny from consumer `.rulesync/permissions.json`.
 * Gemini: SessionStart + AfterTool only; check-behind / path deny stay caveats.
 *
 *   node scripts/hooks-union.mjs           apply then check
 *   node scripts/hooks-union.mjs --check   keep-list only
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PULL = "node scripts/daily-pull-check.mjs";
export const RTK = "node scripts/rtk-check.mjs";
export const FLEET = "node scripts/daily-fleet-check.mjs";
export const BEHIND = "node scripts/check-behind.mjs --hook";
export const VALIDATE = "node scripts/validate.mjs --hook";
export const SIM = "node scripts/sim.mjs --hook";
export const SCRUB =
  'node "${GROK_WORKSPACE_ROOT:-${CLAUDE_PROJECT_DIR:-.}}/scripts/scrub-spawn-prompt.mjs"';
export const GATE_FAT =
  'node "${GROK_WORKSPACE_ROOT:-${CLAUDE_PROJECT_DIR:-.}}/scripts/gate-fat-tools.mjs"';
export const MAP =
  'node "${GROK_WORKSPACE_ROOT:-${CLAUDE_PROJECT_DIR:-.}}/scripts/session-map.mjs"';
const MAP_NEEDLE = "session-map.mjs";

export const AUTORUN_NEEDLES = [
  "daily-pull-check.mjs",
  "rtk-check.mjs",
  "daily-fleet-check.mjs",
  "check-behind.mjs",
  "validate.mjs",
  "sim.mjs",
];
export const GRUNT_NEEDLES = ["scrub-spawn-prompt.mjs", "gate-fat-tools.mjs"];
export const GIT_HOOKS = [
  "scripts/git-hooks/pre-commit",
  "scripts/git-hooks/pre-commit.mjs",
  "scripts/git-hooks/pre-push",
  "scripts/git-hooks/pre-push.mjs",
];
export const POST_WRITE_MATCHER = "Write|Edit|write|search_replace";

const CAVEAT_BEHIND =
  "NOT ported: PreToolUse check-behind.mjs. Gemini has no confirmed before-tool deny event.";
const CAVEAT_PERMS =
  "path-scoped permissions.deny not ported; Gemini is name-scoped";

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

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function resolveRoot(opts) {
  if (typeof opts === "string") return opts;
  if (opts && typeof opts.workspaceRoot === "string" && opts.workspaceRoot) {
    return opts.workspaceRoot;
  }
  return process.cwd();
}

function hasScript(root, name) {
  return fs.existsSync(path.join(root, "scripts", name));
}

function withoutWritePath(arr) {
  return arr.filter((x) => typeof x === "string" && !x.startsWith("Write("));
}

function loadConsumerDeny(root) {
  const data = loadJson(path.join(root, ".rulesync/permissions.json"));
  return Array.isArray(data.deny) ? withoutWritePath(data.deny) : [];
}

function presentAutorun(root) {
  return AUTORUN_NEEDLES.filter((n) => hasScript(root, n));
}

function hookCmd(command, timeout) {
  const h = { type: "command", command };
  if (timeout != null) h.timeout = timeout;
  return h;
}

function gruntPreToolUse() {
  return [
    {
      matcher: "spawn_subagent|Task|Agent|spawn_agent",
      hooks: [hookCmd(SCRUB, 5)],
    },
    {
      matcher: "Read|read_file|Grep|grep|Glob|list_dir|Bash|run_terminal_command|Write|Edit|write|search_replace",
      hooks: [hookCmd(GATE_FAT, 5)],
    },
  ];
}

function commandsIn(group) {
  if (!isPlainObject(group)) return [];
  const out = [];
  if (typeof group.command === "string") out.push(group.command);
  const hooks = Array.isArray(group.hooks) ? group.hooks : [];
  for (const h of hooks) {
    if (isPlainObject(h) && typeof h.command === "string") out.push(h.command);
  }
  return out;
}

function needleOf(group) {
  for (const c of commandsIn(group)) {
    const m = String(c).match(/([\w.-]+\.mjs|orchestrate-parent\.js)/);
    if (m) return m[1];
  }
  return commandsIn(group)[0] || JSON.stringify(group);
}

function upsertGroups(existing, desired) {
  const prev = Array.isArray(existing) ? existing : [];
  const desiredNeedles = new Set(desired.map(needleOf));
  const extras = prev.filter((g) => !desiredNeedles.has(needleOf(g)));
  return [...desired, ...extras];
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function loadJson(p) {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  if (!String(raw).trim()) return {};
  const v = JSON.parse(raw);
  return isPlainObject(v) ? v : {};
}

function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function desiredPre(root) {
  const pre = [];
  if (hasScript(root, "check-behind.mjs")) {
    pre.push({ matcher: "Write|Edit", hooks: [hookCmd(BEHIND)] });
  }
  pre.push(...gruntPreToolUse());
  return pre;
}

function mapNeedles(root) {
  return hasScript(root, MAP_NEEDLE) ? [MAP_NEEDLE] : [];
}

/** `map: false` for hosts rulesync emits no sessionStart for (Antigravity). */
function desiredSession(root, { map = true } = {}) {
  const hooks = [];
  if (map && hasScript(root, MAP_NEEDLE)) hooks.push(hookCmd(MAP, 5));
  if (hasScript(root, "daily-pull-check.mjs")) hooks.push(hookCmd(PULL));
  if (hasScript(root, "rtk-check.mjs")) hooks.push(hookCmd(RTK));
  if (hasScript(root, "daily-fleet-check.mjs")) hooks.push(hookCmd(FLEET));
  return hooks.length ? [{ hooks }] : null;
}

function desiredPost(root) {
  const hooks = [];
  if (hasScript(root, "validate.mjs")) hooks.push(hookCmd(VALIDATE));
  if (hasScript(root, "sim.mjs")) hooks.push(hookCmd(SIM));
  return hooks.length ? [{ matcher: POST_WRITE_MATCHER, hooks }] : null;
}

function consumerNamed(root) {
  const named = {};
  if (hasScript(root, "daily-pull-check.mjs")) {
    named["daily-pull-all"] = { event: "SessionStart", command: PULL };
  }
  if (hasScript(root, "rtk-check.mjs")) {
    named["rtk-check"] = { event: "SessionStart", command: RTK };
  }
  if (hasScript(root, "daily-fleet-check.mjs")) {
    named["daily-fleet-digest"] = { event: "SessionStart", command: FLEET };
  }
  if (hasScript(root, "check-behind.mjs")) {
    named["check-behind"] = { event: "PreToolUse", matcher: "Write|Edit", command: BEHIND };
  }
  named["scrub-spawn-prompt"] = {
    event: "PreToolUse",
    matcher: "spawn_subagent|Task|Agent|spawn_agent",
    command: SCRUB,
    timeout: 5,
  };
  named["gate-fat-tools"] = {
    event: "PreToolUse",
    matcher: "Read|read_file|Grep|grep|Glob|list_dir|Bash|run_terminal_command|Write|Edit|write|search_replace",
    command: GATE_FAT,
    timeout: 5,
  };
  if (hasScript(root, "validate.mjs")) {
    named["validate-artifact"] = { event: "PostToolUse", matcher: POST_WRITE_MATCHER, command: VALIDATE };
  }
  if (hasScript(root, "sim.mjs")) {
    named["simulate-artifact"] = { event: "PostToolUse", matcher: POST_WRITE_MATCHER, command: SIM };
  }
  return named;
}

function applyClaude(root) {
  const abs = path.join(root, ".claude/settings.json");
  const live = loadJson(abs);
  const hooks = isPlainObject(live.hooks) ? { ...live.hooks } : {};
  hooks.PreToolUse = upsertGroups(hooks.PreToolUse, desiredPre(root));
  const session = desiredSession(root);
  if (session) hooks.SessionStart = session;
  const post = desiredPost(root);
  if (post) hooks.PostToolUse = upsertGroups(hooks.PostToolUse, post);
  const permissions = isPlainObject(live.permissions) ? { ...live.permissions } : {};
  const liveDeny = Array.isArray(permissions.deny) ? permissions.deny : [];
  permissions.deny = uniq([
    ...liveDeny.filter((x) => typeof x !== "string" || !x.startsWith("Write(")),
    ...loadConsumerDeny(root),
  ]);
  const next = { ...live, permissions, hooks };
  saveJson(abs, next);
}

function applyCodex(root) {
  const abs = path.join(root, ".codex/hooks.json");
  const live = loadJson(abs);
  const nested = isPlainObject(live.hooks);
  const cur = nested ? { ...live.hooks } : { ...live };
  cur.PreToolUse = upsertGroups(cur.PreToolUse, desiredPre(root));
  const session = desiredSession(root);
  if (session) cur.SessionStart = session;
  const post = desiredPost(root);
  if (post) {
    const codexPost = post.map((g) => ({ hooks: g.hooks }));
    cur.PostToolUse = upsertGroups(cur.PostToolUse, codexPost);
  }
  if (nested) saveJson(abs, { ...live, hooks: cur });
  else saveJson(abs, { ...live, ...cur });
}

function applyAgents(root) {
  const abs = path.join(root, ".agents/hooks.json");
  const live = loadJson(abs);
  const rulesync = isPlainObject(live.rulesync) ? { ...live.rulesync } : {};
  rulesync.PreToolUse = upsertGroups(rulesync.PreToolUse, desiredPre(root));
  const session = desiredSession(root, { map: false });
  if (session) {
    rulesync.SessionStart = [{ matcher: ".*", hooks: session[0].hooks }];
  }
  const post = desiredPost(root);
  if (post) {
    rulesync.PostToolUse = [{ matcher: POST_WRITE_MATCHER, hooks: post[0].hooks }];
  }
  const named = presentAutorun(root).length ? consumerNamed(root) : {};
  saveJson(abs, { ...live, ...named, rulesync });
}

function applyGemini(root) {
  if (!presentAutorun(root).length) return;
  const abs = path.join(root, ".gemini/settings.json");
  const live = loadJson(abs);
  const session = desiredSession(root);
  const post = desiredPost(root);
  const hooks = isPlainObject(live.hooks) ? { ...live.hooks } : {};
  if (session) hooks.SessionStart = session;
  if (post) {
    hooks.AfterTool = [{ matcher: "write_file|replace", hooks: post[0].hooks }];
  }
  saveJson(abs, {
    ...live,
    _caveat_check_behind: CAVEAT_BEHIND,
    _caveat_permissions: CAVEAT_PERMS,
    hooks,
  });
}

export function applyUnion(opts = {}) {
  const root = resolveRoot(opts);
  const check = typeof opts === "object" && opts && opts.check === true;
  if (check) {
    const failures = checkUnion({ workspaceRoot: root });
    if (failures.length) {
      return { ok: false, check: true, error: `drift: ${failures.join("; ")}`, failures };
    }
    return { ok: true, check: true, failures: [] };
  }
  applyClaude(root);
  applyCodex(root);
  applyAgents(root);
  applyGemini(root);
  return { ok: true, check: false };
}

export function checkUnion(opts = {}) {
  const root = resolveRoot(opts);
  const failures = [];
  const autorun = presentAutorun(root);
  const files = [
    {
      id: "claude",
      path: ".claude/settings.json",
      needles: [...GRUNT_NEEDLES, ...mapNeedles(root), ...autorun, ...loadConsumerDeny(root)],
    },
    {
      id: "codex",
      path: ".codex/hooks.json",
      needles: [...GRUNT_NEEDLES, ...mapNeedles(root), ...autorun],
    },
    {
      id: "agents",
      path: ".agents/hooks.json",
      needles: [...GRUNT_NEEDLES, ...autorun],
    },
  ];
  if (autorun.length) {
    files.push({
      id: "gemini",
      path: ".gemini/settings.json",
      needles: [
        ...autorun.filter((n) => n !== "check-behind.mjs"),
        "_caveat_check_behind",
        "_caveat_permissions",
      ],
    });
  }
  for (const spec of files) {
    const p = path.join(root, spec.path);
    if (!fs.existsSync(p)) {
      failures.push(`${spec.id}: missing ${spec.path}`);
      continue;
    }
    const text = fs.readFileSync(p, "utf8");
    for (const n of spec.needles) {
      if (!text.includes(n)) failures.push(`${spec.id}: missing ${n}`);
    }
  }
  const gitDir = path.join(root, "scripts/git-hooks");
  if (fs.existsSync(gitDir)) {
    for (const rel of GIT_HOOKS) {
      if (!fs.existsSync(path.join(root, rel))) failures.push(`git-hook missing: ${rel}`);
    }
  }
  return failures;
}

function main() {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    if (!parsed.ok) {
      process.stderr.write((parsed.error || "invalid argv") + "\n");
      return 1;
    }
    if (!parsed.check) {
      applyUnion({ workspaceRoot: process.cwd() });
      process.stdout.write("hooks-union: applied\n");
    }
    const failures = checkUnion({ workspaceRoot: process.cwd() });
    if (failures.length) {
      for (const f of failures) process.stderr.write(`hooks-union FAIL ${f}\n`);
      return 1;
    }
    process.stdout.write("hooks-union: check ok\n");
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
