/**
 * The Zod schema comb.config.ts is held to as comb loads it: every object
 * is strict, so a misspelled key is refused by name instead of falling back to its default, which a
 * config built through a helper passes `tsc --strict` with. Typed with CodegenConfig, so the two
 * cannot drift.
 */
import * as z from "zod"
import { nonBlank } from "../blank.ts"
import { type CodegenConfig, GENERATORS } from "./config.ts"

/* built on use, as the migrate config's schema is: module scope stays free of work */
const databaseSchema = () =>
	z.strictObject({
		dialect: z.enum(["postgres", "sqlite"]).optional(),
		driver: z.enum(["bun-sqlite", "d1", "libsql", "neon", "turso"]).optional(),
		filePrefix: nonBlank().optional(),
		fts: z
			.record(nonBlank(), z.strictObject({ columns: z.array(nonBlank()).min(1), tokenizer: z.string().optional() }))
			.optional(),
		generators: z.array(z.enum(GENERATORS)).optional(),
		/* an output set to undefined is that generator's left out, as codegen reads it */
		output: z.partialRecord(z.enum([...GENERATORS, "default"]), nonBlank().optional()).optional(),
		partitions: z.record(nonBlank(), z.array(nonBlank()).min(1)).optional(),
		tables: nonBlank(),
	})

/** comb.config.ts's schema */
const codegenConfigSchema = (): z.ZodType<CodegenConfig> =>
	z.strictObject({
		/* An empty map generates nothing, and CI would pass on stale files, as comb.migrate.config.ts refuses */
		databases: z
			.record(nonBlank(), databaseSchema())
			.refine((databases) => Object.keys(databases).length > 0, { message: "databases declares no database" }),
	})

export { codegenConfigSchema }
