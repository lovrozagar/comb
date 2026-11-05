/** What d1-engine.ts hands the D1 proof's child, as JSON */
export type ProofInput = {
	/** The scratch worker's wrangler.json, one D1 binding named DB */
	configPath: string
	/** Each pending file, in order: its name, and its text with the history row wrangler appends */
	files: Array<{ name: string; query: string }>
	/** The copy of the live schema with its seed rows, and the history table, in one batch */
	seed: string[]
	/** The shadow tables each virtual table module makes, by module: the suffix after its table's name */
	shadows: Readonly<Record<string, readonly string[]>>
	/** The checked wrangler's entry module */
	wrangler: string
}

/** What the child answers: D1's refusal of a file, in D1's words, or none */
export type ProofResult = { refused?: string | undefined }

export function prove(input: ProofInput): Promise<ProofResult>
export function main(input: string): Promise<ProofResult>
