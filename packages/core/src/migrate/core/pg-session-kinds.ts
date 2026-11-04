/**
 * The statement kinds pg-session.ts reads a file's use of the session by (PA1 of r22b): those that set
 * it whatever they hold, those that only store what they call, those that read or write no rows, and
 * the definitions of code comb cannot read that a statement on rows may run.
 */

// lookup-table: the statements that set the session whatever they hold
const SETS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"CallStmt",
	"CreateExtensionStmt",
	"AlterExtensionStmt",
	"DiscardStmt",
	"DoStmt",
	"ListenStmt",
	"LoadStmt",
	"PrepareStmt",
	"UnlistenStmt",
])

// lookup-table: the statements that only store what they call: none of their expressions runs as they run
const STORES: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"AlterPolicyStmt",
	"CommentStmt",
	"CreateCastStmt",
	"CreateDomainStmt",
	"CreateFunctionStmt",
	"CreateOpClassStmt",
	"CreatePolicyStmt",
	"CreateStatsStmt",
	"CreateStmt",
	"CreateTrigStmt",
	"CreateEventTrigStmt",
	"DefineStmt",
	"RuleStmt",
	"ViewStmt",
])

// lookup-table: the statements that read or write no rows, so run no stored code but an event trigger
const ROWLESS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	...STORES,
	"AlterDefaultPrivilegesStmt",
	"AlterEnumStmt",
	"AlterFunctionStmt",
	"AlterObjectSchemaStmt",
	"AlterOwnerStmt",
	"AlterRoleStmt",
	"AlterSeqStmt",
	"CompositeTypeStmt",
	"CreateEnumStmt",
	"CreateRoleStmt",
	"CreateSchemaStmt",
	"CreateSeqStmt",
	"DropRoleStmt",
	"DropStmt",
	"GrantRoleStmt",
	"GrantStmt",
	"NotifyStmt",
	"RenameStmt",
	"SecLabelStmt",
	"TransactionStmt",
	"VariableSetStmt",
])

// lookup-table: the definitions of code a statement on rows may run that comb cannot read
const OPAQUE: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"CreateCastStmt",
	"CreateExtensionStmt",
	"CreateOpClassStmt",
	"DefineStmt",
])

// lookup-table: the ALTER TABLE commands that read no rows, as each changes the catalog alone
const ROWLESS_COMMANDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"AT_ChangeOwner",
	"AT_ColumnDefault",
	"AT_DetachPartition",
	"AT_DisableRowSecurity",
	"AT_DisableTrig",
	"AT_DropColumn",
	"AT_DropConstraint",
	"AT_DropNotNull",
	"AT_EnableRowSecurity",
	"AT_EnableTrig",
	"AT_ForceRowSecurity",
	"AT_NoForceRowSecurity",
	"AT_ReplicaIdentity",
	"AT_SetStatistics",
	"AT_SetStorage",
])

export { OPAQUE, ROWLESS, ROWLESS_COMMANDS, SETS, STORES }
