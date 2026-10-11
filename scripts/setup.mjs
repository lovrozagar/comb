#!/usr/bin/env node
/** Handheld machine setup for optional grunt integrations. Secrets stay in ~/.grunt/. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isInteractive as ttyInteractive } from "./interactive.mjs";
import { selectedPacks } from "./feature-packs.mjs";
import {
  CHROMIUM_BINS,
  installHints,
  jevDoctorStatus,
  speakDoctorStatus,
  whichBin,
  workspaceDoctorStatus,
} from "./doctor.mjs";

export const TARGETS = ["speak", "listen", "google-workspace", "browser", "jev"];
export const USAGE = `usage: setup [speak|listen|google-workspace|browser|jev]
  speak            --elevenlabs-key KEY | --openai-key KEY [--provider elevenlabs|openai] [--skip-verify]
  listen           [--openai-key KEY] [--device ID] [--skip-download]
  google-workspace [--creds PATH] [--account NAME] [--project ID]
  browser          (engine install hints; no secrets)
  jev              --api-key KEY
  --redo           redo a target that is already ok

TTY menu shows ok/missing. Missing bins: print OS command, then re-check PATH. Never installs.
Already ok: confirm redo (TTY) unless --redo. Ends with one status line per target (not a README).
Secrets: ~/.grunt/ (not git). Env still wins over the file. Setup does not export keys.
`;

export const ELEVENLABS_KEY_URL = "https://elevenlabs.io/app/settings/api-keys";
export const OPENAI_KEY_URL = "https://platform.openai.com/api-keys";

export function parseArgv(argv) {
  const out = { _: [], flags: {} };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (typeof a === "string" && a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const nxt = args[i + 1];
      if (nxt && !String(nxt).startsWith("--")) {
        out.flags[key] = nxt;
        i += 1;
      } else out.flags[key] = "1";
    } else out._.push(a);
  }
  return out;
}

export function normalizeTarget(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "gw" || s === "google" || s === "workspace" || s === "google-workspace") {
    return "google-workspace";
  }
  if (TARGETS.includes(s)) return s;
  return "";
}

function str(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

export function gruntHome(home = os.homedir()) {
  const d = path.join(home, ".grunt");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(d, 0o700);
  } catch {
    /* win */
  }
  return d;
}

export function writeSecretJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* win */
  }
  return p;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function speakJsonPath(home) {
  return path.join(home, ".grunt", "speak.json");
}

export function mergeSpeakJson(home, patch) {
  gruntHome(home);
  const p = speakJsonPath(home);
  const cur = readJson(p);
  const next = { ...cur, ...patch };
  if (patch && patch.elevenlabs) {
    next.elevenlabs = { ...(cur.elevenlabs || {}), ...patch.elevenlabs };
  }
  if (patch && patch.openai) {
    next.openai = { ...(cur.openai || {}), ...patch.openai };
  }
  if (patch && patch.listen) {
    next.listen = { ...(cur.listen || {}), ...patch.listen };
  }
  writeSecretJson(p, next);
  return p;
}

export function parseDesktopOAuth(raw) {
  const j = typeof raw === "string" ? JSON.parse(raw) : raw;
  const inst = j && (j.installed || j.web);
  if (!inst || !inst.client_id) {
    throw new Error("OAuth JSON needs installed.client_id (Desktop app download)");
  }
  if (!j.installed) {
    throw new Error("OAuth JSON must be a Desktop client (installed), not a Web client");
  }
  return j;
}

export function loadOAuthInput(s) {
  const t = String(s || "").trim();
  if (!t) throw new Error("OAuth JSON path or JSON body required");
  if (t.startsWith("{")) return parseDesktopOAuth(t);
  if (!fs.existsSync(t) || !fs.statSync(t).isFile()) {
    throw new Error(`OAuth JSON not found: ${t}`);
  }
  return parseDesktopOAuth(fs.readFileSync(t, "utf8"));
}

export function installOAuthJson({ src, dest }) {
  const j = loadOAuthInput(src);
  writeSecretJson(dest, j);
  return dest;
}

