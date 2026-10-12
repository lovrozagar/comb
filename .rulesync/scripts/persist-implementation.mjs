#!/usr/bin/env node
/** Allocate/slugify/validate/write a session journal under .tmp/grunt/implementations/. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CREATED_RE,
  DATETIME_RE,
  SERIAL_LINE_RE,
  compactCreatedStamp,
  ensureGitignore,
  nextSerial,
  slugify,
  utcDateTime,
} from "./persist-plan.mjs";

export const IMPLEMENTATION_DIR = ".tmp/grunt/implementations";
/** `{serial}-{slug}-{YYYYMMDDTHHMMSSZ}.md`; stamp required for new writes. */
export const FILENAME_RE = /^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*-\d{8}T\d{6}Z\.md$/;
export const STATUS_RE = /^(in-progress|done|blocked)$/;
export const PLAN_VALUE_RE = /^(none|[1-9][0-9]*)$/;
export const FILENAME_STAMP_RE = /-\d{8}T\d{6}Z$/;
export const REQUIRED_H2 = ["Done", "Issue", "Files", "Log", "Blockers", "Notes"];
const META_LINE_RE = /^\s*IMPL_(NAME|PLAN):\s*.+\s*$/;
const NAME_RE = /^\s*IMPL_NAME:\s*(.+?)\s*$/m;
const PLAN_RE = /^\s*IMPL_PLAN:\s*(.+?)\s*$/m;

export function slugFromFilename(filename) {
  return String(filename)
    .replace(/\.md$/, "")
    .replace(/^[0-9]+-/, "")
    .replace(FILENAME_STAMP_RE, "");
}

export function extractImplName(content) {
  const m = String(content).match(NAME_RE);
  return m ? m[1].trim() : "";
}

export function extractImplPlan(content) {
  const m = String(content).match(PLAN_RE);
  if (!m) return "none";
  const v = m[1].trim().toLowerCase();
  if (v === "none" || v === "") return "none";
  if (/^[1-9][0-9]*$/.test(v)) return v;
  return "";
}

export function stripImplMeta(content) {
  return String(content)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => !META_LINE_RE.test(line))
    .join("\n");
}

