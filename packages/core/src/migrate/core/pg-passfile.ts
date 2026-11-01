/**
 * The password a Postgres URL's `passfile` gives, read as libpq reads its password file (P7 of r18):
 * lines of `host:port:database:user:password`, `#` comments and blank lines skipped, `\` escaping
 * the next character, a field of `*` alone matching anything, the first line that matches winning.
 * A socket target matches as `localhost`. A missing file gives none, as libpq's does; one others can
 * read is refused, as libpq ignores it. comb never reads ~/.pgpass or PGPASSFILE: the URL is the
 * connection (README §configuration).
 */
import { readFileSync, statSync } from "node:fs"
import type { LibpqUrl } from "./pg-url.ts"

/** A line's fields, each as written and unescaped */
function fieldsOf(line: string): Array<{ any: boolean; text: string }> {
	const out: Array<{ any: boolean; text: string }> = []
	let [raw, text] = ["", ""]
	for (let i = 0; i < line.length; i++) {
		const char = line[i] as string
		if (char === "\\" && i + 1 < line.length) {
			raw += char + (line[i + 1] as string)
			text += line[++i] as string
		} else if (char === ":") {
			out.push({ any: raw === "*", text })
			;[raw, text] = ["", ""]
		} else {
			raw += char
			text += char
		}
	}
	return [...out, { any: raw === "*", text }]
}

/** The file's text, or undefined where there is none to read */
function contentsOf(file: string): string | undefined {
	try {
		if ((statSync(file).mode & 0o077) !== 0)
			throw new Error(`passfile ${file} can be read by others, so libpq ignores it; chmod 600 it`)
		return readFileSync(file, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

/** The password `url`'s passfile gives it, or undefined when it names none or none matches */
export function passfilePassword(url: LibpqUrl): string | undefined {
	const file = url.params.get("passfile")
	const text = file === undefined ? undefined : contentsOf(file)
	if (text === undefined) return undefined
	const wanted = [url.socket ? "localhost" : url.host, String(url.port), url.database, url.user]
	for (const line of text.split(/\r?\n/)) {
		if (line === "" || line.startsWith("#")) continue
		const fields = fieldsOf(line)
		if (fields.length < 5) continue
		if (wanted.every((value, i) => (fields[i] as { any: boolean; text: string }).any || fields[i]?.text === value))
			return fields
				.slice(4)
				.map(({ text: part }) => part)
				.join(":")
	}
	return undefined
}
