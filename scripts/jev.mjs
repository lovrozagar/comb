#!/usr/bin/env node
/** One TypeSafe System One call for an external research decision. Caps are local. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MODEL = "jev-1.13.0";
export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MAX_STATE_CHARS = 64_000;
export const MAX_QUESTIONS = 8;
export const MAX_REQUESTS_PER_DAY = 40;
export const MAX_INPUT_TOKENS_PER_DAY = 1_000_000;
export const TIMEOUT_MS = 10_000;
export const MAX_RETRY_WAIT_MS = 2_000;
export const LOCK_STALE_MS = 10_000;

const USAGE = "usage: node scripts/jev.mjs --available | --state FILE --questions FILE\n";
const MISSING_KEY =
  "missing TYPESAFE_API_KEY or ~/.grunt/jev.json. setup: node scripts/setup.mjs jev\n";

export function jevJsonPath(home) {
  return path.join(home, ".grunt", "jev.json");
}

export function jevUsagePath(home) {
  return path.join(home, ".grunt", "jev-usage.json");
}

export function estimateTokens(stateText, questionsText) {
  return Math.ceil((String(stateText).length + String(questionsText).length) / 4);
}

export function loadJevKey({ env = process.env, home = os.homedir() } = {}) {
  const fromEnv = String(env.TYPESAFE_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const parsed = JSON.parse(fs.readFileSync(jevJsonPath(home), "utf8"));
    return String(parsed && parsed.apiKey ? parsed.apiKey : "").trim();
  } catch {
    return "";
  }
}

export function retryWaitMs(header, now = Date.now()) {
  if (header == null || String(header).trim() === "") return null;
  const raw = String(header).trim();
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return ms <= MAX_RETRY_WAIT_MS ? ms : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  const ms = when - now;
  if (ms < 0) return 0;
  return ms <= MAX_RETRY_WAIT_MS ? ms : null;
}

function fail(text) {
  return { code: 2, text };
}

function headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  return headers[name] ?? headers[lower] ?? null;
}

function readLedger(file, day) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.day !== day) return { day, requests: 0, input_tokens: 0 };
    return {
      day,
      requests: Number(parsed.requests) || 0,
      input_tokens: Number(parsed.input_tokens) || 0,
    };
  } catch {
    return { day, requests: 0, input_tokens: 0 };
  }
}

function writeLedger(file, row) {
  fs.writeFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* win */
  }
}

function withLock(home, fn) {
  const dir = path.join(home, ".grunt");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "jev-usage.lock");
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.rmdirSync(lock);
        } catch {
          /* owner still has it */
        }
        continue;
      }
      if (Date.now() - start > LOCK_STALE_MS) return { busy: true };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

function beginAttempt(home, nowMs, estimate) {
  return withLock(home, () => {
    const file = jevUsagePath(home);
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const cur = readLedger(file, day);
    if (cur.requests >= MAX_REQUESTS_PER_DAY) return { stop: "requests" };
    if (
      cur.input_tokens >= MAX_INPUT_TOKENS_PER_DAY ||
      cur.input_tokens + estimate > MAX_INPUT_TOKENS_PER_DAY
    ) {
      return { stop: "tokens" };
    }
    const next = {
      day,
      requests: cur.requests + 1,
      input_tokens: cur.input_tokens + estimate,
    };
    writeLedger(file, next);
    return { ok: true, estimate };
  });
}

function settleTokens(home, nowMs, estimate, actual) {
  return withLock(home, () => {
    const file = jevUsagePath(home);
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const cur = readLedger(file, day);
    const input_tokens = Math.max(0, cur.input_tokens - estimate + actual);
    writeLedger(file, { day, requests: cur.requests, input_tokens });
    return { ok: true };
  });
}

function parseState(stateText) {
  const trimmed = stateText.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return stateText;
  try {
    const parsed = JSON.parse(stateText);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* keep the raw text */
  }
  return stateText;
}

function formatAnswers(payload) {
  const model = String(payload.model || MODEL);
  const used = Number(payload.usage && payload.usage.input_tokens);
  const lines = [`${model}. input_tokens=${Number.isFinite(used) ? used : 0}`];
  const answers = payload.answers && typeof payload.answers === "object" ? payload.answers : {};
  for (const [id, answer] of Object.entries(answers)) {
    if (lines.length >= 8) break;
    if (!answer || typeof answer !== "object") continue;
    if (answer.type === "choice") {
      lines.push(`- ${id} choice=${answer.choice} confidence=${answer.confidence}`);
    } else if (answer.type === "noul") {
      lines.push(`- ${id} noul=${answer.noul}`);
    } else if (answer.type === "score") {
      lines.push(`- ${id} score=${answer.score} confidence=${answer.confidence}`);
    }
  }
  return lines.join("\n") + "\n";
}