export function findDownloadedOAuthJson(home) {
  const dirs = [path.join(home, "Downloads"), path.join(home, "downloads")];
  const hits = [];
  for (const dir of dirs) {
    let ents;
    try {
      ents = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of ents) {
      if (!/client_secret.*\.json$/i.test(name) && name.toLowerCase() !== "google-oauth.json") {
        continue;
      }
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) hits.push({ p, m: st.mtimeMs });
      } catch {
        /* skip */
      }
    }
  }
  hits.sort((a, b) => b.m - a.m);
  return hits[0] ? hits[0].p : "";
}

export function workspaceConsoleUrls(projectId) {
  const p = str(projectId);
  const enc = encodeURIComponent(p);
  return {
    projectCreate: "https://console.cloud.google.com/projectcreate",
    branding: p
      ? `https://console.cloud.google.com/auth/overview/create?project=${enc}`
      : "https://console.cloud.google.com/auth/overview/create",
    enableApis: p
      ? `https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com,gmail.googleapis.com,sheets.googleapis.com,docs.googleapis.com,drive.googleapis.com&project=${enc}`
      : "https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com,gmail.googleapis.com,sheets.googleapis.com,docs.googleapis.com,drive.googleapis.com",
    clientCreate: p
      ? `https://console.cloud.google.com/auth/clients/create?project=${enc}`
      : "https://console.cloud.google.com/auth/clients/create",
  };
}

export async function openUrl(
  url,
  { platform = process.platform, spawnSyncFn, openUrlFn } = {},
) {
  if (typeof openUrlFn === "function") {
    openUrlFn(url);
    return;
  }
  const { openUrl: openWorkspaceUrl } = await import("./google-workspace.mjs");
  openWorkspaceUrl(url, { platform, spawnSyncFn });
}

function flagOn(flags, key) {
  const v = flags && flags[key];
  return v === "1" || v === true || v === "true";
}

export function lookupChromium(whichFn = whichBin, pathEnv = process.env.PATH, platform = process.platform) {
  for (const n of CHROMIUM_BINS) {
    const hit = whichFn(n, pathEnv, platform);
    if (hit) return hit;
  }
  return "";
}

export function browserEngineStatus(lp, cr, platform = process.platform) {
  const have = [lp && "lightpanda", cr && "chromium"].filter(Boolean);
  if (lp && cr) return { ok: true, extra: have.join(",") };
  if (platform === "win32" && cr) {
    return { ok: true, extra: have.concat(["need lightpanda in WSL"]).join(",") };
  }
  const need = [];
  if (!lp) need.push("need lightpanda");
  if (!cr) need.push("need chromium");
  return { ok: false, extra: have.concat(need).join(",") };
}

export function setupTargets(packs = []) {
  const on = new Set(packs);
  return TARGETS.filter((target) => target === "browser" || target === "jev" || on.has(target));
}

export async function targetStatuses({
  home = os.homedir(),
  env = process.env,
  whichFn = whichBin,
  pathEnv,
  platform = process.platform,
  targets = TARGETS,
} = {}) {
  const pEnv = pathEnv || env.PATH || process.env.PATH;
  const speak = speakDoctorStatus({ env, home });
  const jev = jevDoctorStatus({ env, home });
  const ws = workspaceDoctorStatus({ home });
  const lp = whichFn("lightpanda", pEnv, platform);
  const cr = lookupChromium(whichFn, pEnv, platform);
  let listen = { ok: false, extra: "" };
  if (targets.includes("listen")) {
    const { loadCfg, probeStt, findWhisperBin } = await import("./listen.mjs");
    const cfg = loadCfg({ env, home });
    const stt = probeStt({ cfg, whichFn, pathEnv: pEnv, platform, home, cwd: "" });
    const ffmpeg = whichFn("ffmpeg", pEnv, platform);
    const whisper = findWhisperBin(whichFn, pEnv, platform);
    const listenBits = [stt && stt.kind, ffmpeg && "ffmpeg", whisper && "whisper"].filter(Boolean);
    listen = { ok: Boolean(stt), extra: listenBits.join(",") };
  }
  return {
    speak: { ok: speak.ok, extra: speak.extra },
    jev: { ok: jev.ok, extra: jev.extra },
    listen,
    "google-workspace": { ok: ws.ok, extra: ws.extra },
    browser: browserEngineStatus(lp, cr, platform),
  };
}

export function formatStatus(statuses, targets = TARGETS) {
  return targets.map((t) => {
    const st = (statuses && statuses[t]) || { ok: false, extra: "" };
    const b = st.ok ? "ok" : "missing";
    return st.extra ? `${t}  ${b}  ${st.extra}` : `${t}  ${b}`;
  }).join("\n");
}

