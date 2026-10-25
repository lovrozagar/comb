/** What the diagram generator reads the analysis into, and each of its renderers writes from */
export interface Column {
	name: string
	nullable: boolean
	primaryKey: boolean
	reference?: {
		column: string
		onDelete?: string | undefined
		onUpdate?: string | undefined
		table: string
	}
	type: string
}

/** a composite foreign key, which SQL writes on its table rather than on one column (F46) */
export interface TableKey {
	columns: string[]
	onDelete?: string | undefined
	onUpdate?: string | undefined
	refColumns: string[]
	table: string
}

export interface Table {
	columns: Column[]
	/** its composite foreign keys */
	foreignKeys: TableKey[]
	/** a composite primary key's SQL columns, empty for none */
	key: string[]
	name: string
}

export interface Relation {
	from: string
	onDelete?: string | undefined
	onUpdate?: string | undefined
	to: string
}
