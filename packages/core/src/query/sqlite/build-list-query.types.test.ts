/**
 * The README's list flow, compiled as a consumer compiles it: the schema's parsed output goes
 * straight into buildListQuery under the strictest flags a consumer might set (meta-contract §10).
 */
import path from "node:path"
import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"

const QUERY = path.resolve(import.meta.dirname, "..")

function diagnostics(source: string): string[] {
	const project = new Project({
		compilerOptions: {
			allowImportingTsExtensions: true,
			exactOptionalPropertyTypes: true,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			noPropertyAccessFromIndexSignature: true,
			noUncheckedIndexedAccess: true,
			skipLibCheck: true,
			strict: true,
			target: ts.ScriptTarget.ESNext,
		},
	})
	project.createSourceFile(path.join(QUERY, "__consumer__.ts"), source)
	project.resolveSourceFileDependencies()
	return project
		.getPreEmitDiagnostics()
		.filter((d) => d.getSourceFile()?.getBaseName() === "__consumer__.ts")
		.map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n"))
}

/* a compile test builds a TypeScript program; under a full parallel run that takes seconds */
const COMPILE_TIMEOUT_MS = 60_000

describe("the README list flow under exactOptionalPropertyTypes (A-Med)", () => {
	it(
		"hands the schema's output to buildListQuery as is",
		() => {
			const source = `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createListQuerySchema } from "./schema.ts"
import { buildListQuery } from "./sqlite/build-list-query.ts"
const post = sqliteTable("post", { created_at: integer("created_at").notNull(), id: text("id").primaryKey(), title: text("title") })
const schema = createListQuerySchema({ filter: { title: "string" }, search: ["title"], sort: ["created_at"] })
const parsed = schema.parse({})
export const query = buildListQuery({ parsed, table: post })
`
			expect(diagnostics(source)).toEqual([])
		},
		COMPILE_TIMEOUT_MS,
	)
})
