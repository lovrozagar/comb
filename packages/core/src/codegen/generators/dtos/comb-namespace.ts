/**
 * How generated DTO files reach comb's own predicates (C2 of r17): under one namespace, `comb`, so
 * a c.json schema exported under a predicate's name cannot capture it. A global the generated code
 * calls is named through globalThis for the same reason; `comb` and `globalThis` are the names a
 * schema import is aliased away from (schema-aliases.ts).
 */

/** Whether generated code names comb's namespace */
export const COMB_NAMESPACE: RegExp = /\bcomb\./

/** The import a generated file that names comb's namespace takes */
/* written whole from a quoted specifier, so no scan of comb's own imports reads it as one */
export const combImport = (combFrom: string): string => `import * as comb from ${JSON.stringify(combFrom)}`
