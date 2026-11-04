/**
 * A migration file's header as Atlas reads it (PA3 of r22b), the one reader of it in comb: the run
 * of comment lines, `--` or `#`, that opens the file, closed by a line empty once spaces and tabs are
 * trimmed, CRLF read as LF; comment lines that run into a statement are that statement's, and no
 * header. A directive is a header line, trimmed, that matches Atlas's own pattern, `atlas:<name>`
 * after printable ASCII and its value after spaces, so a tab before `atlas:` makes it a comment. The
 * pinned Atlas holds this to its own reading (tests/structure/atlas-header.test.ts).
 */

/* Atlas's directive pattern (sql/migrate/dir.go, reDirective), as Go's RE2 reads it */
const DIRECTIVE = /^([ -~]*)atlas:(\w+)(?: +(.+))*/

/** How Atlas runs a file: in one transaction, outside any, or not at all, with Atlas's own error */
type Txmode = "file" | "none" | { refused: string }

/** A file's header: its text as the file has it, the blank lines that close it included; its directives; and its txmode */
type AtlasHeader = { directives: ReadonlyArray<{ name: string; value: string }>; text: string; txmode: Txmode }

/** The txmode the `values` of a file's txmode directives give, as Atlas's txmodeFor decides it */
function txmodeOf(values: readonly string[]): Txmode {
	const [value] = values
	if (value === undefined) return "file"
	/* Atlas lists them as Go's %q does */
	if (values.length > 1)
		return { refused: `multiple txmode values found in file: [${values.map((v) => JSON.stringify(v)).join(" ")}]` }
	if (value === "none" || value === "file") return value
	if (value === "all") return { refused: 'txmode "all" is not allowed in file directive. Use "file" instead' }
	return { refused: `unknown txmode ${JSON.stringify(value)} found in file directive` }
}

/** The lines of `file` from `at`, each with its line break */
function* linesOf(file: string, at = 0): Generator<string> {
	/* one line and the break that ends it, if any; sticky, so each read starts where the last ended */
	const next = /[^\n]*\n?/y
	next.lastIndex = at
	for (let line = next.exec(file)?.[0] ?? ""; line !== ""; line = next.exec(file)?.[0] ?? "") yield line
}

/** The header of the migration file `file` */
function atlasHeader(file: string): AtlasHeader {
	const comments: string[] = []
	let end = 0
	for (const line of linesOf(file)) {
		if (!line.startsWith("--") && !line.startsWith("#")) break
		comments.push(line.trim())
		end += line.length
	}
	/* Atlas's header closes on a line empty once spaces and tabs are trimmed, or at the file's end; otherwise its comments are the first statement's */
	if (comments.length === 0 || !/^(?:[ \t]*\r?\n|$)/.test(file.slice(end))) return NONE
	let blank = end
	for (const line of linesOf(file, end)) {
		if (!/^[ \t]*\r?\n?$/.test(line)) break
		blank += line.length
	}
	const directives = comments.flatMap((comment) => {
		const [, , name, value] = DIRECTIVE.exec(comment) ?? []
		return name === undefined ? [] : [{ name, value: value ?? "" }]
	})
	const txmodes = directives.filter(({ name }) => name === "txmode").map(({ value }) => value)
	return { directives, text: file.slice(0, blank), txmode: txmodeOf(txmodes) }
}

/* the header of a file that has none */
const NONE: AtlasHeader = { directives: [], text: "", txmode: "file" }

/** Whether Atlas runs `file` outside a transaction, as its header's `atlas:txmode none` asks */
const outsideTransaction = (file: string): boolean => atlasHeader(file).txmode === "none"

export { type AtlasHeader, atlasHeader, outsideTransaction, type Txmode }
