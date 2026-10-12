#!/usr/bin/env node
/** Session browser rail: nav|snap|click|fill|scroll|wait|hover|select|shot|pdf|stop|doctor|ensure. Lightpanda default. */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeStash } from "./grunt-job.mjs";
import {
  CHROMIUM_BINS,
  LIGHTPANDA_REPO as DOCTOR_LP_REPO,
  installHints,
  runDoctor,
  whichBin,
} from "./doctor.mjs";

export { CHROMIUM_BINS, whichBin };
export const SESSION_REL = ".tmp/grunt/browser";
export const LIGHTPANDA_REPO = DOCTOR_LP_REPO;
const INSTALL_HINT =
  `no browser engine; install lightpanda (${LIGHTPANDA_REPO}) or Chromium`;
const CHROMIUM_VERBS = new Set(["shot", "pdf", "trace"]);
const REF_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "option",
]);
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF_B64 =
  "JVBERi0xLjAKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3hbMCAwIDMgM10vUGFyZW50IDIgMCBSL1Jlc291cmNlczw+Pj4KZW5kb2JqCnhyZWYKMCA0CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDQvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgoxOTAKJSVFT0Y=";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function sessionDir(cwd) {
  return path.join(cwd || process.cwd(), SESSION_REL);
}

export function sessionFile(cwd) {
  return path.join(sessionDir(cwd), "session.json");
}

export function isPaintHost(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase();
  if (h === "figma.com" || h.endsWith(".figma.com")) return true;
  if (h === "docs.google.com" || h.endsWith(".docs.google.com")) return true;
  if (h === "sheets.google.com" || h.endsWith(".sheets.google.com")) return true;
  if (h === "slides.google.com" || h.endsWith(".slides.google.com")) return true;
  if (h === "mail.google.com" || h.endsWith(".mail.google.com")) return true;
  if (h === "earth.google.com" || h.endsWith(".earth.google.com")) return true;
  if ((h === "google.com" || h.endsWith(".google.com")) && u.pathname.startsWith("/earth")) {
    return true;
  }
  if (/(^|\.)amazon\./.test(h)) return true;
  return false;
}

const BLOCKED_SNAP_RE =
  /enable javascript|javascript (is )?(required|disabled)|checking your browser|just a moment|captcha|access denied|sorry.*robot|continue shopping|attention required|cf-browser-verification|verify you are a human/i;

export function isBlockedSnap(markdown, lines) {
  const refs = Array.isArray(lines) ? lines.length : 0;
  const md = String(markdown || "").trim();
  if (BLOCKED_SNAP_RE.test(md)) return true;
  const body = md.replace(/^#\s+\S+\s*$/m, "").trim();
  return refs === 0 && body.length < 80;
}

export function lookupBins(pathEnv, platform = process.platform) {
  const lightpanda = whichBin("lightpanda", pathEnv, platform);
  let chromium = "";
  for (const n of CHROMIUM_BINS) {
    chromium = whichBin(n, pathEnv, platform);
    if (chromium) break;
  }
  return { lightpanda, chromium };
}

export function doctorHints(platform = process.platform) {
  return [...installHints("lightpanda", platform), ...installHints("chromium", platform)];
}

export function installHint(platform = process.platform) {
  return [INSTALL_HINT, ...doctorHints(platform)].join("\n");
}

export function pickEngine({
  platform = process.platform,
  verb = "nav",
  url = "",
  bins = {},
  forceChromium = false,
} = {}) {
  const hasC = Boolean(bins.chromium);
  const hasL = Boolean(bins.lightpanda);
  const wantC =
    forceChromium ||
    platform === "win32" ||
    CHROMIUM_VERBS.has(String(verb)) ||
    isPaintHost(url);
  if (wantC) {
    if (!hasC) return { engine: null, error: installHint(platform) };
    return { engine: "chromium" };
  }
  if (hasL) return { engine: "lightpanda" };
  if (hasC) return { engine: "chromium" };
  return { engine: null, error: installHint(platform) };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reap(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      process.kill(pid);
    } catch {
      /* ignore */
    }
    if (alive(pid)) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 1500,
        windowsHide: true,
      });
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
}

function readSession(cwd) {
  const f = sessionFile(cwd);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function writeSession(cwd, session) {
  const dir = sessionDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile(cwd), JSON.stringify(session, null, 2) + "\n");
}

function clearSession(cwd) {
  try {
    fs.unlinkSync(sessionFile(cwd));
  } catch {
    /* ignore */
  }
}

