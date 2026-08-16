/**
 * Entity manifest — the model as data, for consumers that are not TypeScript.
 *
 * Everything here is a projection of `TableMeta` and `deriveEntityMeta`, never a
 * second derivation: the manifest and the schema stamp state the same facts, so
 * a change to one moves the other. See docs/meta-contract.md §11.
 */
import path from "node:path"
import { deriveEntityMeta } from "../entity-meta.ts"
import type { FieldMeta, TableMeta } from "../analyzer-types.ts"
import { writeGenJsonFile } from "../utils/fs.ts"

/**
 * Manifest format version.
 *
 * Same discipline as the meta contract: bumped only when a field is removed or
 * changes meaning. Adding a field never bumps it, so a reader that ignores what
 * it does not recognise keeps working across comb releases.
 */
const MANIFEST_VERSION = 1

type ManifestColumn = {
	name: string
	/** The `c.*` helper that declared it — text, integer, enum, json, ref, … */
	kind: string
	notNull: boolean
	primaryKey: boolean
	/** Declared values for an enum column, or null when not an enum or the list is a const reference */
	enumValues: string[] | null
	/** Length or numeric bound where one was declared */
	max: number | null
	min: number | null
	/** Regex source where one was declared */
	pattern: string | null
	/** Server-assigned; absent from create bodies */
	generated: boolean
	/** Absent from update bodies */
	immutable: boolean
	/** Absent from read bodies */
	private: boolean
	/**
	 * State machine declared on this column, or null.
	 *
	 * Unlike the published stamp, the manifest carries `transitions` too: it is a
	 * local artifact for tools that operate on the model, not a document handed
	 * to a black-box tester. See docs/state-machines.md §5.
	 */
	states: { initial: string | null; terminal: string[]; transitions: Record<string, string[]> | null } | null
}

type ManifestRelation = {
	column: string
	table: string
	refColumn: string
	onDelete: string | null
	onUpdate: string | null
}

type ManifestEntity = {
	name: string
	/** Variable the table was declared under, for locating it in source */
	varName: string
	/** Prefix passed to c.id(), or null for an auto-increment or absent prefix */
	idPrefix: string | null
	/** Null when the table has a composite primary key — see meta-contract §6.4 */
	identity: string | null
	softDelete: string | null
	tenantColumn: string | null
	compositePrimaryKey: boolean
	columns: ManifestColumn[]
	relations: ManifestRelation[]
	uniqueIndexes: { name: string; columns: string[] }[]
	checkConstraints: { name: string; expression: string }[]
}

type Manifest = {
	v: number
	database: string
	entities: ManifestEntity[]
}

type ManifestConfig = {
	filePrefix?: string | undefined
	output: string
}

function toColumn(field: FieldMeta, entityMeta: ReturnType<typeof deriveEntityMeta>): ManifestColumn {
	const { constraints } = field
	return {
		enumValues: field.enumValues,
		generated: entityMeta ? entityMeta.generated.includes(field.name) : constraints.autogenerate,
		immutable: entityMeta ? entityMeta.immutable.includes(field.name) : constraints.nomutate,
		kind: field.drizzleHelper,
		max: constraints.max ?? field.length,
		min: constraints.min,
		name: field.name,
		notNull: field.isNotNull,
		pattern: constraints.pattern,
		primaryKey: field.isPrimaryKey,
		private: constraints.private,
		states: field.states
			? {
					initial: field.states.initial,
					terminal: field.states.terminal ?? [],
					transitions: field.states.transitions,
				}
			: null,
	}
}

function toEntity(table: TableMeta): ManifestEntity {
	/* The same derivation the schema stamp uses, so the two cannot disagree. */
	const meta = deriveEntityMeta(table)

	const relations: ManifestRelation[] = []
	for (const field of table.fields) {
		const fk = field.foreignKey
		if (!fk) continue
		relations.push({
			column: fk.column,
			onDelete: fk.onDelete ?? null,
			onUpdate: fk.onUpdate ?? null,
			refColumn: fk.refColumn,
			table: fk.refTable,
		})
	}

	return {
		checkConstraints: table.checkConstraints.map((c) => ({ expression: c.expression, name: c.name })),
		columns: table.fields.map((f) => toColumn(f, meta)),
		compositePrimaryKey: table.hasCompositePrimaryKey,
		identity: meta?.identity ?? null,
		idPrefix: table.idPrefix,
		name: table.sqlName,
		relations,
		softDelete: meta?.softDelete ?? null,
		tenantColumn: meta?.tenantColumn ?? null,
		uniqueIndexes: table.uniqueIndexes.map((u) => ({ columns: u.columns, name: u.name })),
		varName: table.varName,
	}
}

/**
 * Build the manifest without writing it — useful to a caller assembling its own
 * artifact, and the unit under test.
 *
 * Entities are sorted by SQL name so regenerating an unchanged schema produces
 * an identical file regardless of declaration order.
 */
function buildManifest(tables: TableMeta[], dbName: string): Manifest {
	return {
		database: dbName,
		entities: tables.map(toEntity).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
		v: MANIFEST_VERSION,
	}
}

/** Write the manifest alongside the generated entities. */
function generateManifest(tables: TableMeta[], dbName: string, config: ManifestConfig, cwd: string): void {
	const outputPath = path.resolve(cwd, config.output)
	const manifest = buildManifest(tables, dbName)

	writeGenJsonFile(outputPath, manifest, "comb")
	console.log(`  manifest: ${outputPath} (${manifest.entities.length} entities)`)
}

export {
	buildManifest,
	generateManifest,
	type Manifest,
	type ManifestColumn,
	type ManifestConfig,
	type ManifestEntity,
	type ManifestRelation,
	MANIFEST_VERSION,
}