export function menuOptions(statuses, targets = TARGETS) {
  const base = [
    { value: "speak", label: "speak (ElevenLabs / OpenAI TTS)" },
    { value: "listen", label: "listen (STT)" },
    { value: "google-workspace", label: "google-workspace" },
    { value: "browser", label: "browser (PATH engines)" },
    { value: "jev", label: "jev (TypeSafe research decision)" },
  ].filter((o) => targets.includes(o.value));
  return base.map((o) => {
    const st = (statuses && statuses[o.value]) || { ok: false, extra: "" };
    const tag = st.ok
      ? st.extra
        ? `ok ${st.extra}`
        : "ok"
      : st.extra
        ? `missing ${st.extra}`
        : "missing";
    return { value: o.value, label: `${o.label}  ${tag}` };
  });
}

export function firstMissing(statuses, targets = TARGETS) {
  for (const t of targets) {
    if (!statuses || !statuses[t] || !statuses[t].ok) return t;
  }
  return targets[0] || "browser";
}

export async function reprobeHint({
  id,
  found,
  probe,
  platform = process.platform,
  io,
  interactive = false,
} = {}) {
  let hit = found;
  if (hit) {
    logLine(io, `${id} ok  ${hit}`);
    return hit;
  }
  logLine(io, `${id} missing. print-only; not installed:`);
  for (const h of installHints(id, platform)) logLine(io, h);
  if (interactive && io && typeof io.confirm === "function") {
    const again = await io.confirm({
      message: `Installed ${id}? Re-check PATH`,
      initialValue: false,
    });
    if (again) {
      hit = typeof probe === "function" ? probe() : "";
      if (hit) logLine(io, `${id} ok  ${hit}`);
      else logLine(io, `${id} still missing`);
    }
  }
  return hit;
}

function logLine(io, s) {
  if (io && typeof io.log === "function") io.log(s);
  else process.stdout.write(`${s}\n`);
}

function errLine(io, s) {
  if (io && typeof io.error === "function") io.error(s);
  else process.stderr.write(`${s}\n`);
}

async function defaultIo() {
  const { confirm, password, select, text } = await import("./prompt.mjs");
  return {
    confirm,
    password,
    select,
    text,
    log: (s) => process.stdout.write(`${s}\n`),
    error: (s) => process.stderr.write(`${s}\n`),
  };
}

export function oauthWritePath(home, account) {
  const id = str(account, "default");
  if (id !== "default") {
    return path.join(home, ".grunt", "workspace", id, "google-oauth.json");
  }
  const nested = path.join(home, ".grunt", "workspace", "default", "google-oauth.json");
  if (fs.existsSync(nested)) return nested;
  return path.join(home, ".grunt", "google-oauth.json");
}

