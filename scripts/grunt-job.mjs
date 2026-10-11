#!/usr/bin/env node
/** Deterministic grunt for job: search|exec|test|slice|fetch. Exit 2 + FALLBACK on denylist/HTML-as-exec/unbounded. */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FALLBACK = "FALLBACK";
export const SHELL_META = /[|&;`$(){}<>\n\r]/;
export const MAX_FACTS = 6;
export const MAX_STDOUT = 32 * 1024;
export const STASH_CAP = 2 * 1024 * 1024;
export const MAX_HITS = 10_000;
export const STASH_REL = ".tmp/grunt/stash";

const DENY_SEGS = new Set(["node_modules", "dist", ".next", "build", "coverage"]);
const DENY_LOCK = /\b(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)\b/;
const FAIL_RE = /\b(FAIL(?:ED)?|ERROR|Error:|Exception|panic|E\d{3,})\b/;
const STACK_RE = /^\s+at\s/;
const PASS_RE = /^\s*(✓|√|PASS|ok |passed)\b/i;
const KNOWN_FLAGS = new Set([
  "--job",
  "--query",
  "--path",
  "--glob",
  "--cwd",
  "--stash",
  "--from",
  "--to",
]);
const JOBS = new Set(["search", "exec", "test", "slice", "fetch"]);

function takeFlag(argv, i, prefix) {
  const a = argv[i];
  if (a === prefix) return { value: String(argv[i + 1] || ""), next: i + 1 };
  if (a.startsWith(prefix + "=")) return { value: a.slice(prefix.length + 1), next: i };
  return null;
}

export function parseArgv(argv) {
  let job = "";
  let query = "";
  let searchPath = "";
  let cwd = "";
  let stash = "";
  let from = "";
  let to = "";
  const glob = [];
  let unknown = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const prefix = a.startsWith("--") ? a.split("=")[0] : "";
    if (prefix && !KNOWN_FLAGS.has(prefix)) {
      unknown = true;
      continue;
    }
    const jobF = takeFlag(argv, i, "--job");
    if (jobF) {
      job = jobF.value;
      i = jobF.next;
      continue;
    }
    const queryF = takeFlag(argv, i, "--query");
    if (queryF) {
      query = queryF.value;
      i = queryF.next;
      continue;
    }
    const pathF = takeFlag(argv, i, "--path");
    if (pathF) {
      searchPath = pathF.value;
      i = pathF.next;
      continue;
    }
    const cwdF = takeFlag(argv, i, "--cwd");
    if (cwdF) {
      cwd = cwdF.value;
      i = cwdF.next;
      continue;
    }
    const globF = takeFlag(argv, i, "--glob");
    if (globF) {
      if (globF.value) glob.push(globF.value);
      i = globF.next;
      continue;
    }
    const stashF = takeFlag(argv, i, "--stash");
    if (stashF) {
      stash = stashF.value;
      i = stashF.next;
      continue;
    }
    const fromF = takeFlag(argv, i, "--from");
    if (fromF) {
      from = fromF.value;
      i = fromF.next;
      continue;
    }
    const toF = takeFlag(argv, i, "--to");
    if (toF) {
      to = toF.value;
      i = toF.next;
      continue;
    }
    unknown = true;
  }
  return {
    job: String(job).trim().toLowerCase(),
    query: String(query),
    path: String(searchPath),
    glob,
    cwd: String(cwd),
    stash: String(stash).trim(),
    from: String(from).trim(),
    to: String(to).trim(),
    unknown,
  };
}

export function resolveUnder(root, rel) {
  const base = path.resolve(root || process.cwd());
  if (rel == null || rel === "") return base;
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, rel);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (abs !== base && !abs.startsWith(prefix)) return null;
  return abs;
}

export function resolveJobCwd(cwd, workspaceRoot) {
  return resolveUnder(workspaceRoot || process.cwd(), cwd);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shouldFallback(job, query, extra = {}) {
  const j = String(job || "").trim().toLowerCase();
  if (!JOBS.has(j)) return true;
  if (j === "slice") return !String(extra.stash || "").trim();
  if (j === "fetch") return !/^https?:\/\//i.test(String(query || "").trim());
  const q = String(query || "");
  if (!q.trim()) return true;
  if (/\b(curl|wget)\b/i.test(q)) return true;
  if (/<\s*html\b/i.test(q) || /<\s*!DOCTYPE html/i.test(q)) return true;
  if (DENY_LOCK.test(q)) return true;
  if (/(^|[\s/])\.git(\/|$)/.test(q.replace(/\\/g, "/"))) return true;
  for (const seg of DENY_SEGS) {
    const re = new RegExp(`(^|[\\/\\s'"\`])${escapeRe(seg)}([\\/\\s'"\`]|$)`);
    if (re.test(q)) return true;
  }
  return false;
}

export function isHtml(stdout, stderr) {
  const s = String(stdout || "") + String(stderr || "");
  return /<\s*html\b/i.test(s) || /<\s*!DOCTYPE html/i.test(s);
}

export function looksHtmlOrUnbounded(stdout, stderr) {
  const s = String(stdout || "") + String(stderr || "");
  if (s.length > MAX_STDOUT) return true;
  return isHtml(stdout, stderr);
}

export function squeezLines(lines, query) {
  const arr = (lines || []).map((l, i) => ({ l: String(l), i }));
  if (arr.length <= MAX_FACTS) return arr.map((x) => x.l);
  const q = String(query || "").trim();
  let queryRe = null;
  if (q) {
    try {
      queryRe = new RegExp(q);
    } catch {
      queryRe = null;
    }
  }
  function score(item) {
    const s = item.l;
    if (FAIL_RE.test(s) || STACK_RE.test(s)) return 100;
    if (queryRe) {
      const hit = queryRe.test(s);
      queryRe.lastIndex = 0;
      if (hit) return 50;
    } else if (q && s.includes(q)) return 50;
    if (item.i === 0 || item.i === arr.length - 1) return 20;
    if (PASS_RE.test(s)) return 0;
    return 10;
  }
  const ranked = arr.map((x) => ({ ...x, sc: score(x) }));
  const kept = [];
  const used = new Set();
  function take(pred) {
    for (const x of ranked) {
      if (kept.length >= MAX_FACTS) break;
      if (used.has(x.i)) continue;
      if (pred(x)) {
        kept.push(x);
        used.add(x.i);
      }
    }
  }
  take((x) => x.sc >= 100);
  take((x) => x.sc >= 50);
  if (!used.has(0) && kept.length < MAX_FACTS) {
    kept.push(ranked[0]);
    used.add(0);
  }
  const last = arr.length - 1;
  if (!used.has(last) && kept.length < MAX_FACTS) {
    kept.push(ranked[last]);
    used.add(last);
  }
  take((x) => x.sc > 0);
  take(() => true);
  kept.sort((a, b) => a.i - b.i);
  return kept.map((x) => x.l);
}

export function formatFacts({
  kind,
  n = 0,
  facts,
  errors,
  failed = false,
  stash = "",
  truncated = false,
} = {}) {
  const lines = [];
  const shown = (facts || []).slice(0, MAX_FACTS);
  if (failed) {
    const head =
      kind === "search" ? "Search failed." : "Command failed.";
    lines.push(stash ? `${head.slice(0, -1)}. stash=${stash}` : head);
    for (const e of (errors || []).slice(0, 3)) lines.push(`- ${e}`);
    return lines.slice(0, 8).join("\n") + "\n";
  }
  if (!n) {
    lines.push(kind === "search" ? "No matches." : "No output.");
    return lines.join("\n") + "\n";
  }
  const unit =
    kind === "search" ? (n === 1 ? "match" : "matches") : n === 1 ? "line" : "lines";
  const nLabel = truncated ? `${n}+` : String(n);
  if (stash) {
    lines.push(`${nLabel} ${unit}, ${shown.length} shown. stash=${stash}`);
  } else if (kind === "search") {
    lines.push(n === 1 ? "1 match." : `${n} matches.`);
  } else {
    lines.push(n === 1 ? "1 line." : `${n} lines.`);
  }
  for (const f of shown) lines.push(`- ${f}`);
  return lines.slice(0, 8).join("\n") + "\n";
}

function stashId() {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const b = crypto.randomBytes(4);
  let s = "";
  for (const x of b) s += alphabet[x % 36];
  return s;
}

export function writeStash(cwd, kind, raw) {
  const root = cwd || process.cwd();
  const dir = path.join(root, ".tmp", "grunt", "stash");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${kind}-${stashId()}.txt`;
  let body = String(raw || "");
  const buf = Buffer.from(body, "utf8");
  if (buf.length > STASH_CAP) body = buf.subarray(0, STASH_CAP).toString("utf8");
  if (!body.endsWith("\n")) body += "\n";
  fs.writeFileSync(path.join(dir, name), body);
  return `${STASH_REL}/${name}`;
}

function relStash(abs, cwd) {
  const root = cwd || process.cwd();
  return path.relative(root, abs).replace(/\\/g, "/");
}

export function resolveStashFile(cwd, stash) {
  const id = String(stash || "").trim();
  if (!id || id.includes("..") || path.isAbsolute(id) || /[\\/]/.test(id)) {
    if (id && !id.includes("..") && !path.isAbsolute(id)) {
      const under = String(id).replace(/\\/g, "/");
      if (under.startsWith(".tmp/grunt/stash/") && !under.includes("..")) {
        const abs = resolveUnder(cwd || process.cwd(), under);
        if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
      }
    }
    if (!id || id.includes("..") || path.isAbsolute(id)) return null;
  }
  const dir = path.join(cwd || process.cwd(), ".tmp", "grunt", "stash");
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir);
  const exact = names.find((n) => n === id || n === `${id}.txt`);
  if (exact) return path.join(dir, exact);
  const hit = names.find((n) => n.includes(id) && n.endsWith(".txt"));
  return hit ? path.join(dir, hit) : null;
}

function verdictFromLines({
  kind,
  lines,
  raw,
  query,
  cwd,
  failed = false,
  errors,
  truncated = false,
}) {
  const n = lines.length;
  const shown = squeezLines(lines, query);
  let stash = "";
  const rawText = raw != null ? String(raw) : lines.join("\n");
  if (n > MAX_FACTS || Buffer.byteLength(rawText, "utf8") > MAX_STDOUT) {
    stash = writeStash(cwd, kind, rawText);
  }
  if (failed) {
    const err = (errors && errors.length ? errors : shown).slice(0, 3);
    return {
      fallback: false,
      text: formatFacts({ kind, failed: true, errors: err, stash, n, facts: shown }),
      code: 0,
    };
  }
  return {
    fallback: false,
    text: formatFacts({ kind, n, facts: shown, stash, truncated }),
    code: 0,
  };
}

function runCmd(file, args, cwd) {
  return spawnSync(file, args, {
    encoding: "utf8",
    cwd: cwd || process.cwd(),
    timeout: 20_000,
    maxBuffer: STASH_CAP + 4096,
    env: process.env,
  });
}

const SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "build",
  "coverage",
  ".git",
]);
const SEARCH_MAX_FILE = 200 * 1024;

function parseSearchHits(stdout) {
  const hits = String(stdout || "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const facts = hits.map((line) => {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) return line.slice(0, 160);
    return `${m[1]}:${m[2]} — ${m[3].trim().slice(0, 120)}`;
  });
  return { n: hits.length, facts, raw: hits.join("\n") };
}

export function globToRegExp(glob) {
  const g = String(glob || "").replace(/\\/g, "/");
  let s = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        s += "(?:.*/)?";
        i += 2;
      } else {
        s += ".*";
        i += 1;
      }
    } else if (c === "*") s += "[^/]*";
    else if (c === "?") s += "[^/]";
    else s += escapeRe(c);
  }
  return new RegExp("^" + s + "$");
}

export function globMatch(rel, pattern) {
  const n = String(rel || "").replace(/\\/g, "/");
  let p = String(pattern || "").replace(/\\/g, "/");
  if (!p) return false;
  if (!p.includes("/")) p = "**/" + p;
  return globToRegExp(p).test(n) || globToRegExp(String(pattern).replace(/\\/g, "/")).test(n);
}

function fileMatchesGlobs(rel, globs) {
  if (!globs || !globs.length) return true;
  const base = path.posix.basename(rel);
  return globs.some((g) => globMatch(rel, g) || globMatch(base, g));
}

function nodeSearch(query, { cwd, start, glob } = {}) {
  let re;
  try {
    re = new RegExp(query);
  } catch {
    re = null;
  }
  const facts = [];
  let n = 0;
  let bytes = 0;
  const root = cwd || process.cwd();
  const origin = start || root;

  function searchFile(abs) {
    if (n >= MAX_HITS || bytes >= STASH_CAP) return;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > SEARCH_MAX_FILE) return;
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (!fileMatchesGlobs(rel, glob)) return;
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    if (text.includes("\0")) return;
    const lines = text.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hit = re ? re.test(line) : line.includes(query);
      if (re) re.lastIndex = 0;
      if (!hit) continue;
      n += 1;
      const fact = `${rel}:${i + 1} — ${line.trim().slice(0, 120)}`;
      facts.push(fact);
      bytes += Buffer.byteLength(fact, "utf8") + 1;
      if (n >= MAX_HITS || bytes >= STASH_CAP) return;
    }
  }

  function walk(dir) {
    if (n >= MAX_HITS || bytes >= STASH_CAP) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (n >= MAX_HITS || bytes >= STASH_CAP) return;
      if (SEARCH_SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      searchFile(abs);
    }
  }

  let st;
  try {
    st = fs.statSync(origin);
  } catch {
    return { n: 0, facts: [], truncated: false };
  }
  if (st.isFile()) searchFile(origin);
  else walk(origin);
  return { n, facts, truncated: n >= MAX_HITS || bytes >= STASH_CAP };
}

export function runSearch(query, { cwd, path: searchPath, glob } = {}) {
  const root = cwd || process.cwd();
  const start = searchPath ? resolveUnder(root, searchPath) : root;
  if (!start) {
    return { fallback: true, text: FALLBACK + "\n", code: 2 };
  }
  const globs = Array.isArray(glob) ? glob.filter(Boolean) : glob ? [String(glob)] : [];
  const relStart = path.relative(root, start) || ".";
  const rgArgs = [
    "-n",
    "--max-count",
    String(MAX_HITS),
    "--max-filesize",
    "200K",
    "-g",
    "!node_modules",
    "-g",
    "!dist",
    "-g",
    "!coverage",
    "-g",
    "!.next",
    "-g",
    "!build",
    "-g",
    "!.git",
  ];
  for (const g of globs) {
    rgArgs.push("-g", g);
  }
  rgArgs.push("-e", query, relStart);
  const r = runCmd("rg", rgArgs, root);
  if (!(r.error && r.error.code === "ENOENT")) {
    const stdout = String(r.stdout || "");
    const stderr = String(r.stderr || "");
    if (isHtml(stdout, stderr)) {
      return { fallback: true, text: FALLBACK + "\n", code: 2 };
    }
    if (r.status === 1) {
      return {
        fallback: false,
        text: formatFacts({ kind: "search", n: 0, facts: [] }),
        code: 0,
      };
    }
    if (r.status === 0) {
      const parsed = parseSearchHits(stdout);
      const truncated = parsed.n >= MAX_HITS;
      return verdictFromLines({
        kind: "search",
        lines: parsed.facts,
        raw: parsed.raw,
        query,
        cwd: root,
        truncated,
      });
    }
    if (r.status != null) {
      const errors = stderr
        .split(/\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      return {
        fallback: false,
        text: formatFacts({
          kind: "search",
          failed: true,
          errors: errors.length ? errors : [`rg exit ${r.status}`],
        }),
        code: 0,
      };
    }
  }

  const node = nodeSearch(query, { cwd: root, start, glob: globs });
  return verdictFromLines({
    kind: "search",
    lines: node.facts,
    raw: node.facts.join("\n"),
    query,
    cwd: root,
    truncated: node.truncated,
  });
}

function alreadyRtk(query) {
  const first = String(query || "").trim().split(/\s+/, 1)[0] || "";
  return first === "rtk" || first.endsWith("/rtk");
}

export function runExec(query, { cwd } = {}) {
  const q = String(query).trim();
  if (SHELL_META.test(q)) {
    return { fallback: true, text: FALLBACK + "\n", code: 2 };
  }
  const parts = q.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { fallback: true, text: FALLBACK + "\n", code: 2 };
  }
  let r;
  if (alreadyRtk(q)) {
    r = runCmd(parts[0], parts.slice(1), cwd);
  } else {
    r = runCmd("rtk", parts, cwd);
    if (r.error && r.error.code === "ENOENT") {
      r = runCmd(parts[0], parts.slice(1), cwd);
    }
  }
  if (r.error && r.error.code === "ENOENT") {
    return {
      fallback: false,
      text: formatFacts({
        kind: "exec",
        failed: true,
        errors: [String(r.error.code || "ENOENT")],
      }),
      code: 0,
    };
  }
  const stdout = String(r.stdout || "");
  const stderr = String(r.stderr || "");
  if (isHtml(stdout, stderr)) {
    return { fallback: true, text: FALLBACK + "\n", code: 2 };
  }
  if (r.status !== 0) {
    const errors = stderr
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!errors.length) {
      const fromOut = stdout
        .split(/\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      errors.push(...fromOut);
    }
    const raw = [stdout, stderr].filter(Boolean).join("\n");
    const lines = (errors.length ? errors : [`exit ${r.status}`]);
    return verdictFromLines({
      kind: "exec",
      lines,
      raw,
      query: q,
      cwd,
      failed: true,
      errors: lines,
    });
  }
  const lines = stdout
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length && !stderr.trim()) {
    return {
      fallback: false,
      text: formatFacts({ kind: "exec", n: 0, facts: [] }),
      code: 0,
    };
  }
  const body = lines.length ? lines : [stderr.trim()];
  return verdictFromLines({
    kind: "exec",
    lines: body,
    raw: stdout || stderr,
    query: q,
    cwd,
  });
}

export function runSlice({ stash, path: filter, from, to, cwd } = {}) {
  const abs = resolveStashFile(cwd, stash);
  if (!abs) {
    return {
      fallback: false,
      text: formatFacts({
        kind: "exec",
        failed: true,
        errors: ["missing stash"],
      }),
      code: 0,
    };
  }
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return {
      fallback: false,
      text: formatFacts({
        kind: "exec",
        failed: true,
        errors: ["missing stash"],
      }),
      code: 0,
    };
  }
  if (text.includes("\0")) {
    return {
      fallback: false,
      text: formatFacts({
        kind: "exec",
        failed: true,
        errors: ["binary stash"],
      }),
      code: 0,
    };
  }
  const numbered = text.split(/\n/).map((l, i) => ({ n: i + 1, l }));
  let picked = numbered;
  const a = from !== "" && from != null ? Number(from) : null;
  const b = to !== "" && to != null ? Number(to) : null;
  if (Number.isFinite(a) || Number.isFinite(b)) {
    const start = Number.isFinite(a) ? a : 1;
    const end = Number.isFinite(b) ? b : numbered.length;
    picked = numbered.filter((x) => x.n >= start && x.n <= end);
  }
  if (filter) picked = picked.filter((x) => x.l.includes(String(filter)));
  const factLines = picked.map(
    (x) => `stash:${x.n} — ${x.l.trim().slice(0, 120)}`,
  );
  const rel = relStash(abs, cwd);
  if (picked.length <= MAX_FACTS) {
    return {
      fallback: false,
      text: formatFacts({ kind: "exec", n: picked.length, facts: factLines }),
      code: 0,
    };
  }
  const shown = squeezLines(factLines, filter);
  return {
    fallback: false,
    text: formatFacts({
      kind: "exec",
      n: picked.length,
      facts: shown,
      stash: rel,
    }),
    code: 0,
  };
}

function stripHtml(html) {
  const s = String(html || "");
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const text = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return { title: String(title).replace(/\s+/g, " ").trim(), text };
}

export function runFetch(query, { cwd } = {}) {
  const url = String(query || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { fallback: true, text: FALLBACK + "\n", code: 2 };
  }
  const script = `
    const u = process.argv[1];
    const cap = ${STASH_CAP};
    fetch(u, { redirect: "follow" })
      .then(async (r) => {
        const buf = Buffer.from(await r.arrayBuffer());
        process.stdout.write(buf.subarray(0, cap));
      })
      .catch((e) => {
        process.stderr.write(String(e && e.message ? e.message : e));
        process.exit(1);
      });
  `;
  const r = spawnSync(process.execPath, ["-e", script, url], {
    encoding: "utf8",
    cwd: cwd || process.cwd(),
    timeout: 20_000,
    maxBuffer: STASH_CAP + 4096,
    env: process.env,
  });
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || "fetch failed")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      fallback: false,
      text: formatFacts({
        kind: "exec",
        failed: true,
        errors: err.length ? err.slice(0, 3) : ["fetch failed"],
      }),
      code: 0,
    };
  }
  const raw = String(r.stdout || "");
  const { title, text } = stripHtml(raw);
  const lines = [];
  if (title) lines.push(title);
  for (const part of text.split(/(?<=\.)\s+/)) {
    const p = part.trim();
    if (p) lines.push(p.slice(0, 160));
  }
  const body = lines.length ? lines : ["(empty)"];
  return verdictFromLines({
    kind: "exec",
    lines: body,
    raw,
    query: url,
    cwd,
    truncated: Buffer.byteLength(raw, "utf8") >= STASH_CAP,
  });
}

function fallbackResult() {
  return { fallback: true, text: FALLBACK + "\n", code: 2 };
}

export function runJob({
  job,
  query,
  cwd,
  path: searchPath,
  glob,
  stash,
  from,
  to,
  unknown,
} = {}) {
  if (unknown) return fallbackResult();
  if (shouldFallback(job, query, { stash })) return fallbackResult();
  const root = cwd || process.cwd();
  if (job === "search") return runSearch(query, { cwd: root, path: searchPath, glob });
  if (job === "slice") {
    return runSlice({ stash, path: searchPath, from, to, cwd: root });
  }
  if (job === "fetch") return runFetch(query, { cwd: root });
  return runExec(query, { cwd: root });
}

function main() {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    if (parsed.unknown) {
      process.stdout.write(FALLBACK + "\n");
      return 2;
    }
    const ws = process.cwd();
    const cwd = parsed.cwd ? resolveJobCwd(parsed.cwd, ws) : ws;
    if (!cwd) {
      process.stdout.write(FALLBACK + "\n");
      return 2;
    }
    const result = runJob({
      job: parsed.job,
      query: parsed.query,
      cwd,
      path: parsed.path,
      glob: parsed.glob,
      stash: parsed.stash,
      from: parsed.from,
      to: parsed.to,
    });
    process.stdout.write(result.text);
    return result.code;
  } catch {
    process.stdout.write(FALLBACK + "\n");
    return 2;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
