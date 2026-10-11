#!/usr/bin/env node
/** Workspace vs packaged grunt skill content conflicts (warn-only). */
import fs from "node:fs";
import path from "node:path";

export const WORKSPACE_SKILLS_REL = ".rulesync/skills";
export const PACKAGED_SKILLS_REL = path.join(
  "node_modules",
  "@lovrozagar",
  "grunt",
  ".rulesync",
  "skills",
);

export function listSkillDirNames(skillsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const skillMd = path.join(skillsRoot, ent.name, "SKILL.md");
    try {
      if (!fs.statSync(skillMd).isFile()) continue;
    } catch {
      continue;
    }
    out.push(ent.name);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function readSkillMd(skillsRoot, name) {
  const abs = path.join(skillsRoot, name, "SKILL.md");
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

/** Names in both trees whose SKILL.md bytes differ. */
export function findSkillContentConflicts({ workspaceSkillsDir, packagedSkillsDir } = {}) {
  if (!workspaceSkillsDir || !packagedSkillsDir) return [];
  const packaged = listSkillDirNames(packagedSkillsDir);
  if (!packaged.length) return [];
  const conflicts = [];
  for (const name of packaged) {
    const ws = readSkillMd(workspaceSkillsDir, name);
    if (ws == null) continue;
    const pkg = readSkillMd(packagedSkillsDir, name);
    if (pkg == null) continue;
    if (Buffer.compare(ws, pkg) !== 0) {
      conflicts.push({
        name,
        workspacePath: path.join(workspaceSkillsDir, name, "SKILL.md"),
        packagedPath: path.join(packagedSkillsDir, name, "SKILL.md"),
      });
    }
  }
  return conflicts;
}

export function formatSkillConflictWarn(name) {
  return `skill \`${name}\` differs from packaged grunt; re-init overwrites`;
}
