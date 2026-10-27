/**
 * `comb migrate apply`, `baseline` and `status` on a Postgres database: Atlas applies and records,
 * comb snapshots, classifies and approves (migrate/core/atlas-apply.ts). The URL's warnings (TLS,
 * poolers) are printed before anything runs.
 */
import fs from "node:fs"
import { approveMigration } from "../migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas, statusWithAtlas } from "../migrate/core/atlas-apply.ts"
import { pgUrlProblems } from "../migrate/core/atlas-target.ts"
import { loadPostgresParser } from "../migrate/core/pg-parser.ts"
import type { ResolvedPostgresProviderConfig } from "../migrate/types.ts"
import type { ParsedArgs } from "./args.ts"
import type { MigrateTarget } from "./migrate-target.ts"
import { checkPassed, CliError, type CliIo, type MigrateOutcome } from "./output.ts"

type PostgresTarget = MigrateTarget & { provider: ResolvedPostgresProviderConfig }

/** Run `mode` on the Postgres database `target` through Atlas */
export async function migratePostgres(
	mode: "apply" | "baseline" | "check" | "status",
	target: PostgresTarget,
	{ args, io }: { args: ParsedArgs; io: CliIo },
): Promise<MigrateOutcome> {
	for (const flag of ["file", "local"]) {
		if (args.options[flag] !== undefined)
			throw new CliError(`--${flag} does not apply to a Postgres database: Atlas applies its migrations directory`)
	}
	if (!fs.existsSync(target.migrationsDir)) throw new CliError(`Migrations dir not found: ${target.migrationsDir}`)
	for (const warning of pgUrlProblems(target.provider, { url: true }).warnings) io.err(`Warning: ${warning}`)
	const options = { dir: target.migrationsDir, exec: io.run, print: io.out, target: target.provider }
	if (mode === "baseline") {
		/* baseline replays the history as the statements Postgres runs (M75) */
		await loadPostgresParser()
		io.out(`\nBaseline done: ${baselineWithAtlas(options).length} marked`)
		return { applied: [], pending: [] }
	}
	if (mode === "status") return statusWithAtlas(options)
	const yes = args.options["yes"] === true
	const approve = (migration: Parameters<typeof approveMigration>[0]) =>
		approveMigration(migration, { confirm: io.confirm, dialect: "postgres", target: target.label, yes })
	const applied = await applyWithAtlas({ ...options, approve, checkOnly: mode === "check" })
	if (mode === "check") {
		io.out(checkPassed(applied))
		return { applied: [], pending: applied }
	}
	if (applied.length > 0) io.out(`\nDone: ${applied.length} applied`)
	return { applied, pending: [] }
}
