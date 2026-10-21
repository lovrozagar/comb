/** A pending migration refused before anything applied: the reason, and every file that was pending */
export class Refused extends Error {
	readonly pending: string[]

	constructor(message: string, pending: readonly string[]) {
		super(message)
		this.name = "Refused"
		this.pending = [...pending]
	}
}
