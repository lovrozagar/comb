#!/usr/bin/env node
/**
 * Code-only folder map for agents. Folders, never files.
 *
 * Source: git ls-files (tracked + untracked, gitignore applied). A folder is
 * shown when it or a descendant holds a code file and no segment is skipped.
 * Package roots (package.json, go.mod, Cargo.toml, pyproject.toml) carry
 * `# name  path`. Single-child chains collapse; plain leaf dirs fold at foldAt.
 * Depth is uniform per package: the deepest level that fits the size limit;
 * deeper folders end in `…`.
 *
 *   node scripts/folder-map.mjs [dir]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripJsonc } from "./jsonc.mjs";

export const DEFAULTS = Object.freeze({
  budget: 5000,
  depthCap: 6,
  foldAt: 12,
  codeExt: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "sql", "vue", "svelte", "astro"],
  skip: [
    "_gen", "gen", "generated", "dist", "build", "assets", "static", "public",
    "fixtures", "__fixtures__", "__snapshots__", "__mocks__", "testdata",
    "vendor", "migrations", "locales", "i18n",
  ],
  include: [],
  exclude: [],
});

export const CONFIG_REL = ".rulesync/grunt.map.jsonc";
const MANIFESTS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml"];

/** DEFAULTS merged with known keys from CONFIG_REL; bad file → defaults + warn. */
export function loadMapConfig(root, warn = (m) => process.stderr.write(`${m}\n`)) {
  const abs = path.join(root, CONFIG_REL);
  if (!fs.existsSync(abs)) return { ...DEFAULTS };
  let raw;
  try {
    raw = JSON.parse(stripJsonc(fs.readFileSync(abs, "utf8")));
  } catch (err) {
    warn(`grunt map: ignoring ${CONFIG_REL}: ${err.message}`);
    return { ...DEFAULTS };
  }
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw || {})) {
    if (!(k in DEFAULTS)) continue;
    const ok = Array.isArray(DEFAULTS[k])
      ? Array.isArray(v) && v.every((x) => typeof x === "string")
      : Number.isFinite(v) && v > 0;
    if (ok) out[k] = v;
    else warn(`grunt map: ignoring ${CONFIG_REL} key ${k}`);
  }
  return out;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Repo top, or null outside git. */
export function repoRoot(cwd) {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  return top ? top.trim() : null;
}

/**
 * Repo-relative posix path of `abs` ("" at the top), or null when it is not a
 * dir in a repo. Asks git so Windows short (8.3) vs long paths cannot diverge.
 */
export function repoPrefix(abs) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  const prefix = git(["rev-parse", "--show-prefix"], abs);
  return prefix == null ? null : prefix.trim().replace(/\/$/, "");
}

/** Tracked + untracked-unignored files, repo-relative, posix. */
export function listFiles(root) {
  const out = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
  if (out == null) return null;
  return [...new Set(out.split("\0").filter(Boolean))];
}