export async function setupSpeak({
  flags = {},
  home = os.homedir(),
  io,
  fetchFn,
  openUrlFn,
  platform = process.platform,
  spawnSyncFn,
  interactive = false,
} = {}) {
  const { loadCfg: loadSpeakCfg, whoami: speakWhoami } = await import("./speak.mjs");
  let elevenKey = str(flags["elevenlabs-key"] || flags.elevenlabs);
  let openaiKey = str(flags["openai-key"] || flags.openai);
  let provider = str(flags.provider).toLowerCase();
  const skipVerify = flagOn(flags, "skip-verify");

  if (interactive && io && !elevenKey && !openaiKey) {
    provider = str(
      await io.select({
        message: "Speak provider",
        options: [
          { value: "elevenlabs", label: "ElevenLabs" },
          { value: "openai", label: "OpenAI" },
          { value: "both", label: "both" },
        ],
        initialValue: provider === "openai" ? "openai" : "elevenlabs",
      }),
    );
  }

  const askEleven = provider === "elevenlabs" || provider === "both" || (!provider && !openaiKey);
  const askOpenAi = provider === "openai" || provider === "both";

  if (interactive && io) {
    if (askEleven && !elevenKey) {
      logLine(io, `Open: ${ELEVENLABS_KEY_URL}`);
      await openUrl(ELEVENLABS_KEY_URL, { platform, spawnSyncFn, openUrlFn });
      elevenKey = str(await io.password({ message: "ElevenLabs API key" }));
    }
    if (askOpenAi && !openaiKey) {
      logLine(io, `Open: ${OPENAI_KEY_URL}`);
      await openUrl(OPENAI_KEY_URL, { platform, spawnSyncFn, openUrlFn });
      openaiKey = str(await io.password({ message: "OpenAI API key" }));
    }
  }

  if (provider === "openai") elevenKey = str(flags["elevenlabs-key"] || flags.elevenlabs);
  if (provider === "elevenlabs") openaiKey = str(flags["openai-key"] || flags.openai);

  const patch = {};
  if (provider && provider !== "both") patch.provider = provider;
  if (elevenKey) patch.elevenlabs = { apiKey: elevenKey };
  if (openaiKey) patch.openai = { apiKey: openaiKey };

  if (!patch.elevenlabs && !patch.openai) {
    throw new Error(
      interactive
        ? "need an ElevenLabs or OpenAI key"
        : "need --elevenlabs-key or --openai-key (or TTY: node scripts/setup.mjs speak)",
    );
  }

  const dest = mergeSpeakJson(home, patch);
  logLine(io, `wrote ${dest}`);

  if (skipVerify) return { ok: true, dest, verified: false };

  const cfg = loadSpeakCfg({ env: {}, home });
  const who = await speakWhoami({
    provider: provider === "both" || !provider ? undefined : provider,
    cfg,
    fetchFn,
  });
  logLine(io, who);
  return { ok: true, dest, verified: true, who };
}

export async function setupListen({
  flags = {},
  env = process.env,
  home = os.homedir(),
  io,
  fetchFn,
  openUrlFn,
  platform = process.platform,
  spawnSyncFn,
  whichFn = whichBin,
  pathEnv = process.env.PATH,
  interactive = false,
} = {}) {
  const { downloadGgml, findWhisperBin, loadCfg: loadListenCfg, probeStt } = await import("./listen.mjs");
  const ffmpegBin = await reprobeHint({
    id: "ffmpeg",
    found: whichFn("ffmpeg", pathEnv, platform),
    probe: () => whichFn("ffmpeg", pathEnv, platform),
    platform,
    io,
    interactive,
  });
  const whisperBin = await reprobeHint({
    id: "whisper-cli",
    found: findWhisperBin(whichFn, pathEnv, platform),
    probe: () => findWhisperBin(whichFn, pathEnv, platform),
    platform,
    io,
    interactive,
  });

  const skipDownload = flagOn(flags, "skip-download");
  if (whisperBin && !skipDownload) {
    let go = true;
    if (interactive && io && typeof io.confirm === "function") {
      go = await io.confirm({
        message: "Download ggml-base.en.bin (~142MB) into ~/.grunt/whisper/?",
        initialValue: true,
      });
    }
    if (go) {
      const model = await downloadGgml({ home, fetchFn, log: { error: (s) => logLine(io, s) } });
      logLine(io, `model ${model}`);
    }
  }

  const openai = str(flags["openai-key"] || flags.openai);
  let openaiKey = openai;
  const cfgNow = loadListenCfg({ env, home });
  if (!whisperBin && !cfgNow.apiKey && !openaiKey) {
    if (interactive && io) {
      logLine(io, `Local STT is unavailable. OpenAI Whisper fallback: ${OPENAI_KEY_URL}`);
      await openUrl(OPENAI_KEY_URL, { platform, spawnSyncFn, openUrlFn });
      openaiKey = str(await io.password({ message: "OpenAI API key (fallback STT)" }));
    } else {
      throw new Error(
        "need whisper-cli or --openai-key (or TTY: node scripts/setup.mjs listen)",
      );
    }
  }

  const patch = {};
  if (openaiKey) patch.openai = { apiKey: openaiKey };
  const device = str(flags.device);
  if (device) patch.listen = { device };
  if (interactive && io && ffmpegBin && !device && typeof io.text === "function") {
    const d = str(
      await io.text({
        message: "Mic device id (blank = default; Windows needs an id from listen devices)",
        defaultValue: "",
      }),
    );
    if (d) patch.listen = { ...(patch.listen || {}), device: d };
  }
  if (Object.keys(patch).length) {
    const dest = mergeSpeakJson(home, patch);
    logLine(io, `wrote ${dest}`);
  }

  const cfg = loadListenCfg({ env: {}, home });
  const stt = probeStt({ cfg, whichFn, pathEnv, platform, home, cwd: "" });
  if (stt && stt.kind === "local") {
    logLine(io, `stt=local  bin=${stt.bin}  model=${stt.model}`);
  } else if (stt && stt.kind === "openai") {
    logLine(io, `stt=openai  model=${stt.model}`);
  } else {
    logLine(io, "stt=none");
  }
  return { ok: true, stt };
}

