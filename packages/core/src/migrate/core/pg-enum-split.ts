/**
 * Atlas writes `ALTER TYPE … ADD VALUE` into the same file as the statements that use the new
 * value, and Postgres refuses that inside one transaction ("unsafe use of new value", 55P04), so
 * the file fails on apply although the dev replay passed. comb moves the ADD VALUE statements into
 * a file of their own at the migration's version and the rest to the next second, each its own
 * transaction.
 */
import { nextVersion } from "./atlas-dir.ts"
import { codeOf, QNAME } from "./sql-code.ts"
import { withDirectivesFirst } from "./pg-objects.ts"
import { atlasDirectives, atlasFile, pgStatements } from "./pg-split.ts"

// per-process-constant: a pattern composed from the name grammar, compiled once
const ADD_VALUE = /* @__PURE__ */ new RegExp(`^ALTER TYPE (?:IF EXISTS )?${QNAME} ADD VALUE\\b`, "i")
const VERSIONED = /^(\d{14})(.*)\.sql$/

/** The files a migration becomes: itself, or its ADD VALUE statements first and the rest a version later */
function splitEnumValues(name: string, file: string): Array<[string, string]> {
	const [, version, suffix] = VERSIONED.exec(name) ?? []
	const statements = pgStatements(file)
	const values = statements.filter((stmt) => ADD_VALUE.test(codeOf(stmt, "postgres")))
	const rest = statements.filter((stmt) => !values.includes(stmt))
	if (version === undefined || values.length === 0 || rest.length === 0) return [[name, file]]
	return [
		[`${version}${suffix}_enum_values.sql`, atlasFile(values)],
		/* comb's file: its directives honored, a blank line after them (withDirectivesFirst) */
		[`${nextVersion(version)}${suffix}.sql`, atlasFile(rest, withDirectivesFirst(atlasDirectives(file), ""))],
	]
}

export { splitEnumValues }
