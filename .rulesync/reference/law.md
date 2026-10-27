# Law

Protocol stays overview; domain fills this.

## Skills naming

Do not reuse a grunt skill name for a consumer custom skill. `grunt upgrade` prints the reserved list. Pack names stay reserved when their directory is absent.

Override: same name → one SSOT path (`.rulesync/skills/<name>/`). Re-init / `grunt upgrade` force-refresh overwrites grunt-owned names; consumer extras kept. Maps `origin` badge ≠ content picker.

Upgrade copies the current package trees and product scripts (to `.rulesync/scripts/`), then deletes cumulative retired grunt-owned names (skills `parent` `solo` `cascade`; agents `implementer` `thinker`; scripts `telemetry.mjs` `grunt-config.mjs`; paths `.grok/parent.md` `.grok/skills/shared` `.rulesync/grunt.config.jsonc` `.rulesync/grunt.config.local.jsonc` `.rulesync/grunt.config.local.jsonc.example`) and any reserved skill dir this package no longer ships. `fs.cpSync` does not remove dest extras; prune is what drops them. Consumer skills/refs/scripts not on those lists stay. Extra `##` headings in shared reference docs (e.g. `law.md`) are kept. `grunt:*` package scripts that differ from a known grunt default stay; `grunt:test:e2e` is added only when a vitest e2e config exists. When a pre-0.11 root `scripts/` holds `guarded-roots.mjs` or `gate-fat-tools.mjs`, upgrade deletes the grunt product names there, removes the dir if that empties it, and rewrites `scripts/<grunt name>` refs in package scripts and `.rulesync/grunt.pipeline.jsonc`; consumer files and refs stay. Check steps omitted from the dest pipeline (`.rulesync/scripts/pipeline.mjs`, or the legacy root copy) seed `.rulesync/grunt.pipeline.jsonc`. doctor/listen/speak call the consumer's root `scripts/lib/env.mjs` `loadEnv` when that file exists.
