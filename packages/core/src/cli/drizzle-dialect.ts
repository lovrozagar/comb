/**
 * The dialect a drizzle config states, held to the database's: drizzle-kit exports
 * none of the other dialect's tables, so a diff with a config of the other dialect would write a
 * DROP TABLE for each.
 */
import { loadModule } from "./comb-config.ts"
import { CliError } from "./output.ts"

export type Dialect = "postgres" | "sqlite"

// lookup-table: the drizzle dialects each comb dialect takes, the one a fix names first
const DRIZZLE_DIALECTS: Record<Dialect, readonly string[]> = { postgres: ["postgresql"], sqlite: ["sqlite", "turso"] }

// lookup-table: each comb dialect as a message names it
export const DIALECT_NAMES: Record<Dialect, string> = { postgres: "Postgres", sqlite: "SQLite" }

/** What a config must state: its dialect, the clause naming who needs it, and any other fix */
export type Expected = { but: string; dialect: Dialect; otherwise?: string | undefined }

/** The `dialect` the drizzle config `file` exports, loaded as comb loads its own configs, its failure naming the file */
export async function statedDialect(file: string): Promise<unknown> {
	const config = (await loadModule(file)).default as { dialect?: unknown } | undefined
	return config?.dialect
}

/**
 * The `dialect` a drizzle config's source states as a string literal, undefined when it states
 * none that way; for `migrate init`, which runs before drizzle-kit, which a config imports, is installed
 */
export function literalDialect(source: string): string | undefined {
	/* each string kept and each comment dropped, so a dialect commented out is not read and a URL's // ends no line */
	const code = source.replace(STRING_OR_COMMENT, (_match, string: string | undefined) => string ?? " ")
	return /\bdialect\s*:\s*["'`]([\w-]+)["'`]/.exec(code)?.[1]
}

/** A string literal (captured) or a comment, whichever starts first */
const STRING_OR_COMMENT = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g

/** Refuse the drizzle config `file` unless the dialect it states is one `expected.dialect` takes */
export function checkDialect(file: string, stated: unknown, expected: Expected): void {
	const takes = DRIZZLE_DIALECTS[expected.dialect]
	if (typeof stated === "string" && takes.includes(stated)) return
	const states = stated === undefined ? "states no dialect" : `states dialect ${JSON.stringify(stated)}`
	throw new CliError(
		`${file} ${states}, but ${expected.but}: set dialect: "${takes[0]}" in it${expected.otherwise ?? ""}`,
	)
}
