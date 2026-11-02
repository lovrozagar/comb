/** The files a stopped run names: still pending, applied before it stopped, and unknown, whose answer was lost */
type Files = { applied?: readonly string[]; pending: readonly string[]; unknown?: readonly string[] }

/**
 * A migration run stopped: the reason, the files still pending, the files that applied before it
 * stopped, none when it was refused before anything ran, and the files that may have committed,
 * whose answer was lost, for `comb migrate status` to read (S3 of r20)
 */
export class Refused extends Error {
	readonly applied: string[]
	readonly pending: string[]
	readonly unknown: string[]

	constructor(message: string, { applied = [], pending, unknown = [] }: Files) {
		super(message)
		this.name = "Refused"
		this.applied = [...applied]
		this.pending = [...pending]
		this.unknown = [...unknown]
	}
}
