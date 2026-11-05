/**
 * Entity manifest — the model as data, for consumers that are not TypeScript.
 *
 * Everything here is a projection of `TableMeta` and `deriveEntityMeta`, never a
 * second derivation: the manifest and the schema stamp state the same facts, so
 * a change to one moves the other. See docs/meta-contract.md §8.2.
 */
import path from "node:path"
import { deriveEntityMeta, publishedPartialUniqueIndexes, publishedUniqueIndexes, writesOf } from "../entity-meta.ts"
import type { FieldMeta, TableMeta } from "../analyzer-types.ts"
import { writeGenJsonFile } from "../utils/fs.ts"
import type { GeneratorContext } from "./context-types.ts"
import { qualifiedName } from "../utils/table-name.ts"
import { writeRules } from "./dtos/field-schema.ts"
import { transformsOf } from "./dtos/text-schema.ts"

/**
 * Manifest format version.
 *
 * Same discipline as the meta contract: bumped only when a field is removed or
 * changes meaning. Adding a field never bumps it, so a reader that ignores what
 * it does not recognise keeps working across comb releases.
 */
const MANIFEST_VERSION = 3

/** One column of a manifest entity, with what a write of it is held to */
type ManifestColumn = {
	/** the column's property name in its table's definition */
	name: string
	/** The `c.*` helper that declared it — text, integer, enum, json, ref, … */
	kind: string
	/**
	 * The column's SQL type, its modifier included, as drizzle writes it (`timestamp(3) with time
	 * zone`, `interval day`, `numeric(3, -2)`): with `kind`, the check a plain Postgres type's rule is
	 */
	sqlType: string
	/** An array column's dimensions, 0 for a column of one value: its `sqlType` is its element's */
	dimensions: number
	/** Whether a written array's element may be null, as the column's drizzle type declares; false for a column of one value */
	nullElements: boolean
	/** the column is NOT NULL */
	notNull: boolean
	/** the column alone is the table's primary key; false on each column of a composite one, which `compositePrimaryKey` flags */
	primaryKey: boolean
	/** Declared values for an enum column, or null when not an enum or the list is a const reference */
	enumValues: string[] | null
	/**
	 * The bounds a written value is held to, as the write DTO enforces them: a text's
	 * length, its kind's and the declared together, a number's value, clamped to what the column
	 * holds; an array's are each element's. Null where none, and on a plain Postgres column whose
	 * type has a rule of its own (a uuid, an inet, a real), which `kind` and `sqlType` name
	 */
	max: number | null
	/** The most bytes a written JSON value takes serialized, null for none and for any other column */
	maxBytes: number | null
	/** the smallest value a write takes, measured as `max` is; null where none */
	min: number | null
	/** Every regex a written text must match, its kind's and the declared one, as JavaScript regex literals; a plain Postgres type's rule is its `kind` and `sqlType`'s */
	patterns: string[]
	/** A text column's format, null for any other */
	textKind: "email" | "imageUri" | "name" | "password" | "url" | null
	/** The rewrites a written value takes before `min`, `max` and `patterns` bind it, in order: the DTO's own list (meta-contract §2.1) */
	transform: string[]
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
	states: {
		/** the state a new row starts in; null when none is declared */
		initial: string | null
		/** the states a row never leaves */
		terminal: string[]
		/** each state, to the states a row may move to from it; null when none are declared */
		transitions: Record<string, string[]> | null
	} | null
}

/** One foreign key of a manifest entity */
type ManifestRelation = {
	/** the referencing column, by its name among this entity's `columns` */
	column: string
	/** the composite key the column is part of, each column paired by position with the one it references; absent on a single-column key */
	key?:
		| {
				/** the key's referencing columns, by name, in key order */
				columns: string[]
				/** the referenced columns, by name, each paired by position with `columns` */
				refColumns: string[]
		  }
		| undefined
	/** the referenced entity, by its `name`: schema-qualified on Postgres, never the TypeScript variable (since `v` 3) */
	table: string
	/** the referenced column, by its name among that entity's `columns` */
	refColumn: string
	/** what the database does to this row when the referenced row is deleted (`cascade`, `set null`); null for its default */
	onDelete: string | null
	/** what the database does to this row when the referenced key changes; null for its default */
	onUpdate: string | null
}

/** One table of the manifest */
type ManifestEntity = {
	/** the table's SQL name, schema-qualified on Postgres; entities are sorted by it */
	name: string
	/** Variable the table was declared under, for locating it in source */
	varName: string
	/** Prefix passed to c.id(), or null for an auto-increment or absent prefix */
	idPrefix: string | null
	/** Null when the table has a composite primary key — see meta-contract §6.4 */
	identity: string | null
	/** the soft-delete timestamp column, or null when rows are deleted outright, the column is private, or the table has no single-column primary key */
	softDelete: string | null
	/** the column that scopes rows to a tenant, or null when none, or more than one, is declared, it is private, or the table has no single-column primary key */
	tenantColumn: string | null
	/** the primary key spans more than one column */
	compositePrimaryKey: boolean
	/** every column, private ones flagged, in declaration order */
	columns: ManifestColumn[]
	/** every foreign key, in column order */
	relations: ManifestRelation[]
	/** the unique indexes, as the stamp publishes them */
	uniqueIndexes: {
		/** the index's name, which a violation of it reports */
		name: string
		/** the indexed columns, by name, in index order */
		columns: string[]
	}[]
	/** each with its predicate, SQL over SQL names, as the stamp publishes them (meta-contract §6.8) */
	partialUniqueIndexes: {
		/** the index's name, which a violation of it reports */
		name: string
		/** the indexed columns, by name, in index order */
		columns: string[]
		/** the rows the columns are unique among, as SQL */
		where: string
	}[]
	/** the table's CHECK constraints */
	checkConstraints: {
		/** the constraint's name, which a violation of it reports */
		name: string
		/** the condition every row must meet, as SQL */
		expression: string
	}[]
}

