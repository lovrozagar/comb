export { analyze } from "./analyzer.ts"
export {
	type CodegenConfig,
	type DatabaseCodegen,
	defineCodegenConfig,
	type FtsTableConfig,
	GENERATORS,
	type GeneratorName,
} from "./config.ts"
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
export { type FieldConstraints, fieldConstraintsOf } from "./annotations.ts"
export { deriveEntityMeta, isExcludedFromUpdate } from "./entity-meta.ts"
export { validateTables } from "./utils/validate.ts"
