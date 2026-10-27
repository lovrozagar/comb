#!/usr/bin/env node
/** Allocate/validate/write a roadmap under docs/roadmaps/. Updates keep the file. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compactCreatedStamp,
  FILENAME_RE,
  PLAN_DIR,
  slugify,
  utcDateTime,
} from "./persist-plan.mjs";

export const ROADMAP_DIR = "docs/roadmaps";
export const ROADMAP_FILENAME_RE =
  /^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*-\d{8}T\d{6}Z\.md$/;
const STATUS_RE = /^(draft|locked|in-progress|done|blocked)$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REQUIRED_H2 = [
  "Goal",
  "Context",
  "Decisions",
  "Order",
  "Watch-outs",
  "Verify",
];
const SLICE_RE = /^(?: {0,2})(\d+) \[([ xX])\] Title: (.+)$/;
const KEY_RE = /^ {2,8}(Goal|Why|Location): (.*)$/;
const BOX_RE = /^(?: {0,2})(\d+(?:\.\d+){0,2}) \[([ xX])\] (.+)$/;

function locationOk(loc) {
  const norm = String(loc || "").replace(/\\/g, "/");
  if (path.isAbsolute(loc)) return true;
  const prefix = `${PLAN_DIR}/`;
  if (!norm.startsWith(prefix)) return false;
  const base = norm.slice(prefix.length);
  return !base.includes("/") && FILENAME_RE.test(base);
}

function sentences(text) {
  return String(text)
    .trim()
    .split(/(?<=[.!?])(?:\s+|$)/)
    .filter((s) => s.trim());
}

function stripFrontmatter(text) {
  const s = String(text).replace(/^\uFEFF/, "");
  if (!s.startsWith("---\n")) return { body: s, map: {} };
  const end = s.indexOf("\n---\n", 4);
  if (end === -1) return { body: s, map: {} };
  const map = {};
  for (const line of s.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    map[m[1]] = v;
  }
  return { body: s.slice(end + 5), map };
}

function preamble(raw) {
  const stripped = stripFrontmatter(raw);
  let text = stripped.body.replace(/^\s+/, "");
  let status = stripped.map.status || "";
  const nameMatch = text.match(/^ROADMAP_NAME:\s*(.+)\s*$/m);
  text = text.replace(/^ROADMAP_NAME:\s*.+\n/m, "");
  const statusLine = text.match(/^status:\s*(\S+)\s*$/m);
  if (statusLine) {
    if (!status) status = statusLine[1];
    text = text.replace(/^status:\s*\S+\s*\n/m, "");
  }
  const h1 = text.match(/^#\s+(.+)\s*$/m);
  return {
    body: text,
    status,
    name: nameMatch ? nameMatch[1].trim() : h1 ? h1[1].trim() : "",
  };
}

/** A Write of a roadmap. An edit that sends no full body is not one. */
export function isFullRoadmapBody(content) {
  const text = String(content || "");
  if (/^ROADMAP_NAME:\s*\S/m.test(text)) return true;
  return ["Goal", "Context", "Decisions", "Order", "Watch-outs", "Verify"].every(
    (h) => new RegExp(`^## ${h}$`, "m").test(text),
  );
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

function parseSlices(orderBody) {
  const slices = [];
  let cur = null;
  for (const line of String(orderBody).split("\n")) {
    const head = line.match(SLICE_RE);
    if (head) {
      if (cur) slices.push(cur);
      cur = {
        title: head[3].trim(),
        goal: "",
        why: "",
        location: "",
        hasGoal: false,
        hasWhy: false,
        hasLocation: false,
      };
      continue;
    }
    if (!cur) continue;
    const key = line.match(KEY_RE);
    if (!key) continue;
    if (key[1] === "Goal") {
      cur.goal = key[2].trim();
      cur.hasGoal = true;
    } else if (key[1] === "Why") {
      cur.why = key[2].trim();
      cur.hasWhy = true;
    } else {
      cur.location = key[2].trim();
      cur.hasLocation = true;
    }
  }
  if (cur) slices.push(cur);
  return slices;
}

export function validateRoadmap(filename, text, { fresh = false } = {}) {
  const errors = [];
  if (!ROADMAP_FILENAME_RE.test(filename)) errors.push("filename");
  const { body, map } = stripFrontmatter(text);
  if (!map.serial || !map.name || !map.status || !map.created || !map.source) {
    errors.push("frontmatter");
  }
  if (map.status && !STATUS_RE.test(map.status)) errors.push("status");
  const slug = String(filename)
    .replace(/\.md$/, "")
    .replace(/^[0-9]+-/, "")
    .replace(/-\d{8}T\d{6}Z$/, "");
  if (map.name && map.name !== slug) errors.push("name");
  if (!body.trim().startsWith(`# ${slug}`)) errors.push("h1");
  const { order, bodies } = sectionBodies(body);
  if (REQUIRED_H2.some((h, i) => order[i] !== h)) errors.push("heading order");
  if (order.some((h) => !REQUIRED_H2.includes(h))) errors.push("extra h2");
  const goalN = sentences(bodies.Goal || "");
  if (goalN.length < 1 || goalN.length > 3) errors.push("goal");
  for (const h of ["Context", "Decisions", "Watch-outs"]) {
    const b = (bodies[h] || "").trim();
    if (!b || !/^(?:[-*] |\(none\))/m.test(b)) errors.push(`${h.toLowerCase()} bullets`);
  }
  const slices = parseSlices(bodies.Order || "");
  if (slices.length < 2) errors.push("slices");
  for (const slice of slices) {
    const words = slice.title.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 6) errors.push("title");
    if (!slice.hasGoal || sentences(slice.goal).length !== 1) errors.push("slice goal");
    if (!slice.hasWhy || sentences(slice.why).length < 1 || sentences(slice.why).length > 2) {
      errors.push("why");
    }
    if (slice.hasLocation && !locationOk(slice.location)) errors.push("location");
  }
  if (fresh && map.status && map.status !== "draft") errors.push("fresh status");
  if (fresh) {
    for (const line of String(bodies.Order || "").split("\n")) {
      const m = line.match(BOX_RE);
      if (m && m[2] !== " ") errors.push("fresh [x]");
    }
  }
  const boxes = [];
  for (const line of String(bodies.Verify || "").split("\n")) {
    const m = line.match(BOX_RE);
    if (!m) continue;
    if (fresh && m[2] !== " ") errors.push("fresh [x]");
    boxes.push(m[1]);
  }
  const leaves = boxes.filter((id) => /^\d+\.\d+/.test(id));
  if (leaves.length < 1 || leaves.length > 5) errors.push("verify");
  return [...new Set(errors)];
}

