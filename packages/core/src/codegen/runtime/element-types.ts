/**
 * Whether a Postgres array column's element takes null, as its drizzle type declares it (A2-9 of
 * r22): drizzle types `text().array()` as `string[]` and `text().array().$type<string | null>()` as
 * `(string | null)[]`, so a write DTO takes a null element only where the table's insert does. The
 * type leaves no trace at runtime, so TypeScript's checker reads it from the tables file, under the
 * project's tsconfig with strictNullChecks, which a declared `| null` needs to mean anything. A
 * column the checker cannot answer for fails codegen, naming it: either default builds a DTO that
 * disagrees with the app's own types. Any other type error in the file is left to the project's
 * own typecheck, so whether codegen takes a project never turns on its having an array column.
 */
import { Project, ts } from "ts-morph"
import { compilerOptionsFor } from "./ts-options.mjs"

/** Whether the element of the array column `key` of the table exported as `table` takes null */
type ElementNulls = (table: string, key: string, dimensions: number) => boolean

/** Whether `type` takes null: null itself, any or unknown, or a union holding one */
const admitsNull = (type: ts.Type): boolean =>
	(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
	(type.isUnion() && type.types.some(admitsNull))

/* the checker's type for what it could not resolve, an any no tables file wrote */
const isUnresolved = (type: ts.Type): boolean =>
	(type as ts.Type & { intrinsicName?: string | undefined }).intrinsicName === "error"

/**
 * The checker over `tablesPath`, a TypeScript or JavaScript module whatever the project's allowJs (A3-1
 * of r23), and what it exports: none for a script, which the read refuses naming the column. A type
 * error elsewhere in the file is the project's own typecheck's to report: the read fails only where
 * it cannot resolve what it needs
 */
function checkerOf(tablesPath: string): { checker: ts.TypeChecker; exports: readonly ts.Symbol[] } {
	const options = {
		...compilerOptionsFor(tablesPath),
		allowJs: true,
		noEmit: true,
		skipLibCheck: true,
		strictNullChecks: true,
	}
	const project = new Project({ compilerOptions: options, skipAddingFilesFromTsConfig: true })
	const source = project.addSourceFileAtPath(tablesPath).compilerNode
	const checker = project.getTypeChecker().compilerObject
	const module = checker.getSymbolAtLocation(source)
	return { checker, exports: module === undefined ? [] : checker.getExportsOfModule(module) }
}

/** The type of `key` in the insert of the table exported as `table`; undefined when TypeScript resolves none */
function insertTypeOf(
	{ checker, exports }: ReturnType<typeof checkerOf>,
	table: string,
	key: string,
): ts.Type | undefined {
	const exported = exports.find((symbol) => symbol.name === table)
	const insert = exported && checker.getTypeOfSymbol(exported).getProperty("$inferInsert")
	const column = insert && checker.getTypeOfSymbol(insert).getProperty(key)
	return column && checker.getTypeOfSymbol(column)
}

/**
 * What each array column's element takes, read from `tablesPath` once, on the first column asked
 * for, so a project with no array column builds no program
 */
function elementNullsOf(tablesPath: string): ElementNulls {
	let read: ReturnType<typeof checkerOf> | undefined
	return (table, key, dimensions) => {
		read ??= checkerOf(tablesPath)
		const at = `${table}.${key}`
		const declared = insertTypeOf(read, table, key)
		if (declared === undefined)
			throw new Error(
				`${at}: codegen reads an array column's element type from its table's $inferInsert, which TypeScript cannot resolve for the export ${table} of ${tablesPath}`,
			)
		const { checker } = read
		let element = declared
		for (let level = 0; level < dimensions; level++) {
			/* an array's level alone, never a string's character index */
			const array = checker.getNonNullableType(element)
			if (!checker.isArrayType(array))
				throw new Error(
					`${at}: its $inferInsert type, ${checker.typeToString(declared)}, is no array of ${dimensions} dimensions, which the column declares; type its element with $type<E>()`,
				)
			element = checker.getTypeArguments(array as ts.TypeReference)[0] as ts.Type
		}
		if (isUnresolved(element))
			throw new Error(
				`${at}: its element type, ${checker.typeToString(element)}, does not resolve, so codegen cannot read whether it takes null; fix the type its $type<E>() names`,
			)
		return admitsNull(element)
	}
}

export { elementNullsOf }
export type { ElementNulls }
