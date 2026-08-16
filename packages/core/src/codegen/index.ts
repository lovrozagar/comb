export { analyze } from "./analyzer.ts"
export type {
	AnalysisResult,
	CheckConstraintMeta,
	FieldConstraintsMeta,
	FieldMeta,
	ForeignKeyRef,
	ImportsMeta,
	TableMeta,
	TimestampsMeta,
	UniqueIndexMeta,
} from "./analyzer-types.ts"
export { type FieldConstraints, parseFieldConstraints } from "./annotations.ts"
export { deriveEntityMeta, isExcludedFromUpdate } from "./entity-meta.ts"
export { validateTables } from "./utils/validate.ts"
