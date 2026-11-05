/**
 * An ALTER DOMAIN read from its parse tree, rated as its column twin (P16 of the 0.14.1 review):
 * every column of the domain holds what it changes, so a DROP DEFAULT and a DROP CONSTRAINT are
 * cautious, a SET NOT NULL unsafe with a scan, and a validated check a scan. Postgres validates a
 * domain's constraint under SHARE on each table with a column of it, so a VALIDATE CONSTRAINT scans
 * as the ADD would have, in any file: no NOT VALID form avoids that lock (PA9 of r22b).
 */
import type { Finding } from "./classify-alter.ts"
import { names, type Node } from "./pg-nodes.ts"

/** An ALTER DOMAIN, rated as its column twin (P16): every column of the domain holds what it changes */
function domainFindings(node: Node): Finding[] {
	const scan: Finding = {
		level: "lock",
		note: `scans every column of domain ${names(node["typeName"]).join(".")}, and blocks writes to each table that holds one while it scans`,
	}
	const subtype = node["subtype"]
	/* T is SET or DROP DEFAULT, O SET NOT NULL, C ADD CONSTRAINT, X DROP CONSTRAINT, V VALIDATE CONSTRAINT */
	if (subtype === "T") return node["def"] === undefined ? [{ level: "cautious" }] : []
	if (subtype === "O") return [{ level: "unsafe" }, scan]
	if (subtype === "C") return ((node["def"] as Node)["Constraint"] as Node)["skip_validation"] === true ? [] : [scan]
	if (subtype === "V") return [scan]
	return subtype === "X" ? [{ level: "cautious" }] : []
}

export { domainFindings }
