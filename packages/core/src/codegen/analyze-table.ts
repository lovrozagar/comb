/**
 * One table definition: its fields, its options (composite key, unique indexes, CHECKs) and the
 * facts derived from them.
 */
import {
	type CallExpression,
	type Node,
	type ObjectLiteralExpression,
	SyntaxKind,
	type VariableDeclaration,
} from "ts-morph"
import { parseField } from "./analyze-field.ts"
import { constraintsAt } from "./utils/constraint-reader.ts"
import { readTableOptions } from "./analyze-options.ts"
import type { FieldMeta, ImportsMeta, TableMeta, TimestampsMeta } from "./analyzer-types.ts"
import { readEnum, resolve } from "./utils/enum-source.ts"
import { placeOf, textWithoutComments } from "./utils/node-text.ts"
import { type ImportRef, importRefs, type JsonSchemaSource, readJsonSchema } from "./utils/schema-source.ts"
import { getTableName, sqlNameArg } from "./utils/ts-morph.ts"

/** The timestamp columns a table has, and their casing */
// lookup-table: timestamp column names under either casing
const TIMESTAMP_KEYS: Record<string, "createdAt" | "deletedAt" | "updatedAt"> = {
	createdAt: "createdAt",
	created_at: "createdAt",
	deletedAt: "deletedAt",
	deleted_at: "deletedAt",
	updatedAt: "updatedAt",
	updated_at: "updatedAt",
}

