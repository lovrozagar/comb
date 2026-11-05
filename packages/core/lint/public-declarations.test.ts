/** The syntax walk comb/public-jsdoc and its surface share: what of a declaration a consumer sees. */
import { describe, expect, it } from "vitest"
import { walkPublic } from "./public-declarations.js"

type Node = { parent?: Node; type: string; [key: string]: unknown }

describe("walkPublic", () => {
	it("visits each node once on a tree whose nodes point back at their parent, as oxlint's do", () => {
		const child: Node = { type: "Identifier" }
		const program: Node = { body: [child], type: "Program" }
		child.parent = program
		const seen: string[] = []
		walkPublic(program, (node: Node) => {
			seen.push(node.type)
			return true
		})
		expect(seen).toEqual(["Program", "Identifier"])
	})
})
