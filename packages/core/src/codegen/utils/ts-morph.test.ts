import { describe, expect, it } from "vitest"
import {
	createProject,
	createProjectFromTablesDir,
	extractDbName,
	getTableName,
	getTablesImportPath,
	importPathFrom,
	tableSourceFiles,
} from "./ts-morph.ts"

describe("extractDbName", () => {
	it("extracts from db.core.tables.ts pattern", () => {
		expect(extractDbName("/some/path/db.core.tables.ts")).toBe("core")
	})

	it("extracts from saas pattern: csvme.db.shard.tables.gen.ts", () => {
		expect(extractDbName("/path/csvme.db.shard.tables.gen.ts")).toBe("shard")
	})

	it("returns 'db' for plain tables.ts", () => {
		expect(extractDbName("/path/tables.ts")).toBe("db")
		/* the README's layout: src/db/core.tables.ts */
		expect(extractDbName("/path/src/db/core.tables.ts")).toBe("core")
	})

	it("extracts from nested path", () => {
		expect(extractDbName("/a/b/c/db.auth.tables.ts")).toBe("auth")
	})
})

describe("getTablesImportPath", () => {
	it("returns relative path without .ts extension", () => {
		expect(getTablesImportPath("/path/db.core.tables.ts")).toBe("./db.core.tables")
	})

	it("handles nested filename", () => {
		expect(getTablesImportPath("/a/b/my.db.shard.tables.gen.ts")).toBe("./my.db.shard.tables.gen")
	})
})
describe("extractDbName — naming conventions", () => {
	const cases: Array<[string, string]> = [
		["/x/app.db-core.tables.ts", "core"],
		["/x/app.db.growth.tables.gen.ts", "growth"],
		["/x/db.core.tables.ts", "core"],
		["/x/whatever.ts", "db"],
		["/x/tables.ts", "db"],
	]

	for (const [input, expected] of cases) {
		it(`reads ${expected} from ${input.split("/").pop()}`, () => {
			expect(extractDbName(input)).toBe(expected)
		})
	}

	it("prefers the prefixed pattern over the others", () => {
		expect(extractDbName("/x/db.wrong.db-right.tables.ts")).toBe("right")
	})
})

describe("getTablesImportPath", () => {
	it("drops the extension and makes the path relative to the same directory", () => {
		expect(getTablesImportPath("/a/b/db.core.tables.ts")).toBe("./db.core.tables")
		expect(getTablesImportPath("db.core.tables.gen.ts")).toBe("./db.core.tables.gen")
	})
})

describe("project helpers", () => {
	it("reads a tables file's directory, without dependencies or build output", async () => {
		const fs = await import("node:fs")
		const os = await import("node:os")
		const path = await import("node:path")
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-project-"))
		try {
			for (const file of ["db.x.tables.ts", "shared/enums.ts", "node_modules/pkg/index.ts", "dist/out.ts"]) {
				fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
				fs.writeFileSync(path.join(dir, file), "export const x = 1\n")
			}
			const names = createProjectFromTablesDir(path.join(dir, "db.x.tables.ts"))
				.getSourceFiles()
				.map((f) => path.relative(dir, f.getFilePath()))
				.sort()
			expect(names).toEqual(["db.x.tables.ts", "shared/enums.ts"])
		} finally {
			fs.rmSync(dir, { force: true, recursive: true })
		}
	})

	it("names a table by its first argument, or its variable when it has none", () => {
		const file = createProject().createSourceFile(
			"x.ts",
			'const a = sqliteTable("posts", {})\nconst b = sqliteTable()\nconst c = 1',
		)
		const init = (name: string) => file.getVariableDeclarationOrThrow(name).getInitializerOrThrow()
		expect(getTableName("a", init("a"))).toBe("posts")
		expect(getTableName("b", init("b"))).toBe("b")
		expect(getTableName("c", init("c"))).toBe("c")
	})
})

describe("tableSourceFiles", () => {
	it("follows re-exports from the tables file once each, cycles included, past local exports and packages, and leaves the rest of the folder", () => {
		const project = createProject()
		project.createSourceFile(
			"/p/db.x.tables.ts",
			'export * from "./a"\nexport { b } from "./b"\nexport * from "drizzle-orm"\nconst t = 1\nexport { t }',
		)
		project.createSourceFile("/p/a.ts", 'export * from "./db.x.tables"\nexport const a = 1')
		project.createSourceFile("/p/b.ts", "export const b = 1")
		project.createSourceFile("/p/db.y.tables.ts", "export const y = 1")
		const names = tableSourceFiles(project, "/p/db.x.tables.ts").map((f) => f.getBaseName())
		expect(names).toEqual(["db.x.tables.ts", "a.ts", "b.ts"])
		expect(tableSourceFiles(project, "/p/missing.ts")).toEqual([])
	})
})

describe("importPathFrom", () => {
	it("imports a sibling with ./, a file elsewhere with ../, never with .ts", () => {
		expect(importPathFrom("/p/src/gen/orm.gen.ts", "/p/src/gen/db.relations.gen.ts")).toBe("./db.relations.gen")
		expect(importPathFrom("/p/src/gen/orm.gen.ts", "/p/src/db/db.core.tables.ts")).toBe("../db/db.core.tables")
	})
})
