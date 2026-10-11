#!/usr/bin/env node
/** Snapshot/remerge AGENTS.md CLAUDE.md GEMINI.md around generate/check/watch. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  GUARDED_ROOT_FILES,
  healGuardedRootFile,
  remergeGuardedRoots,
  snapshotGuardedRoots,
  withGuardedCheckInteriors,
} from "./guarded-md.mjs";
import { runPipeline } from "./pipeline.mjs";

export function attachGuardedRootWatchers(cwd, heal) {
  const w = fs.watch(cwd, (_event, filename) => {
    if (!filename) return;
    const base = path.basename(String(filename));
    if (!GUARDED_ROOT_FILES.includes(base)) return;
    heal(base);
  });
  return () => {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  };
}

export function runGuardedRoots(mode, { cwd = process.cwd(), exec = execSync, attachWatchers } = {}) {
  if (mode === "generate") {
    const snap = snapshotGuardedRoots(cwd);
    try {
      runPipeline("generate", { cwd, exec });
    } finally {
      remergeGuardedRoots(cwd, snap);
    }
    return;
  }
  if (mode === "check") {
    withGuardedCheckInteriors(cwd, () => {
      runPipeline("check", { cwd, exec });
    });
    return;
  }
  if (mode === "watch") {
    const snap = snapshotGuardedRoots(cwd);
    const heal = (file) => healGuardedRootFile(cwd, file, snap);
    const attach = attachWatchers || ((opts) => attachGuardedRootWatchers(opts.cwd, opts.heal));
    const stop = attach({ cwd, snap, heal });
    try {
      runPipeline("watch", { cwd, exec });
    } finally {
      try {
        stop?.();
      } catch {
        /* ignore */
      }
      remergeGuardedRoots(cwd, snap);
    }
    return;
  }
  throw new Error("usage: guarded-roots.mjs generate|check|watch");
}

function main() {
  try {
    runGuardedRoots(process.argv[2] || "");
    return 0;
  } catch (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    return 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile) process.exit(main());