export async function setupGoogleWorkspace({
  flags = {},
  home = os.homedir(),
  io,
  openUrlFn,
  platform = process.platform,
  spawnSyncFn,
  interactive = false,
  loginFn,
} = {}) {
  const { loginLoopback, setAccount, tokenStorePath } = await import("./google-workspace.mjs");
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const account = str(flags.account, "default");
    setAccount(account);
    gruntHome(home);
    const dest = oauthWritePath(home, account);
    const credsFlag = str(flags.creds || flags.json);
    let projectId = str(flags.project);

    if (!credsFlag && interactive && io) {
      const urls0 = workspaceConsoleUrls(projectId);
      logLine(io, "Each person uses their own GCP Desktop OAuth client. Do not share JSON or tokens.");
      logLine(io, `Open: ${urls0.projectCreate}`);
      await openUrl(urls0.projectCreate, { platform, spawnSyncFn, openUrlFn });
      if (typeof io.confirm === "function") {
        await io.confirm({ message: "GCP project created? Continue", initialValue: true });
      }
      if (typeof io.text === "function") {
        projectId = str(
          await io.text({
            message: "Project ID (from the console URL ?project=)",
            initialValue: projectId,
          }),
          projectId,
        );
      }
      const urls = workspaceConsoleUrls(projectId);
      logLine(io, "Consent: Internal on paid Workspace, else Testing + add your email as a test user.");
      logLine(io, `Open: ${urls.branding}`);
      await openUrl(urls.branding, { platform, spawnSyncFn, openUrlFn });
      if (typeof io.confirm === "function") {
        await io.confirm({ message: "Branding / audience done? Continue", initialValue: true });
      }
      logLine(io, `Open: ${urls.enableApis}`);
      await openUrl(urls.enableApis, { platform, spawnSyncFn, openUrlFn });
      if (typeof io.confirm === "function") {
        await io.confirm({ message: "APIs enabled? Continue", initialValue: true });
      }
      logLine(io, "Create OAuth client: application type Desktop app → Download JSON.");
      logLine(io, `Open: ${urls.clientCreate}`);
      await openUrl(urls.clientCreate, { platform, spawnSyncFn, openUrlFn });
      if (typeof io.confirm === "function") {
        await io.confirm({ message: "JSON downloaded? Continue", initialValue: true });
      }
      const found = findDownloadedOAuthJson(home);
      const src = str(
        typeof io.text === "function"
          ? await io.text({
              message: "Path to Desktop OAuth JSON (or paste the JSON)",
              initialValue: found,
              defaultValue: found,
            })
          : found,
      );
      if (!src) throw new Error("need path to Desktop OAuth JSON");
      installOAuthJson({ src, dest });
    } else if (credsFlag) {
      installOAuthJson({ src: credsFlag, dest });
    } else if (!fs.existsSync(dest)) {
      throw new Error(
        `need --creds PATH (or TTY: node scripts/setup.mjs google-workspace)`,
      );
    }

    logLine(io, `oauth ${dest}`);
    const login = loginFn || loginLoopback;
    await login(dest);
    logLine(io, `tokens ${tokenStorePath()}`);
    return { ok: true, dest, tokens: tokenStorePath() };
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}

export async function setupBrowser({
  io,
  platform = process.platform,
  pathEnv = process.env.PATH,
  whichFn = whichBin,
  interactive = false,
} = {}) {
  const lp = await reprobeHint({
    id: "lightpanda",
    found: whichFn("lightpanda", pathEnv, platform),
    probe: () => whichFn("lightpanda", pathEnv, platform),
    platform,
    io,
    interactive,
  });
  const chromium = await reprobeHint({
    id: "chromium",
    found: lookupChromium(whichFn, pathEnv, platform),
    probe: () => lookupChromium(whichFn, pathEnv, platform),
    platform,
    io,
    interactive,
  });
  const st = browserEngineStatus(lp, chromium, platform);
  logLine(io, "session: .tmp/grunt/browser/");
  if (lp && chromium) {
    logLine(io, "browser ok  lightpanda (default) + chromium (fallback)");
  } else if (!lp && chromium && platform !== "win32") {
    logLine(io, "Chromium is the fallback only. Install Lightpanda as well (default engine).");
  } else if (lp && !chromium) {
    logLine(io, "Lightpanda ok. Install a chromium-family browser as well (shot/pdf/fallback).");
  }
  return { ok: st.ok, lightpanda: lp, chromium };
}

