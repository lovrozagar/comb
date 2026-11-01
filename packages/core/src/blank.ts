/**
 * One rule for the text a config states (S5, S6, K7 of r19): a name, a path or a credential that
 * holds only whitespace is blank, as an empty one is. A config holds its names and paths to it at
 * load, through `nonBlank`, and a command holds a credential it resolves to it at use, through
 * `blank`, so a template or an env file's stray space fails naming the field, never at the
 * service it would be sent to.
 */
import * as z from "zod"

/** Whether `value` holds nothing but whitespace */
const blank = (value: string): boolean => value.trim() === ""

/** A string a config states that must not be blank, `missing` its message when it is absent; the issue's path names the key */
const nonBlank = (message = "must not be blank", missing?: string): z.ZodString =>
	z.string(missing === undefined ? undefined : { error: missing }).refine((value) => !blank(value), { message })

export { blank, nonBlank }