function ok(stdout) {
  return { code: 0, stdout: stdout.endsWith("\n") ? stdout : stdout + "\n", stderr: "" };
}

function fail(stderr) {
  const msg = String(stderr || "fail").replace(/^Error:\s*/, "");
  return { code: 1, stdout: "", stderr: msg.endsWith("\n") ? msg : msg + "\n" };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = addr && addr.port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

async function waitVersion(port, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* retry */
    }
    await sleep(40);
  }
  throw new Error("engine not ready");
}

export async function connectCdp(port) {
  const version = await waitVersion(port);
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("engine not ready");
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("engine not ready")), 4000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("engine not ready"));
    });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.id == null || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || "cdp"));
    else p.resolve(msg.result || {});
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function defaultAx(url) {
  return [
    {
      nodeId: "1",
      role: { value: "WebArea" },
      name: { value: url || "page" },
      childIds: ["2", "3"],
    },
    {
      nodeId: "2",
      role: { value: "link" },
      name: { value: "Home" },
      backendDOMNodeId: 10,
      childIds: [],
    },
    {
      nodeId: "3",
      role: { value: "textbox" },
      name: { value: "Search" },
      backendDOMNodeId: 11,
      childIds: [],
    },
  ];
}

function encodeWsFrame(data) {
  const payload = Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buf) {
  const messages = [];
  let offset = 0;
  while (buf.length - offset >= 2) {
    const b1 = buf[offset + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let start = offset + 2;
    if (len === 126) {
      if (buf.length - offset < 4) break;
      len = buf.readUInt16BE(offset + 2);
      start = offset + 4;
    } else if (len === 127) {
      if (buf.length - offset < 10) break;
      len = Number(buf.readBigUInt64BE(offset + 2));
      start = offset + 10;
    }
    const maskStart = start;
    if (masked) start += 4;
    if (buf.length < start + len) break;
    let payload = buf.subarray(start, start + len);
    if (masked) {
      const mask = buf.subarray(maskStart, maskStart + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    const opcode = buf[offset] & 0x0f;
    offset = start + len;
    if (opcode === 0x8) messages.push({ type: "close" });
    else if (opcode === 0x1 || opcode === 0x2) {
      messages.push({ type: "msg", data: payload.toString("utf8") });
    }
  }
  return { messages, rest: buf.subarray(offset) };
}

async function handleCdp(state, method, params = {}) {
  if (state.failProbe && (method === "Browser.getVersion" || method === "Target.getTargets")) {
    throw new Error("probe failed");
  }
  switch (method) {
    case "Browser.getVersion":
      return { protocolVersion: "1.3", product: state.engine || "lightpanda" };
    case "Target.getTargets":
      return {
        targetInfos: [{ targetId: "t1", type: "page", url: state.url || "about:blank", attached: true }],
      };
    case "Page.enable":
    case "Accessibility.enable":
    case "Runtime.enable":
    case "DOM.enable":
      return {};
    case "Page.navigate":
      state.url = params.url || state.url;
      state.markdown = `# ${state.url}\n\nhello`;
      return { frameId: "f1" };
    case "LP.getMarkdown":
      if (state.thinSnap) return { markdown: `# ${state.url || ""}\n` };
      return { markdown: state.markdown || `# ${state.url || ""}\n\nhello` };
    case "Accessibility.getFullAXTree":
      if (state.thinSnap) return { nodes: [] };
      return { nodes: state.axNodes || defaultAx(state.url) };
    case "DOM.resolveNode": {
      const id = params.backendNodeId;
      const known = new Set([10, 11]);
      if (!known.has(id)) throw new Error("stale");
      return { object: { objectId: "oid-" + id } };
    }
    case "Runtime.callFunctionOn":
      return { result: { type: "undefined" } };
    case "Input.insertText":
      return {};
    case "Page.captureScreenshot":
      return { data: PNG_B64 };
    case "Page.printToPDF":
      return { data: PDF_B64 };
    case "Runtime.evaluate":
      return { result: { type: "string", value: state.markdown || "" } };
    default:
      return {};
  }
}

/** Undocumented test helper: fake Lightpanda/Chromium CDP. */
export async function serveCdp(state = {}, { port = 0 } = {}) {
  const st = {
    url: "about:blank",
    markdown: "",
    failProbe: false,
    thinSnap: false,
    engine: "lightpanda",
    ...state,
  };
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith("/json/version")) {
      const addr = server.address();
      const p = addr && addr.port;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          Browser: st.engine || "Lightpanda",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://127.0.0.1:${p}/devtools/browser/grunt`,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeWsFrames(buf);
      buf = Buffer.from(decoded.rest);
      for (const m of decoded.messages) {
        if (m.type === "close") {
          socket.end();
          return;
        }
        if (m.type !== "msg") continue;
        let msg;
        try {
          msg = JSON.parse(m.data);
        } catch {
          continue;
        }
        Promise.resolve()
          .then(() => handleCdp(st, msg.method, msg.params || {}))
          .then((result) => {
            socket.write(encodeWsFrame(JSON.stringify({ id: msg.id, result })));
          })
          .catch((err) => {
            socket.write(
              encodeWsFrame(
                JSON.stringify({
                  id: msg.id,
                  error: { code: -32000, message: String(err && err.message ? err.message : err) },
                }),
              ),
            );
          });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const addr = server.address();
  return {
    port: addr.port,
    close() {
      server.close();
    },
    state: st,
  };
}

function engineBin(engine, bins) {
  if (engine === "lightpanda") return bins.lightpanda;
  return bins.chromium;
}

function spawnEngine(bin, args, opts) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const mjs = `${String(bin).replace(/\.(cmd|bat)$/i, "")}.mjs`;
    try {
      fs.accessSync(mjs, fs.constants.F_OK);
      return spawn(process.execPath, [mjs, ...args], opts);
    } catch {
      return spawn(bin, args, { ...opts, shell: true });
    }
  }
  return spawn(bin, args, opts);
}

function spawnArgs(engine, port, profile) {
  if (engine === "lightpanda") return ["serve", "--host", "127.0.0.1", "--port", String(port)];
  return [
    "--headless=new",
    "--disable-gpu",
    "--remote-debugging-port",
    String(port),
    "--user-data-dir",
    profile,
    "about:blank",
  ];
}

async function launchEngine(engine, ctx) {
  const bin = engineBin(engine, ctx.bins);
  if (!bin) throw new Error(INSTALL_HINT);
  const dir = sessionDir(ctx.cwd);
  fs.mkdirSync(dir, { recursive: true });
  const profile = path.join(dir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const port = await freePort();
  const child = spawnEngine(bin, spawnArgs(engine, port, profile), {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: ctx.env,
    cwd: ctx.cwd,
  });
  child.unref();
  try {
    await waitVersion(port);
  } catch (err) {
    reap(child.pid);
    throw err;
  }
  return {
    engine,
    pid: child.pid,
    port,
    lastURL: "",
    lastRefs: {},
    escalated: false,
    swapCount: 0,
  };
}

async function probe(session) {
  const cdp = await connectCdp(session.port);
  try {
    await cdp.send("Browser.getVersion");
  } finally {
    cdp.close();
  }
}

async function navigate(session, url) {
  const cdp = await connectCdp(session.port);
  try {
    await cdp.send("Page.enable").catch(() => {});
    await cdp.send("Page.navigate", { url });
    session.lastURL = url;
  } finally {
    cdp.close();
  }
}

function formatRefs(nodes) {
  const lastRefs = {};
  const lines = [];
  let n = 1;
  for (const node of nodes || []) {
    const role = String((node.role && node.role.value) || node.role || "").toLowerCase();
    if (!REF_ROLES.has(role)) continue;
    const name = String((node.name && node.name.value) || node.name || "");
    const id = String(n++);
    lastRefs[id] = {
      role,
      name,
      backendNodeId: node.backendDOMNodeId ?? node.backendNodeId,
      nodeId: node.nodeId,
    };
    lines.push(`[${id}] ${role} ${name}`.trim());
  }
  return { lastRefs, lines };
}

async function snapshot(session) {
  const cdp = await connectCdp(session.port);
  try {
    let markdown = "";
    if (session.engine === "lightpanda") {
      try {
        const r = await cdp.send("LP.getMarkdown");
        markdown = r.markdown || r.result || "";
      } catch {
        markdown = "";
      }
    }
    if (!markdown) {
      markdown = `# ${session.lastURL || ""}\n`;
    }
    await cdp.send("Accessibility.enable").catch(() => {});
    const ax = await cdp.send("Accessibility.getFullAXTree");
    const { lastRefs, lines } = formatRefs(ax.nodes || []);
    session.lastRefs = lastRefs;
    return { markdown, lines };
  } finally {
    cdp.close();
  }
}

async function swapToChromium(session, ctx) {
  if (session.engine === "chromium") return session;
  if ((session.swapCount || 0) >= 1 && session.engine === "chromium") return session;
  const url = session.lastURL;
  reap(session.pid);
  const next = await launchEngine("chromium", ctx);
  next.lastURL = url;
  next.lastRefs = session.lastRefs || {};
  next.escalated = true;
  next.swapCount = (session.swapCount || 0) + 1;
  if (url) await navigate(next, url);
  return next;
}

async function withCdp(session, fn) {
  const cdp = await connectCdp(session.port);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

export async function runBrowser(argv, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const bins = lookupBins(env.PATH, platform);
  const ctx = { cwd, env, platform, bins };
  const verb = String(argv[0] || "").toLowerCase();
  try {
    if (!verb || verb === "help" || verb === "-h" || verb === "--help") {
      return ok("nav|snap|click|fill|scroll|wait|hover|select|shot|pdf|stop|doctor|ensure");
    }
    if (verb === "doctor" || verb === "ensure") {
      return runDoctor({ pathEnv: env.PATH, platform, cwd });
    }
    if (verb === "stop") {
      const s = readSession(cwd);
      if (s && s.pid) reap(s.pid);
      clearSession(cwd);
      await sleep(30);
      return ok("stopped");
    }
    if (verb === "nav") {
      const url = String(argv[1] || "").trim();
      if (!url) return fail("nav <url>");
      const picked = pickEngine({ platform, verb: "nav", url, bins });
      if (!picked.engine) return fail(picked.error || INSTALL_HINT);
      const prev = readSession(cwd);
      if (prev && prev.pid) reap(prev.pid);
      let session;
      try {
        session = await launchEngine(picked.engine, ctx);
      } catch {
        return fail(INSTALL_HINT);
      }
      if (picked.engine === "lightpanda") {
        try {
          await probe(session);
        } catch {
          if (!bins.chromium) {
            reap(session.pid);
            return fail(INSTALL_HINT);
          }
          reap(session.pid);
          session = await launchEngine("chromium", ctx);
          session.escalated = true;
          session.swapCount = 1;
        }
      }
      await navigate(session, url);
      writeSession(cwd, session);
      return ok(`engine: ${session.engine}\nurl: ${session.lastURL}`);
    }
    if (verb === "snap") {
      let session = readSession(cwd);
      if (!session || !alive(session.pid)) return fail("no browser session; run nav");
      let { markdown, lines } = await snapshot(session);
      if (
        session.engine === "lightpanda" &&
        (session.swapCount || 0) < 1 &&
        bins.chromium &&
        isBlockedSnap(markdown, lines)
      ) {
        session = await swapToChromium(session, ctx);
        ({ markdown, lines } = await snapshot(session));
      }
      writeSession(cwd, session);
      const raw = [markdown.trim(), "", ...lines].join("\n");
      const headings = String(markdown || "")
        .split(/\n/)
        .filter((l) => /^#{1,6}\s/.test(l));
      const shown = [...headings.slice(0, 6), ...lines.slice(0, 24)];
      if (raw.length > 32 * 1024 || lines.length > 6) {
        const stash = writeStash(cwd, "snap", raw);
        return ok(
          `engine: ${session.engine}\nurl: ${session.lastURL}\n${shown.length} shown. stash=${stash}\n${shown.join("\n")}`,
        );
      }
      const body = [markdown.trim(), "", ...lines].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
      return ok(`engine: ${session.engine}\nurl: ${session.lastURL}\n\n${body}`);
    }
    if (verb === "wait") {
      const session = readSession(cwd);
      if (!session || !alive(session.pid)) return fail("no browser session; run nav");
      const raw = String(argv[1] || "1000");
      const ms = Math.min(15000, Math.max(0, Number(raw) || 0));
      await sleep(ms);
      return ok(`wait: ${ms}`);
    }
    if (verb === "scroll") {
      let session = readSession(cwd);
      if (!session || !alive(session.pid)) return fail("no browser session; run nav");
      const arg = String(argv[1] || "down");
      const refs = session.lastRefs || {};
      const rec = refs[arg];
      const act = async (sess) =>
        withCdp(sess, async (cdp) => {
          if (rec) {
            const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: rec.backendNodeId });
            const objectId = resolved.object && resolved.object.objectId;
            if (!objectId) throw new Error("stale");
            await cdp.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: "function() { this.scrollIntoView({ block: 'center' }); }",
            });
            return;
          }
          let dy = 600;
          if (arg === "up") dy = -600;
          else if (/^-?\d+$/.test(arg)) dy = Number(arg);
          await cdp.send("Runtime.evaluate", {
            expression: `window.scrollBy(0, ${dy})`,
          });
        });
      try {
        await act(session);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/stale|missing/i.test(msg)) return fail(`stale ref: ${arg}`);
        return fail(msg);
      }
      writeSession(cwd, session);
      return ok(`scroll: ${arg}`);
    }
    if (verb === "click" || verb === "fill" || verb === "hover" || verb === "select") {
      let session = readSession(cwd);
      if (!session || !alive(session.pid)) return fail("no browser session; run nav");
      const refs = session.lastRefs || {};
      if (!Object.keys(refs).length) return fail("no snap refs; run snap");
      const refId = String(argv[1] || "");
      const rec = refs[refId];
      if (!rec) return fail(`missing ref: ${refId}`);
      const text = argv.slice(2).join(" ");
      if (verb === "fill" && !text) return fail("fill <ref> <text>");
      if (verb === "select" && !text) return fail("select <ref> <value>");
      const act = async (sess) =>
        withCdp(sess, async (cdp) => {
          const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: rec.backendNodeId });
          const objectId = resolved.object && resolved.object.objectId;
          if (!objectId) throw new Error("stale");
          if (verb === "click") {
            await cdp.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: "function() { this.click(); }",
            });
          } else if (verb === "hover") {
            await cdp.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration:
                "function() { this.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); }",
            });
          } else if (verb === "select") {
            await cdp.send("Runtime.callFunctionOn", {
              objectId,
              arguments: [{ value: text }],
              functionDeclaration:
                "function(v) { this.value = v; this.dispatchEvent(new Event('change', { bubbles: true })); }",
            });
          } else {
            await cdp.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: "function() { this.focus(); this.value = ''; }",
            });
            await cdp.send("Input.insertText", { text });
            await cdp.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration:
                "function() { this.dispatchEvent(new Event('input', { bubbles: true })); }",
            });
          }
        });
      try {
        await act(session);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/stale|missing/i.test(msg)) return fail(`stale ref: ${refId}`);
        if (session.engine !== "chromium" && (session.swapCount || 0) < 1 && bins.chromium) {
          session = await swapToChromium(session, ctx);
          writeSession(cwd, session);
          try {
            await act(session);
          } catch (err2) {
            const msg2 = String(err2 && err2.message ? err2.message : err2);
            if (/stale|missing/i.test(msg2)) return fail(`stale ref: ${refId}`);
            return fail(msg2);
          }
        } else {
          return fail(msg);
        }
      }
      writeSession(cwd, session);
      return ok(`${verb}: ${refId}`);
    }
    if (verb === "shot" || verb === "pdf") {
      let session = readSession(cwd);
      if (!session || !session.lastURL) return fail("no browser session; run nav");
      const picked = pickEngine({ platform, verb, url: session.lastURL, bins, forceChromium: true });
      if (!picked.engine) return fail(picked.error || INSTALL_HINT);
      if (session.engine !== "chromium") {
        if (!alive(session.pid) && !session.lastURL) return fail("no browser session; run nav");
        session = await swapToChromium(session, ctx);
      } else if (!alive(session.pid)) {
        return fail("no browser session; run nav");
      }
      const dir = sessionDir(cwd);
      fs.mkdirSync(dir, { recursive: true });
      const destName = verb === "shot" ? "shot.png" : "page.pdf";
      const dest = path.join(dir, destName);
      await withCdp(session, async (cdp) => {
        if (verb === "shot") {
          const r = await cdp.send("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(dest, Buffer.from(r.data, "base64"));
        } else {
          const r = await cdp.send("Page.printToPDF", {});
          fs.writeFileSync(dest, Buffer.from(r.data, "base64"));
        }
      });
      writeSession(cwd, session);
      return ok(`engine: ${session.engine}\nfile: ${path.join(SESSION_REL, destName)}`);
    }
    return fail("unknown verb");
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).replace(/^Error:\s*/, "");
    return fail(msg);
  }
}

async function main() {
  const r = await runBrowser(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.code;
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === thisFile || import.meta.url === pathToFileURL(invoked).href) {
  main().then((code) => process.exit(code), () => process.exit(1));
}