/* the shared timestamp schemas are epoch milliseconds; a text or JSON column under the name is not one */
const EPOCH_HELPERS = /^\s*(?:c\.(?:createdAt|updatedAt|deletedAt|timestamp|integer)|integer)\s*\(/

/** The timestamp columns a table declares, each under its own name, and the casing they share */
function detectTimestamps(fields: FieldMeta[]): TimestampsMeta {
	const names: TimestampsMeta["names"] = { createdAt: null, deletedAt: null, updatedAt: null }
	for (const field of fields) {
		const key = Object.hasOwn(TIMESTAMP_KEYS, field.name) ? TIMESTAMP_KEYS[field.name] : undefined
		if (key !== undefined && EPOCH_HELPERS.test(field.raw)) names[key] = field.name
	}
	const declared = Object.values(names).filter((name) => name !== null)
	const snake = declared.filter((name) => name.includes("_")).length
	const style = snake === 0 ? "camelCase" : snake === declared.length ? "snake_case" : "mixed"
	return {
		createdAt: names.createdAt !== null,
		deletedAt: names.deletedAt !== null,
		names,
		style,
		updatedAt: names.updatedAt !== null,
	}
}

/* `.$type<z.infer<typeof schema>>()` types a column by a schema the DTO validates with */
const INFERRED = /\.\$type<\s*z\.infer<\s*typeof\s+(\w+)\s*>\s*>/

/** The names a field's generated schema uses: an unreadable enum const, a JSON schema's free names, an inferred type's schema. */
function importedNames(enumReference: string | null, json: JsonSchemaSource | null, raw: string): string[] {
	const names = [enumReference, ...(json === null ? [] : json.names), INFERRED.exec(raw)?.[1]]
	return [...new Set(names.filter((name) => typeof name === "string"))]
}

/* the shared-schema pass must not hoist anything that names an import */
function recordImports(refs: ImportRef[], enumReference: string | null, imports: ImportsMeta): void {
	for (const ref of refs) {
		if (ref.name === enumReference) imports.enumImports.set(ref.name, ref.from)
		else imports.jsonSchemaImports.add(ref.name)
	}
}

/** The column helper call a field's chain starts from: `c.ref(OWNER)` in `c.ref(OWNER).notNull()` */
function rootCall(value: Node): Node | undefined {
	let node: Node | undefined = value
	while (node !== undefined) {
		const call: CallExpression | undefined = node.asKind(SyntaxKind.CallExpression)
		if (call !== undefined && /^(?:c\.)?\w+$/.test(call.getExpression().getText())) return call
		const next: Node = call === undefined ? node : call.getExpression()
		node = next.asKind(SyntaxKind.PropertyAccessExpression)?.getExpression()
	}
	return undefined
}

/**
 * The SQL name a field's column call declares, read on the AST so a const holding it counts; the
 * text's reading when the call names none (no argument, a config object, or c.id's prefix)
 */
function astSqlName(value: Node, parsed: string): string {
	const first = rootCall(value)?.asKind(SyntaxKind.CallExpression)?.getArguments()[0]
	const named = first !== undefined && !first.isKind(SyntaxKind.ObjectLiteralExpression) && parsed !== "id"
	return named ? sqlNameArg(first) : parsed
}

/** One field, with what only the AST knows: enum values and states, schema and imports. */
function fieldOf(key: string, value: Node, imports: ImportsMeta): FieldMeta {
	/* a comment in the chain is a note, not code: `// TODO: .notNull()` declares nothing */
	const raw = textWithoutComments(value)
	const enumSource = readEnum(value)
	const enumReference = enumSource === null ? null : enumSource.reference
	const json = readJsonSchema(value)
	const schemaImports = importRefs(importedNames(enumReference, json, raw), value.getSourceFile())
	recordImports(schemaImports, enumReference, imports)
	/* each value read at its own node, through the project that resolves its imports (F1) */
	const parsed = parseField(key, raw, {
		declared: constraintsAt(value.getProject(), value),
		place: `${placeOf(value)}: ${key}`,
	})
	return {
		...parsed,
		sqlName: astSqlName(value, parsed.sqlName),
		enumName: enumReference,
		enumValues: enumSource?.values ?? null,
		jsonSchemaName: json?.expression ?? null,
		schemaImports,
		states: enumSource?.machine ?? null,
	}
}

/** A property's name as written: `"display-name"` is display-name. */
function keyOf(name: Node): string {
	return name.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ?? name.getText()
}

/** `node`'s place, as `file:line`, for an error that points at the source */
/* shared column consts spread into shared column consts, at most this deep */
const MAX_SPREAD_DEPTH = 4

/**
 * Every field of a table's column object, through spreads of shared column consts; records the
 * names they import. A property comb cannot read is an error at its place, never a column the
 * DTOs silently lack.
 */
function fieldsOf(columns: ObjectLiteralExpression, imports: ImportsMeta, depth = 0): FieldMeta[] {
	const fields: FieldMeta[] = []
	for (const property of columns.getProperties()) {
		const spread = property.asKind(SyntaxKind.SpreadAssignment)
		const assignment = property.asKind(SyntaxKind.PropertyAssignment)
		const value = assignment?.getInitializer()
		if (assignment !== undefined && value !== undefined) {
			fields.push(fieldOf(keyOf(assignment.getNameNode()), value, imports))
			continue
		}
		const shared = resolve(spread?.getExpression())?.asKind(SyntaxKind.ObjectLiteralExpression)
		if (shared === undefined || depth >= MAX_SPREAD_DEPTH) {
			throw new Error(
				`${placeOf(property)}: comb cannot read the columns of ${property.getText()}; spread a const object literal, at most ${MAX_SPREAD_DEPTH} deep`,
			)
		}
		fields.push(...fieldsOf(shared, imports, depth + 1))
	}
	return fields
}

/** The table `declaration` defines, or null when its call does not carry a column object. */
export function parseTable(declaration: VariableDeclaration, imports: ImportsMeta): TableMeta | null {
	const initializer = declaration.getInitializer()
	const args = initializer?.asKind(SyntaxKind.CallExpression)?.getArguments() ?? []
	const columns = args[1]?.asKind(SyntaxKind.ObjectLiteralExpression)
	if (initializer === undefined || columns === undefined) return null
	const varName = declaration.getName()
	const fields = fieldsOf(columns, imports)
	const idPrefix = fields.map((f) => /c\.id\(["'](\w+)["']\)/.exec(f.raw)?.[1]).find((p) => p !== undefined) ?? null
	return {
		...readTableOptions(args[2]),
		fields,
		idPrefix,
		sqlName: getTableName(varName, initializer),
		timestamps: detectTimestamps(fields),
		varName,
	}
}
