/**
 * Derive the entity half of the meta contract from a table's analysis.
 *
 * Kept separate from the DTO generator so the derivation can be tested
 * directly against the analyzer's view of a table, rather than by grepping
 * generated text. See docs/meta-contract.md.
 */
import type { CombEntityMetaInput } from "../meta.ts"
import { isReference } from "./analyze-field.ts"
import type { FieldMeta, TableMeta, UniqueIndexMeta } from "./analyzer-types.ts"
import { qualifiedName } from "./utils/table-name.ts"

/**
 * Whether a field is absent from the generated update body.
 *
 * The DTO generator skips these fields when it builds the update body, and
 * `deriveEntityMeta` falls back to it when called without generator output, as
 * the manifest calls it. The schema stamp reads the field set the generator
 * actually emitted instead, so a rule `generateFieldSchema` adds on its own
 * still reaches `immutable`.
 */
function isExcludedFromUpdate(field: FieldMeta): boolean {
	return (
		field.isPrimaryKey ||
		/* a composite key's column is the row's identity too (F7) */
		field.inCompositeKey ||
		/* the database writes a generated column and refuses a value for it (F8) */
		field.generated ||
		field.constraints.nomutate ||
		field.constraints.autogenerate ||
		/* a reference is set once, at creation, unless it declares mutable (F25): an ownership key
		   (organization, project) that a body could move would move the row to another tenant */
		(isReference(field) && !field.constraints.mutable)
	)
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
	if (declared.length !== 1 || declared[0]!.constraints.private) return null
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
	const field = table.fields.find((f) => f.states !== null && f.enumValues !== null && !f.constraints.private)
	if (!field?.states || !field.enumValues) return null

	return {
		column: field.name,
		initial: field.states.initial,
		terminal: field.states.terminal ?? [],
		values: field.enumValues,
	}
}

/**
 * The unique indexes a table publishes: every one but those over a private column, whose name
 * would otherwise reach the document. The stamp and the manifest both read this.
 */
/** A column's own `.unique()` as an index: under the name it gives, else drizzle's `<table>_<column>_unique` */
const columnUnique = (field: FieldMeta): UniqueIndexMeta | null =>
	field.unique === null ? null : { columns: [field.name], name: field.unique }

function publishedUniqueIndexes(table: TableMeta): TableMeta["uniqueIndexes"] {
	const hidden = new Set(table.fields.filter((f) => f.constraints.private).map((f) => f.name))
	const columns = table.fields.flatMap((field) => columnUnique(field) ?? [])
	return [...table.uniqueIndexes, ...columns].filter((index) => !index.columns.some((column) => hidden.has(column)))
}

/**
 * Whether comb or the database fills `field`: an `autogenerate` column, a generated or identity
 * column (F8), or a key that c.id, c.serialId, AUTOINCREMENT or a default fills; a natural key the
 * caller supplies is not generated
 */
function isGenerated(field: FieldMeta): boolean {
	if (field.constraints.autogenerate || field.generated || field.identity) return true
	const filledKey = field.combKind === "id" || field.combKind === "serialId" || field.autoIncrement || field.hasDefault
	return field.isPrimaryKey && filledKey
}

/**
 * Build entity facts, or null when the table has no single identity to publish.
 *
 * A composite primary key has no one identifier, and picking a column would be
 * a guess — the downstream item-route checks do not apply to such an entity
 * anyway. Omitting is the honest outcome; see docs §6.4.
 */
function deriveEntityMeta(table: TableMeta, updateFields?: ReadonlySet<string>): CombEntityMetaInput | null {
	if (table.hasCompositePrimaryKey) return null

	const primaryKey = table.fields.find((f) => f.isPrimaryKey)
	if (!primaryKey) return null

	/* `autogenerate` already defaults to true on the timestamp factories, so
	   the parsed constraints cover both the explicit and the implied cases. */
	/* a private column is absent from every published list (docs/meta-contract.md §8) */
	const published = table.fields.filter((f) => !f.constraints.private)
	const generated = published.filter((f) => f.constraints.autogenerate || f.generated).map((f) => f.name)
	if (isGenerated(primaryKey) && !generated.includes(primaryKey.name)) generated.unshift(primaryKey.name)

	/* Prefer the field set the generator actually emitted: whatever is missing
	   from the update body is, by construction, immutable. Falling back to the
	   predicate is for callers who have no generator output to hand. */
	const immutable = updateFields
		? published.filter((f) => !updateFields.has(f.name)).map((f) => f.name)
		: published.filter(isExcludedFromUpdate).map((f) => f.name)

	return {
		generated,
		identity: primaryKey.name,
		immutable,
		kind: "entity",
		name: qualifiedName(table),
		/* a private name never reaches the document (docs/meta-contract.md §8) */
		softDelete: published.some((f) => f.name === table.timestamps.names.deletedAt)
			? table.timestamps.names.deletedAt
			: null,
		states: statesOf(table),
		tenantColumn: tenantColumnOf(table),
		uniqueIndexes: publishedUniqueIndexes(table),
	}
}

export { deriveEntityMeta, isExcludedFromUpdate, isGenerated, publishedUniqueIndexes }
