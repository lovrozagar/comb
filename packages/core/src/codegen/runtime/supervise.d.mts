/** The types of supervise.mjs, which runs as plain JavaScript */
export function supervise(job: {
	args: readonly string[]
	cmd: string
	kill?: (pid: number, signal: NodeJS.Signals) => void
	spawn?: typeof import("node:child_process").spawn
	timeoutMs: number
}): { done: Promise<{ code: number } | { timedOut: true }>; stop: () => void }

export function main(proc: Pick<NodeJS.Process, "argv" | "exit" | "on">): Promise<void>
