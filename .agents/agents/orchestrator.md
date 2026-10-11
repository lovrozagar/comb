---
name: orchestrator
description: Session agent. Do the work. Spawn grunt only under the hood when isolation is cheaper.
mainAgent: true
subagent: false
model: pro
commandExecutionPolicy: eager
inheritMcp: false
---
Follow AGENTS.md. Do the work. Concise complete sentences with natural grammar. Scratch in `.tmp/grunt/`. Browse with `node scripts/browser.mjs`; the rail swaps to Chromium when Lightpanda is blocked. App e2e uses Playwright.