async function postOnce(fetchImpl, key, state, questions) {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, state, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json, headers: response.headers };
}

function stopText(kind) {
  if (kind === "requests") return `daily request cap ${MAX_REQUESTS_PER_DAY}\n`;
  if (kind === "tokens") return `daily input token cap ${MAX_INPUT_TOKENS_PER_DAY}\n`;
  return "jev usage lock busy\n";
}

export function createJevRunner() {
  let spent = false;
  return async function runJev(opts = {}) {
    if (spent) return fail("process request cap 1\n");
    const home = opts.home || os.homedir();
    const env = opts.env || process.env;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const nowFn = typeof opts.now === "function" ? opts.now : () => opts.now ?? Date.now();
    const stateText = opts.stateText;
    const questionsText = opts.questionsText;
    if (typeof stateText !== "string" || typeof questionsText !== "string") {
      return fail(USAGE);
    }
    if (stateText.length > MAX_STATE_CHARS) return fail("state exceeds 64000 characters\n");
    let questions;
    try {
      questions = JSON.parse(questionsText);
    } catch {
      return fail("questions must be a JSON object\n");
    }
    if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
      return fail("questions must be a JSON object\n");
    }
    const count = Object.keys(questions).length;
    if (count < 1) return fail("questions missing\n");
    if (count > MAX_QUESTIONS) return fail("questions exceed 8\n");
    const key = loadJevKey({ env, home });
    if (!key) return fail(MISSING_KEY);
    const estimate = estimateTokens(stateText, questionsText);
    const state = parseState(stateText);

    const attempt = async () => {
      const nowMs = nowFn();
      const begun = beginAttempt(home, nowMs, estimate);
      if (begun.busy) return fail(stopText("lock"));
      if (begun.stop) return fail(stopText(begun.stop));
      spent = true;
      let response;
      try {
        response = await postOnce(fetchImpl, key, state, questions);
      } catch {
        return fail("jev request failed\n");
      }
      return { response, nowMs };
    };

    const first = await attempt();
    if (first.code) return first;
    let { response, nowMs } = first;
    if (response.status === 429 || response.status === 529) {
      const wait = retryWaitMs(headerGet(response.headers, "retry-after"), nowMs);
      if (wait != null) {
        await sleep(wait);
        const second = await attempt();
        if (second.code) return second;
        response = second.response;
        nowMs = second.nowMs;
      }
    }
    if (response.status < 200 || response.status >= 300 || !response.json || typeof response.json !== "object") {
      return fail("jev request failed\n");
    }
    const actual = Number(response.json.usage && response.json.usage.input_tokens);
    if (Number.isFinite(actual) && actual >= 0) settleTokens(home, nowMs, estimate, actual);
    const text = formatAnswers(response.json);
    if (text.includes(key)) return fail("jev request failed\n");
    return { code: 0, text };
  };
}

export function parseArgv(argv) {
  const flags = {};
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string" || !arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 2) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next && !String(next).startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else flags[name] = "1";
  }
  return { flags };
}

const runner = createJevRunner();

export async function main(argv = process.argv.slice(2), opts = {}) {
  const { flags } = parseArgv(argv);
  if (flags.available) {
    const present = Boolean(loadJevKey({ env: opts.env || process.env, home: opts.home || os.homedir() }));
    return { code: 0, text: present ? "yes\n" : "no\n" };
  }
  if (!flags.state || !flags.questions) return fail(USAGE);
  let stateText;
  let questionsText;
  try {
    stateText = fs.readFileSync(flags.state, "utf8");
    questionsText = fs.readFileSync(flags.questions, "utf8");
  } catch {
    return fail("state or questions file missing\n");
  }
  const run = opts.run || runner;
  return run({
    home: opts.home,
    env: opts.env,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    now: opts.now,
    stateText,
    questionsText,
  });
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  main()
    .then((result) => {
      process.stdout.write(result.text);
      process.exit(result.code);
    })
    .catch(() => {
      process.stdout.write("jev request failed\n");
      process.exit(2);
    });
}
