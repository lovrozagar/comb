/** Sentinel merge for AGENTS.md CLAUDE.md GEMINI.md. Copied into consumers. */
import fs from "node:fs";
import path from "node:path";

export const GUARDED_ROOT_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];
export const SENTINEL_BEGIN = "<!-- grunt:begin -->";
export const SENTINEL_END = "<!-- grunt:end -->";
export const MAX_GUARDED_MARKDOWN_BYTES = 2 * 1024 * 1024;
const GRUNT_REGION_RE =
  /(?:^|(?<=\n)|(?<=\r\n))[ \t]*<!-- grunt:begin -->[ \t]*\r?\n?[\s\S]*?(?:^|(?<=\n)|(?<=\r\n))[ \t]*<!-- grunt:end -->[ \t]*\r?\n?/g;
const GRUNT_INTERIOR_RE =
  /(?:^|(?<=\n)|(?<=\r\n))[ \t]*<!-- grunt:begin -->[ \t]*\r?\n?([\s\S]*?)(?:^|(?<=\n)|(?<=\r\n))[ \t]*<!-- grunt:end -->/g;
const ORPHAN_END_RE = /(?:^|\r?\n)[ \t]*<!-- grunt:end -->[ \t]*(?=\r?\n|$)|<!-- grunt:end -->/g;
const BEGIN_LINE_RE = /^[ \t]*<!-- grunt:begin -->[ \t]*$/;
const END_LINE_RE = /^[ \t]*<!-- grunt:end -->[ \t]*$/;

function detectNewline(text) {
  return String(text).includes("\r\n") ? "\r\n" : "\n";
}

function toNewline(text, nl) {
  return String(text).replace(/\r\n/g, "\n").replace(/\n/g, nl);
}

function trimTrailingNewlines(text) {
  return String(text).replace(/(?:\r?\n)+$/, "");
}

function normEq(a, b) {
  return (
    trimTrailingNewlines(String(a).replace(/\r\n/g, "\n")) ===
    trimTrailingNewlines(String(b).replace(/\r\n/g, "\n"))
  );
}

function cloneRe(re) {
  return new RegExp(re.source, re.flags);
}

function inspectGuardedBuffer(buf) {
  if (buf.length > MAX_GUARDED_MARKDOWN_BYTES) return "huge";
  if (buf.includes(0)) return "binary";
  return null;
}

export function extractUserMarkdown(text) {
  let user = String(text).replace(cloneRe(GRUNT_REGION_RE), "");
  const i = user.indexOf(SENTINEL_BEGIN);
  if (i >= 0) user = user.slice(0, i);
  user = user.replace(cloneRe(ORPHAN_END_RE), "");
  return userRemainderIsBlank(user) ? "" : user;
}

function unwrapStackedMarkers(text) {
  const lines = String(text).split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && BEGIN_LINE_RE.test(lines[start])) start++;
  while (end > start && lines[end - 1] === "") end--;
  while (end > start && END_LINE_RE.test(lines[end - 1])) {
    end--;
    while (end > start && lines[end - 1] === "") end--;
  }
  return lines.slice(start, end).join("\n");
}

export function extractGruntBody(text) {
  const src = String(text);
  const parts = [];
  const re = cloneRe(GRUNT_INTERIOR_RE);
  let m;
  while ((m = re.exec(src))) {
    parts.push(trimTrailingNewlines(unwrapStackedMarkers(m[1])));
  }
  if (parts.length) return parts.join("\n");
  const i = src.indexOf(SENTINEL_BEGIN);
  if (i >= 0) {
    return trimTrailingNewlines(
      unwrapStackedMarkers(src.slice(i + SENTINEL_BEGIN.length).replace(/^[ \t]*\r?\n/, "")),
    );
  }
  if (!src.includes(SENTINEL_END)) return null;
  return trimTrailingNewlines(unwrapStackedMarkers(src));
}

function userRemainderIsBlank(user) {
  return String(user).replace(/\r\n/g, "\n").replace(/\n/g, "") === "";
}

export function composeGuardedMarkdown(gruntBody, userRemainder, nl = "\n") {
  const raw = extractGruntBody(gruntBody) ?? gruntBody;
  const body = toNewline(trimTrailingNewlines(raw), nl);
  const block = `${SENTINEL_BEGIN}${nl}${body}${nl}${SENTINEL_END}${nl}`;
  const user = extractUserMarkdown(userRemainder == null ? "" : String(userRemainder));
  if (!user || userRemainderIsBlank(user)) return block;
  return block + toNewline(user, nl);
}

export function mergeGuardedContent(existingText, gruntBody) {
  const existing = existingText == null ? "" : String(existingText);
  const nl =
    existing.includes("\r\n") || String(gruntBody).includes("\r\n")
      ? detectNewline(existing || gruntBody)
      : "\n";
  if (!existing) return composeGuardedMarkdown(gruntBody, "", nl);
  const hadSentinel = existing.includes(SENTINEL_BEGIN) && existing.includes(SENTINEL_END);
  const user = extractUserMarkdown(existing);
  if (!hadSentinel && normEq(existing, gruntBody)) {
    return composeGuardedMarkdown(gruntBody, "", nl);
  }
  return composeGuardedMarkdown(gruntBody, user, nl);
}

