/**
 * In a Bun single-file executable, process.execPath is the app itself and comb's own modules live in
 * the filesystem it embeds, which no second process can read and from which a project's package
 * cannot be loaded. Codegen's child, the D1 proof's child and wrangler's module each need one, so
 * each is refused up front with what it needs.
 */

/* where a Bun single-file executable embeds its modules, on posix and on windows */
const EMBEDDED = /\/\$bunfs\/|\/~BUN\//

/** Throws `refusal` when a Bun single-file executable embeds the module at `moduleUrl` */
export function refuseCompiled(moduleUrl: string, refusal: string): void {
	if (EMBEDDED.test(moduleUrl)) throw new Error(refusal)
}

/**
 * What comb says when a Bun single-file executable runs a migrate command or an API call that loads
 * `peers` from the project: the executable embeds comb's modules, from which no installed package
 * resolves or loads
 */
export const compiledRefusal = (peers: readonly string[]): string =>
	`comb loads ${peers.join(" and ")} from the project, which a Bun single-file executable cannot do: run it with bun or node, not from a compiled executable`

/**
 * What comb says when a Bun single-file executable runs `command`, whose tables file loads in a
 * child process: the child is the executable itself, as codegen says of its own load
 */
export const childRefusal = (command: string): string =>
	`comb migrate ${command} loads the tables file in a child process, which cannot read the modules a Bun single-file executable embeds: run comb migrate with bun or node, not from a compiled executable`
