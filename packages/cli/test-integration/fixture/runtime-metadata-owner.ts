import { mock } from "bun:test"
import { readFile } from "node:fs/promises"

export type MetadataInput = {
  response: "configured" | "missing-cargo" | "failed" | "malformed" | "missing-target" | "invalid-target"
  target: string
}
type Request = { command: string; args: string[]; cwd?: string }
const input = JSON.parse(await readFile(process.argv[2], "utf8")) as MetadataInput
const api = { ...await import("node:child_process") }
let request: Request | undefined
mock.module("node:child_process", () => ({
  ...api,
  spawnSync(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
    if (command !== "cargo" || !args.includes("metadata")) throw new Error("Unexpected external process")
    if (options?.env && (
      Object.keys(options.env).length !== Object.keys(process.env).length ||
      Object.entries(options.env).some(([key, value]) => value !== process.env[key])
    ))
      throw new Error("Cargo metadata changed inherited environment")
    request = { command, args, cwd: options?.cwd }
    const stdout = input.response === "malformed" ? "{not-json"
      : JSON.stringify(input.response === "missing-target" ? {} : {
          target_directory: input.response === "invalid-target" ? 17 : input.target,
        })
    const error = input.response === "missing-cargo"
      ? Object.assign(new Error("spawn cargo ENOENT"), { code: "ENOENT" }) : undefined
    const status = error ? null : input.response === "failed" ? 1 : 0
    const stderr = input.response === "failed" ? "synthetic cargo metadata failure" : ""
    return { pid: 0, output: [null, stdout, stderr], stdout, stderr, status, signal: null, error }
  },
}))
try {
  const { runtimeExecutable } = await import("../../src/runtime-executable")
  const executable = await runtimeExecutable()
  console.log(JSON.stringify({ ok: true, executable, request }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error), request }))
} finally {
  mock.restore()
}
