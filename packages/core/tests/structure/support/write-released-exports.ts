/**
 * Regenerates __snapshots__/released-exports.json from a checkout of a release tag, which has its
 * dependencies installed: `bun tests/structure/support/write-released-exports.ts <checkout>/packages/core`.
 * Run it from this package after each release, so the next version's section is held to that release.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { exportsOf } from "./exports-of.ts"

const root = process.argv[2]
if (root === undefined) throw new Error("name the release's packages/core")
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
const target = join(import.meta.dirname, "../__snapshots__/released-exports.json")
writeFileSync(target, `${JSON.stringify({ exports: exportsOf(root), version }, null, "\t")}\n`)
