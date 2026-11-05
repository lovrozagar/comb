/**
 * KT7 of r22b: `runCli(argv, io)` takes what an embedder supplies, and nothing typed by comb's
 * internals. Checked by `bun run typecheck`; nothing here runs.
 */
import { expectTypeOf } from "vitest"
import type { CliIo, Run, RunOptions, RunResult, Terminal } from "../../src/cli/index.ts"

/* the working folder, the two streams, a question, and the one process seam, which an embedder can type */
expectTypeOf<keyof CliIo>().toEqualTypeOf<"confirm" | "cwd" | "err" | "out" | "run">()
expectTypeOf<CliIo["run"]>().toEqualTypeOf<Run | undefined>()
expectTypeOf<Run>().parameters.toEqualTypeOf<[cmd: string, args: readonly string[], options?: RunOptions]>()
expectTypeOf<Run>().returns.toEqualTypeOf<Promise<RunResult>>()

/* Terminal is typed by the calls comb makes, so it names no `NodeJS`: the process's own streams still fit it, and a number does not */
expectTypeOf(process.stdin).toExtend<Terminal["input"]>()
expectTypeOf(process.stderr).toExtend<Terminal["output"]>()
expectTypeOf<number>().not.toExtend<Terminal["output"]>()
expectTypeOf<{ write(chunk: number): void }>().not.toExtend<Terminal["output"]>()

/* the types 0.20.1 named, which an embedder's streams were typed by, fit it too */
expectTypeOf<NodeJS.ReadableStream & { isTTY?: boolean }>().toExtend<Terminal["input"]>()
expectTypeOf<NodeJS.WritableStream>().toExtend<Terminal["output"]>()
