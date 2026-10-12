#!/usr/bin/env node
/** Extract/validate a JSON `need:` array. Fail → stderr + exit 1. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NEED_JOBS = new Set(["search", "exec", "web", "test", "slice", "fetch"]);

export function parseNeed(text) {
  const s = String(text ?? "");
  const m = s.match(/^\s*need:\s*(\[[\s\S]*\])\s*$/m);
  if (!m) {
    return { ok: false, error: "no json need array" };
  }
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!Array.isArray(parsed) || parsed.length < 1) {
    return { ok: false, error: "need array empty" };
  }
  const jobs = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "invalid job item" };
    }
    const job = String(item.job ?? "").trim();
    const query = String(item.query ?? "").trim();
    const stash = item.stash != null ? String(item.stash).trim() : "";
    if (!NEED_JOBS.has(job)) {
      return { ok: false, error: "invalid job or query" };
    }
    if (job === "slice") {
      if (!stash && !query) {
        return { ok: false, error: "invalid job or query" };
      }
    } else if (!query) {
      return { ok: false, error: "invalid job or query" };
    }
    const row = { job, query };
    if (job === "slice" && stash) row.stash = stash;
    else if (stash) row.stash = stash;
    if (item.path != null && String(item.path).trim()) {
      row.path = String(item.path).trim();
    }
    if (item.cwd != null && String(item.cwd).trim()) {
      row.cwd = String(item.cwd).trim();
    }
    if (item.glob != null && item.glob !== "") {
      row.glob = Array.isArray(item.glob)
        ? item.glob.map((g) => String(g))
        : [String(item.glob)];
    }
    if (item.from != null && String(item.from).trim()) {
      row.from = String(item.from).trim();
    }
    if (item.to != null && String(item.to).trim()) {
      row.to = String(item.to).trim();
    }
    if (job === "slice" && !row.stash && query) {
      row.stash = query;
    }
    jobs.push(row);
  }
  return { ok: true, jobs };
}

function main() {
  try {
    const arg = process.argv[2];
    const text =
      arg && arg !== "-"
        ? fs.readFileSync(arg, "utf8")
        : fs.readFileSync(0, "utf8");
    const result = parseNeed(text);
    if (!result.ok) {
      process.stderr.write(result.error + "\n");
      return 1;
    }
    process.stdout.write(JSON.stringify(result.jobs) + "\n");
    return 0;
  } catch {
    process.stderr.write("parse-need failed\n");
    return 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
