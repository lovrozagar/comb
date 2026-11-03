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
	/** the stamp on the generated read schema */
	stamp: CombEntityMeta
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
	if (stamp === null) throw new Error(`${entity}'s read schema carries no stamp`)
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
 * Each disagreement between the channels, as `<field>: <what>`: a field the stamp calls generated
 * that the create DTO takes, or immutable that the update DTO takes, and back; and the manifest's
 * flags against the stamp's lists
 */
export function disagreements({ create, manifest, stamp, update }: EntityChannels): string[] {
	return Object.values(manifest).flatMap(({ generated, immutable, name, private: hidden }) => {
		if (hidden) return []
		const said = { generated: stamp.generated.includes(name), immutable: stamp.immutable.includes(name) }
		return [
			...(said.generated === create.includes(name)
				? [`${name}: stamp generated ${said.generated}, create takes it ${create.includes(name)}`]
				: []),
			...(said.immutable === update.includes(name)
				? [`${name}: stamp immutable ${said.immutable}, update takes it ${update.includes(name)}`]
				: []),
			...(generated === said.generated ? [] : [`${name}: manifest generated ${generated}, stamp ${said.generated}`]),
			...(immutable === said.immutable ? [] : [`${name}: manifest immutable ${immutable}, stamp ${said.immutable}`]),
		]
	})
}
