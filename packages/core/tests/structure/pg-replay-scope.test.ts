/**
 * P1 of r20, amended: the dev replay commits each history file on devUrl's server, so it runs no
 * statement whose scope is the server or another database (BEYOND in pg-outside-transaction.ts).
 * Every statement node type of the parser comb loads is ruled here, so a new libpg-query node
 * cannot reach the replay unclassified: in BEYOND (some only for a shared object), CREATE ROLE (run,
 * tagged and dropped: pg-replay-database.ts), or the database's own. A DO block, a function and a
 * procedure run what they hold as written: no parse tree shows their dynamic SQL.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { BEYOND } from "../../src/migrate/core/pg-outside-transaction.ts"

const require = createRequire(import.meta.url)
const types = createRequire(require.resolve("libpg-query/package.json")).resolve("@pgsql/types/types.d.ts")

/** Every statement node type the parser's types declare */
const statements = [...readFileSync(types, "utf8").matchAll(/export interface (\w+Stmt)\b/g)].map(([, name]) => name)

/* RawStmt is the parser's wrapper around one statement, never a statement itself */
const DATABASE_SCOPED: readonly string[] = [
	"AlterCollationStmt",
	"AlterDefaultPrivilegesStmt",
	"AlterDomainStmt",
	"AlterEnumStmt",
	"AlterEventTrigStmt",
	"AlterExtensionContentsStmt",
	"AlterExtensionStmt",
	"AlterFdwStmt",
	"AlterForeignServerStmt",
	"AlterFunctionStmt",
	"AlterObjectDependsStmt",
	"AlterObjectSchemaStmt",
	"AlterOpFamilyStmt",
	"AlterOperatorStmt",
	"AlterPolicyStmt",
	"AlterPublicationStmt",
	"AlterSeqStmt",
	"AlterStatsStmt",
	"AlterTSConfigurationStmt",
	"AlterTSDictionaryStmt",
	"AlterTableMoveAllStmt",
	"AlterTableStmt",
	"AlterTypeStmt",
	"AlterUserMappingStmt",
	"CallStmt",
	"ClosePortalStmt",
	"ClusterStmt",
	"CompositeTypeStmt",
	"ConstraintsSetStmt",
	"CreateAmStmt",
	"CreateCastStmt",
	"CreateConversionStmt",
	"CreateDomainStmt",
	"CreateEnumStmt",
	"CreateEventTrigStmt",
	"CreateExtensionStmt",
	"CreateFdwStmt",
	"CreateForeignServerStmt",
	"CreateForeignTableStmt",
	"CreateFunctionStmt",
	"CreateOpClassStmt",
	"CreateOpFamilyStmt",
	"CreatePLangStmt",
	"CreatePolicyStmt",
	"CreatePublicationStmt",
	"CreateRangeStmt",
	"CreateSchemaStmt",
	"CreateSeqStmt",
	"CreateStatsStmt",
	"CreateStmt",
	"CreateTableAsStmt",
	"CreateTransformStmt",
	"CreateTrigStmt",
	"CreateUserMappingStmt",
	"DeallocateStmt",
	"DeclareCursorStmt",
	"DefineStmt",
	"DeleteStmt",
	"DiscardStmt",
	"DoStmt",
	"DropStmt",
	"DropUserMappingStmt",
	"ExecuteStmt",
	"ExplainStmt",
	"FetchStmt",
	"ImportForeignSchemaStmt",
	"IndexStmt",
	"InsertStmt",
	"ListenStmt",
	"LoadStmt",
	"LockStmt",
	"MergeStmt",
	"NotifyStmt",
	"PLAssignStmt",
	"PrepareStmt",
	"RawStmt",
	"RefreshMatViewStmt",
	"ReplicaIdentityStmt",
	"ReturnStmt",
	"RuleStmt",
	"SelectStmt",
	"SetOperationStmt",
	"TruncateStmt",
	"UnlistenStmt",
	"UpdateStmt",
	"VacuumStmt",
	"VariableSetStmt",
	"VariableShowStmt",
	"ViewStmt",
]

describe("the dev replay's scope table (P1 of r20)", () => {
	it("rules every statement node type of the parser once: beyond the database, CREATE ROLE, or the database's own", () => {
		const ruled = [...Object.keys(BEYOND), "CreateRoleStmt", ...DATABASE_SCOPED]
		expect(statements.length).toBeGreaterThan(100)
		expect(statements.filter((name) => !ruled.includes(name))).toEqual([])
		expect(ruled.filter((name) => !statements.includes(name))).toEqual([])
		expect(ruled.length).toBe(new Set(ruled).size)
	})
})
