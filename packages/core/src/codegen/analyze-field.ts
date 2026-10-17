/**
 * One column of a table definition, read from its initializer's text: the helper, the SQL name,
 * keys, references and annotations every generator needs. Enum values and states need the AST
 * and are read by analyze-table.
 */
import type { FieldMeta, ForeignKeyRef } from "./analyzer-types.ts"
import { parseFieldConstraints } from "./annotations.ts"
import { extractLength, type IdentifierValues } from "./utils/constraint-text.ts"

/**
 * Extract Drizzle helper name from raw initializer text.
 * e.g. "c.text(...)" -> "text", "c.createdAt(...)" -> "createdAt"
 */
function extractDrizzleHelper(raw: string): string {
	const match = raw.match(/c\.(\w+)[<(]/)
	return match?.[1] ?? "unknown"
}

/**
 * Extract FK reference info from .references(() => table.column, { onDelete: "cascade" })
 */
function extractForeignKey(raw: string, fieldName: string): ForeignKeyRef | null {
	/* the options may be an inline object (whose actions are read) or anything else (which is not) */
	const refMatch =
		/\.references\(\s*\(\)\s*(?::\s*[\w.]+\s*)?=>\s*(?<refTable>\w+)\.(?<refColumn>\w+)(?:,\s*\{(?<options>[^}]*)\})?/.exec(
			raw,
		)
	const ref = refMatch?.groups as { options?: string; refColumn: string; refTable: string } | undefined
	if (ref === undefined) return null

	const optionsStr = ref.options ?? ""
	/* Drizzle's referential actions include multi-word forms — "set null",
	   "set default", "no action" — so \w+ would silently drop three of five. */
	const onDeleteMatch = optionsStr.match(/onDelete:\s*["']([^"']+)["']/)
	const onUpdateMatch = optionsStr.match(/onUpdate:\s*["']([^"']+)["']/)

	return {
		column: fieldName,
		onDelete: onDeleteMatch?.[1],
		onUpdate: onUpdateMatch?.[1],
		refColumn: ref.refColumn,
		refTable: ref.refTable,
	}
}

/* c.id(prefix) and c.serialId() always make the column "id"; their argument is no column name */
const ID_HELPERS = /^\s*c\.(?:id|serialId)\s*\(/

/** The SQL column name a column call declares: its first string argument, else the property name. */
function sqlNameOf(key: string, raw: string): string {
	if (ID_HELPERS.test(raw)) return "id"
	const named = /^\s*(?:c\.)?\w+\s*(?:<[^(]*>)?\(\s*(["'`])([^"'`]+)\1/.exec(raw)
	return named?.[2] ?? key
}

/** Parse a single field from a property assignment node. */
export function parseField(key: string, raw: string, identifiers?: IdentifierValues): FieldMeta {
	const constraints = parseFieldConstraints(raw, key, identifiers)
	const isPrimaryKey = /\.primaryKey\(/.test(raw) || ID_HELPERS.test(raw)
	/* c.createdAt and c.updatedAt call .notNull() inside the helper, where the text cannot see it */
	const isNotNull = /\.notNull\(\)/.test(raw) || isPrimaryKey || /^\s*c\.(?:createdAt|updatedAt)\s*\(/.test(raw)
	const drizzleHelper = extractDrizzleHelper(raw)
	const fk = extractForeignKey(raw, key)
	const length = extractLength(raw)

	return {
		constraints,
		drizzleHelper,
		/* read from the AST by the table pass, which can follow consts and imports */
		enumName: null,
		enumValues: null,
		states: null,
		foreignKey: fk,
		isNotNull,
		isPrimaryKey,
		/* read from the AST by the table pass */
		jsonSchemaName: null,
		length,
		name: key,
		raw,
		schemaImports: [],
		sqlName: sqlNameOf(key, raw),
	}
}
