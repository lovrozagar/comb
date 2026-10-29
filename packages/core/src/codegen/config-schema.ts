/**
 * The Zod schema comb.config.ts is held to as comb loads it (K14 of the 0.15.0 review): every object
 * is strict, so a misspelled key is refused by name instead of falling back to its default, which a
 * config built through a helper passes `tsc --strict` with. Typed with CodegenConfig, so the two
 * cannot drift.
 */
import * as z from "zod"
import { type CodegenConfig, GENERATORS } from "./config.ts"

/* built on use, as the migrate config's schema is: module scope stays free of work */
const databaseSchema = () =>
	z.strictObject({
		dialect: z.enum(["postgres", "sqlite"]).optional(),
		driver: z.enum(["bun-sqlite", "d1", "libsql", "neon", "turso"]).optional(),
		filePrefix: z.string().min(1).optional(),
		fts: z
			.record(z.string(), z.strictObject({ columns: z.array(z.string().min(1)), tokenizer: z.string().optional() }))
			.optional(),
		generators: z.array(z.enum(GENERATORS)).optional(),
		output: z.partialRecord(z.enum([...GENERATORS, "default"]), z.string().min(1)).optional(),
		tables: z.string().min(1),
	})

/** comb.config.ts's schema */
const codegenConfigSchema = (): z.ZodType<CodegenConfig> =>
	z.strictObject({ databases: z.record(z.string(), databaseSchema()) })

export { codegenConfigSchema }