/** The model as JSON, for tools that do not read TypeScript */
type Manifest = {
	/** the format version, `MANIFEST_VERSION`: raised only when a field is removed or changes meaning, never when one is added */
	v: number
	/** the database's name: its key in comb.config.ts, or under `--tables` the one in the tables file's name (`core` for `db.core.tables.ts`) */
	database: string
	/** every table, sorted by `name`, so an unchanged schema regenerates an identical file */
	entities: ManifestEntity[]
}

/** Where the manifest generator writes */
type ManifestConfig = {
	/** the JSON file written, relative to the codegen working directory */
	output: string
}

/** The format a text column declares, the one the DTO checks */
const textKindOf = (constraints: FieldMeta["constraints"]): ManifestColumn["textKind"] =>
	(["email", "url", "imageUri", "password", "name"] as const).find((kind) => constraints[kind]) ?? null

function toColumn(field: FieldMeta, dialect: GeneratorContext["dialect"]): ManifestColumn {
	const { constraints } = field
	const { max, maxBytes, min, patterns } = writeRules(field, dialect)
	return {
		enumValues: field.enumValues,
		/* what the write bodies do, read off the rule the DTOs and the stamp read, a private column's too */
		generated: !writesOf(field).create,
		immutable: !writesOf(field).update,
		kind: field.drizzleHelper,
		max,
		maxBytes,
		min,
		name: field.name,
		notNull: field.isNotNull,
		patterns,
		primaryKey: field.isPrimaryKey,
		textKind: textKindOf(constraints),
		transform: transformsOf(constraints, true),
		private: constraints.private,
		sqlType: field.sqlType,
		dimensions: field.dimensions ?? 0,
		nullElements: field.nullElements === true,
		states: field.states
			? {
					initial: field.states.initial,
					terminal: field.states.terminal ?? [],
					transitions: field.states.transitions,
				}
			: null,
	}
}

/** Each table's entity name, by the variable a foreign key names its target with */
const entityNames = (tables: TableMeta[]): Map<string, string> =>
	new Map(tables.map((table) => [table.varName, qualifiedName(table)]))

function toEntity(table: TableMeta, dialect: GeneratorContext["dialect"], names: Map<string, string>): ManifestEntity {
	/* The same derivation the schema stamp uses, so the two cannot disagree. */
	const meta = deriveEntityMeta(table)

	const relations: ManifestRelation[] = []
	for (const field of table.fields) {
		const fk = field.foreignKey
		if (!fk) continue
		relations.push({
			column: fk.column,
			...(fk.key === undefined ? {} : { key: { columns: fk.key.columns, refColumns: fk.key.refColumns } }),
			onDelete: fk.onDelete ?? null,
			onUpdate: fk.onUpdate ?? null,
			refColumn: fk.refColumn,
			table: names.get(fk.refTable) as string,
		})
	}

	return {
		checkConstraints: table.checkConstraints.map((c) => ({ expression: c.expression, name: c.name })),
		columns: table.fields.map((f) => toColumn(f, dialect)),
		compositePrimaryKey: table.hasCompositePrimaryKey,
		identity: meta?.identity ?? null,
		idPrefix: table.idPrefix,
		name: qualifiedName(table),
		relations,
		softDelete: meta?.softDelete ?? null,
		tenantColumn: meta?.tenantColumn ?? null,
		partialUniqueIndexes: publishedPartialUniqueIndexes(table).map((u) => ({
			columns: u.columns,
			name: u.name,
			where: u.where,
		})),
		uniqueIndexes: publishedUniqueIndexes(table).map((u) => ({ columns: u.columns, name: u.name })),
		varName: table.varName,
	}
}

/**
 * Build the manifest without writing it — useful to a caller assembling its own
 * artifact, and the unit under test. `dialect` decides what a column holds, as the DTO's does.
 *
 * Entities are sorted by SQL name so regenerating an unchanged schema produces
 * an identical file regardless of declaration order.
 */
function buildManifest(tables: TableMeta[], dbName: string, dialect: GeneratorContext["dialect"]): Manifest {
	const names = entityNames(tables)
	return {
		database: dbName,
		entities: tables
			.map((table) => toEntity(table, dialect, names))
			.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name)),
		v: MANIFEST_VERSION,
	}
}

/** Write the manifest alongside the generated entities. */
function generateManifest(ctx: GeneratorContext, config: ManifestConfig): void {
	const { dbName, tables } = ctx.analysis
	const { cwd } = ctx
	const outputPath = path.resolve(cwd, config.output)
	const manifest = buildManifest(tables, dbName, ctx.dialect)

	writeGenJsonFile(outputPath, manifest, { generator: "comb", staged: ctx.staged })
	ctx.log(`  manifest: ${outputPath} (${manifest.entities.length} entities)`)
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
