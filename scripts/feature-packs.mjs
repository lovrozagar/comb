/** Optional installer packs. The npm package still ships them. Init writes only the selected ones. */
import fs from "node:fs";
import path from "node:path";

export const FEATURES_REL = ".rulesync/grunt.features.jsonc";

export const OPTIONAL_PACKS = [
  { name: "google-workspace", skill: "google-workspace", ref: "google-workspace.md", script: "google-workspace.mjs" },
  { name: "listen", skill: "listen", ref: "listen.md", script: "listen.mjs" },
  { name: "speak", skill: "speak", ref: "speak.md", script: "speak.mjs" },
  { name: "clasp", skill: "clasp", ref: "clasp.md", script: "" },
];

export const PACK_OPTIONS = OPTIONAL_PACKS.map((pack) => ({ value: pack.name, label: pack.name }));

const SKILL_DIRS = [".rulesync/skills", ".grok/skills", ".claude/skills", ".agents/skills"];

function partsOf(rel) {
  return String(rel || "").split(/[/\\]/).filter((part) => part && part !== ".");
}

function knownSet() {
  return new Set(OPTIONAL_PACKS.map((pack) => pack.name));
}

function inTableOrder(names) {
  const on = new Set(names);
  return OPTIONAL_PACKS.map((pack) => pack.name).filter((name) => on.has(name));
}

export function normalizePacks(list) {
  const known = knownSet();
  const seen = [];
  for (const raw of list || []) {
    const name = String(raw || "").trim();
    if (!name || seen.includes(name)) continue;
    if (!known.has(name)) throw new Error(`unknown pack ${name}`);
    seen.push(name);
  }
  return inTableOrder(seen);
}

export function parsePacksFlag(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "none") return [];
  return normalizePacks(text.split(","));
}

function stripJsonc(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** null when the file is missing. Bad JSON or an empty list is `{ packs: [] }`. */
export function readPacks(dest) {
  const abs = path.join(dest, FEATURES_REL);
  if (!fs.existsSync(abs)) return null;
  try {
    const data = JSON.parse(stripJsonc(fs.readFileSync(abs, "utf8")));
    const raw = Array.isArray(data?.packs) ? data.packs : [];
    const known = knownSet();
    return { packs: inTableOrder(raw.map((name) => String(name).trim()).filter((name) => known.has(name))) };
  } catch {
    return { packs: [] };
  }
}

export function selectedPacks(dest) {
  const saved = readPacks(dest);
  return saved ? saved.packs : [];
}

export function writePacks(dest, packs) {
  const selected = normalizePacks(packs);
  const abs = path.join(dest, FEATURES_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify({ packs: selected }, null, 2)}\n`);
}

/** An array, including `[]`, is an answer. Otherwise use the saved file, or nothing. */
export function resolvePackSelection(dest, packs) {
  if (Array.isArray(packs)) return { packs: normalizePacks(packs), answered: true };
  const saved = readPacks(dest);
  if (saved) return { packs: saved.packs, answered: false };
  return { packs: [], answered: false };
}

export function isUnselectedPackPath(rel, selected) {
  const on = selected instanceof Set ? selected : new Set(selected || []);
  const parts = partsOf(rel);
  if (parts.length >= 3 && parts[1] === "skills") {
    const pack = OPTIONAL_PACKS.find((item) => item.skill === parts[2]);
    if (pack && !on.has(pack.name)) return true;
  }
  if (parts[0] === ".rulesync" && parts[1] === "reference" && parts.length >= 3) {
    const pack = OPTIONAL_PACKS.find((item) => item.ref === parts[2]);
    if (pack && !on.has(pack.name)) return true;
  }
  return false;
}

export function unselectedPackRels(selected) {
  const on = selected instanceof Set ? selected : new Set(selected || []);
  const rels = [];
  for (const pack of OPTIONAL_PACKS) {
    if (on.has(pack.name)) continue;
    for (const dir of SKILL_DIRS) rels.push(`${dir}/${pack.skill}`);
    if (pack.ref) rels.push(`.rulesync/reference/${pack.ref}`);
    if (pack.script) rels.push(`scripts/${pack.script}`);
  }
  return rels;
}

export function unselectedRefNames(selected) {
  const on = selected instanceof Set ? selected : new Set(selected || []);
  return new Set(OPTIONAL_PACKS.filter((pack) => pack.ref && !on.has(pack.name)).map((pack) => pack.ref));
}

export function unselectedScriptNames(selected) {
  const on = selected instanceof Set ? selected : new Set(selected || []);
  return new Set(OPTIONAL_PACKS.filter((pack) => pack.script && !on.has(pack.name)).map((pack) => pack.script));
}