/** `*` = one segment, `**` = any depth; matches the dir and everything under it. */
function globRe(glob) {
  const body = String(glob)
    .replace(/\/+$/, "")
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${body}(/|$)`);
}

function packageName(root, dir, manifest) {
  try {
    const text = fs.readFileSync(path.join(root, dir, manifest), "utf8");
    if (manifest === "package.json") return JSON.parse(text).name || "";
    if (manifest === "go.mod") return (text.match(/^module\s+(\S+)/m) || [])[1] || "";
    return (text.match(/^name\s*=\s*"([^"]+)"/m) || [])[1] || "";
  } catch {
    return "";
  }
}

/**
 * Raw tree from file paths. Node: { name, path, kids: Map, own, pkg }.
 * `own` = holds a kept file directly. `pkg` is the package name ("" when
 * unnamed) on package roots, else null.
 */
export function buildTree(root, files, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const code = new RegExp(`\\.(${o.codeExt.join("|")})$`);
  const skip = new Set(o.skip);
  const include = o.include.map(globRe);
  const exclude = o.exclude.map(globRe);
  const manifests = new Map();
  for (const f of files) {
    const base = path.posix.basename(f);
    if (MANIFESTS.includes(base) && !manifests.has(path.posix.dirname(f))) {
      manifests.set(path.posix.dirname(f), base);
    }
  }
  const top = { name: "", path: "", kids: new Map(), own: false, pkg: null };
  for (const f of files) {
    const dir = path.posix.dirname(f);
    if (dir === ".") continue;
    if (exclude.some((re) => re.test(dir))) continue;
    const forced = include.some((re) => re.test(dir));
    const segs = dir.split("/");
    if (!forced) {
      if (!code.test(f)) continue;
      if (segs.some((s) => s.startsWith(".") || skip.has(s))) continue;
    }
    let node = top;
    for (const s of segs) {
      let next = node.kids.get(s);
      if (!next) {
        const p = node.path ? `${node.path}/${s}` : s;
        const m = manifests.get(p);
        next = { name: s, path: p, kids: new Map(), own: false, pkg: m ? packageName(root, p, m) : null };
        node.kids.set(s, next);
      }
      node = next;
    }
    node.own = true;
  }
  return top;
}

/**
 * Display tree: chains collapsed, leaf dirs folded.
 * Row: { kind: "dir"|"fold", label, path, pkg, kids: Row[] }.
 */
export function displayRows(node, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const names = [...node.kids.keys()].sort();
  const leaves = names.filter((n) => {
    const k = node.kids.get(n);
    return k.kids.size === 0 && k.pkg == null;
  });
  const folded = leaves.length >= o.foldAt ? new Set(leaves) : new Set();
  const rows = [];
  if (folded.size) {
    rows.push({ kind: "fold", label: leaves, path: node.path, pkg: null, kids: [] });
  }
  for (const n of names) {
    if (folded.has(n)) continue;
    let k = node.kids.get(n);
    let label = n;
    // Collapse pass-through dirs only; a dir with its own code stays a row.
    while (k.kids.size === 1 && k.pkg == null && !k.own) {
      const [only] = k.kids.values();
      label = `${label}/${only.name}`;
      k = only;
    }
    rows.push({ kind: "dir", label, path: k.path, pkg: k.pkg, kids: displayRows(k, o) });
  }
  return rows;
}

export function rowText(row, depth, { more = false, base = "" } = {}) {
  const pad = "  ".repeat(depth);
  if (row.kind === "fold") {
    const shown = row.label.slice(0, 6).join(", ");
    return `${pad}(${row.label.length} leaf dirs: ${shown}${row.label.length > 6 ? ", …" : ""})`;
  }
  const full = base ? `${base}/${row.path}` : row.path;
  let line = `${pad}${row.label}/`;
  if (row.pkg != null) line += row.pkg ? `  # ${row.pkg}  ${full}` : `  # ${full}`;
  if (more) line += "  …";
  return line;
}

export function tokens(text) {
  return Math.ceil(text.length / 4);
}

/** True when a package root sits anywhere below `row`. */
function holdsPackage(row) {
  return row.kids.some((k) => k.pkg != null || holdsPackage(k));
}

/**
 * Render rows with every package expanded to `cap` levels below its root
 * (top-level non-package rows count from 1). A row past the cap hides its
 * kids and ends in `…`, unless a package root sits below it: package rows
 * always stay reachable, and their own depth restarts at 0.
 */
function renderAtDepth(rows, cap, base) {
  const lines = [];
  const walk = (list, depth, pkgDepth) => {
    for (const row of list) {
      const rel = row.pkg != null ? 0 : pkgDepth;
      const hidden = row.kids.length > 0 && rel >= cap && !holdsPackage(row);
      lines.push(rowText(row, depth, { more: hidden, base }));
      if (!hidden) walk(row.kids, depth + 1, rel + 1);
    }
  };
  walk(rows, 0, 1);
  return lines;
}

/**
 * Map text for `root` (any dir inside a git repo), scoped to `dir` when set.
 * Depth is uniform: the deepest cap (≤ depthCap) whose text fits the limit,
 * where limit = budget × 4 chars, lowered by `opts.maxChars` (hook caps).
 * Returns { text, rows, tokens, depth } or null outside git.
 */
export function folderMap({ root, dir = "", ...opts } = {}) {
  const top = repoRoot(root);
  if (!top) return null;
  const files = listFiles(top);
  if (!files) return null;
  const o = { ...loadMapConfig(top), ...opts };
  const scope = dir ? repoPrefix(path.resolve(root, dir)) : "";
  if (scope == null) return { text: "", rows: 0, tokens: 0, depth: 0 };
  const scoped = scope
    ? files.filter((f) => f.startsWith(`${scope}/`)).map((f) => f.slice(scope.length + 1))
    : files;
  const rows = displayRows(buildTree(scope ? path.join(top, scope) : top, scoped, o), o);
  const limit = Math.min(o.budget * 4, o.maxChars ?? Infinity);
  let lines = [];
  let depth = o.depthCap;
  for (; depth >= 1; depth--) {
    lines = renderAtDepth(rows, depth, scope);
    if (lines.join("\n").length + 1 <= limit) break;
  }
  depth = Math.max(depth, 1);
  const text = lines.length ? `${lines.join("\n")}\n` : "";
  return { text, rows: lines.length, tokens: tokens(text), depth };
}

/** Text for `grunt map [dir]` / `node scripts/folder-map.mjs [dir]` run from `cwd`. */
export function mapCommand(cwd, dir = "") {
  const out = folderMap({ root: cwd, dir });
  if (!out) return "grunt map: not a git repository\n";
  return out.text || "grunt map: no code folders\n";
}

function main() {
  process.stdout.write(mapCommand(process.cwd(), process.argv[2] || ""));
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
