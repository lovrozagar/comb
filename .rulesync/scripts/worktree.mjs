#!/usr/bin/env node
/**
 * Worktrees live at `<root>/.worktrees/<name>` on branch `wt/<name>` (roadmap D5, D6).
 *
 *   node .rulesync/scripts/worktree.mjs add <name>   make or reuse one; prints its path
 *   node .rulesync/scripts/worktree.mjs list         every linked worktree with its state
 *   node .rulesync/scripts/worktree.mjs prune        remove clean ones whose own commits reached the default branch
 *   node .rulesync/scripts/worktree.mjs hook         Claude Code WorktreeCreate / WorktreeRemove on stdin
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalPath, resolveRoots } from "./workspace-root.mjs";

export const WORKTREES_DIR = ".worktrees";
const BRANCH_PREFIX = "wt/";
const USAGE = "usage: worktree.mjs add <name> | list | prune | hook";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function samePath(a, b) {
  return canonicalPath(path.resolve(a)) === canonicalPath(path.resolve(b));
}

/** A git-safe directory and branch name, or null when nothing usable is left. */
export function worktreeName(raw) {
  const name = String(raw ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "");
  return name || null;
}

/** True when `file` is a direct child of `<root>/.worktrees`, however git spells the path. */
export function isManaged(file, root, p = path) {
  const rel = p.relative(p.resolve(root, WORKTREES_DIR), p.resolve(file));
  return !!rel && !rel.startsWith("..") && !p.isAbsolute(rel) && !rel.includes(p.sep);
}

/** `git worktree list --porcelain`, main checkout first. */
function worktreeEntries(root) {
  const r = git(root, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  return r.out
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n");
      const field = (k) => lines.find((l) => l === k || l.startsWith(`${k} `));
      const wt = field("worktree");
      const branch = field("branch");
      return wt && { path: canonicalPath(path.resolve(wt.slice("worktree ".length))), branch: branch ? branch.slice("branch refs/heads/".length) : null };
    })
    .filter(Boolean);
}

function branchExists(root, branch) {
  return git(root, ["show-ref", "--verify", "-q", `refs/heads/${branch}`]).ok;
}

/** `origin/HEAD`'s branch when it exists locally, else the main checkout's current branch. */
export function defaultBranch(root) {
  const remote = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote.ok) {
    const b = remote.out.replace(/^origin\//, "");
    if (branchExists(root, b)) return b;
  }
  const head = git(root, ["symbolic-ref", "--short", "HEAD"]);
  return head.ok ? head.out : "HEAD";
}

export function isMerged(root, branch) {
  return git(root, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, defaultBranch(root)]).ok;
}

