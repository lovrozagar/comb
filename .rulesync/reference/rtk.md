---
tags: [rtk]
---

# RTK

Shell stdout compression. PreToolUse: Bash → `rtk <cmd>`. Not Read/Grep/Glob/prompts/images.

Grok PostToolUse is observe-only — do not attempt output scrub; compress via RTK / spawn / isolation facts only.

## Commands

ls · tree · read · smart · git · gh · glab · clasp · aws · psql · pnpm · err · test · json · deps · env · find · diff · log · dotnet · docker · kubectl · oc · summary · grep · rg · init · wget · wc · gain · cc-economics · config · jest · vitest · prisma · tsc · next · lint · prettier · format · playwright · lightpanda · cargo · npm · npx · curl · discover · session · telemetry · learn · run · proxy · pipe · trust · untrust · verify · ruff · pytest · mypy · rake · rubocop · rspec · pip · go · gt · golangci-lint · gradlew · mvn · hook-audit · rewrite · hook · help

**git:** diff · log · status · show · add · commit · push · pull · branch · fetch · stash (list show pop apply drop push) · worktree
**cargo:** build · test · clippy · check · install · nextest
**go:** test · build · vet
**docker:** ps · images · logs · compose (ps logs build)
**gh:** pr · issue · run · repo
**clasp:** login · logout · create · clone · pull · push · status · open · run · deploy · logs · setting

Flags: `-v`/`-vv`/`-vvv` · `--ultra-compact` · `--skip-env` · `-h` · `-V`

Unknown cmds passthrough. `rtk run` unfiltered.

**playwright:** test-runner family only — not the browser rail.
**lightpanda:** browser-rail CDP via `scripts/browser.mjs` (not MCP, not env).
