/**
 * `comb migrate apply`, `check`, `baseline` and `status` on a D1 database: comb checks, wrangler
 * applies and records (migrate/core/d1-history.ts). The database comes from comb.migrate.config.ts
 * (its wrangler config and environment with it), or, in a project without one, is the binding the
 * command names in the wrangler config of the working folder.
 */
import fs from "node:fs"
import path from "node:path"
import { approveMigration } from "../migrate/core/approval.ts"
import {
	applyD1,
	baselineD1,
	type D1Target,
	findWranglerConfig,
	type ReadConfig,
	statusD1,
} from "../migrate/core/d1-history.ts"
import { run as runProcess } from "../migrate/core/process.ts"
import { createD1Provider, wranglerFlags } from "../migrate/drivers/d1.ts"
import type { D1ProviderConfig } from "../migrate/types.ts"
import type { ParsedArgs } from "./args.ts"
import type { MigrateTarget } from "./migrate-target.ts"
import { checkPassed, CliError, type CliIo } from "./output.ts"

type D1Mode = "apply" | "baseline" | "check" | "status"

/** One D1 command: what it was asked, and where it reports */
type D1Request = { args: ParsedArgs; db: string; io: CliIo; mode: D1Mode }

/* a variable, so a consumer's tsc never resolves wrangler, an optional peer */
const WRANGLER = "wrangler"

/** wrangler's config reader, or the package to install when wrangler is missing; `specifier` is for tests */
async function wranglerReader(specifier: string = WRANGLER): Promise<ReadConfig> {
	try {
		const wrangler = (await import(specifier)) as { unstable_readConfig: ReadConfig }
		return (args) => wrangler.unstable_readConfig(args)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error
		throw new CliError(
			"comb needs wrangler (>=4.147.0 <5) to migrate a D1 database; run comb through a package script, or install wrangler",
		)
	}
}

/** The D1 database comb.migrate.config.ts resolved, or the binding named on the command line */
function d1Config(request: D1Request, resolved: MigrateTarget | undefined): { config: D1ProviderConfig; dir: string } {
	const { args, db, io } = request
	if (resolved?.provider.type === "d1") {
		if (args.options["local"] !== undefined)
			throw new CliError("--local applies without comb.migrate.config.ts; set local: true on its d1 provider")
		const wranglerConfig = resolved.provider.wranglerConfig ?? findWranglerConfig(resolved.configDir)
		if (wranglerConfig === undefined)
			throw new CliError(`no wrangler config next to comb.migrate.config.ts; set wranglerConfig on ${db}'s d1 provider`)
		return { config: { ...resolved.provider, wranglerConfig }, dir: resolved.migrationsDir }
	}
	if (args.options["env"] !== undefined)
		throw new CliError("-e/--env needs comb.migrate.config.ts to define environments")
	const wranglerConfig = findWranglerConfig(io.cwd)
	if (wranglerConfig === undefined) throw new CliError(`no wrangler config in ${io.cwd} binds the D1 database ${db}`)
	const local = args.options["local"] === true
	const config: D1ProviderConfig = { databaseId: db, databaseName: db, local, type: "d1", wranglerConfig }
	return { config, dir: path.resolve(io.cwd, (args.options["dir"] as string | undefined) ?? "atlas-migrations") }
}

/** Run `request.mode` on the D1 database `resolved` names, or `request.db` when the project has no migrate config */
export { wranglerReader }

export async function migrateD1(request: D1Request, resolved: MigrateTarget | undefined): Promise<void> {
	const { args, io, mode } = request
	if (args.options["file"] !== undefined)
		throw new CliError("--file does not apply to a D1 database: wrangler applies its migrations directory")
	const { config, dir } = d1Config(request, resolved)
	if (!fs.existsSync(dir)) throw new CliError(`Migrations dir not found: ${dir}`)
	/* wrangler takes the binding or the database_name: the provider's databaseName, whatever the environment is called */
	const name = config.databaseName
	const exec = io.run ?? runProcess
	const conn = await createD1Provider(config, exec).connect({ migrationsDir: dir, name, provider: config })
	const target: D1Target = {
		conn,
		exec,
		flags: wranglerFlags(config),
		migrationsDir: dir,
		name,
		wranglerConfig: config.wranglerConfig as string,
		wranglerEnv: config.wranglerEnv,
	}
	const read = await wranglerReader()
	const label = resolved?.label ?? name
	if (mode === "status") return statusD1(target, read, io.out)
	if (mode === "baseline") {
		io.out(`\nBaseline done: ${(await baselineD1(target, read, io.out)).length} marked`)
		return
	}
	const yes = args.options["yes"] === true
	const approve = (migration: Parameters<typeof approveMigration>[0]) =>
		approveMigration(migration, { confirm: io.confirm, target: label, yes })
	const names = await applyD1(target, { approve, checkOnly: mode === "check", print: io.out, read })
	if (mode === "check") io.out(checkPassed(names))
	else io.out(names.length === 0 ? "No migrations to apply" : `\nDone: ${names.length} applied`)
}
