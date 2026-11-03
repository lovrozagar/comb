/**
 * The statements Postgres runs only outside a transaction block, read from their parse trees (P8 of
 * r19), the one table check's refusal and the dev replays (pg-replay.ts) both read. Each is named as
 * Postgres's refusal names it. Probed on Postgres 17 (.tmp/grunt/p18/runs/8954e05-probe-p8-*.log, and
 * f761199-probe-p8-*.log for failover):
 * VACUUM (never ANALYZE alone), a bare CLUSTER, every CONCURRENTLY build, drop, reindex and partition
 * detach, a REINDEX of a schema, a database or the system, ALTER SYSTEM, CREATE and DROP DATABASE,
 * ALTER DATABASE SET TABLESPACE, CREATE and DROP TABLESPACE, DISCARD ALL, COMMIT and ROLLBACK
 * PREPARED, and a subscription's slot work: CREATE SUBSCRIPTION making a slot (its default unless
 * `connect` or `create_slot` is false), DROP SUBSCRIPTION (whose slot comb cannot see), and ALTER
 * SUBSCRIPTION's REFRESH, a publication change that refreshes (its default) and a SET of failover. A plain CLUSTER, a
 * REINDEX of one table or index, a detach's FINALIZE and the rest run in one.
 *
 * Beside it, the statements whose scope is the server or another database (P1 of r20, amended):
 * the dev replay runs each history file as Atlas applies it, committed, in a database of its own,
 * so a statement that reaches past that database would change devUrl's server for good, the
 * target's own when they share one. A structure test holds every statement node type of the parser
 * to this table or to the ones ruled database-scoped.
 */
type Node = Record<string, unknown>

/** A statement's one node: its type and fields */
const nodeOf = (tree: unknown): [string, Record<string, unknown>] => {
	/* a statement's tree is the parser's one RawStmt, whose stmt holds one node */
	const [{ stmt }] = tree as [{ stmt: Node }]
	return Object.entries(stmt)[0] as [string, Node]
}

/** An ALTER TABLE's commands */
const commandsOf = (node: Node): Node[] =>
	(node["cmds"] as Array<{ AlterTableCmd: Node }>).map((cmd) => cmd.AlterTableCmd)

/** A statement's options, by name: each one's value as written, `true` for one given with none */
function optionsOf(node: Node, field = "options"): Map<string, unknown> {
	const options = (node[field] as Array<{ DefElem: Node }> | undefined) ?? []
	return new Map(options.map(({ DefElem }) => [String(DefElem["defname"]), DefElem["arg"] ?? true]))
}

/** Whether an option's value reads as false, as Postgres reads a boolean: false, off or 0 (an Integer 0 has no ival) */
function isOff(value: unknown): boolean {
	if (value === true || value === undefined) return false
	const node = value as Node
	const word =
		((node["String"] as Node | undefined)?.["sval"] as string | undefined) ??
		(((node["TypeName"] as Node | undefined)?.["names"] as Array<{ String: Node }> | undefined)?.at(-1)?.String[
			"sval"
		] as string | undefined) ??
		/* an option's value is a word or an integer */
		String(((node["Integer"] as Node)["ival"] as number | undefined) ?? 0)
	return /^(?:false|off|0)$/i.test(word)
}

/** Whether a node is built CONCURRENTLY, as its parse tree marks it: an index's build, drop or reindex, a partition's detach */
function concurrent(type: string, node: Node): boolean {
	if (type === "IndexStmt" || type === "DropStmt") return node["concurrent"] === true
	if (type === "AlterTableStmt")
		return commandsOf(node).some(
			(cmd) =>
				cmd["subtype"] === "AT_DetachPartition" &&
				((cmd["def"] as Node)["PartitionCmd"] as Node)["concurrent"] === true,
		)
	return type === "ReindexStmt" && optionsOf(node, "params").has("concurrently")
}

