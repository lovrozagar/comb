import { describe, expect, it } from "vitest"
import type { CombEntityMetaInput } from "../../../meta.ts"
import type { ImportRef } from "../../analyzer-types.ts"
import type { FieldInfo, SharedSchema, TableInfo } from "./dto-types.ts"
import { type EntityFileOptions, generateEntityFile, schemaImportLines } from "./entity-file.ts"

const NONE = { createdAt: false, deletedAt: false, updatedAt: false }

function table(fields: FieldInfo[], overrides: Partial<TableInfo> = {}): TableInfo {
	return {
		combMeta: null,
		fields,
		hasTimestamps: NONE,
		name: "blog_post",
		needsSharedMeta: false,
		timestampStyle: "snake_case",
		...overrides,
	}
}

const field = (key: string, type: FieldInfo["type"], zodType: string): FieldInfo => ({ key, type, zodType })

function file(t: TableInfo, options: Partial<EntityFileOptions> = {}): string {
	return generateEntityFile(t, {
		entityDir: "/app/dtos/blog-post",
		schemaImports: [],
		sharedSchemas: new Map(),
		...options,
	})
}

const META: CombEntityMetaInput = {
	generated: ["id"],
	identity: "id",
	immutable: ["id"],
	kind: "entity",
	name: "blog_post",
	softDelete: null,
	states: { column: "status", initial: null, terminal: ["done"], values: ["open", "done"] },
	partialUniqueIndexes: [{ columns: ["slug"], name: "post_slug_live", where: "deleted_at IS NULL" }],
	tenantColumn: null,
	uniqueIndexes: [{ columns: ["slug"], name: "post_slug" }],
}

describe("schemaImportLines", () => {
	it("imports each name from its module, relative to the entity file for project files", () => {
		const refs: ImportRef[] = [
			{ from: "./schemas", imported: "prefs", name: "prefs", path: "/app/schemas.ts" },
			{ from: "./schemas", imported: "theme", name: "localTheme", path: "/app/schemas.ts" },
			{ from: "@app/enums", imported: "ROLES", name: "ROLES", path: null },
			{ from: "./all", imported: "*", name: "all", path: "/app/all.ts" },
			{ from: "@app/def", imported: "default", name: "def", path: null },
			{ from: "./in-dir", imported: "x", name: "x", path: "/app/dtos/blog-post/in-dir.ts" },
		]
		expect(schemaImportLines(refs, "/app/dtos/blog-post")).toEqual([
			'import * as all from "../../all"',
			'import { prefs, theme as localTheme } from "../../schemas"',
			'import { x } from "./in-dir"',
			'import def from "@app/def"',
			'import { ROLES } from "@app/enums"',
		])
	})
})

describe("generateEntityFile", () => {
	it("writes each schema type it has fields for, with the stamp on read and the types after", () => {
		const output = file(
			table([field("id", "read", "z.string()"), field("id", "create", "z.string().optional()")], { combMeta: META }),
			{ metaImportFrom: "@app/comb/meta" },
		)
		expect(output).toContain('import { combMeta } from "@app/comb/meta"')
		expect(output).toContain("export const blogPostDtoReadSchema = z.object({\n\tid: _str,\n}).meta(combMeta({")
		expect(output).toContain('\tstates: {\n\t\tcolumn: "status",\n\t\tinitial: null,\n\t\tterminal: ["done"],')
		expect(output).toContain('\tuniqueIndexes: [{ columns: ["slug"], name: "post_slug" }],')
		/* C7 of the 0.14.1 review: each partial index with its predicate */
		expect(output).toContain(
			'\tpartialUniqueIndexes: [{ columns: ["slug"], name: "post_slug_live", where: "deleted_at IS NULL" }],',
		)
		expect(output).toContain("export const blogPostDtoCreateSchema = z.object({\n\tid: _str.optional(),\n})\n")
		expect(output).not.toContain("blogPostDtoUpdateSchema")
		expect(output).toContain("export type BlogPostDtoRead = z.infer<typeof blogPostDtoReadSchema>")
		expect(output).toContain('import { _str } from "../_shared/index.gen"')
	})

	it("renders a stamp without states or indexes, and the default meta import", () => {
		const output = file(
			table([field("id", "read", "z.string()")], {
				combMeta: { ...META, softDelete: "deleted_at", states: null, uniqueIndexes: [] },
			}),
		)
		expect(output).toContain('import { combMeta } from "@lovrozagar/comb/meta"')
		expect(output).toContain(
			'\tsoftDelete: "deleted_at",\n\tstates: null,\n\ttenantColumn: null,\n\tuniqueIndexes: [],',
		)
	})
})

describe("generateEntityFile: shared module imports", () => {
	it("spreads the shared timestamps into read and readPartial, never a create or update body (F4)", () => {
		const fields = [
			field("title", "read", "z.string()"),
			field("created_at", "read", "timestampSchema"),
			field("created_at", "update", "timestampSchema.optional()"),
			field("title", "update", "z.string().optional()"),
		]
		const output = file(table(fields, { hasTimestamps: { createdAt: true, deletedAt: false, updatedAt: true } }), {
			filePrefix: "db.blog",
		})
		expect(output).toContain("\t...timestampsCreatedUpdatedReadSnakeCase,\n\ttitle: _str,\n")
		expect(output).toContain("blogPostDtoUpdateSchema = z.object({\n\tcreated_at: timestampSchema.optional(),")
		expect(output).toContain(
			'import { _str, timestampSchema, timestampsCreatedUpdatedReadPartialSnakeCase, timestampsCreatedUpdatedReadSnakeCase } from "../_shared/db.blog._shared.gen"',
		)
	})

	it("uses shared constants, local consts for repeated inline schemas, and the shared meta", () => {
		const sharedSchemas = new Map<string, SharedSchema>([
			["z.string().max(9)", { code: "_str.max(9)", count: 3, name: "_z0" }],
		])
		const fields = [
			field("a", "read", "z.string().max(9)"),
			field("b", "read", "z.enum(ROLES)"),
			field("c", "read", "z.enum(ROLES)"),
			field("d", "read", "z.string().max(9).nullable()"),
			field("e", "read", "prefs"),
		]
		const output = file(table(fields, { needsSharedMeta: true }), { sharedSchemas })
		expect(output).toContain("const _l0 = z.enum(ROLES)\n")
		expect(output).toContain("\ta: _z0,\n\tb: _l0,\n\tc: _l0,\n\td: _z0.nullable(),\n\te: prefs,\n")
		expect(output).toContain('import { _m, _z0 } from "../_shared/index.gen"')
	})

	it("imports nothing from _shared when nothing comes from there", () => {
		expect(file(table([field("e", "read", "prefs")]))).not.toContain("_shared")
	})
})

/* C2 of r17: an entity file whose own code names comb's predicate imports comb's namespace, from where comb is imported */
describe("generateEntityFile: comb's namespace", () => {
	const guarded = table([field("title", "read", "z.string().refine(comb.isStorableText)")])

	it("imports it only when the file names it, from the configured specifier or comb's own", () => {
		expect(file(guarded, { combFrom: "~/comb" })).toContain('import * as comb from "~/comb"')
		expect(file(guarded)).toContain('import * as comb from "@lovrozagar/comb"')
		expect(file(table([field("title", "read", "z.string()")]))).not.toContain("import * as comb")
	})
})
