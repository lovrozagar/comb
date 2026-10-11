---
tags: [cascade]
---

# Protocol

The session agent has tools. Fat Read/Grep/Bash dumps are rewritten to `scripts/grunt-job.mjs` (squeez + stash). Isolation facts stay ≤8 lines.

Run `node scripts/grunt-job.mjs --job search|exec|slice|fetch|test` first. Spawn a grunt model only when the dump needs judgment (browse snap, messy test log). Isolation work may run as grunt.

`need:` JSON (search|exec|slice|fetch) may be intercepted in-hook (cap 4). Peek/kill if a child is running: Grok `get_command_or_subagent_output` `timeout_ms=60000`. Other hosts: block on spawn return.

Session flags: `/auto` (default) keeps going and asks on blockers instead of monkey-patching. `/ask` finishes one step, recaps, then asks. Slash `/ask` stamps `.tmp/grunt/orchestrator-logs/session-gate-{sid}`; `/auto` unlinks.

Scratch: `.tmp/grunt/`. Stash: `.tmp/grunt/stash/`. Sessions: `.tmp/grunt/sessions/{sid}/`. Browser: `.tmp/grunt/browser/`.
