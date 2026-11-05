#!/usr/bin/env node
/**
 * Delete scratch under .tmp/grunt/ that grunt does not own, dead-session state and stray nested .tmp/grunt dirs,
 * and age out grunt's own files untouched for 30 days (roadmap D12).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boardHome, readBootId, sweep } from "./board.mjs";
import { FILENAME_RE, TMP_DIR, TMP_RESERVED_DIRS } from "./persist-tmp.mjs";
import { resolveRoots } from "./workspace-root.mjs";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const AGE = 30 * DAY;
const DURABLE = ["plans", "roadmaps", "handoffs", "implementations"];

// How each grunt-owned dir is cleaned. A reserved dir with no policy fails at load, so a new one is never deleted silently.
const POLICY = {
  plans: "age-done",
  roadmaps: "age-done",
  handoffs: "age",
  implementations: "age-done",
  browser: "keep",
  listen: "keep",
  speak: "keep",
  sessions: "per-session",
  "orchestrator-logs": "per-stamp",
  stash: "per-receipt",
};
for (const name of TMP_RESERVED_DIRS) {
  if (!POLICY[name]) throw new Error(`clean: no policy for reserved dir ${name}`);
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Newest mtime anywhere inside; a symlink counts by its own mtime and is never followed.
function newest(p) {
  const st = fs.lstatSync(p);
  let t = st.mtimeMs;
  if (st.isDirectory()) for (const name of list(p)) t = Math.max(t, newest(path.join(p, name)));
  return t;
}

function stats(p) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return { bytes: st.size, dir: false };
  let bytes = 0;
  for (const name of list(p)) bytes += stats(path.join(p, name)).bytes;
  return { bytes, dir: true };
}

function holdsFile(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return true;
  return list(p).some((name) => holdsFile(path.join(p, name)));
}

/** Nested .tmp/grunt dirs below the root, from git's ignored-dir listing; [] outside git. */
export function nestedTmpDirs(root) {
  const r = spawnSync("git", ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) return [];
  const out = [];
  for (const entry of r.stdout.split("\0")) {
    const e = entry.replace(/\/+$/, "");
    let rel = null;
    if (e.endsWith("/.tmp")) rel = `${e}/grunt`;
    else if (e.endsWith("/.tmp/grunt")) rel = e;
    if (!rel) continue;
    const abs = path.join(root, rel);
    try {
      if (fs.lstatSync(abs).isDirectory()) out.push(abs);
    } catch {
      /* no grunt dir under this .tmp */
    }
  }
  return out;
}

const OLD_KIND = { plans: "old plan", roadmaps: "old roadmap", implementations: "old journal", handoffs: "old handoff" };
const SERIAL_RE = /^([0-9]+)-/;

/** The serial a dir's counter sees in `name`, else null: `nextSerial` counts `.md` only, the roadmap counter any name. */
function serialOf(dir, name) {
  const m = SERIAL_RE.exec(name);
  if (!m || (dir !== "roadmaps" && !name.endsWith(".md"))) return null;
  return Number(m[1]);
}

function statusOf(file) {
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, "utf8"));
    const s = m && /^status:\s*(\S+)/m.exec(m[1]);
    return s ? s[1] : null;
  } catch {
    return null;
  }
}

/** Resolved `Location:` paths named by every roadmap that is not `done`. */
function roadmapLocations(tmp) {
  const dir = path.join(tmp, "roadmaps");
  const out = new Set();
  for (const name of list(dir)) {
    const file = path.join(dir, name);
    if (statusOf(file) === "done") continue;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s*Location:\s*(\S+)\s*$/gm)) out.add(path.resolve(m[1]));
  }
  return out;
}

/** The name with the highest serial under `pick`, so max + 1 counters never hand out a number again. */
function keeperOf(names, pick) {
  let best = null;
  let top = -1;
  for (const n of names) {
    const s = pick(n);
    if (s !== null && s > top) [best, top] = [n, s];
  }
  return best;
}

/** The first durable dir (`plans`, `roadmaps`, `handoffs`, `implementations`) holding a file under `dir`, else null. */
export function nestedHolds(dir) {
  return DURABLE.find((d) => holdsFile(path.join(dir, d))) ?? null;
}

