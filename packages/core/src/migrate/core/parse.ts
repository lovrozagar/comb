/**
 * SQL parsing utilities for migrations
 */
import { createHash } from "crypto"
import type { ExtractedSchema, MigrationClassification, MigrationSafety, ParsedMigration } from "../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   SQL STATEMENT SPLITTING
   ═══════════════════════════════════════════════════════════════════════════ */

export function splitSqlStatements(sql: string): string[] {
	const statements: string[] = []
	let current = ""
	let inString = false
	let stringChar = ""
	let inComment = false
	let commentType: "line" | "block" | null = null

	for (let i = 0; i < sql.length; i++) {
		const char = sql[i]
		const nextChar = sql[i + 1]

		/* Handle comments */
		if (!inString && !inComment) {
			if (char === "-" && nextChar === "-") {
				inComment = true
				commentType = "line"
				current += char
				continue
			}
			if (char === "/" && nextChar === "*") {
				inComment = true
				commentType = "block"
				current += char
				continue
			}
		}

		if (inComment) {
			current += char
			if (commentType === "line" && char === "\n") {
				inComment = false
				commentType = null
			} else if (commentType === "block" && char === "*" && nextChar === "/") {
				current += nextChar
				i++
				inComment = false
				commentType = null
			}
			continue
		}

		/* Handle strings */
		if (!inString && (char === "'" || char === '"')) {
			inString = true
			stringChar = char
			current += char
			continue
		}

		if (inString) {
			current += char
			if (char === stringChar) {
				/* Check for escaped quote */
				if (nextChar === stringChar) {
					current += nextChar
					i++
					continue
				}
				inString = false
			}
			continue
		}

		/* Statement separator */
		if (char === ";") {
			const trimmed = current.trim()
			if (trimmed.length > 0) {
				statements.push(trimmed)
			}
			current = ""
			continue
		}

		current += char
	}

	/* Don't forget last statement */
	const trimmed = current.trim()
	if (trimmed.length > 0) {
		statements.push(trimmed)
	}

	return statements
}

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION HASH
   ═══════════════════════════════════════════════════════════════════════════ */

