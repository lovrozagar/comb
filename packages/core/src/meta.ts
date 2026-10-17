/**
 * The comb meta contract — facts about tables and queries, stamped onto Zod
 * schemas so they survive the trip to JSON Schema and into an OpenAPI document.
 *
 * comb publishes facts in comb's vocabulary. Mapping them to a consumer's tag
 * names is the consumer's job. See docs/meta-contract.md.
 */
import {
	COMB_FILTER_GRAMMAR,
	COMB_META_KEY,
	COMB_META_VERSION,
	type CombEntityMeta,
	type CombEntityMetaInput,
	type CombFilterField,
	type CombFilterGrammar,
	type CombMeta,
	type CombMetaInput,
	type CombMetaKind,
	type CombMetaStamp,
	type CombQueryMeta,
	type CombQueryMetaInput,
	type CombStatesMeta,
	type UniqueIndexMeta,
} from "./meta/contract.ts"
import { isRecord, readCombEntityMeta, readCombMeta, readCombQueryMeta } from "./meta/read.ts"

/**
 * Build the stamp for a Zod `.meta()` call.
 *
 * Stamp the schema you RETURN, not the one you build from — a transform/pipe
 * does not forward the base's metadata to the output view. See docs §3.1.
 */
function combMeta(meta: CombEntityMetaInput): CombMetaStamp<CombEntityMeta>
function combMeta(meta: CombQueryMetaInput): CombMetaStamp<CombQueryMeta>
function combMeta(meta: CombMetaInput): CombMetaStamp {
	return { [COMB_META_KEY]: { ...meta, v: COMB_META_VERSION } as CombMeta }
}

/** Minimal shape of a Zod schema, so this module needs no zod import. */
type MetaCarrier<T> = { meta: (m: Record<string, unknown>) => T }

/**
 * Re-stamp `to` with the facts `from` carries.
 *
 * `.extend()` drops registry metadata silently (docs §5), so a consumer who
 * extends a generated read schema loses the entity facts with no diagnostic.
 * This is the recovery path.
 */
function carryCombMeta<T>(from: unknown, to: MetaCarrier<T>): T | null {
	const meta = readCombMeta(toJsonSchemaLike(from))
	if (!meta) return null
	return to.meta({ [COMB_META_KEY]: meta })
}

/**
 * What carries the facts: a JSON Schema holds them at its root, a Zod schema in its registry
 * metadata, which `.meta()` with no argument returns.
 */
function toJsonSchemaLike(value: unknown): unknown {
	if (isRecord(value) && COMB_META_KEY in value) return value
	const meta = (value as { meta?: unknown } | null)?.meta
	return typeof meta === "function" ? (meta as () => unknown).call(value) : value
}

export {
	carryCombMeta,
	COMB_FILTER_GRAMMAR,
	COMB_META_KEY,
	COMB_META_VERSION,
	combMeta,
	type CombEntityMeta,
	type CombEntityMetaInput,
	type CombFilterGrammar,
	type CombMeta,
	type CombMetaInput,
	type CombMetaKind,
	type CombMetaStamp,
	type CombFilterField,
	type CombQueryMeta,
	type CombQueryMetaInput,
	type CombStatesMeta,
	type UniqueIndexMeta,
	readCombEntityMeta,
	readCombMeta,
	readCombQueryMeta,
}