/** Pure decision: which paths to remove and what was kept, by kind. */
export function planClean({ root, now, liveSessions, nested = [] }) {
  const tmp = path.join(root, TMP_DIR);
  const remove = [];
  const keep = [];
  const recent = (p, window = HOUR) => newest(p) >= now - window;
  const decide = (p, gone, kind, keptAs) => (gone ? remove.push({ path: p, kind }) : keep.push({ path: p, kind: keptAs }));
  const old = (p) => newest(p) < now - AGE;
  const pinned = roadmapLocations(tmp);
  const names = list(tmp);
  const artifactKeeper = keeperOf(
    names.filter((n) => FILENAME_RE.test(n) && !fs.lstatSync(path.join(tmp, n)).isDirectory()),
    (n) => Number(SERIAL_RE.exec(n)[1]),
  );
  for (const name of names) {
    const p = path.join(tmp, name);
    const policy = TMP_RESERVED_DIRS.has(name) ? POLICY[name] : null;
    if (policy === "keep") {
      keep.push({ path: p, kind: name });
    } else if (policy === "age" || policy === "age-done") {
      const entries = list(p);
      const keeper = keeperOf(entries, (n) => serialOf(name, n));
      keep.push({ path: p, kind: name });
      for (const entry of entries) {
        const child = path.join(p, entry);
        if (entry === keeper || serialOf(name, entry) === null || !old(child)) continue;
        if (policy === "age-done" && statusOf(child) !== "done") continue;
        if (name === "plans" && pinned.has(path.resolve(child))) continue;
        remove.push({ path: child, kind: OLD_KIND[name] });
      }
    } else if (policy === "per-session") {
      for (const sid of list(p)) {
        const child = path.join(p, sid);
        const live = liveSessions.has(sid);
        decide(child, !live && !recent(child), "dead session", live ? "live session" : "recent");
      }
    } else if (policy === "per-stamp") {
      for (const stamp of list(p)) {
        const child = path.join(p, stamp);
        const live = [...liveSessions].some((sid) => stamp.endsWith(`-${sid}`));
        decide(child, !live && !recent(child), "stale stamp", live ? "live session" : "recent");
      }
    } else if (policy === "per-receipt") {
      for (const receipt of list(p)) {
        const child = path.join(p, receipt);
        decide(child, !recent(child, DAY), "stash receipt", "recent");
      }
    } else if (FILENAME_RE.test(name) && !fs.lstatSync(p).isDirectory()) {
      decide(p, name !== artifactKeeper && old(p), "old tmp artifact", "tmp artifact");
    } else {
      decide(p, !recent(p), stats(p).dir ? "dir" : "file", "recent");
    }
  }
  for (const dir of nested) {
    const held = nestedHolds(dir);
    if (held) keep.push({ path: dir, kind: "nested", holds: held });
    else remove.push({ path: dir, kind: "nested dir" });
  }
  return { remove, keep };
}

const REMOVE_ORDER = [
  "file",
  "dir",
  "dead session",
  "stale stamp",
  "stash receipt",
  "nested dir",
  "old plan",
  "old roadmap",
  "old journal",
  "old handoff",
  "old tmp artifact",
];
const PLURAL = {
  file: "files",
  dir: "dirs",
  "dead session": "dead sessions",
  "stale stamp": "stale stamps",
  "stash receipt": "stash receipts",
  "nested dir": "nested dirs",
  "old plan": "old plans",
  "old roadmap": "old roadmaps",
  "old journal": "old journals",
  "old handoff": "old handoffs",
  "old tmp artifact": "old tmp artifacts",
};

function counted(items, order, plural) {
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  return order
    .filter((k) => counts.get(k))
    .map((k) => `${counts.get(k)} ${counts.get(k) === 1 ? k : plural[k] || k}`);
}

function size(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function keptLine(keep) {
  const durable = DURABLE.filter((d) => keep.some((k) => k.kind === d));
  const rest = counted(keep, ["tmp artifact", "live session", "recent"], {
    "tmp artifact": "tmp artifacts",
    "live session": "live sessions",
    recent: "entries touched recently",
  });
  return [...durable, ...rest].join(", ") || "nothing";
}

/** Plan, delete unless dryRun, report through `out`; returns the exit code. */
export function runClean({ root, now, liveSessions, dryRun, out }) {
  const relOf = (p) => path.relative(root, p).split(path.sep).join("/");
  const { remove, keep } = planClean({ root, now, liveSessions, nested: nestedTmpDirs(root) });
  const done = [];
  let failed = 0;
  let bytes = 0;
  for (const item of remove) {
    const b = stats(item.path).bytes;
    if (dryRun) {
      out(relOf(item.path));
    } else {
      try {
        fs.rmSync(item.path, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        failed += 1;
        out(`skipped ${relOf(item.path)}: ${err.code || err.message}`);
        continue;
      }
    }
    done.push(item);
    bytes += b;
  }
  const verb = dryRun ? "would remove" : "removed";
  const parts = counted(done, REMOVE_ORDER, PLURAL);
  out(
    parts.length
      ? `${verb} ${parts.join(", ")} (${size(bytes)})`
      : `${verb} 0 entries from ${relOf(path.join(root, TMP_DIR))}`,
  );
  out(`${dryRun ? "would keep" : "kept"} ${keptLine(keep)}`);
  for (const k of keep.filter((k) => k.kind === "nested")) out(`kept nested ${relOf(k.path)}: holds ${k.holds}`);
  return failed ? 1 : 0;
}

/** Session ids with a live host process on this machine's board. */
export function liveSessions(env = process.env) {
  return new Set(sweep({ home: boardHome(env), boot: readBootId() }).map((row) => row.session));
}

function main(argv = process.argv.slice(2)) {
  return runClean({
    root: resolveRoots().root,
    now: Date.now(),
    liveSessions: liveSessions(),
    dryRun: argv.includes("--dry-run"),
    out: (line) => console.log(line),
  });
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url) || import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = main();
}
