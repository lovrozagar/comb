---
name: principle-guard-the-context-window
description: "Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to grunt-job and `.tmp/grunt/` scratch; keep summaries in the session, not raw payloads. Use for /principle-guard-the-context-window."
---
# Guard the Context Window

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

Slash `/principle-guard-the-context-window` only. Not a session flag.

**Pattern:**
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
