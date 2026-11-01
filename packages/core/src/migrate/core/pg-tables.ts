/**
 * Postgres tables as comb follows them around Atlas's statements: which tables those create,
 * alter and drop, and each table's row level security. Atlas OSS drops `ALTER TABLE … ENABLE ROW
 * LEVEL SECURITY` without a word, so a policy would never be enforced; comb owns each table's two
 * flags (ENABLE/DISABLE and FORCE/NO FORCE) the way it owns policies (pg-objects.ts): it takes
 * the statements out of the history and the target, follows the flags per table, and writes the
 * delta after Atlas's statements.
 */
import { codeOf, lastPart, QNAME, splitTopLevel } from "./sql-code.ts"
import { parsePostgres } from "./pg-parser.ts"
import { pgStatements } from "./pg-split.ts"

/** A table's row level security as a migration leaves it */
type Rls = {
	enabled: boolean
	forced: boolean
	/** the table's name as written */
	name: string
}

/** A statement as written and as code */
type Statement = { code: string; sql: string }

/** What Atlas's statements do to tables: those they alter or drop, those they create, and those they drop */
type AtlasTables = { altered: Set<string>; created: Set<string>; dropped: Set<string> }

// per-process-constant: a table Atlas creates, composed once
const CREATE_TABLE = /* @__PURE__ */ new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?(${QNAME})`, "i")
// per-process-constant: the tables an Atlas statement changes, composed once
const ALTERS_TABLE = /* @__PURE__ */ new RegExp(
	`^(?:ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QNAME})|DROP TABLE (?:IF EXISTS )?(${QNAME}(?:\\s*,\\s*${QNAME})*))`,
	"i",
)

/** The tables Atlas's statements alter or drop, and those they create and drop */
function atlasTables(atlasSql: string): AtlasTables {
	const altered = new Set<string>()
	const created = new Set<string>()
	const dropped = new Set<string>()
	for (const statement of pgStatements(atlasSql)) {
		const code = codeOf(statement, "postgres")
		const [, alter, drops] = ALTERS_TABLE.exec(code) ?? []
		if (alter !== undefined) altered.add(lastPart(alter))
		for (const name of drops === undefined ? [] : splitTopLevel(drops)) {
			altered.add(lastPart(name))
			dropped.add(lastPart(name))
		}
		const [, made] = CREATE_TABLE.exec(code) ?? []
		if (made !== undefined) created.add(lastPart(made))
	}
	return { altered, created, dropped }
}

// per-process-constant: the table an ALTER TABLE names, as written, composed once
const ALTERED = /* @__PURE__ */ new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QNAME})`, "i")
const OFF = { enabled: false, forced: false }

// lookup-table: each row level security command of an ALTER TABLE, by its parse-tree subtype, and the flag it sets
const RLS_COMMANDS: Readonly<Record<string, Partial<Pick<Rls, "enabled" | "forced">>>> = {
	AT_DisableRowSecurity: { enabled: false },
	AT_EnableRowSecurity: { enabled: true },
	AT_ForceRowSecurity: { forced: true },
	AT_NoForceRowSecurity: { forced: false },
}

/**
 * Whether a statement changes row level security, which comb owns, following each table's flags: read
 * from its parse tree, so any number of the commands, among others, set them (P14 of r19). It is
 * comb's whole, out of Atlas's history, only when every command is one; a statement that does more
 * stays in it, where Atlas runs it and leaves the flags to comb
 */
function followRls({ code, sql }: Statement, rls: Map<string, Rls>): boolean {
	const [, table] = ALTERED.exec(code) ?? []
	if (table === undefined) return false
	/* the parser's one RawStmt: an ALTER TABLE's commands, each with its subtype */
	const [{ stmt }] = parsePostgres(sql).stmts as [
		{ stmt: { AlterTableStmt?: { cmds: Array<{ AlterTableCmd: { subtype: string } }> } } },
	]
	const commands = (stmt.AlterTableStmt?.cmds ?? []).map(({ AlterTableCmd }) => AlterTableCmd.subtype)
	const flags = commands.flatMap((subtype) => {
		const set = RLS_COMMANDS[subtype]
		return set === undefined ? [] : [set]
	})
	if (flags.length === 0) return false
	const key = lastPart(table)
	rls.set(key, { ...(rls.get(key) ?? OFF), ...Object.assign({}, ...flags), name: table })
	return flags.length === commands.length
}

/**
 * The statements that bring each table's row level security from `from` to `to`: a table Atlas
 * creates starts with none (a rename is a create), and one it drops needs none
 */
function rlsDelta(from: Map<string, Rls>, to: Map<string, Rls>, tables: AtlasTables): string[] {
	const out: string[] = []
	for (const key of new Set([...to.keys(), ...from.keys()])) {
		if (tables.dropped.has(key) && !tables.created.has(key)) continue
		const want = to.get(key) ?? OFF
		const had = tables.created.has(key) ? OFF : (from.get(key) ?? OFF)
		const name = (to.get(key) ?? from.get(key))?.name as string
		if (want.enabled !== had.enabled)
			out.push(`ALTER TABLE ${name} ${want.enabled ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`)
		if (want.forced !== had.forced)
			out.push(`ALTER TABLE ${name} ${want.forced ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY`)
	}
	return out
}

export { atlasTables, type AtlasTables, followRls, type Rls, rlsDelta, type Statement }
