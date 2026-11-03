/**
 * C3 of r18, as a class: generated code names every global through `globalThis` (C2 of r17), as an
 * app's schema module may export a value named `Array`, `Set` or any other, which the generated file
 * then imports in the global's place. Every value a generated file names must be its own: declared
 * in it, imported by it, or `globalThis`. A bare global fails here, before it ships.
 * C4 of r20: and it imports nothing it never names, which a consumer's noUnusedLocals refuses, a
 * schema named as a shared one is (`jsonValueSchemaStrict`) among them. C3 of r21: a plain JSON
 * column, whose schema is hoisted whole, imports that shared name and not `jsonValueSchema`.
 */
import fs from "node:fs"
import path from "node:path"
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { codegen, project, useProjects } from "../integration/support/codegen-project.ts"

useProjects()

const CONFIG = `export default { databases: { core: { tables: "./src/db/db.core.tables.ts" } } }\n`

/* a column of every kind a builder writes code for: arrays of several dimensions, JSON, enums, a state machine */
const TABLES = {
	postgres: `import * as z from "zod"
import { cidr, integer, json, jsonb, pgTable } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
export const docSchema = z.object({ a: z.string() })
export const jsonValueSchemaStrict = z.object({ b: z.string() })
export const cidrSchemaDoc = z.object({ c: z.string() })
export const timestampSchemaDoc = z.object({ d: z.string() })
export const grid = pgTable("grid", {
	id: c.id("grd"),
	cells: integer("cells").array("[][]"),
	tags: c.text("tags").array(),
	doc: c.json("doc", docSchema, { maxBytes: 1024 }),
	strict: c.json("strict", jsonValueSchemaStrict),
	raw: jsonb("raw"),
	loose: json("loose").notNull(),
	net: cidr("net"),
	state: c.enum("state", ["draft", "live", "gone"], { initial: "draft", terminal: ["gone"], transitions: { draft: ["live"], live: ["gone"] } }).notNull(),
	pw: c.text("pw", { password: true }),
	email: c.text("email", { email: true, trim: true }),
	url: c.text("url", { url: true }),
	count: c.integer("count", { min: 0 }),
	ratio: c.real("ratio"),
	at: c.timestamp("at"),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
	deleted_at: c.deletedAt("deleted_at"),
})
`,
	sqlite: `import * as z from "zod"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const docSchema = z.object({ a: z.string() })
export const cidrSchemaDoc = z.object({ c: z.string() })
export const timestampSchemaDoc = z.object({ d: z.string() })
export const item = sqliteTable("item", {
	id: c.id("itm"),
	doc: c.json("doc", docSchema),
	cidrDoc: c.json("cidr_doc", cidrSchemaDoc),
	stampDoc: c.json("stamp_doc", timestampSchemaDoc).notNull(),
	raw: text("raw", { mode: "json" }),
	state: c.enum("state", ["draft", "live"]).notNull(),
	name: c.text("name", { name: true, lowercase: true }),
	flag: c.boolean("flag"),
	count: c.integer("count"),
	at: c.timestamp("at"),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
})
`,
}

/** Each value `file` names that resolves outside it, other than `globalThis`, with its line */
function freeValues(program: ts.Program, file: ts.SourceFile): string[] {
	const checker = program.getTypeChecker()
	const free: string[] = []
	const visit = (node: ts.Node): void => {
		if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return
		if (ts.isIdentifier(node) && isValueReference(node) && node.text !== "globalThis") {
			const declarations = checker.getSymbolAtLocation(node)?.declarations ?? []
			if (declarations.length === 0 || declarations.some((declaration) => declaration.getSourceFile() !== file)) {
				const { line } = file.getLineAndCharacterOfPosition(node.getStart())
				free.push(`${node.text} at line ${line + 1}`)
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(file)
	return free
}

/* the nodes whose `name` is a property, a key or what they declare, never a value they reference */
const NAMING: ReadonlyArray<(node: ts.Node) => boolean> = [
	ts.isBindingElement,
	ts.isExportSpecifier,
	ts.isFunctionDeclaration,
	ts.isInterfaceDeclaration,
	ts.isMethodDeclaration,
	ts.isParameter,
	ts.isPropertyAccessExpression,
	ts.isPropertyAssignment,
	ts.isPropertySignature,
	ts.isTypeAliasDeclaration,
	ts.isVariableDeclaration,
]

/** Whether `id` names a value where it stands: not a property, a declaration's own name, or a key */
function isValueReference(id: ts.Identifier): boolean {
	const { parent } = id
	if (ts.isQualifiedName(parent) || (ts.isBindingElement(parent) && parent.propertyName === id)) return false
	return !NAMING.some((names) => names(parent) && (parent as ts.NamedDeclaration).name === id)
}

describe("generated code names every global through globalThis, and imports only what it names", () => {
	it.each(Object.entries(TABLES))(
		"on %s, in every generated file",
		async (_, tables) => {
			const dir = project({ "comb.config.ts": CONFIG, "src/db/db.core.tables.ts": tables })
			await codegen(dir)
			const files = (fs.readdirSync(dir, { recursive: true }) as string[])
				.filter((name) => name.endsWith(".gen.ts"))
				.map((name) => path.join(dir, name))
			const program = ts.createProgram(files, {
				allowImportingTsExtensions: true,
				module: ts.ModuleKind.Preserve,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				noEmit: true,
				noUnusedLocals: true,
				skipLibCheck: true,
				strict: true,
				target: ts.ScriptTarget.ESNext,
			})
			const free = files.flatMap((name) => {
				const file = program.getSourceFile(name) as ts.SourceFile
				return freeValues(program, file).map((at) => `${path.relative(dir, name)}: ${at}`)
			})
			expect(free).toEqual([])
			/* TS6133 and TS6192: an import nothing reads, as a consumer's noUnusedLocals reports it */
			const unused = program
				.getSemanticDiagnostics()
				.filter(({ code }) => code === 6133 || code === 6192)
				.map(
					({ file, messageText }) =>
						`${path.relative(dir, file?.fileName ?? "")}: ${ts.flattenDiagnosticMessageText(messageText, " ")}`,
				)
			expect(unused).toEqual([])
		},
		120_000,
	)
})
