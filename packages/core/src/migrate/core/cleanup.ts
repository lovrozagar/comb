/**
 * The cleanup a replay registers: one step, run at most once, that SIGINT and SIGTERM run too
 * before the process ends as the signal would
 */

/* the cleanup of a replay that has made nothing yet */
const NOTHING = async (): Promise<void> => undefined

/**
 * A cleanup whose step runs at most once, set once there is something to clean: a signal before
 * that cleans nothing, and the step set after it still runs
 */
export function onceCleanup(): { run: () => Promise<void>; set: (step: () => Promise<void>) => void } {
	let step = NOTHING
	let ran: Promise<void> | undefined
	return {
		run: () => (ran ??= step()),
		set: (next) => {
			step = next
			ran = undefined
		},
	}
}

/**
 * `body`, while SIGINT and SIGTERM run `cleanup` and then end the process as the signal would: by
 * the signal again, unless the host listens for it too and so ends it its own way
 */
export async function onSignals<T>(cleanup: () => Promise<void>, body: () => Promise<T>): Promise<T> {
	const stop = (signal: NodeJS.Signals) => {
		void cleanup().finally(() => {
			if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
		})
	}
	process.once("SIGINT", stop).once("SIGTERM", stop)
	try {
		return await body()
	} finally {
		process.off("SIGINT", stop).off("SIGTERM", stop)
	}
}
