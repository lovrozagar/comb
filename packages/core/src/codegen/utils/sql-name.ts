/**
 * Whether SQL comb rendered names a column, as it quotes every column there by its SQL name
 * (sqlIdentifier) (C5 of r17). Plain text: a name may hold any character, and no RegExp is built
 * from it.
 */
import { sqlIdentifier } from "./case.ts"

export const namesColumn = (sql: string, sqlName: string): boolean => sql.includes(sqlIdentifier(sqlName))
