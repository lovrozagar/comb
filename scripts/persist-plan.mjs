#!/usr/bin/env node
/** Allocate/slugify/validate/write a local plan under .tmp/grunt/plans/. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
export const REQUIRED_H2 = [
  "Goal",
  "Context",
  "Constraints",
  "Watch-outs",
  "Steps",
  "Verify",
];
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

export function injectFrontmatter({ serial, slug, source, body, created }) {
  const src = String(source || "").slice(0, 120);
  let rest = stripFrontmatter(body).replace(/^\s+/, "");
  if (!rest.startsWith("# ")) {
    rest = `# ${slug}\n\n` + rest;
  } else {
    rest = rest.replace(/^# .+/, `# ${slug}`);
  }
  return `---
serial: ${serial}
name: ${slug}
status: ready
created: ${created || utcDateTime()}
source: ${JSON.stringify(src)}
---

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

export function validatePlan(filename, text) {
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
  const slugFromName = map.name;
  if (slugFromName && slugFromFilename(filename) !== slugFromName) {
    errors.push("name/filename slug");
  }
  if (!body.trim().startsWith(`# ${slugFromName}`)) errors.push("h1 slug");
  const { order, bodies } = sectionBodies(body);
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
    if (m[3] !== " ") errors.push("fresh [x]");
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
  const body = stripPlanName(raw);
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
  });
  const errors = validatePlan(filename, full);
  if (errors.length) {
    return { ok: false, error: errors.join("; "), errors };
  }
  ensureGitignore(ws);
  fs.writeFileSync(dest, full);
  return { ok: true, path: dest, serial, slug, content: full, filename };
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
