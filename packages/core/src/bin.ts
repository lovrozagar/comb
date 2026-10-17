#!/usr/bin/env bun
import { processIo, runCli } from "./cli/index.ts"

process.exitCode = await runCli(process.argv.slice(2), processIo())