// lookup-table: the REINDEX kinds that reach more than one table, which a transaction refuses
const WIDE_REINDEX: Readonly<Record<string, string>> = {
	REINDEX_OBJECT_DATABASE: "REINDEX DATABASE",
	REINDEX_OBJECT_SCHEMA: "REINDEX SCHEMA",
	REINDEX_OBJECT_SYSTEM: "REINDEX SYSTEM",
}

// lookup-table: the ALTER SUBSCRIPTION kinds that change its publications, refreshing them unless `refresh` is false
const PUBLICATION_CHANGES: ReadonlySet<unknown> = /* @__PURE__ */ new Set([
	"ALTER_SUBSCRIPTION_ADD_PUBLICATION",
	"ALTER_SUBSCRIPTION_DROP_PUBLICATION",
	"ALTER_SUBSCRIPTION_SET_PUBLICATION",
])

// lookup-table: each statement that needs no transaction block of its own, by node type, with what it is when it does
const OUTSIDE: Readonly<Record<string, (node: Node) => string | undefined>> = {
	AlterDatabaseStmt: (node) => (optionsOf(node).has("tablespace") ? "ALTER DATABASE SET TABLESPACE" : undefined),
	AlterSubscriptionStmt: (node) => {
		if (node["kind"] === "ALTER_SUBSCRIPTION_REFRESH") return "ALTER SUBSCRIPTION ... REFRESH"
		/* P4 of r20: Postgres 17 refuses any failover value in a transaction, beside other options or alone */
		if (node["kind"] === "ALTER_SUBSCRIPTION_OPTIONS" && optionsOf(node).has("failover"))
			return "ALTER SUBSCRIPTION ... SET (failover)"
		const refreshes = PUBLICATION_CHANGES.has(node["kind"]) && !isOff(optionsOf(node).get("refresh"))
		return refreshes ? "ALTER SUBSCRIPTION with refresh" : undefined
	},
	AlterSystemStmt: () => "ALTER SYSTEM",
	ClusterStmt: (node) => (node["relation"] === undefined ? "CLUSTER" : undefined),
	CreateSubscriptionStmt: (node) => {
		const options = optionsOf(node)
		const slot = !isOff(options.get("connect")) && !isOff(options.get("create_slot"))
		return slot ? "CREATE SUBSCRIPTION ... WITH (create_slot = true)" : undefined
	},
	CreateTableSpaceStmt: () => "CREATE TABLESPACE",
	CreatedbStmt: () => "CREATE DATABASE",
	DiscardStmt: (node) => (node["target"] === "DISCARD_ALL" ? "DISCARD ALL" : undefined),
	DropSubscriptionStmt: () => "DROP SUBSCRIPTION",
	DropTableSpaceStmt: () => "DROP TABLESPACE",
	DropdbStmt: () => "DROP DATABASE",
	ReindexStmt: (node) => WIDE_REINDEX[String(node["kind"])],
	TransactionStmt: (node) =>
		({ TRANS_STMT_COMMIT_PREPARED: "COMMIT PREPARED", TRANS_STMT_ROLLBACK_PREPARED: "ROLLBACK PREPARED" })[
			String(node["kind"])
		],
	VacuumStmt: (node) => (node["is_vacuumcmd"] === true ? "VACUUM" : undefined),
}

// lookup-table: how Postgres's refusal names each CONCURRENTLY statement
const CONCURRENT: Readonly<Record<string, string>> = {
	AlterTableStmt: "ALTER TABLE ... DETACH",
	DropStmt: "DROP INDEX",
	IndexStmt: "CREATE INDEX",
	ReindexStmt: "REINDEX",
}

/** What a statement is, by its parse tree's node `type`, when Postgres runs it only outside a transaction block; undefined when it runs in one */
function outsideOnly(type: string, node: Node): string | undefined {
	if (concurrent(type, node)) return `${CONCURRENT[type] as string} CONCURRENTLY`
	return OUTSIDE[type]?.(node)
}

