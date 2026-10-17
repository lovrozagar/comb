#!/usr/bin/env bun
import { runCli } from "./cli.ts"

process.exitCode = await runCli(process.argv.slice(2), {
	cwd: process.cwd(),
	err: (line) => console.error(line),
	out: (line) => console.log(line),
})