function render(serial, slug, status, created, source, body) {
  let rest = body.replace(/^\s+/, "");
  if (!rest.startsWith("# ")) rest = `# ${slug}\n\n${rest}`;
  else rest = rest.replace(/^# .+/, `# ${slug}`);
  return `---
serial: ${serial}
name: ${slug}
status: ${status}
created: ${created}
source: ${JSON.stringify(String(source).slice(0, 120))}
---

${rest}`;
}

function sourceOf(pre, slug) {
  const goal = pre.body.match(/## Goal\n([\s\S]*?)\n## /);
  return String(
    pre.name || (goal ? goal[1].trim().replace(/\s+/g, " ") : slug),
  ).slice(0, 120);
}

export function persistRoadmap({
  workspaceRoot,
  content,
  created,
  filePath,
} = {}) {
  const ws = workspaceRoot || process.cwd();
  const dir = path.join(ws, ROADMAP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const raw = String(content || "");
  const pre = preamble(raw);
  const slug = slugify(pre.name);
  let abs = "";
  if (filePath) {
    abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(ws, filePath);
  }
  const exists = abs && fs.existsSync(abs) && fs.statSync(abs).isFile();
  if (exists) {
    const filename = path.basename(abs);
    const serial = parseInt(filename.split("-")[0], 10);
    const prev = stripFrontmatter(fs.readFileSync(abs, "utf8")).map;
    const createdAt = prev.created && DATETIME_RE.test(prev.created) ? prev.created : utcDateTime();
    const full = render(serial, slugFromFile(filename), pre.status || prev.status || "draft", createdAt, prev.source || sourceOf(pre, slug), pre.body);
    const errors = validateRoadmap(filename, full, { fresh: false });
    if (errors.length) return { ok: false, error: errors.join("; "), errors };
    fs.writeFileSync(abs, full);
    return {
      ok: true,
      path: path.relative(ws, abs).replace(/\\/g, "/"),
      serial,
      filename,
      content: full,
    };
  }
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
  const full = render(serial, slug, pre.status || "draft", createdAt, sourceOf(pre, slug), pre.body);
  const errors = validateRoadmap(filename, full, { fresh: true });
  if (errors.length) return { ok: false, error: errors.join("; "), errors };
  fs.writeFileSync(dest, full);
  return {
    ok: true,
    path: `${ROADMAP_DIR}/${filename}`,
    serial,
    filename,
    content: full,
  };
}

function slugFromFile(filename) {
  return String(filename)
    .replace(/\.md$/, "")
    .replace(/^[0-9]+-/, "")
    .replace(/-\d{8}T\d{6}Z$/, "");
}

function nextSerial(dir) {
  let next = 1;
  if (!fs.existsSync(dir)) return next;
  for (const b of fs.readdirSync(dir)) {
    const m = b.match(/^([0-9]+)-/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= next) next = n + 1;
  }
  return next;
}

function main() {
  try {
    const wsIdx = process.argv.indexOf("--workspace");
    const workspaceRoot = wsIdx >= 0 ? process.argv[wsIdx + 1] : process.cwd();
    const content = fs.readFileSync(0, "utf8");
    const result = persistRoadmap({ workspaceRoot, content });
    if (!result.ok) {
      process.stderr.write((result.error || "invalid roadmap") + "\n");
      return 1;
    }
    process.stdout.write(JSON.stringify({ serial: result.serial, path: result.path }) + "\n");
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
