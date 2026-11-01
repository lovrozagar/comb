#!/usr/bin/env node
/** Allocate/slugify/validate/write a local plan under .tmp/grunt/plans/. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matchLessons } from "./lessons.mjs";

export const PLAN_DIR = ".tmp/grunt/plans";
/** One-shot rename source; drop next release. */
export const LEGACY_PLAN_DIR = ".tmp/plans";

/** If `.tmp/plans` exists and `.tmp/grunt/plans` is missing, rename. Both exist: leave old. */
export function migrateLegacyPlansDir(workspaceRoot) {
  const ws = workspaceRoot || process.cwd();
  const legacy = path.join(ws, LEGACY_PLAN_DIR);
  const next = path.join(ws, PLAN_DIR);
  if (fs.existsSync(legacy) && !fs.existsSync(next)) {
    fs.mkdirSync(path.dirname(next), { recursive: true });
    fs.renameSync(legacy, next);
  }
  return next;
}
/** Old unstamped names and new `{serial}-{slug}-{YYYYMMDDTHHMMSSZ}.md`. */
export const FILENAME_RE =
  /^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*(-\d{8}T\d{6}Z)?\.md$/;
export const SERIAL_LINE_RE = /^serial: [1-9][0-9]*$/;
export const STATUS_RE = /^(ready|in-progress|done|blocked)$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const CREATED_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/;
export const FILENAME_STAMP_RE = /-\d{8}T\d{6}Z$/;
/** Conventional Commits subject. Scope optional. Lowercase, no trailing period. */
export const COMMIT_SUBJECT_RE =
  /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9]+(?:-[a-z0-9]+)*\))?: [a-z0-9](?:[a-z0-9 .'/:_,-]*[a-z0-9])?$/;
export const REQUIRED_H2 = [
  "Goal",
  "Context",
  "Constraints",
  "Watch-outs",
  "Steps",
  "Verify",
];
/** Last heading: this plan's own log of mistakes. Required on new plans, append-only on updates. */
export const MISTAKES_H2 = "Previous mistakes";
/** Entry kinds a plan logs. A roadmap adds its own. */
export const PLAN_MISTAKE_SOURCES = ["feedback", "verify", "review", "premise"];
const BOX_RE = /^( {0,2})(\d+(?:\.\d+){0,2}) \[([ xX])\] (.+)$/;
const LEAF_ID_RE = /^\d+\.\d+(?:\.\d+)?$/;

export function slugify(name) {
  let s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 50) {
    s = s.slice(0, 50).replace(/-+$/g, "");
  }
  if (!s) s = "unnamed";
  if (s.endsWith(".lock")) {
    s = s.slice(0, -5).replace(/-+$/g, "") || "unnamed";
  }
  return s;
}

export function utcDateTime(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function utcDate(d = new Date()) {
  return utcDateTime(d).slice(0, 10);
}

export function compactCreatedStamp(created) {
  return String(created).replace(/[-:]/g, "");
}

export function slugFromFilename(filename) {
  return String(filename)
    .replace(/\.md$/, "")
    .replace(/^[0-9]+-/, "")
    .replace(FILENAME_STAMP_RE, "");
}

export function extractPlanName(content) {
  const m = String(content).match(/^\s*PLAN_NAME:\s*(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

export function stripPlanName(content) {
  return String(content).replace(/^\s*PLAN_NAME:\s*.+\s*\n/, "");
}

export function extractH1(content) {
  const m = String(content).match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

export function nextSerial(plansDir) {
  let next = 1;
  if (!fs.existsSync(plansDir)) return next;
  for (const b of fs.readdirSync(plansDir)) {
    if (!b.endsWith(".md")) continue;
    const m = b.match(/^([0-9]+)-/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= next) next = n + 1;
  }
  return next;
}

export function ensureGitignore(workspaceRoot) {
  const p = path.join(workspaceRoot, ".gitignore");
  let cur = "";
  try {
    cur = fs.readFileSync(p, "utf8");
  } catch {
    fs.writeFileSync(p, ".tmp/\n");
    return;
  }
  if (/(?:^|\n)\.tmp\/(?:\n|$)/.test(cur)) return;
  const next = cur.endsWith("\n") || !cur ? cur : cur + "\n";
  fs.writeFileSync(p, next + ".tmp/\n");
}

function stripFrontmatter(text) {
  const s = String(text).replace(/^\uFEFF/, "");
  if (!s.startsWith("---\n")) return s;
  const end = s.indexOf("\n---\n", 4);
  if (end === -1) return s;
  return s.slice(end + 5);
}

export function extractCommit(content) {
  const text = String(content).replace(/^\uFEFF/, "");
  if (text.startsWith("---\n")) {
    const fm = parseFrontmatter(text);
    if (!fm.error && Object.prototype.hasOwnProperty.call(fm.map, "commit")) {
      return fm.map.commit;
    }
  }
  const m = text.match(/^commit:\s*(.*?)\s*$/m);
  return m ? m[1] : undefined;
}

function stripCommitLine(content) {
  return String(content).replace(/^commit:\s*.*\n/m, "");
}

export function injectFrontmatter({
  serial,
  slug,
  source,
  body,
  created,
  commit,
}) {
  const src = String(source || "").slice(0, 120);
  let rest = stripFrontmatter(body).replace(/^\s+/, "");
  if (!rest.startsWith("# ")) {
    rest = `# ${slug}\n\n` + rest;
  } else {
    rest = rest.replace(/^# .+/, `# ${slug}`);
  }
  const commitLine =
    commit != null && commit !== "" ? `commit: ${commit}\n` : "";
  return `---
serial: ${serial}
name: ${slug}
status: ready
reviews: 0
created: ${created || utcDateTime()}
source: ${JSON.stringify(src)}
${commitLine}---

${rest}`;
}

function sectionBodies(text) {
  const h2 = [...text.matchAll(/^## (.+)$/gm)].map((m) => ({
    title: m[1].trim(),
    index: m.index,
  }));
  const bodies = {};
  for (let i = 0; i < h2.length; i++) {
    const start = h2[i].index + h2[i].title.length + 4;
    const end = i + 1 < h2.length ? h2[i + 1].index : text.length;
    bodies[h2[i].title] = text.slice(start, end);
  }
  return { order: h2.map((h) => h.title), bodies };
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { error: "missing frontmatter" };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { error: "unterminated frontmatter" };
  const raw = text.slice(4, end);
  const map = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-z]+):(?:\s+(.*))?$/);
    if (!m) continue;
    let v = m[2] ?? "";
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    map[m[1]] = v;
  }
  return { map, body: text.slice(end + 5) };
}

const REVIEWS_RE = /^(0|[1-9][0-9]*)$/;
/** Statuses a plan may enter only after that many settled `/review-plan` rounds. */
const REVIEWS_TO_ENTER = { "in-progress": 1 };

/**
 * `reviews` counts settled review rounds: well-formed, never removed or lowered, and gating entry to
 * a status. `gates` maps a status to the rounds it needs; `review` is the command the deny names.
 */
export function reviewErrors(map, prev, { gates, review }) {
  const has = Object.prototype.hasOwnProperty.call(map, "reviews");
  if (has && !REVIEWS_RE.test(String(map.reviews))) {
    return ["reviews must be a whole number with no sign or leading zero, e.g. reviews: 1"];
  }
  const count = has ? Number(map.reviews) : 0;
  const errors = [];
  if (prev && Object.prototype.hasOwnProperty.call(prev, "reviews")) {
    if (!has) errors.push(`keep reviews: ${prev.reviews} in the frontmatter; the review count cannot be removed`);
    else if (count < Number(prev.reviews)) errors.push(`reviews cannot go down (saved ${prev.reviews}, got ${count})`);
  }
  const need = gates[map.status];
  if (need && (!prev || prev.status !== map.status) && count < need) {
    errors.push(
      `status ${map.status} needs reviews: ${need} or more; run ${review}, settle its findings, and bump reviews in that save`,
    );
  }
  return errors;
}

/** `(none)` or one `- {source}: {what was wrong} → {what changed}` line per entry. */
export function parseMistakes(sectionText, sources) {
  const re = new RegExp(
    `^- (${sources.join("|")}): (.+?) → (.+?)(?: \\(lesson: ([a-z0-9]+(?:-[a-z0-9]+)*)\\))?$`,
  );
  const lines = String(sectionText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 1 && lines[0] === "(none)") return { entries: [], errors: [] };
  if (!lines.length) return { entries: [], errors: ["## Previous mistakes is empty; write (none)"] };
  const entries = [];
  const errors = [];
  for (const line of lines) {
    const m = line.match(re);
    if (!m) {
      errors.push(
        `Previous mistakes entry must be "- {${sources.join("|")}}: {what was wrong} → {what changed}": ${line}`,
      );
      continue;
    }
    entries.push({ source: m[1], text: `${m[2]} → ${m[3]}`, lesson: m[4], line });
  }
  return { entries, errors };
}

/**
 * Errors in a `## Previous mistakes` log given a document's heading order and section bodies:
 * last and once, required when `fresh`, well-formed, and append-only against `previous` (the saved
 * document's order and bodies). `kind` names the document in the deny.
 */
export function mistakeLogErrors(order, bodies, { fresh, previous, sources, kind }) {
  const errors = [];
  const at = order.indexOf(MISTAKES_H2);
  if (at !== -1 && (at !== order.length - 1 || order.lastIndexOf(MISTAKES_H2) !== at)) {
    errors.push("## Previous mistakes must be the last heading, once");
  }
  if (at === -1 && fresh) {
    errors.push(`missing ## Previous mistakes; end a new ${kind} with it and (none)`);
  }
  const mistakes = at === -1 ? { entries: [], errors: [] } : parseMistakes(bodies[MISTAKES_H2], sources);
  errors.push(...mistakes.errors);
  if (previous && previous.order.includes(MISTAKES_H2)) {
    const current = mistakes.entries.map((e) => e.line);
    parseMistakes(previous.bodies[MISTAKES_H2], sources).entries.forEach((e, i) => {
      if (current[i] !== e.line) {
        errors.push(`Previous mistakes is append-only; keep this entry unchanged: ${e.line}`);
      }
    });
  }
  return errors;
}

/**
 * `fresh` is a new plan: no `[x]`, Previous mistakes required. `previous` is the saved text an
 * update replaces: its Previous mistakes entries must survive unchanged and in order.
 */
export function validatePlan(filename, text, { fresh = true, previous } = {}) {
  const errors = [];
  if (!FILENAME_RE.test(filename)) errors.push("filename");
  const fm = parseFrontmatter(text);
  if (fm.error) {
    errors.push(fm.error);
    return errors;
  }
  const { map, body } = fm;
  const serialLine = text.split("\n").find((l) => l.startsWith("serial:"));
  if (!serialLine || !SERIAL_LINE_RE.test(serialLine)) errors.push("serial line");
  for (const k of ["serial", "name", "status", "created", "source"]) {
    if (map[k] == null || map[k] === "") errors.push(`missing ${k}`);
  }
  if (map.status && !STATUS_RE.test(map.status)) errors.push("status");
  if (map.created && !CREATED_RE.test(map.created)) errors.push("created");
  if (typeof map.source === "string" && map.source.length > 120) {
    errors.push("source length");
  }
  if (
    Object.prototype.hasOwnProperty.call(map, "commit") &&
    !COMMIT_SUBJECT_RE.test(String(map.commit))
  ) {
    errors.push("commit");
  }
  const slugFromName = map.name;
  if (slugFromName && slugFromFilename(filename) !== slugFromName) {
    errors.push("name/filename slug");
  }
  if (!body.trim().startsWith(`# ${slugFromName}`)) errors.push("h1 slug");
  const prevFm = previous == null ? null : parseFrontmatter(previous);
  errors.push(
    ...reviewErrors(map, prevFm && !prevFm.error ? prevFm.map : null, {
      gates: REVIEWS_TO_ENTER,
      review: "/review-plan {n}",
    }),
  );
  const fileSerial = filename.match(/^(\d+)-/);
  if (fileSerial && map.serial && Number(map.serial) !== Number(fileSerial[1])) {
    errors.push("serial/filename");
  }
  const { order: allOrder, bodies } = sectionBodies(body);
  errors.push(
    ...mistakeLogErrors(allOrder, bodies, {
      fresh,
      previous: previous == null ? null : sectionBodies(stripFrontmatter(previous)),
      sources: PLAN_MISTAKE_SOURCES,
      kind: "plan",
    }),
  );
  const order = allOrder.filter((h) => h !== MISTAKES_H2);
  const firstSix = order.slice(0, REQUIRED_H2.length);
  if (REQUIRED_H2.some((h, i) => firstSix[i] !== h)) errors.push("heading order");
  const extra = order.filter((h) => !REQUIRED_H2.includes(h));
  if (extra.length) errors.push("extra h2");
  const goal = (bodies.Goal || "").trim();
  const sentences = goal.split(/(?<=[.!?])(?:\s+|$)/).filter((s) => s.trim());
  if (!goal || sentences.length < 1 || sentences.length > 3) errors.push("goal");
  for (const h of ["Context", "Constraints", "Watch-outs"]) {
    const b = (bodies[h] || "").trim();
    if (!b) errors.push(`${h} empty`);
    else if (!/^(?:[-*] |\(none\))/m.test(b)) errors.push(`${h} bullets`);
  }
  const boxes = [];
  for (const line of text.split("\n")) {
    const m = line.match(BOX_RE);
    if (!m) continue;
    if (fresh && m[3] !== " ") errors.push("fresh [x]");
    boxes.push({ id: m[2], text: m[4] });
  }
  const leaves = boxes.filter((b) => LEAF_ID_RE.test(b.id));
  if (leaves.length < 1) errors.push("no N.M leaf");
  const phases = boxes.filter((b) => /^\d+$/.test(b.id));
  for (const p of phases) {
    if (!boxes.some((b) => b.id.startsWith(p.id + "."))) errors.push(`phase ${p.id} leaf`);
  }
  if (phases.length) {
    const last = phases[phases.length - 1];
    if (!/^Verify\b/i.test(last.text) && last.id !== String(phases.length)) {
      errors.push("verify last phase");
    }
  }
  return [...new Set(errors)];
}

/** Lessons matching workspace files a new plan names (absolute paths) that Watch-outs does not cite. */
/**
 * Absolute paths under `ws` that `text` names, written with either separator (case-insensitive on
 * Windows). A sibling dir that shares the prefix does not count.
 */
export function workspacePaths(ws, text, p = path) {
  const segs = p.resolve(ws).split(/[\\/]/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(
    `(?<![\\w.\\\\/-])${segs.join("[\\\\/]")}[\\\\/][^\\s\`'"()<>,;]+`,
    p.sep === "\\" ? "gi" : "g",
  );
  return [...new Set((String(text).match(re) || []).map((m) => m.replace(/[.:]+$/, "")))];
}

function uncitedLessons(ws, text) {
  const files = workspacePaths(ws, text);
  if (!files.length) return [];
  const watch = sectionBodies(stripFrontmatter(text)).bodies["Watch-outs"] || "";
  return matchLessons({ workspaceRoot: ws, files }).filter((r) => !watch.includes(r.file));
}

/** Body-only revision (PLAN_NAME, no frontmatter): keep the saved frontmatter and slug. */
function withSavedFrontmatter(previous, raw) {
  const fm = parseFrontmatter(previous);
  // Nothing to keep: validation of the bare body names the missing frontmatter.
  if (fm.error) return raw;
  const head = previous.slice(0, previous.length - fm.body.length);
  const commit = extractCommit(raw);
  const nextHead =
    commit == null
      ? head
      : /^commit:/m.test(head)
        ? head.replace(/^commit:.*$/m, `commit: ${commit}`)
        : head.replace(/\n---\n$/, `\ncommit: ${commit}\n---\n`);
  let rest = stripCommitLine(stripPlanName(raw)).replace(/^\s+/, "");
  rest = rest.startsWith("# ") ? rest.replace(/^# .+/, `# ${fm.map.name}`) : `# ${fm.map.name}\n\n${rest}`;
  return `${nextHead}\n${rest}`;
}

/**
 * Rewrite of a saved plan: same file and serial, `[x]` allowed, Previous mistakes append-only.
 * Validates only. The host writes `content`: a write here first makes Claude Code refuse the
 * Write as modified since read.
 */
export function preparePlanUpdate({ workspaceRoot, filePath, content }) {
  const ws = workspaceRoot || process.cwd();
  const abs = path.resolve(ws, filePath);
  const filename = path.basename(abs);
  const previous = fs.readFileSync(abs, "utf8");
  const text = String(content || "").replace(/^﻿/, "");
  const full = text.startsWith("---\n") ? text : withSavedFrontmatter(previous, text);
  const errors = validatePlan(filename, full, { fresh: false, previous });
  if (errors.length) {
    return { ok: false, error: errors.join("; "), errors };
  }
  return {
    ok: true,
    path: path.relative(ws, abs).split(path.sep).join("/"),
    serial: Number(filename.match(/^(\d+)-/)[1]),
    slug: slugFromFilename(filename),
    content: full,
    filename,
  };
}

export function persistPlan({
  workspaceRoot,
  content,
  source,
  created,
} = {}) {
  const ws = workspaceRoot || process.cwd();
  const raw = String(content || "");
  const planName = extractPlanName(raw) || extractH1(stripFrontmatter(stripPlanName(raw)));
  const slug = slugify(planName);
  const src =
    source ||
    (raw.match(/^\s*source:\s*(.+)$/m) ? undefined : planName);
  const commit = extractCommit(raw);
  const body = stripCommitLine(stripPlanName(raw));
  migrateLegacyPlansDir(ws);
  const plansDir = path.join(ws, PLAN_DIR);
  fs.mkdirSync(plansDir, { recursive: true });
  const createdAt =
    created && DATETIME_RE.test(created) ? created : utcDateTime();
  const stamp = compactCreatedStamp(createdAt);
  let serial = nextSerial(plansDir);
  let filename = `${serial}-${slug}-${stamp}.md`;
  let dest = path.join(plansDir, filename);
  let tries = 0;
  while (fs.existsSync(dest) && tries < 5) {
    serial += 1;
    filename = `${serial}-${slug}-${stamp}.md`;
    dest = path.join(plansDir, filename);
    tries += 1;
  }
  if (fs.existsSync(dest)) {
    return { ok: false, error: "serial collision" };
  }
  const goalMatch = stripFrontmatter(body).match(/## Goal\n([\s\S]*?)\n## /);
  const sourceText = String(
    source ||
      planName ||
      (goalMatch ? goalMatch[1].trim().replace(/\s+/g, " ") : slug),
  ).slice(0, 120);
  const full = injectFrontmatter({
    serial,
    slug,
    source: sourceText,
    body,
    created: createdAt,
    commit,
  });
  const errors = validatePlan(filename, full);
  for (const r of uncitedLessons(ws, full)) {
    errors.push(`cite this matched lesson in Watch-outs: ${r.file} (${r.summary})`);
  }
  if (errors.length) {
    return { ok: false, error: errors.join("; "), errors };
  }
  ensureGitignore(ws);
  fs.writeFileSync(dest, full);
  return {
    ok: true,
    path: `${PLAN_DIR}/${filename}`,
    serial,
    slug,
    content: full,
    filename,
  };
}

function main() {
  try {
    const wsIdx = process.argv.indexOf("--workspace");
    const workspaceRoot =
      wsIdx >= 0 ? process.argv[wsIdx + 1] : process.cwd();
    const content = fs.readFileSync(0, "utf8");
    const result = persistPlan({ workspaceRoot, content });
    if (!result.ok) {
      process.stderr.write((result.error || "invalid plan") + "\n");
      return 1;
    }
    process.stdout.write(
      JSON.stringify({
        serial: result.serial,
        path: result.path,
        absPath: path.resolve(workspaceRoot, result.path),
        filename: result.filename,
      }) + "\n",
    );
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
