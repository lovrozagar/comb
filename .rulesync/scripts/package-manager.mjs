/** Detect npm | yarn | pnpm | bun. Never default to npm. */
import fs from "node:fs";
import path from "node:path";

export const PACKAGE_MANAGERS = ["npm", "yarn", "pnpm", "bun"];

export const UNKNOWN_PACKAGE_MANAGER =
  'Cannot tell which package manager to use (npm, yarn, pnpm, bun). Add a lockfile or package.json "packageManager" field, or pass --pm <name>.';

export const PACKAGE_MANAGER_ASK = "Which package manager?";

export const PACKAGE_MANAGER_OPTIONS = PACKAGE_MANAGERS.map((value) => ({
  value,
  label: value,
}));

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function readJson(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

export function isPackageManager(name) {
  return PACKAGE_MANAGERS.includes(String(name || "").toLowerCase());
}

export function parsePackageManagerField(raw) {
  if (raw && typeof raw === "object" && typeof raw.name === "string") {
    raw = raw.name;
  }
  if (typeof raw !== "string") return null;
  const name = raw.trim().split("@")[0].toLowerCase();
  return isPackageManager(name) ? name : null;
}

function fieldFromPkg(pkg) {
  if (!pkg || typeof pkg !== "object") return null;
  const fromField = parsePackageManagerField(pkg.packageManager);
  if (fromField) return fromField;
  return parsePackageManagerField(pkg.devEngines?.packageManager);
}

export function detectFromRepo(cwd) {
  const lockfiles = [];
  const managers = [];
  const seen = new Set();
  const add = (name, lock) => {
    if (!isPackageManager(name)) return;
    if (lock) lockfiles.push(lock);
    if (seen.has(name)) return;
    seen.add(name);
    managers.push(name);
  };
  const pkg = readJson(path.join(cwd || "", "package.json"));
  const fromField = fieldFromPkg(pkg);
  if (fromField) add(fromField, null);
  for (const [file, name] of LOCKFILES) {
    if (isFile(path.join(cwd || "", file))) add(name, file);
  }
  return { managers, lockfiles };
}

export function detectFromInvocation(env = process.env, { versions = process.versions } = {}) {
  const ua = String(env?.npm_config_user_agent || "").trim();
  if (ua) {
    const first = ua.split(/[\s/]/)[0].toLowerCase();
    if (isPackageManager(first)) return first;
  }
  const execPath = String(env?.npm_execpath || "").replace(/\\/g, "/");
  const base = execPath.split("/").pop() || "";
  const lower = base.toLowerCase();
  for (const pm of PACKAGE_MANAGERS) {
    if (lower === pm || lower.startsWith(`${pm}.`) || lower.startsWith(`${pm}-`)) return pm;
  }
  if (versions && versions.bun) return "bun";
  return null;
}

export function detectPackageManager({
  cwd = "",
  env = process.env,
  override,
  versions = process.versions,
} = {}) {
  if (override != null && override !== "") {
    const name = String(override).toLowerCase();
    if (!isPackageManager(name)) {
      return { manager: null, source: null, error: "invalid", override: name };
    }
    return { manager: name, source: "flag" };
  }
  const repo = detectFromRepo(cwd);
  if (repo.managers.length === 1) {
    return { manager: repo.managers[0], source: "repo", lockfiles: repo.lockfiles };
  }
  const invoked = detectFromInvocation(env, { versions });
  if (invoked) {
    if (repo.managers.length === 0) {
      return { manager: invoked, source: "invocation", lockfiles: repo.lockfiles };
    }
    if (repo.managers.includes(invoked)) {
      return {
        manager: invoked,
        source: "invocation",
        candidates: repo.managers,
        lockfiles: repo.lockfiles,
      };
    }
  }
  return {
    manager: null,
    source: null,
    candidates: repo.managers,
    lockfiles: repo.lockfiles,
  };
}

export function installArgs(_pm) {
  return ["install"];
}

/** Add `spec` as a devDependency. pnpm needs `-w` at a workspace root. */
export function addDevArgs(pm, spec, { cwd = "" } = {}) {
  if (pm === "npm") return ["install", "-D", spec];
  if (pm === "pnpm" && isFile(path.join(cwd, "pnpm-workspace.yaml"))) {
    return ["add", "-D", "-w", spec];
  }
  return ["add", "-D", spec];
}

export function runScriptArgs(pm, script, extra = []) {
  if (!extra.length) return ["run", script];
  if (pm === "npm") return ["run", script, "--", ...extra];
  return ["run", script, ...extra];
}

export function runScriptLine(pm, script) {
  if (pm) return `${pm} run ${script}`;
  return `npm|yarn|pnpm|bun run ${script}`;
}
