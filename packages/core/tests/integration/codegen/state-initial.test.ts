/**
 * CD4 of r22b: a state column's declared `initial` is the value a row starts at
 * (docs/state-machines.md §2), yet the create DTO took every state, so a client created a job
 * already `done` and skipped the lifecycle the update side and `assertTransition` guard. The create
 * DTO takes `initial` alone, published as `const`, with it as the example; the update DTO keeps the
 * enum; and a default other than `initial` is refused at codegen, naming the column.
 */
import { afterAll, describe, expect, it } from "vitest"
import * as z from "zod"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const DIALECTS = ["postgres", "sqlite"] as const
type Dialect = (typeof DIALECTS)[number]

const STATES = ["queued", "running", "done", "failed"]
const MACHINE =
	'{ initial: "queued", terminal: ["done", "failed"], transitions: { queued: ["running"], running: ["done", "failed"] } }'

/** A job table whose `status` is a state column, with `tail` after it (a default, a not-null) */
const table = (dialect: Dialect, tail: string): string =>
	`export const STATES = ${JSON.stringify(STATES)} as const
export const job = ${dialect === "postgres" ? "pgTable" : "sqliteTable"}("job", { id: c.text("id").primaryKey(), status: c.enum("status", STATES, ${MACHINE})${tail} })`

/* the column's shapes: [name, tail, whether a create may leave it out] */
const SHAPES: Array<[shape: string, tail: string, optional: boolean]> = [
	["with a default", '.notNull().default("queued")', true],
	["without a default", ".notNull()", false],
]

type Published = { const?: unknown; enum?: unknown; examples?: unknown[] }

describe("create takes only a state column's initial (CD4; sibling: the update DTO's enum)", () => {
	describe.each(DIALECTS)("on %s", (dialect) => {
		it.each(SHAPES)("%s: create takes initial alone, update every state", async (shape, tail, optional) => {
			const dtos = await generatedDtos(
				`cd4-${dialect}-${SHAPES.findIndex(([each]) => each === shape)}`,
				table(dialect, tail),
				{
					dialect,
				},
			)
			const create = dtos["job"]?.["jobDtoCreateSchema"] as z.ZodObject
			const update = dtos["job"]?.["jobDtoUpdateSchema"] as z.ZodObject
			for (const status of STATES) {
				expect(create.safeParse({ id: "j1", status }).success, `create ${status}`).toBe(status === "queued")
				expect(update.safeParse({ status }).success, `update ${status}`).toBe(true)
			}
			expect(create.safeParse({ id: "j1" }).success).toBe(optional)
			const published = z.toJSONSchema(create, { io: "input" }).properties?.["status"] as Published
			expect(published.const).toBe("queued")
			expect(published.examples).toEqual(["queued"])
			const updated = z.toJSONSchema(update, { io: "input" }).properties?.["status"] as Published
			expect(updated.enum).toEqual(STATES)
			expect(updated.examples).toEqual(["queued"])
		})

		it("refuses a default other than initial, naming the column", async () => {
			await expect(
				generatedDtos(`cd4-other-${dialect}`, table(dialect, '.notNull().default("done")'), { dialect }),
			).rejects.toThrow(
				'job.status: its default "done" is not its state machine\'s initial "queued"; a row starts at initial',
			)
		})

		it("refuses a default function, which comb cannot hold to initial, naming the column", async () => {
			await expect(
				generatedDtos(`cd4-fn-${dialect}`, table(dialect, '.notNull().$defaultFn(() => "queued")'), { dialect }),
			).rejects.toThrow(
				'job.status: its default is no literal value, so comb cannot hold it to its state machine\'s initial "queued"; write .default("queued")',
			)
		})
	})
})