/** `##` blocks in `existing` whose titles are not in `incoming`. */
export function extraH2Sections(existing, incoming) {
  const incomingTitles = new Set(
    [...String(incoming ?? "").matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()),
  );
  const text = String(existing ?? "").replace(/\r\n/g, "\n");
  const matches = [...text.matchAll(/^## /gm)];
  if (!matches.length) return "";
  const chunks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const block = text.slice(start, end).replace(/(?:\n)+$/, "");
    const title = block.match(/^## (.+)$/m)?.[1].trim();
    if (title && !incomingTitles.has(title)) chunks.push(block);
  }
  return chunks.join("\n\n");
}

/** Grunt body plus consumer-only `##` sections. No sentinels (INDEX inlines law.md). */
export function mergeReferenceMarkdown(existing, incoming) {
  const src = String(incoming ?? "");
  const extras = extraH2Sections(existing ?? "", src);
  const base = src.replace(/(?:\r?\n)+$/, "");
  if (!extras.trim()) return `${base}\n`;
  return `${base}\n\n${extras.replace(/(?:\n)+$/, "")}\n`;
}

export function writeMergedGuardedFile(destPath, gruntBody) {
  if (!fs.existsSync(destPath)) {
    fs.writeFileSync(destPath, mergeGuardedContent("", gruntBody));
    return;
  }
  const buf = fs.readFileSync(destPath);
  if (inspectGuardedBuffer(buf)) return "aborted-unsafe";
  fs.writeFileSync(destPath, mergeGuardedContent(buf.toString("utf8"), gruntBody));
}

export function guardedMarkdownDrift(destPath, gruntBody) {
  if (!fs.existsSync(destPath)) return true;
  const buf = fs.readFileSync(destPath);
  if (inspectGuardedBuffer(buf)) return true;
  const text = buf.toString("utf8");
  const interior = extractGruntBody(text);
  if (interior == null) return !normEq(text, gruntBody);
  return !normEq(interior, gruntBody);
}

export function snapshotGuardedRoots(root) {
  const snap = {};
  for (const file of GUARDED_ROOT_FILES) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    const unsafe = inspectGuardedBuffer(buf);
    if (unsafe) {
      snap[file] = { unsafe, rawBuf: buf };
      continue;
    }
    const raw = buf.toString("utf8");
    snap[file] = { raw, user: extractUserMarkdown(raw) };
  }
  return snap;
}

export function remergeGuardedRoots(root, snap) {
  for (const file of GUARDED_ROOT_FILES) {
    const p = path.join(root, file);
    const rec = snap[file];
    if (rec?.unsafe) {
      fs.writeFileSync(p, rec.rawBuf);
      continue;
    }
    if (!fs.existsSync(p)) {
      if (rec?.raw != null) fs.writeFileSync(p, rec.raw);
      continue;
    }
    const buf = fs.readFileSync(p);
    if (inspectGuardedBuffer(buf)) {
      if (rec?.raw != null) fs.writeFileSync(p, rec.raw);
      continue;
    }
    const current = buf.toString("utf8");
    if (rec && current === rec.raw) continue;
    const gruntBody = extractGruntBody(current) ?? current;
    const nl = detectNewline((rec && rec.raw) || current);
    let user = rec ? rec.user : extractUserMarkdown(current);
    if (rec && !rec.raw.includes(SENTINEL_BEGIN) && normEq(rec.raw, gruntBody)) user = "";
    if (!rec && extractGruntBody(current) == null && normEq(current, gruntBody)) user = "";
    fs.writeFileSync(p, composeGuardedMarkdown(gruntBody, user, nl));
  }
}

export function healGuardedRootFile(root, file, snap) {
  if (!GUARDED_ROOT_FILES.includes(file)) return;
  const p = path.join(root, file);
  const rec = snap[file];
  if (!fs.existsSync(p)) return;
  if (rec?.unsafe) {
    fs.writeFileSync(p, rec.rawBuf);
    return;
  }
  const buf = fs.readFileSync(p);
  if (inspectGuardedBuffer(buf)) {
    if (rec?.raw != null) fs.writeFileSync(p, rec.raw);
    return;
  }
  const current = buf.toString("utf8");
  const interior = extractGruntBody(current);
  if (interior != null) {
    snap[file] = { raw: current, user: extractUserMarkdown(current) };
    return;
  }
  if (rec && current === rec.raw) return;
  const gruntBody = current;
  const nl = detectNewline((rec && rec.raw) || current);
  let user = rec ? rec.user : extractUserMarkdown(current);
  if (rec && !rec.raw.includes(SENTINEL_BEGIN) && normEq(rec.raw, gruntBody)) user = "";
  if (!rec && normEq(current, gruntBody)) user = "";
  const out = composeGuardedMarkdown(gruntBody, user, nl);
  fs.writeFileSync(p, out);
  snap[file] = { raw: out, user };
}

export function withGuardedCheckInteriors(root, fn) {
  const snap = snapshotGuardedRoots(root);
  try {
    for (const file of GUARDED_ROOT_FILES) {
      const rec = snap[file];
      if (!rec || rec.unsafe) continue;
      const body = extractGruntBody(rec.raw);
      if (body == null) continue;
      const nl = detectNewline(rec.raw);
      fs.writeFileSync(path.join(root, file), `${toNewline(trimTrailingNewlines(body), nl)}${nl}`);
    }
    return fn();
  } finally {
    for (const file of GUARDED_ROOT_FILES) {
      const rec = snap[file];
      if (!rec) continue;
      if (rec.unsafe) fs.writeFileSync(path.join(root, file), rec.rawBuf);
      else fs.writeFileSync(path.join(root, file), rec.raw);
    }
  }
}
