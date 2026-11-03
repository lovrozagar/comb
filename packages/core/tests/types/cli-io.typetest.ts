/**
 * KT7 of r22b: `runCli(argv, io)` takes what an embedder supplies, and nothing typed by comb's
 * internals. Checked by `bun run typecheck`; nothing here runs.
 */
import { expectTypeOf } from "vitest"
import type { CliIo, Run, RunOptions, RunResult } from "../../src/cli/index.ts"

/* the working folder, the two streams, a question, and the one process seam, which an embedder can type */
expectTypeOf<keyof CliIo>().toEqualTypeOf<"confirm" | "cwd" | "err" | "out" | "run">()
expectTypeOf<CliIo["run"]>().toEqualTypeOf<Run | undefined>()
expectTypeOf<Run>().parameters.toEqualTypeOf<[cmd: string, args: readonly string[], options?: RunOptions]>()
expectTypeOf<Run>().returns.toEqualTypeOf<RunResult>()
