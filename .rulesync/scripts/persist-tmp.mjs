#!/usr/bin/env node
/** Allocate/slugify/write a one-off convo artifact under .tmp/grunt/. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DATETIME_RE,
  compactCreatedStamp,
  ensureGitignore,
  slugify,
  utcDateTime,
} from "./persist-plan.mjs";

export const TMP_DIR = ".tmp/grunt";
/** `{serial}-{slug}-{YYYYMMDDTHHMMSSZ}.{ext}`; stamp required. */
export const FILENAME_RE =
  /^[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*-\d{8}T\d{6}Z\.[a-z0-9]+$/;
export const FILENAME_STAMP_RE = /-\d{8}T\d{6}Z$/;
const META_LINE_RE = /^\s*TMP_(NAME|EXT):\s*.+\s*$/;
const NAME_RE = /^\s*TMP_NAME:\s*(.+?)\s*$/m;
const EXT_RE = /^\s*TMP_EXT:\s*(.+?)\s*$/m;

export function extractTmpName(content) {
  const m = String(content).match(NAME_RE);
  return m ? m[1].trim() : "";
}

export function extractTmpExt(content) {
  const m = String(content).match(EXT_RE);
  return m ? m[1].trim() : "";
}

export function stripTmpMeta(content) {
  return String(content)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => !META_LINE_RE.test(line))
    .join("\n");
}

export function normalizeTmpExt(raw) {
  let e = String(raw || "")
    .trim()
    .toLowerCase();
  if (e.startsWith(".")) e = e.slice(1);
  if (!/^[a-z0-9]+$/.test(e) || e.length > 16) return "";
  return e;
}

function nextTmpSerial(dir) {
  let next = 1;
  if (!fs.existsSync(dir)) return next;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const m = ent.name.match(/^([0-9]+)-/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= next) next = n + 1;
  }
  return next;
}

export function persistTmp({ workspaceRoot, content, created } = {}) {
  const ws = workspaceRoot || process.cwd();
  const raw = String(content || "");
  if (raw.includes("\0")) return { ok: false, error: "binary" };
  const name = extractTmpName(raw);
  if (!name) return { ok: false, error: "missing TMP_NAME" };
  const extRaw = extractTmpExt(raw);
  const ext = extRaw ? normalizeTmpExt(extRaw) : "md";
  if (!ext) return { ok: false, error: "ext" };
  const slug = slugify(name);
  const body = stripTmpMeta(raw);
  const dir = path.join(ws, TMP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const createdAt = created && DATETIME_RE.test(created) ? created : utcDateTime();
  const stamp = compactCreatedStamp(createdAt);
  let serial = nextTmpSerial(dir);
  let filename = `${serial}-${slug}-${stamp}.${ext}`;
  let dest = path.join(dir, filename);
  let tries = 0;
  while (fs.existsSync(dest) && tries < 5) {
    serial += 1;
    filename = `${serial}-${slug}-${stamp}.${ext}`;
    dest = path.join(dir, filename);
    tries += 1;
  }
  if (fs.existsSync(dest)) return { ok: false, error: "serial collision" };
  if (!FILENAME_RE.test(filename)) return { ok: false, error: "filename" };
  ensureGitignore(ws);
  fs.writeFileSync(dest, body);
  return { ok: true, path: dest, serial, slug, ext, content: body, filename };
}

function main() {
  try {
    const wsIdx = process.argv.indexOf("--workspace");
    const workspaceRoot = wsIdx >= 0 ? process.argv[wsIdx + 1] : process.cwd();
    const content = fs.readFileSync(0, "utf8");
    const result = persistTmp({ workspaceRoot, content });
    if (!result.ok) {
      process.stderr.write((result.error || "invalid tmp") + "\n");
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