// lookup-table: the shared objects a statement names by its object type, which every database of the server sees
const SHARED: Readonly<Record<string, string>> = {
	OBJECT_DATABASE: "a database",
	OBJECT_PARAMETER_ACL: "a server parameter",
	OBJECT_ROLE: "a role",
	OBJECT_TABLESPACE: "a tablespace",
}

/** What a statement that names a shared object by `field` is, `what` it does to it; undefined for any other object */
const onShared =
	(what: string, field: string) =>
	(node: Node): string | undefined => {
		const object = SHARED[String(node[field])]
		return object === undefined ? undefined : `${what} ${object}`
	}

// lookup-table: the TRANSACTION kinds that make or end a prepared transaction, which outlives the session
const PREPARED: Readonly<Record<string, string>> = {
	TRANS_STMT_COMMIT_PREPARED: "COMMIT PREPARED",
	TRANS_STMT_PREPARE: "PREPARE TRANSACTION",
	TRANS_STMT_ROLLBACK_PREPARED: "ROLLBACK PREPARED",
}

// lookup-table: each statement whose scope is the server or another database, by node type, with what it is when it is
const BEYOND: Readonly<Record<string, (node: Node) => string | undefined>> = {
	AlterDatabaseRefreshCollStmt: () => "ALTER DATABASE",
	AlterDatabaseSetStmt: () => "ALTER DATABASE",
	AlterDatabaseStmt: () => "ALTER DATABASE",
	AlterOwnerStmt: /* @__PURE__ */ onShared("ALTER OWNER of", "objectType"),
	AlterRoleSetStmt: () => "ALTER ROLE",
	AlterRoleStmt: () => "ALTER ROLE",
	AlterSubscriptionStmt: () => "ALTER SUBSCRIPTION",
	AlterSystemStmt: () => "ALTER SYSTEM",
	AlterTableSpaceOptionsStmt: () => "ALTER TABLESPACE",
	CheckPointStmt: () => "CHECKPOINT",
	CommentStmt: /* @__PURE__ */ onShared("COMMENT on", "objtype"),
	/* the server's own files and programs */
	CopyStmt: (node) =>
		node["filename"] !== undefined && (node["is_program"] === true || node["is_from"] !== true)
			? "COPY with a server file or program"
			: undefined,
	CreateSubscriptionStmt: () => "CREATE SUBSCRIPTION",
	CreateTableSpaceStmt: () => "CREATE TABLESPACE",
	CreatedbStmt: () => "CREATE DATABASE",
	/* each also revokes what the role holds on the server's databases and tablespaces */
	DropOwnedStmt: () => "DROP OWNED",
	DropRoleStmt: () => "DROP ROLE",
	DropSubscriptionStmt: () => "DROP SUBSCRIPTION",
	DropTableSpaceStmt: () => "DROP TABLESPACE",
	DropdbStmt: () => "DROP DATABASE",
	GrantRoleStmt: () => "GRANT or REVOKE of a role",
	GrantStmt: /* @__PURE__ */ onShared("GRANT or REVOKE on", "objtype"),
	ReassignOwnedStmt: () => "REASSIGN OWNED",
	ReindexStmt: (node) =>
		node["kind"] === "REINDEX_OBJECT_DATABASE" || node["kind"] === "REINDEX_OBJECT_SYSTEM"
			? (WIDE_REINDEX[String(node["kind"])] as string)
			: undefined,
	RenameStmt: /* @__PURE__ */ onShared("RENAME of", "renameType"),
	SecLabelStmt: /* @__PURE__ */ onShared("SECURITY LABEL on", "objtype"),
	TransactionStmt: (node) => PREPARED[String(node["kind"])],
}

/** What a statement is, by its parse tree's node `type`, when its scope is the server or another database; undefined when it is its database's */
const beyondDatabase = (type: string, node: Node): string | undefined => BEYOND[type]?.(node)

export { BEYOND, beyondDatabase, CONCURRENT, nodeOf, OUTSIDE, outsideOnly }
