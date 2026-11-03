/**
 * The facts comb publishes about one entity, by each channel that publishes them: the stamp it
 * emits on the generated read schema, the keys the generated create and update DTOs take, and the
 * manifest. meta-contract §8.2 holds them to one another field by field, so a test generates the
 * DTOs, reads the stamp off the read schema's published JSON Schema, as a consumer reads it, rather
 * than off a restated rule, and compares.
 */
import path from "node:path"
import * as z from "zod"
import { analyze } from "../../../src/codegen/analyzer.ts"
import { buildManifest, type ManifestColumn } from "../../../src/codegen/generators/manifest.ts"
import { type CombEntityMeta, readCombEntityMeta } from "../../../src/meta.ts"
import { type GenerateOptions, generatedDir, generatedDtos } from "./dtos.ts"

export type EntityChannels = {
	/** the keys the generated create DTO takes */
	create: string[]
	/** the manifest's column of each field, by name */
	manifest: Record<string, ManifestColumn>
	/** the stamp on the generated read schema; null where it carries none, as for a composite key */
	stamp: CombEntityMeta | null
	/** the keys the generated update DTO takes */
	update: string[]
}

const keysOf = (schema: unknown): string[] => Object.keys((schema as z.ZodObject).shape)

/** Each channel's facts on `entity`, its DTOs generated from `tables` under `name` */
export async function entityChannels(
	name: string,
	tables: string,
	options: GenerateOptions & { dialect: "postgres" | "sqlite"; entity: string },
): Promise<EntityChannels> {
	const { entity } = options
	const dtos = await generatedDtos(name, tables, options)
	const kebab = entity.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
	const module = dtos[kebab] as Record<string, unknown>
	const published = z.toJSONSchema(module[`${entity}DtoReadSchema`] as z.ZodType, { unrepresentable: "any" })
	const stamp = readCombEntityMeta(published)
	const analysis = analyze(path.join(generatedDir(name), "db.x.tables.ts"))
	const manifest = buildManifest(analysis.tables, "x", options.dialect).entities.find((each) => each.varName === entity)
	if (manifest === undefined) throw new Error(`the manifest holds no ${entity}`)
	return {
		create: keysOf(module[`${entity}DtoCreateSchema`]),
		manifest: Object.fromEntries(manifest.columns.map((column) => [column.name, column])),
		stamp,
		update: keysOf(module[`${entity}DtoUpdateSchema`]),
	}
}

/**
 * Each disagreement between the channels, as `<field>: <what>`: the manifest's `generated` against
 * the create body and its `immutable` against the update body, for every column, a private one
 * included (CS6 of r22b); and, for a published column, the stamp's lists against both, both ways
 * (CS4). A private column is in neither of the stamp's lists, whose names stay out of the document
 */
export function disagreements({ create, manifest, stamp, update }: EntityChannels): string[] {
	return Object.values(manifest).flatMap(({ generated, immutable, name, private: hidden }) => {
		const body = { generated: !create.includes(name), immutable: !update.includes(name) }
		const said = {
			generated: stamp?.generated.includes(name) ?? body.generated,
			immutable: stamp?.immutable.includes(name) ?? body.immutable,
		}
		const listed = hidden && stamp !== null && (said.generated || said.immutable)
		return [
			...(generated === body.generated
				? []
				: [`${name}: manifest generated ${generated}, create takes it ${!body.generated}`]),
			...(immutable === body.immutable
				? []
				: [`${name}: manifest immutable ${immutable}, update takes it ${!body.immutable}`]),
			...(listed ? [`${name}: private, yet in the stamp's lists`] : []),
			...(hidden || said.generated === body.generated
				? []
				: [`${name}: stamp generated ${said.generated}, create takes it ${!body.generated}`]),
			...(hidden || said.immutable === body.immutable
				? []
				: [`${name}: stamp immutable ${said.immutable}, update takes it ${!body.immutable}`]),
		]
	})
}
