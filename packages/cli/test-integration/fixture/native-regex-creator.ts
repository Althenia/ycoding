import { mock } from "bun:test"
import { writeFileSync } from "node:fs"
import type { SpawnOptions } from "node:child_process"
import { regexProcessSource, REGEX_PROCESS_MARKER } from "../../../codemode/src/internal/regex-process"

const api = await import("node:child_process")
await mock.module("node:child_process", () => ({ ...api, spawn(command: string, args: ReadonlyArray<string>, options: SpawnOptions) {
  const child = api.spawn(command, args, options)
  writeFileSync(process.argv[2], JSON.stringify({ pid: child.pid }), { mode: 0o600 })
  return child
} }))
const { runRegexWorker } = await import("../../src/private-entry")
process.exitCode = await runRegexWorker(["-e", regexProcessSource, "--", REGEX_PROCESS_MARKER])
