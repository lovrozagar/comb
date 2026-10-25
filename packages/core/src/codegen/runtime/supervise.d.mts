/** The types of supervise.mjs, which runs as plain JavaScript */
export function supervise(
	timeoutMs: number,
	cmd: string,
	args: readonly string[],
): { done: Promise<{ code: number } | { timedOut: true }>; stop: () => void }

export function main(proc: Pick<NodeJS.Process, "argv" | "exit" | "on">): Promise<void>
