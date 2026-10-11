# Law

Protocol stays overview; domain fills this.

## Skills naming

Reserved (do not reuse in consumer custom skills): `ask` `auto` `browser` `clasp` `commit` `commit-and-push` `commit-push` `commit-push-deploy` `commit-push-release` `explain` `google-workspace` `handoff` `implement-plan` `jev` `listen` `pickup` `speak` `su` `tmp` `write-plan`.

Override: same name → one SSOT path (`.rulesync/skills/<name>/`). Re-init / `grunt upgrade` force-refresh overwrites grunt-owned names; consumer extras kept. Maps `origin` badge ≠ content picker.

Upgrade copies the current package trees and product scripts, then deletes cumulative retired grunt-owned names (skills `parent` `solo` `cascade`; agents `implementer` `thinker`; scripts `telemetry.mjs` `grunt-config.mjs`; paths `.grok/parent.md` `.grok/skills/shared` `.rulesync/grunt.config.jsonc` `.rulesync/grunt.config.local.jsonc` `.rulesync/grunt.config.local.jsonc.example`) and any reserved skill dir this package no longer ships. `fs.cpSync` does not remove dest extras; prune is what drops them. Consumer skills/refs/scripts not on those lists stay. Extra `##` headings in shared reference docs (e.g. `law.md`) are kept. `grunt:*` package scripts that differ from a known grunt default stay; `grunt:test:e2e` is added only when a vitest e2e config exists. Check steps omitted from dest `scripts/pipeline.mjs` seed `.rulesync/grunt.pipeline.jsonc`. doctor/listen/speak call `scripts/lib/env.mjs` `loadEnv` when that file exists.