/** The branch moved after it was created; no reflog counts as no, so a fresh worktree is never pruned. */
export function hasOwnCommits(root, branch) {
  const r = git(root, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`]);
  return r.ok && r.out.split("\n").some((l) => l && !l.startsWith("branch: Created from"));
}

/** Copy each gitignored file `.worktreeinclude` matches that the worktree lacks; never overwrite. */
function copyIncluded(root, dest) {
  if (!fs.existsSync(path.join(root, ".worktreeinclude"))) return;
  const listed = git(root, ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude"]);
  const candidates = listed.out.split("\n").filter((rel) => rel && !rel.startsWith(`${WORKTREES_DIR}/`));
  if (!candidates.length) return;
  const ignored = spawnSync("git", ["check-ignore", "--stdin"], { cwd: root, input: candidates.join("\n"), encoding: "utf8" });
  for (const rel of (ignored.stdout || "").split("\n").filter(Boolean)) {
    const to = path.join(dest, rel);
    if (fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, rel), to);
  }
}

/** Make or reuse `<root>/.worktrees/<name>` on `wt/<name>`; throws a one-line message when it cannot. */
export function addWorktree(root, raw) {
  const name = worktreeName(raw);
  if (!name) throw new Error(`worktree name "${raw ?? ""}" has no usable characters; use letters, digits, ".", "_" or "-"`);
  const dest = path.join(root, WORKTREES_DIR, name);
  const branch = BRANCH_PREFIX + name;
  let known = worktreeEntries(root).slice(1).find((e) => samePath(e.path, dest));
  if (known && !fs.existsSync(dest)) {
    git(root, ["worktree", "prune"]);
    known = null;
  }
  if (!known) {
    if (fs.existsSync(dest)) throw new Error(`${dest} exists and is not a worktree of this repo; move it or pick another name`);
    const args = branchExists(root, branch) ? ["worktree", "add", dest, branch] : ["worktree", "add", "-b", branch, dest, "HEAD"];
    // git's own output goes to stderr, so stdout carries only the path.
    if (spawnSync("git", args, { cwd: root, stdio: ["ignore", 2, 2] }).status !== 0) throw new Error(`git worktree add failed for ${dest}`);
  }
  copyIncluded(root, dest);
  return { path: canonicalPath(dest), branch, created: !known };
}

/** @returns {Array<{ path: string, branch: string | null, state: "clean" | "dirty" | "missing", merged: boolean, managed: boolean }>} */
export function listWorktrees(root) {
  return worktreeEntries(root)
    .slice(1)
    .map((e) => {
      const state = !fs.existsSync(e.path) ? "missing" : git(e.path, ["status", "--porcelain"]).out ? "dirty" : "clean";
      const merged = !!e.branch && hasOwnCommits(root, e.branch) && isMerged(root, e.branch);
      return { path: e.path, branch: e.branch, state, merged, managed: isManaged(e.path, root) };
    });
}

/** Remove clean managed worktrees whose own commits reached the default branch, then merged `wt/*` branches left without one. */
export function pruneWorktrees(root) {
  const removed = [];
  for (const w of listWorktrees(root)) {
    if (!w.managed || w.state !== "clean" || !w.merged) continue;
    if (!git(root, ["worktree", "remove", w.path]).ok) continue;
    git(root, ["branch", "-D", w.branch]);
    removed.push({ path: w.path, branch: w.branch });
  }
  const held = new Set(worktreeEntries(root).map((e) => e.branch).filter(Boolean));
  const branches = git(root, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`]).out.split("\n");
  for (const b of branches.filter(Boolean)) {
    if (held.has(b) || !isMerged(root, b)) continue;
    if (git(root, ["branch", "-D", b]).ok) removed.push({ path: null, branch: b });
  }
  return removed;
}

/** Claude Code's WorktreeCreate / WorktreeRemove; other events do nothing. */
export function worktreeHook(data) {
  const event = data && data.hook_event_name;
  try {
    if (event === "WorktreeCreate") {
      return { code: 0, stdout: `${addWorktree(resolveRoots(data).root, data.name).path}\n`, stderr: "" };
    }
    if (event === "WorktreeRemove") {
      const target = String(data.worktree_path || "");
      if (!target) return { code: 0, stdout: "", stderr: "" };
      const root = resolveRoots(data).root;
      const entry = worktreeEntries(root).slice(1).find((e) => samePath(e.path, target));
      if (entry) {
        const r = git(root, ["worktree", "remove", "--force", entry.path]);
        if (!r.ok && fs.existsSync(target)) return { code: 1, stdout: "", stderr: r.err || `could not remove ${target}` };
      }
      const branch = entry ? entry.branch : BRANCH_PREFIX + path.basename(target);
      if (branch && branch.startsWith(BRANCH_PREFIX) && branchExists(root, branch) && isMerged(root, branch)) {
        git(root, ["branch", "-D", branch]);
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e.message };
  }
}

/** Shell words per command segment; a word holding `$`, a backtick or a leading `~` is not literal. */
function shellSegments(command) {
  const segments = [[]];
  let word = null;
  const end = () => {
    if (word) segments[segments.length - 1].push(word);
    word = null;
  };
  const add = (text, literal = true) => {
    word = word || { text: "", literal: true };
    word.text += text;
    if (!literal) word.literal = false;
  };
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === " " || ch === "\t") end();
    else if (";&|\n".includes(ch)) {
      end();
      if (segments[segments.length - 1].length) segments.push([]);
    } else if (ch === "'") {
      const close = s.indexOf("'", i + 1);
      add(close === -1 ? s.slice(i + 1) : s.slice(i + 1, close));
      i = close === -1 ? s.length : close;
    } else if (ch === '"') {
      const close = s.indexOf('"', i + 1);
      const inner = close === -1 ? s.slice(i + 1) : s.slice(i + 1, close);
      add(inner, !/[$`\\]/.test(inner));
      i = close === -1 ? s.length : close;
    } else if (ch === "\\") {
      add(s[i + 1] ?? "");
      i++;
    } else add(ch, !(ch === "$" || ch === "`" || (ch === "~" && !word)));
  }
  end();
  return segments.filter((seg) => seg.length);
}

