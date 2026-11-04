/**
 * Whether a test file reaches the Postgres test server, and whether it takes the run's lock itself,
 * read from what its code does, never from its name or path (comb-9d, plan 21): a real import of
 * node-postgres, postgres.js or a Postgres test helper, a read of the server's variable, or that
 * variable handed on as a property, as to a child process's env. A string or a comment that only
 * spells one (a lint fixture, a workflow's env line) is no reach, and nor is a type-only import.
 */
import { ts } from "ts-morph"

/** The server's variable */
const PG_VAR = "COMB_TEST_PG_URL"

/** The modules whose import reaches the server: the drivers, and each Postgres test helper (tests/support/pg-suites.ts) */
const PG_MODULE =
	/^(?:pg|postgres)$|\/support\/(?:pg|pg-check|pg-lock|pg-pause|pg-roles|pg-run-lock|pg-url|stale-replay)\.ts$/

/** The shared helper that takes the run's lock (tests/support/pg-lock.ts) */
const LOCK_MODULE = /\/support\/pg-lock\.ts$/
const LOCK_CALL = "acquirePgRunLock"

const parsed = (text: string): ts.SourceFile =>
	ts.createSourceFile("file.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)

/** Every node of `file`, depth first */
function nodes(node: ts.Node, all: ts.Node[] = []): ts.Node[] {
	all.push(node)
	ts.forEachChild(node, (child) => void nodes(child, all))
	return all
}

/** Whether `node` imports a value, not types alone */
function importsValue(node: ts.ImportDeclaration): boolean {
	const clause = node.importClause
	if (clause === undefined) return true
	if (clause.isTypeOnly) return false
	if (clause.name !== undefined) return true
	const bindings = clause.namedBindings
	return bindings === undefined || ts.isNamespaceImport(bindings) || bindings.elements.some((e) => !e.isTypeOnly)
}

/** The module `node` loads as a value: a value import, or a dynamic `import()` */
function loaded(node: ts.Node): string | undefined {
	if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && importsValue(node))
		return node.moduleSpecifier.text
	const [first] = ts.isCallExpression(node) ? node.arguments : []
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && first !== undefined)
		return ts.isStringLiteral(first) ? first.text : undefined
	return undefined
}

/** Whether `node` reads the server's variable by its name */
function readsVar(node: ts.Node): boolean {
	if (ts.isPropertyAccessExpression(node)) return node.name.text === PG_VAR
	if (ts.isElementAccessExpression(node))
		return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === PG_VAR
	return false
}

/** Whether `node` reads the server's variable, or hands it on as a property */
function usesVar(node: ts.Node): boolean {
	if (readsVar(node)) return true
	if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
		return (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === PG_VAR
	return false
}

/** Whether the code `text` reaches the Postgres test server */
export function reachesPg(text: string): boolean {
	for (const node of nodes(parsed(text))) {
		const module = loaded(node)
		if ((module !== undefined && PG_MODULE.test(module)) || usesVar(node)) return true
	}
	return false
}

/** Whether the code `text` takes the run's lock itself: it imports the shared helper and calls it */
export function takesPgLock(text: string): boolean {
	const all = nodes(parsed(text))
	const imported = all.some(
		(node) =>
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			LOCK_MODULE.test(node.moduleSpecifier.text) &&
			node.importClause?.namedBindings !== undefined &&
			ts.isNamedImports(node.importClause.namedBindings) &&
			node.importClause.namedBindings.elements.some((element) => element.name.text === LOCK_CALL),
	)
	return (
		imported &&
		all.some(
			(node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === LOCK_CALL,
		)
	)
}

/**
 * Whether the code `text` reads the server's variable by its name, past pgUrl (tests/support/pg-url.ts),
 * which reads it through its constant and refuses it unset or empty: a read of its own could hand an
 * unset URL on, and the suite fail later on something else
 */
export const readsPgVar = (text: string): boolean => nodes(parsed(text)).some(readsVar)