export function extractH1(content) {
  const m = String(content).match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

export function isFullImplementationBody(content) {
  const s = String(content || "");
  return /^---\n/.test(s) || /^# /m.test(s) || /^## Done\b/m.test(s);
}

function stripFrontmatter(text) {
  const s = String(text).replace(/^\uFEFF/, "");
  if (!s.startsWith("---\n")) return s;
  const end = s.indexOf("\n---\n", 4);
  if (end === -1) return s;
  return s.slice(end + 5);
}

export function injectFrontmatter({ serial, slug, source, body, created, plan }) {
  const src = String(source || "").slice(0, 120);
  const planVal = PLAN_VALUE_RE.test(String(plan || "")) ? String(plan) : "none";
  let rest = stripFrontmatter(body).replace(/^\s+/, "");
  if (!rest.startsWith("# ")) {
    rest = `# ${slug}\n\n` + rest;
  } else {
    rest = rest.replace(/^# .+/, `# ${slug}`);
  }
  return `---
serial: ${serial}
plan: ${planVal}
name: ${slug}
status: in-progress
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

function bulletsOrNone(body, label) {
  const b = String(body || "").trim();
  if (!b) return `${label} empty`;
  if (b === "(none)") return "";
  const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return `${label} empty`;
  for (const line of lines) {
    if (line === "(none)") continue;
    if (label === "Log" && /^\d+\.\d+(?:\.\d+)? \[[ xX]\] /.test(line)) continue;
    if (!/^[-*] /.test(line)) return `${label} bullets`;
  }
  return "";
}

function filesError(body) {
  const b = String(body || "").trim();
  if (!b) return "Files empty";
  if (b === "(none)") return "";
  for (const line of b.split("\n")) {
    const t = line.trim();
    if (!t || t === "(none)") continue;
    if (!/^[-*] /.test(t)) return "Files bullets";
    const p = t.replace(/^[-*] /, "").trim();
    if (!p) return "Files bullets";
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "Files abs";
    if (p.startsWith(".tmp/") || p.includes("/.tmp/")) return "Files tmp";
  }
  return "";
}

export function validateImplementation(filename, text) {
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
  for (const k of ["serial", "plan", "name", "status", "created", "source"]) {
    if (map[k] == null || map[k] === "") errors.push(`missing ${k}`);
  }
  if (map.status && !STATUS_RE.test(map.status)) errors.push("status");
  if (map.plan && !PLAN_VALUE_RE.test(map.plan)) errors.push("plan");
  if (map.created && !CREATED_RE.test(map.created)) errors.push("created");
  if (typeof map.source === "string" && map.source.length > 120) {
    errors.push("source length");
  }
  const slug = map.name;
  if (slug && slugFromFilename(filename) !== slug) errors.push("name/filename slug");
  if (!body.trim().startsWith(`# ${slug}`)) errors.push("h1 slug");
  const { order, bodies } = sectionBodies(body);
  const first = order.slice(0, REQUIRED_H2.length);
  if (REQUIRED_H2.some((h, i) => first[i] !== h)) errors.push("heading order");
  const extra = order.filter((h) => !REQUIRED_H2.includes(h));
  if (extra.length) errors.push("extra h2");
  for (const h of ["Done", "Issue", "Log", "Blockers", "Notes"]) {
    const err = bulletsOrNone(bodies[h], h);
    if (err) errors.push(err);
  }
  const ferr = filesError(bodies.Files);
  if (ferr) errors.push(ferr);
  const blockers = (bodies.Blockers || "").trim();
  if (map.status === "blocked" && blockers === "(none)") errors.push("blocked blockers");
  return [...new Set(errors)];
}

export function persistImplementation({
  workspaceRoot,
  content,
  source,
  created,
} = {}) {
  const ws = workspaceRoot || process.cwd();
  const raw = String(content || "");
  const name = extractImplName(raw) || extractH1(stripFrontmatter(stripImplMeta(raw)));
  const slug = slugify(name);
  const dir = path.join(ws, IMPLEMENTATION_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const plan = extractImplPlan(raw);
  if (raw.match(PLAN_RE) && !plan) return { ok: false, error: "plan", errors: ["plan"] };
  const body = stripImplMeta(raw);
  const createdAt = created && DATETIME_RE.test(created) ? created : utcDateTime();
  const stamp = compactCreatedStamp(createdAt);
  let serial = nextSerial(dir);
  let filename = `${serial}-${slug}-${stamp}.md`;
  let dest = path.join(dir, filename);
  let tries = 0;
  while (fs.existsSync(dest) && tries < 5) {
    serial += 1;
    filename = `${serial}-${slug}-${stamp}.md`;
    dest = path.join(dir, filename);
    tries += 1;
  }
  if (fs.existsSync(dest)) return { ok: false, error: "serial collision" };
  const doneMatch = stripFrontmatter(body).match(/## Done\n([\s\S]*?)\n## /);
  const sourceText = String(
    source ||
      name ||
      (doneMatch ? doneMatch[1].trim().replace(/\s+/g, " ") : slug),
  ).slice(0, 120);
  const full = injectFrontmatter({
    serial,
    slug,
    source: sourceText,
    body,
    created: createdAt,
    plan,
  });
  const errors = validateImplementation(filename, full);
  if (errors.length) return { ok: false, error: errors.join("; "), errors };
  ensureGitignore(ws);
  fs.writeFileSync(dest, full);
  return { ok: true, path: dest, serial, slug, content: full, filename, plan };
}

function main() {
  try {
    const wsIdx = process.argv.indexOf("--workspace");
    const workspaceRoot = wsIdx >= 0 ? process.argv[wsIdx + 1] : process.cwd();
    const content = fs.readFileSync(0, "utf8");
    const result = persistImplementation({ workspaceRoot, content });
    if (!result.ok) {
      process.stderr.write((result.error || "invalid implementation") + "\n");
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
