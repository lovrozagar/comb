/**
 * Derive the entity half of the meta contract from a table's analysis.
 *
 * Kept separate from the DTO generator so the derivation can be tested
 * directly against the analyzer's view of a table, rather than by grepping
 * generated text. See docs/meta-contract.md.
 */
import type { CombEntityMetaInput } from "../meta.ts"
import type { FieldMeta, TableMeta } from "./analyzer-types.ts"

/**
 * Whether a field is absent from the generated update body.
 *
 * This is the *approximation*, for callers holding only a `TableMeta`. The DTO
 * generator passes the field set it actually emitted instead — see
 * `deriveEntityMeta`'s second argument — because a predicate restating the
 * generator's rules is exactly the second declaration this contract exists to
 * avoid. It has already drifted once: foreign keys are dropped from update
 * bodies deep inside `generateFieldSchema`, which no rule up here mentioned.
 */
function isExcludedFromUpdate(field: FieldMeta): boolean {
	return (
		field.isPrimaryKey ||
		field.name === "id" ||
		field.constraints.nomutate ||
		field.constraints.autogenerate ||
		/* Set once at creation — see the FK branch of generateFieldSchema */
		field.foreignKey !== null ||
		/c\.ref[<(]/.test(field.raw)
	)
}

/** Timestamp columns, under whichever casing the table declared. */
function timestampNames(table: TableMeta): { createdAt: string; deletedAt: string; updatedAt: string } {
	return table.timestamps.style === "snake_case"
		? { createdAt: "created_at", deletedAt: "deleted_at", updatedAt: "updated_at" }
		: { createdAt: "createdAt", deletedAt: "deletedAt", updatedAt: "updatedAt" }
}

/**
 * The column a table declares as its tenant scope, or null.
 *
 * Only an explicit `{ tenant: true }` counts. comb can see that a column is a
 * foreign key but not that the table it references is the tenant; inferring it
 * from a name would reproduce a consumer's own fallback heuristic one layer
 * earlier and dress a guess up as a declaration. A wrong tenant boundary makes
 * a consumer confident about the wrong thing, which is worse than saying
 * nothing. See docs/meta-contract.md §6.3.
 *
 * More than one declaration is a mistake with no safe resolution, so it yields
 * null rather than a coin flip; validateTables reports it.
 */
function tenantColumnOf(table: TableMeta): string | null {
	const declared = table.fields.filter((f) => f.constraints.tenant)
	if (declared.length !== 1) return null
	return declared[0]!.name
}

/**
 * The published subset of a declared state machine, or null.
 *
 * `transitions` is not published: it is a write-side rule, and a document
 * consumer has no use for the graph. Only the first declaring column is taken —
 * a table with two independent lifecycles is real but rare, and a shape a
 * consumer can read without branching is worth more than completeness here.
 * See docs/state-machines.md §5.
 */
function statesOf(table: TableMeta): CombEntityMetaInput["states"] {
	const field = table.fields.find((f) => f.states !== null && f.enumValues !== null)
	if (!field?.states || !field.enumValues) return null

	return {
		column: field.name,
		initial: field.states.initial,
		terminal: field.states.terminal ?? [],
		values: field.enumValues,
	}
}

/**
 * Build entity facts, or null when the table has no single identity to publish.
 *
 * A composite primary key has no one identifier, and picking a column would be
 * a guess — the downstream item-route checks do not apply to such an entity
 * anyway. Omitting is the honest outcome; see docs §6.3.
 */
function deriveEntityMeta(table: TableMeta, updateFields?: ReadonlySet<string>): CombEntityMetaInput | null {
	if (table.hasCompositePrimaryKey) return null

	const primaryKey = table.fields.find((f) => f.isPrimaryKey)
	if (!primaryKey) return null

	/* `autogenerate` already defaults to true on the timestamp factories, so
	   the parsed constraints cover both the explicit and the implied cases. */
	const generated = table.fields.filter((f) => f.constraints.autogenerate).map((f) => f.name)

	/* An id carrying a c.id() prefix is assigned by comb, an auto-increment id
	   by the database. Neither is expressible as a field constraint. */
	if (!generated.includes(primaryKey.name)) generated.unshift(primaryKey.name)

	/* Prefer the field set the generator actually emitted: whatever is missing
	   from the update body is, by construction, immutable. Falling back to the
	   predicate is for callers who have no generator output to hand. */
	const immutable = updateFields
		? table.fields.filter((f) => !updateFields.has(f.name)).map((f) => f.name)
		: table.fields.filter(isExcludedFromUpdate).map((f) => f.name)

	return {
		generated,
		identity: primaryKey.name,
		immutable,
		kind: "entity",
		name: table.sqlName,
		softDelete: table.timestamps.deletedAt ? timestampNames(table).deletedAt : null,
		states: statesOf(table),
		tenantColumn: tenantColumnOf(table),
	}
}

export { deriveEntityMeta, isExcludedFromUpdate }
