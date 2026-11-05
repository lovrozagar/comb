/**
 * What a failed `wrangler d1 migrations apply` says, read for the refusal comb gives.
 */
import { LOCKER } from "../drivers/d1-lock.ts"

type Ran = { stderr: string; stdout: string }

/** wrangler's own error lines from a failed run, its colours and banner left out; its whole output when it printed none */
export function wranglerError({ stderr, stdout }: Ran): string {
	/* the escape sequences that colour a terminal's text */
	const output = `${stderr}${stdout}`.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
	const errors = output.split("\n").filter((line) => line.includes("[ERROR]"))
	return (errors.length > 0 ? errors.map((line) => line.trim()).join("; ") : output).trim()
}

/**
 * Why a failed apply failed. When it `locked` out on a --local target (d1-lock.ts lockedOut), another process held
 * the file's write lock: wrangler runs its batch once and names only an internal error, so the lock is named here and
 * never waited out, since comb cannot know the batch did nothing, and what the table holds says what is still pending.
 */
export function applyFailure(ran: Ran, locked: boolean): string {
	return locked
		? `the local D1 database was locked by ${LOCKER} while wrangler applied: let it finish and rerun`
		: wranglerError(ran)
}
