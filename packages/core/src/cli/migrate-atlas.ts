/**
 * `comb migrate apply`, `baseline` and `status` on a Postgres database: Atlas applies and records,
 * comb snapshots, classifies and approves (migrate/core/atlas-apply.ts). The URL's warnings (TLS,
 * poolers) are printed before anything runs.
 */
import { approveMigration } from "../migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas, statusWithAtlas } from "../migrate/core/atlas-apply.ts"
import { pgUrlProblems } from "../migrate/core/atlas-target.ts"
import { loadPostgresParser } from "../migrate/core/pg-parser.ts"
import type { ResolvedPostgresProviderConfig } from "../migrate/types.ts"
import type { ParsedArgs } from "./args.ts"
import { type MigrateTarget, refuseBlank, refuseNoDir } from "./migrate-target.ts"
import { checkPassed, CliError, type CliContext, type MigrateOutcome } from "./output.ts"

type PostgresTarget = MigrateTarget & { provider: ResolvedPostgresProviderConfig }

/** Run `mode` on the Postgres database `target` through Atlas */
export async function migratePostgres(
	mode: "apply" | "baseline" | "check" | "status",
	target: PostgresTarget,
	{ args, io }: { args: ParsedArgs; io: CliContext },
): Promise<MigrateOutcome> {
	for (const flag of ["file", "local"]) {
		if (args.options[flag] !== undefined)
			throw new CliError(`--${flag} does not apply to a Postgres database: Atlas applies its migrations directory`)
	}
	if (args.options["hashes"] !== undefined)
		throw new CliError(
			"--hashes is for a D1 database, whose history records names alone: Atlas records each file's hash as it applies it",
		)
	refuseNoDir(target.migrationsDir)
	/* where init's starter reads the url, which an unset DATABASE_URL leaves blank */
	refuseBlank(target, { url: target.provider.url }, "; init's starter reads it from DATABASE_URL")
	/* status alone never reaches the dev database */
	if (mode !== "status") refuseBlank(target, { devUrl: target.provider.devUrl })
	for (const warning of pgUrlProblems(target.provider, { url: true }).warnings) io.err(`Warning: ${warning}`)
	const options = {
		dir: target.migrationsDir,
		exec: io.run,
		print: io.out,
		readLive: io.readPgObjects,
		readReplay: io.replayPgHistory,
		readyDev: io.readyPgDev,
		target: target.provider,
	}
	if (mode === "baseline") {
		/* baseline replays the history as the statements Postgres runs */
		await loadPostgresParser()
		io.out(`\nBaseline done: ${(await baselineWithAtlas(options)).length} marked`)
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
