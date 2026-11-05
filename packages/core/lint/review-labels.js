/* The internal review labels a shipped comment must not cite: a finding's ID, as "KC2 of r22b",
 * "(AB3-5)", "B2-3 of area B" or "S6 of the 0.15.0 review". A consumer reads comb's src and its
 * generated files; the label means nothing there, so the comment says the reason and the commit
 * message keeps the label. Both comb/no-review-label and the codemod that stripped them read this. */

/* the words between two of a label's, which a comment may wrap: a space, or a line end and the next
 * line's comment lead */
const GAP = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*(?:\*(?!\/)|\/\/)?[ \t]*)`

/* real names a finding's ID would match: Cloudflare D1, SQLite FTS5, Go's RE2, a hash, a standard,
 * an encoding, a Postgres integer type, a TypeScript diagnostic, a SQLSTATE */
const NAMES = String.raw`(?!(?:D1|FTS\d|RE2|SHA\d+|ES\d{4}|UTF\d+|INT\d+|TS\d{4}|P0001|XX000)\b)`

/** One finding's ID: an optional `letter-` prefix, letters, a number, an optional `-number` and an
 * optional letter (QL2, N-S5, AB4-7, P1a) */
const ID = String.raw`\b${NAMES}(?:[A-Z]-)?[A-Z]{1,3}\d+(?:-\d+)?[a-z]?\b`

/* the review a finding belongs to */
const ROUND = [
	String.raw`r\d+[a-z]?(?:${GAP}review)?`,
	String.raw`area${GAP}[A-Z](?:${GAP}round${GAP}\d+)?(?:'s${GAP}review)?`,
	String.raw`plan${GAP}\d+(?:'s${GAP}(?:rerun|review))?`,
	String.raw`phase${GAP}\d+`,
	String.raw`\d+\.\d+(?:\.\d+)?(?:'s${GAP}review)?`,
	String.raw`the${GAP}(?:\d+\.\d+\.\d+${GAP}(?:consumers${GAP})?(?:review|round)|area${GAP}[A-Z](?:${GAP}round-\w+)?${GAP}reviews?|round-\w+${GAP}review|r\d+[a-z]?${GAP}review)`,
].join("|")

/* a plan's step, which a label qualifies as a finding's ID: `27.12 of plan 15` */
const STEP = String.raw`\b\d+(?:\.\d+)+[a-z]?\b`

/* a probe's number, which a label qualifies as a finding's ID: `0005 of r22b` */
const PROBE = String.raw`\b\d{4}\b`

/** IDs joined by commas or `and`, with the review they belong to: `CD7, CS4 and CS6 of r22b` */
const QUALIFIED = String.raw`(?:${ID}|${STEP}|${PROBE})(?:(?:,${GAP}|${GAP}and${GAP})(?:${ID}|${STEP}|${PROBE}))*${GAP}of${GAP}(?:${ROUND})\b`

/* a label a comment cites: a qualified one, one its review leads (`r19 C5`), an ID with a part
 * (`AB3-5`) or a possessive (`AA10's`), or a release's gate (`0.20.0 G3`) */
const CITED = String.raw`${QUALIFIED}|plan${GAP}\d+'s${GAP}${STEP}|\br\d+[a-z]?${GAP}${ID}|${ID}(?='s\b)|\b${NAMES}[A-Z]{1,3}\d+-\d+[a-z]?\b|\b\d+\.\d+\.\d+${GAP}G\d\b`

/* any other ID, wherever it stands (`the F20 check`, `// C21`): a finding's ID is no word a reader
 * knows, so only a real name in NAMES passes, or a VDBE opcode's operand P1 to P5 where prose names
 * it as one (`whose P1 is`, `the cursor P1`). A new real name this flags goes in NAMES. */
const OPERAND = String.raw`(?<=\b(?:whose|their|its|on|cursor|with|and)[ \t]+)P[1-5]\b`
const TOKEN = String.raw`\b${NAMES}(?!${OPERAND})(?:[A-Z]-)?[A-Z]{1,3}\d+(?:-\d+)?[a-z]?\b`

/* a plan's step alone in a parenthesis or one of its comma- or semicolon-parts (`(27.17)`), which a
 * version never is: it names its product (`TypeScript 5.7`); a review round alone (`r22b`); and a
 * scratch log under .tmp/grunt, which no checkout holds. A step's own letter runs a to c, so a
 * duration (`1.5s`) is no step */
const LEFT = String.raw`(?<=[(,;][ \t]*)\d+(?:\.\d+)+[a-c]?(?=[ \t]*[),;])|\br\d+[a-z]?\b|(?:\.\/)?\.tmp\/grunt\/[^\s),;]+`

/** Every review label in `text`, one regex so a list's IDs are its label's, not their own */
const LABEL = new RegExp(`${CITED}|${TOKEN}|${LEFT}`, "gm")

/** Every review label `text` cites, in order, each on one line */
export function reviewLabels(text) {
	return [...String(text).matchAll(LABEL)].map((match) => match[0].replaceAll(new RegExp(GAP, "g"), " "))
}

export { GAP, ID, LABEL }
