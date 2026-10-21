/** A node's source text with its comments removed, so text checks read code, not notes about it. */
import type { Node } from "ts-morph"

/** `node`'s text without any comment inside it. */
/** Where `node` is, as `<file>:<line>`, for an error that points at the source */
export const placeOf = (node: Node): string => `${node.getSourceFile().getFilePath()}:${node.getStartLineNumber()}`

export function textWithoutComments(node: Node): string {
	const start = node.getStart()
	const text = node.getText()
	/* keyed by start: a comment is reported by the node before it and the node after it */
	const ranges = new Map<number, number>()
	for (const part of [node, ...node.getDescendants()]) {
		for (const range of [...part.getLeadingCommentRanges(), ...part.getTrailingCommentRanges()]) {
			if (range.getPos() >= start && range.getEnd() <= node.getEnd()) ranges.set(range.getPos(), range.getEnd())
		}
	}
	let out = ""
	let at = 0
	for (const [pos, end] of [...ranges].sort(([a], [b]) => a - b)) {
		out += text.slice(at, pos - start)
		at = end - start
	}
	return out + text.slice(at)
}