export function generateMigrationHash(sql: string): string {
	/* Normalize: remove comments, collapse whitespace */
	const normalized = sql
		.replace(/--[^\n]*\n/g, "\n")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.trim()

	return createHash("sha256").update(normalized).digest("hex")
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEMA EXTRACTION
   ═══════════════════════════════════════════════════════════════════════════ */

export function extractSchema(sql: string): ExtractedSchema {
	const tables = new Map<string, string[]>()
	const indexes: string[] = []
	const droppedTables: string[] = []

	const statements = splitSqlStatements(sql)

	for (const stmt of statements) {
		/* CREATE TABLE */
		const createTableMatch = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(/i)
		if (createTableMatch?.[1]) {
			const tableName = createTableMatch[1]
			/* Find outermost parenthesized body, handling nested parens like DEFAULT (unixepoch() * 1000) */
			const openIdx = stmt.indexOf("(")
			if (openIdx !== -1) {
				let depth = 1
				let closeIdx = openIdx + 1
				for (; closeIdx < stmt.length && depth > 0; closeIdx++) {
					if (stmt[closeIdx] === "(") depth++
					else if (stmt[closeIdx] === ")") depth--
				}
				const body = stmt.substring(openIdx + 1, closeIdx - 1)
				/* Split on commas not inside parentheses */
				const columnDefs: string[] = []
				let segDepth = 0
				let segStart = 0
				for (let ci = 0; ci < body.length; ci++) {
					if (body[ci] === "(") segDepth++
					else if (body[ci] === ")") segDepth--
					else if (body[ci] === "," && segDepth === 0) {
						columnDefs.push(body.substring(segStart, ci).trim())
						segStart = ci + 1
					}
				}
				columnDefs.push(body.substring(segStart).trim())
				const columnNames = columnDefs
					.map((def) => {
						const match = def.match(/^["'`]?(\w+)["'`]?\s+/i)
						return match?.[1]
					})
					.filter(
						(name): name is string =>
							!!name &&
							!name.toUpperCase().startsWith("CONSTRAINT") &&
							!name.toUpperCase().startsWith("PRIMARY") &&
							!name.toUpperCase().startsWith("FOREIGN") &&
							!name.toUpperCase().startsWith("UNIQUE") &&
							!name.toUpperCase().startsWith("CHECK"),
					)
				tables.set(tableName, columnNames)
			} else {
				tables.set(tableName, [])
			}
		}

		/* CREATE INDEX */
		const createIndexMatch = stmt.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i)
		if (createIndexMatch?.[1]) {
			indexes.push(createIndexMatch[1])
		}

		/* DROP TABLE */
		const dropTableMatch = stmt.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i)
		if (dropTableMatch?.[1]) {
			droppedTables.push(dropTableMatch[1])
			tables.delete(dropTableMatch[1])
		}

		/* ALTER TABLE ... RENAME TO ... (Atlas temp table pattern) */
		const renameMatch = stmt.match(/ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+RENAME\s+TO\s+["'`]?(\w+)["'`]?/i)
		if (renameMatch?.[1] && renameMatch?.[2]) {
			const oldName = renameMatch[1]
			const newName = renameMatch[2]
			const columns = tables.get(oldName)
			if (columns) {
				tables.delete(oldName)
				tables.set(newName, columns)
			}
		}
	}

	return { droppedTables, indexes, tables }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DROP STATEMENT EXTRACTION
   ═══════════════════════════════════════════════════════════════════════════ */

export function extractDropStatements(sql: string): string[] {
	const drops: string[] = []
	const statements = splitSqlStatements(sql)

	for (const stmt of statements) {
		const upper = stmt.toUpperCase()

		if (upper.includes("DROP TABLE")) {
			const match = stmt.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i)
			if (match?.[1]) {
				drops.push(`DROP TABLE ${match[1]}`)
			}
		}

		if (upper.includes("DROP COLUMN")) {
			const match = stmt.match(/ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+DROP\s+COLUMN\s+["'`]?(\w+)["'`]?/i)
			if (match?.[1] && match?.[2]) {
				drops.push(`DROP COLUMN ${match[1]}.${match[2]}`)
			}
		}

		if (upper.includes("DROP INDEX")) {
			const match = stmt.match(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i)
			if (match?.[1]) {
				drops.push(`DROP INDEX ${match[1]}`)
			}
		}
	}

	return drops
}

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION CLASSIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */

export function classifyMigration(sql: string): MigrationClassification {
	const statements = splitSqlStatements(sql)
	const unsafeStatements: string[] = []

	for (const stmt of statements) {
		const upper = stmt.toUpperCase()

		/* Unsafe: DROP TABLE, DROP COLUMN, TRUNCATE */
		if (upper.includes("DROP TABLE") && !upper.includes("IF EXISTS")) {
			unsafeStatements.push(stmt.slice(0, 80) + (stmt.length > 80 ? "..." : ""))
		}
		if (upper.includes("DROP COLUMN")) {
			unsafeStatements.push(stmt.slice(0, 80) + (stmt.length > 80 ? "..." : ""))
		}
		if (upper.includes("TRUNCATE")) {
			unsafeStatements.push(stmt.slice(0, 80) + (stmt.length > 80 ? "..." : ""))
		}

		/* Unsafe: Removing NOT NULL without default */
		if (upper.includes("ALTER") && upper.includes("NOT NULL") && !upper.includes("DEFAULT")) {
			unsafeStatements.push(stmt.slice(0, 80) + (stmt.length > 80 ? "..." : ""))
		}
	}

	let safety: MigrationSafety = "safe"
	if (unsafeStatements.length > 0) {
		safety = "unsafe"
	} else if (sql.toUpperCase().includes("DROP")) {
		safety = "cautious"
	}

	return { safety, unsafeStatements }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAKE IDEMPOTENT
   ═══════════════════════════════════════════════════════════════════════════ */

export function makeIdempotent(statements: string[]): string[] {
	return statements.map((stmt) => {
		const trimmed = stmt.trim()

		/* CREATE INDEX → CREATE INDEX IF NOT EXISTS */
		if (/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i.test(trimmed)) {
			return trimmed.replace(/^(CREATE\s+)(UNIQUE\s+)?(INDEX\s+)/i, "$1$2$3IF NOT EXISTS ")
		}

		/* DROP INDEX → DROP INDEX IF EXISTS */
		if (/^DROP\s+INDEX\s+(?!IF\s+EXISTS)/i.test(trimmed)) {
			return trimmed.replace(/^(DROP\s+INDEX\s+)/i, "$1IF EXISTS ")
		}

		return stmt
	})
}

/* ═══════════════════════════════════════════════════════════════════════════
   PARSE MIGRATION
   ═══════════════════════════════════════════════════════════════════════════ */

export function parseMigration(sql: string, filename: string): ParsedMigration {
	const hash = generateMigrationHash(sql)
	const expected = extractSchema(sql)
	const statements = makeIdempotent(splitSqlStatements(sql))
	const drops = extractDropStatements(sql)
	const classification = classifyMigration(sql)

	return {
		classification,
		drops,
		expected,
		filename,
		hash,
		sql,
		statements,
	}
}