const ADD_VALUE_FLAGS = new Set(["-b", "-B", "--reason"]);

/** `{ target, branch, commitish, detach }` for a `git … worktree add …` segment, else null. */
function worktreeAddOf(words, cwd, p) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) i++;
  const bin = words[i]?.text || "";
  if (bin !== "git" && !bin.endsWith("/git")) return null;
  let at = cwd;
  for (i++; i < words.length && words[i].text.startsWith("-"); i++) {
    if (words[i].text === "-C") {
      const dir = words[++i];
      if (!dir || !dir.literal) return { unreadable: true };
      at = p.resolve(at, dir.text);
    } else if (words[i].text === "-c") i++;
  }
  if (words[i]?.text !== "worktree" || words[i + 1]?.text !== "add") return null;
  const out = { at, target: null, branch: null, commitish: null, detach: false };
  for (i += 2; i < words.length; i++) {
    const w = words[i];
    if (ADD_VALUE_FLAGS.has(w.text)) {
      const value = words[++i];
      if (w.text !== "--reason") out.branch = value ? value.text : null;
    } else if (w.text === "--detach" || w.text === "-d") out.detach = true;
    else if (w.text.startsWith("-")) continue;
    else if (!out.target) out.target = w;
    else if (!out.commitish) out.commitish = w.text;
  }
  return out;
}

/** The deny reason for a `git worktree add` aimed anywhere but `<root>/.worktrees/<name>` on `wt/<name>`, else null. */
export function worktreeAddReason(command, roots, cwd, p = path) {
  let here = cwd;
  for (const words of shellSegments(command)) {
    if (words[0].text === "cd" && words.length === 2 && words[1].literal) {
      here = p.resolve(here, words[1].text);
      continue;
    }
    const add = worktreeAddOf(words, here, p);
    if (!add || add.unreadable || !add.target || !add.target.literal) continue;
    const abs = canonicalPath(p.resolve(add.at, add.target.text), p);
    const name = isManaged(abs, roots.root, p) ? p.basename(abs) : null;
    const branch = add.branch ?? (add.detach ? null : add.commitish);
    if (name && branch === BRANCH_PREFIX + name) continue;
    const suggest = worktreeName(add.branch ? add.branch.replace(/^wt\//, "") : p.basename(abs)) || "<name>";
    const script = p.join(roots.checkout || roots.root, ".rulesync", "scripts", "worktree.mjs");
    return `worktrees live in ${p.join(roots.root, WORKTREES_DIR, "<name>")} on branch wt/<name>: run node ${script} add ${suggest}`;
  }
  return null;
}

function main(argv) {
  const [cmd, arg] = argv;
  try {
    if (cmd === "add" && arg !== undefined) {
      process.stdout.write(`${addWorktree(resolveRoots({}).root, arg).path}\n`);
      return 0;
    }
    if (cmd === "list") {
      for (const w of listWorktrees(resolveRoots({}).root)) {
        const cols = [w.path, w.branch || "(detached)", w.state, w.merged ? "merged" : "unmerged"];
        if (!w.managed) cols.push(`outside ${WORKTREES_DIR}`);
        process.stdout.write(`${cols.join("\t")}\n`);
      }
      return 0;
    }
    if (cmd === "prune") {
      const removed = pruneWorktrees(resolveRoots({}).root);
      for (const r of removed) process.stdout.write(r.path ? `removed ${r.path} (${r.branch})\n` : `deleted branch ${r.branch}\n`);
      if (!removed.length) process.stdout.write("nothing to prune\n");
      return 0;
    }
    if (cmd === "hook") {
      const res = worktreeHook(JSON.parse(fs.readFileSync(0, "utf8") || "{}"));
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(`${res.stderr}\n`);
      return res.code;
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url) || import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = main(process.argv.slice(2));
}
