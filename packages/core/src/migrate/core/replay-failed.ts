/** The dev database could not be readied, or the history could not be replayed on it, or the target read: nothing was compared */
class ReplayFailed extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "ReplayFailed"
	}
}

export { ReplayFailed }
