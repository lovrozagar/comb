---
tags: [browser]
---

# Browser

Zero-config in-tree session rail. Not MCP. Not env. Not raw Playwright. Lightpanda first; swap to Chromium when blocked.

```
node scripts/browser.mjs nav|snap|click|fill|scroll|wait|hover|select|shot|pdf|stop|doctor|ensure
```

Default engine: **Lightpanda** (`lightpanda` on PATH). Chromium when a rule below requires it. Never report "can't browse" while Chromium is available.

## Verbs

| verb | purpose |
| --- | --- |
| `nav <url>` | launch or reuse session; go to URL |
| `snap` | markdown + numbered AX refs (default read) |
| `click <ref>` | click a ref from last `snap` |
| `fill <ref> <text>` | fill a ref from last `snap` |
| `scroll [ref|down|up|N]` | scroll a snap ref into view, or the window |
| `wait [ms]` | pause (default 1000, cap 15000) |
| `hover <ref>` | hover a snap ref |
| `select <ref> <value>` | set a select/option value |
| `shot` | screenshot (Chromium paint) |
| `pdf` | PDF (Chromium paint) |
| `stop` | reap engine pid; clear session; idempotent |
| `doctor` | unified prereq doctor (`scripts/doctor.mjs`); alias `ensure` |
| `ensure` | alias of `doctor` |

Session + profile + artifacts: `.tmp/grunt/browser/` only.

## Install

Run `grunt doctor` / `node scripts/doctor.mjs`. Handheld engine hints (no keys): `node scripts/setup.mjs browser`. Doctor/setup is enough. Do not read a README unless those are missing; then https://github.com/lovrozagar/grunt#prerequisites (not the consumer README).

## Engine

Lightpanda first (`lightpanda serve` internally, CDP, `LP.getMarkdown` + AX refs).

Chromium immediately when any of:

- verb is `shot` | `pdf` | `trace`
- `process.platform === "win32"`
- Chromium-first host: figma, Google docs / sheets / slides, mail.google, earth, amazon
- `lightpanda` missing from PATH and a Chromium binary is present
- Lightpanda probe fails **once** → one Chromium replay of last URL; no loop
- `snap` on Lightpanda is empty, a bot/JS wall, or client-rendered junk → one Chromium replay, then snap again

The session agent does not invent a "can't" for Amazon or other client-rendered sites. The rail swaps. One swap cap. App e2e stays Playwright (`playwright test`), not this CLI.

No user env. Never `GRUNT_BROWSER*`. Never `LIGHTPANDA_CDP_URL`.

## Non-goals

- MCP browser servers
- user env knobs
- raw Playwright as the browse tool (Playwright is the app e2e runner)
- grunt `job:browse`
- teaching thinker / orchestrator to browse

## RTK

`playwright` on the RTK command list is the **test-runner family only**. Browser rail is `lightpanda` + `scripts/browser.mjs`.