export async function setupJev({
  flags = {},
  home = os.homedir(),
  io,
  interactive = false,
} = {}) {
  let apiKey = str(flags["api-key"] || flags.key);
  if (interactive && io && !apiKey && typeof io.password === "function") {
    logLine(io, "Open: https://console.typesafe.ai/keys");
    apiKey = str(await io.password({ message: "TypeSafe API key" }));
  }
  if (!apiKey) {
    throw new Error(
      interactive
        ? "need a TypeSafe API key"
        : "need --api-key (or TTY: node scripts/setup.mjs jev)",
    );
  }
  const dest = writeSecretJson(path.join(home, ".grunt", "jev.json"), { apiKey });
  logLine(io, `wrote ${dest}`);
  return { ok: true, dest };
}

async function runTarget(target, ctx) {
  if (target === "speak") return setupSpeak(ctx);
  if (target === "listen") return setupListen(ctx);
  if (target === "google-workspace") return setupGoogleWorkspace(ctx);
  if (target === "browser") return setupBrowser(ctx);
  if (target === "jev") return setupJev(ctx);
  throw new Error(`unknown target ${target}`);
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const { _, flags } = parseArgv(argv);
  const env = opts.env || process.env;
  const home = opts.home || env.HOME || env.USERPROFILE || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const targets = setupTargets(selectedPacks(cwd));
  const interactive =
    opts.interactive != null
      ? Boolean(opts.interactive)
      : ttyInteractive({
          argv,
          env,
          stdin: opts.stdin || process.stdin,
          stdout: opts.stdout || process.stdout,
        });
  const io = opts.io || (interactive ? await defaultIo() : null);
  const ctx = {
    flags,
    env,
    home,
    io,
    fetchFn: opts.fetchFn,
    openUrlFn: opts.openUrlFn,
    platform: opts.platform || process.platform,
    spawnSyncFn: opts.spawnSyncFn,
    whichFn: opts.whichFn,
    pathEnv: opts.pathEnv || env.PATH || process.env.PATH,
    interactive,
    loginFn: opts.loginFn,
  };

  const statusOpts = {
    home,
    env,
    whichFn: ctx.whichFn,
    pathEnv: ctx.pathEnv,
    platform: ctx.platform,
  };
  let statuses = await targetStatuses({ ...statusOpts, targets });
  let target = normalizeTarget(_[0]);
  if (target && !targets.includes(target)) {
    errLine(io, `${target} is off. Enable it with \`grunt init\` or \`grunt upgrade\`.`);
    return 1;
  }
  if (!target && interactive && io && typeof io.select === "function") {
    target = normalizeTarget(
      await io.select({
        message: "Setup",
        options: menuOptions(statuses, targets),
        initialValue: firstMissing(statuses, targets),
      }),
    );
  }
  if (!target) {
    errLine(io, USAGE.trimEnd());
    return 1;
  }
  try {
    const st = statuses[target] || { ok: false, extra: "" };
    const force = flagOn(flags, "redo");
    if (st.ok && interactive && !force && io && typeof io.confirm === "function") {
      const extra = st.extra ? ` (${st.extra})` : "";
      const again = await io.confirm({
        message: `${target} already ok${extra}. Redo?`,
        initialValue: false,
      });
      if (!again) {
        logLine(io, `skip ${target} (already ok)`);
        logLine(io, formatStatus(statuses, targets));
        return 0;
      }
    }
    await runTarget(target, ctx);
    statuses = await targetStatuses({ ...statusOpts, targets });
    logLine(io, formatStatus(statuses, targets));
    return 0;
  } catch (e) {
    errLine(io, String(e && e.message ? e.message : e));
    return 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  main().then((code) => process.exit(code));
}
