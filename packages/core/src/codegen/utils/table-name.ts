/**
 * A table's names where a Postgres schema is set (F51): two tables of one name in two schemas,
 * Supabase's auth.users beside the app's own users, are two tables, so each is named with its
 * schema wherever comb keys or publishes it, and plainly where none is set.
 */
import type { TableMeta } from "../analyzer-types.ts"
import { sqlIdentifier } from "./case.ts"

type Named = Pick<TableMeta, "schema" | "sqlName">

/** `auth.users` for a schema'd table, else its SQL name: the constraint map's key and the published entity name */
export const qualifiedName = ({ schema, sqlName }: Named): string =>
	schema === null ? sqlName : `${schema}.${sqlName}`

/** The start of a table's error keys, `auth_users` for a schema'd one: a key stays one identifier, which i18n tools nest on dots */
export const errorKeyPrefix = ({ schema, sqlName }: Named): string =>
	schema === null ? sqlName : `${schema}_${sqlName}`

/** The table as SQL names it, each part quoted: `"auth"."users"` */
export const tableIdentifier = ({ schema, sqlName }: Named): string =>
	schema === null ? sqlIdentifier(sqlName) : `${sqlIdentifier(schema)}.${sqlIdentifier(sqlName)}`
