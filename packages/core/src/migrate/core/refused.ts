/**
 * A migration run stopped: the reason, the files still pending, and the files that applied before
 * it stopped, none when it was refused before anything ran
 */
export class Refused extends Error {
	readonly applied: string[]
	readonly pending: string[]

	constructor(message: string, pending: readonly string[], applied: readonly string[] = []) {
		super(message)
		this.name = "Refused"
		this.applied = [...applied]
		this.pending = [...pending]
	}
}
