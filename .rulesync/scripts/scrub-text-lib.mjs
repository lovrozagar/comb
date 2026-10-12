import path from "node:path";

export const MD_SUFFIXES = new Set([".md", ".markdown"]);
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})/;
const INTENT_PREFIXES = [
  "can you please",
  "could you please",
  "would you please",
  "can you",
  "could you",
  "would you",
  "please",
  "i want you to",
  "i need you to",
  "i would like you to",
  "i'd like you to",
];
const INTENT_MID = [
  [String.raw`\bmake me an\b`, "make"],
  [String.raw`\bmake me a\b`, "make"],
  [String.raw`\bmake me\b`, "make"],
  [String.raw`\bi want the\b`, ""],
  [String.raw`\bi need the\b`, ""],
  [String.raw`\bi want a\b`, ""],
  [String.raw`\bi need a\b`, ""],
  [String.raw`\bi want\b`, ""],
  [String.raw`\bi need\b`, ""],
  [String.raw`\bto\s*,`, ","],
];
const FILLER_PREFIX = new RegExp(
  "^(?:" + INTENT_PREFIXES.join("|") + ")\\s+",
  "i",
);
const FILLER_SUFFIX = /\s+(?:thank you|thanks|please)[.!]*\s*$/i;
const COMMA_WS = /\s*,\s*/g;
const WS_RUN = /[ \t]+/g;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function helpText() {
  return `Usage: scrub-text [--intent] [--md] [--no-md] [FILE...]
Normalize UTF-8 text for agents. Reads stdin if no FILE.

  --intent   One-line paste: drop blanks; strip filler (please / can you /
             i want / make me a / to , …). Typos kept; no spellcheck.
  --md       Markdown-aware (preserve fences, headings, lists)
  --no-md    Disable auto --md for .md/.markdown files
  -h, --help This help

Default: UTF-8, newlines to \\n, strip trailing whitespace, collapse extra
blank lines and (plain text) internal whitespace. .md/.markdown files enable
--md unless --no-md.

Not RTK (shell stdout). Use this for user paste and markdown files.
`;
}

export function parseArgs(argv) {
  const args = {
    help: false,
    intent: false,
    md: false,
    noMd: false,
    files: [],
    unknown: [],
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      args.files.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--intent") {
      args.intent = true;
    } else if (a === "--md") {
      args.md = true;
    } else if (a === "--no-md") {
      args.noMd = true;
    } else if (a.startsWith("-") && a !== "-") {
      args.unknown.push(a);
    } else {
      args.files.push(a);
    }
    i += 1;
  }
  return args;
}

export function decodeUtf8(data, label) {
  try {
    return decoder.decode(data);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

export function autoMd(files, forceMd, noMd) {
  if (noMd) return false;
  if (forceMd) return true;
  if (!files.length) return false;
  return files.every((f) => MD_SUFFIXES.has(path.extname(f).toLowerCase()));
}

export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function collapseBlankRuns(lines, maxBlank) {
  const out = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks += 1;
      if (blanks <= maxBlank) out.push("");
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  return out;
}

export function trimEdgeBlanks(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start += 1;
  while (end > start && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end);
}

export function collapseInternalWs(line) {
  return line.replace(WS_RUN, " ").trim();
}

export function fenceMatch(line) {
  return line.match(FENCE_RE);
}

export function normalizePlain(text) {
  text = normalizeNewlines(text);
  let lines = text.split("\n").map((ln) => collapseInternalWs(ln.replace(/[ \t]+$/g, "")));
  lines = collapseBlankRuns(lines, 1);
  lines = trimEdgeBlanks(lines);
  const nonempty = lines.filter((ln) => ln);
  if (nonempty.length && nonempty.every((ln) => ln.length <= 80)) {
    lines = nonempty;
  }
  return lines.join("\n");
}

export function normalizeMd(text) {
  text = normalizeNewlines(text);
  const rawLines = text.split("\n");
  const out = [];
  let fenceMarker = null;
  for (const line of rawLines) {
    if (fenceMarker !== null) {
      out.push(line);
      const m = fenceMatch(line);
      if (
        m &&
        m[2][0] === fenceMarker[0] &&
        m[2].length >= fenceMarker.length
      ) {
        fenceMarker = null;
      }
      continue;
    }
    const m = fenceMatch(line);
    if (m) {
      fenceMarker = m[2];
      out.push(line.replace(/[ \t]+$/g, ""));
      continue;
    }
    out.push(line.replace(/[ \t]+$/g, ""));
  }
  return trimEdgeBlanks(collapseBlankRuns(out, 2)).join("\n");
}

export function stripFiller(text) {
  let prev = null;
  while (prev !== text) {
    prev = text;
    text = text.replace(FILLER_PREFIX, "").trim();
    text = text.replace(FILLER_SUFFIX, "").trim();
    for (const [pat, repl] of INTENT_MID) {
      text = text.replace(new RegExp(pat, "gi"), repl);
    }
    text = text.replace(COMMA_WS, " ");
    text = text.replace(WS_RUN, " ").trim();
  }
  return text;
}

export function intentMode(text) {
  const lines = text
    .split("\n")
    .map((ln) => ln.trim())
    .filter(Boolean);
  const joined = lines.join(" ").replace(WS_RUN, " ").trim();
  return stripFiller(joined);
}

export function scrubText(raw, { md = false, intent = false } = {}) {
  let text = md ? normalizeMd(raw) : normalizePlain(raw);
  if (intent) text = intentMode(text);
  return text;
}
