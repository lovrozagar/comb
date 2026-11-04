/**
 * In a Bun single-file executable, process.execPath is the app itself and comb's own modules live in
 * the filesystem it embeds, which no second process can read and from which a project's package
 * cannot be loaded. Codegen's child, the D1 proof's child and wrangler's module each need one, so
 * each is refused up front with what it needs (D3-4 and D4-5 of the area D reviews).
 */

/* where a Bun single-file executable embeds its modules, on posix and on windows */
const EMBEDDED = /\/\$bunfs\/|\/~BUN\//

/** Throws `refusal` when a Bun single-file executable embeds the module at `moduleUrl` */
export function refuseCompiled(moduleUrl: string, refusal: string): void {
	if (EMBEDDED.test(moduleUrl)) throw new Error(refusal)
}
