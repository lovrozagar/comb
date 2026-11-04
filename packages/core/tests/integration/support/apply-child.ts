/**
 * An apply run in a process of its own, for a test to signal while Atlas applies (PA4 of r22): the
 * directory and the target come as JSON in argv[2]. It writes its pid first, then each line the
 * apply prints, so a test reads what it said however the process ends.
 */
import { writeSync } from "node:fs"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"

const { devUrl, dir, url } = JSON.parse(process.argv[2] as string) as { devUrl: string; dir: string; url: string }

await loadPostgresParser()
writeSync(1, `pid ${process.pid}\n`)
await applyWithAtlas({
	approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
	dir,
	print: (line) => writeSync(1, `${line}\n`),
	target: { devUrl, lockTimeout: "5s", schema: "public", url },
})
writeSync(1, "applied\n")
