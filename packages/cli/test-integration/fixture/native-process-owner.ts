import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { createHash } from "node:crypto"
import { readFileSync, renameSync, watch, writeFileSync } from "node:fs"
import path from "node:path"

export type Input = {
  action: "public" | "serve" | "private"
  mode?: "default" | "service" | "stdio"
  hostname?: string
  port?: number
  service?: boolean
  stdio?: boolean
  meeting?: boolean
  command?: string[]
  env?: Record<string, string>
}
export type OwnerReport = {
  pid: number
  ready?: boolean
  url?: string
  nativePid?: number
  passwordFingerprint?: string
  finished?: boolean
  success?: boolean
}

const inputPath = process.env.YCODING_TEST_NATIVE_OWNER_INPUT
const file = process.env.YCODING_TEST_NATIVE_OWNER_REPORT
const cancelPath = process.env.YCODING_TEST_NATIVE_CANCEL
if (!inputPath || !file || !cancelPath) throw new Error("Native owner fixture requires private control paths")
const reportPath = file
const input = JSON.parse(readFileSync(inputPath, "utf8")) as Input
const reentry = process.argv[2] === "serve"
const report: OwnerReport = { pid: process.pid }
function save() {
  if (reentry) return
  writeFileSync(reportPath + ".next", JSON.stringify(report), { mode: 0o600 })
  renameSync(reportPath + ".next", reportPath)
}
save()
const cancelled = Promise.withResolvers<void>()
const watcher = watch(path.dirname(cancelPath), (_event, name) => {
  if (String(name) === path.basename(cancelPath) && readFileSync(cancelPath, "utf8") === "cancel")
    cancelled.resolve()
})
process.on("SIGTERM", () => cancelled.resolve())
process.on("SIGINT", () => cancelled.resolve())
const operation = await (async () => {
  if (input.action === "serve" || reentry) {
    const { runServe } = await import("../../src/commands/handlers/serve-shared")
    return runServe({
      service: reentry ? false : input.service === true,
      stdio: reentry || input.stdio === true,
      hostname: Option.fromUndefinedOr(input.hostname),
      port: Option.fromUndefinedOr(reentry ? 0 : input.port),
      meeting: input.meeting,
    })
  }
  if (input.action === "public") {
    const { ServerProcess } = await import("../../src/server-process")
    return ServerProcess.run({ mode: input.mode ?? "default", hostname: input.hostname, port: input.port })
  }
  const { Standalone } = await import("../../src/services/standalone")
  return Effect.gen(function* () {
    const endpoint = yield* Standalone.start({ command: input.command, env: input.env })
    report.ready = true
    report.url = endpoint.url
    report.nativePid = endpoint.pid
    report.passwordFingerprint = createHash("sha256").update(endpoint.auth.password).digest("hex")
    save()
    yield* Effect.never
  })
})()
const fiber = Effect.runFork(Effect.scoped(operation))
void cancelled.promise.then(() => Effect.runPromise(Fiber.interrupt(fiber))).catch((error: unknown) => {
  process.stderr.write(String(error) + "\n")
  process.exitCode = 1
})
const exit = await Effect.runPromise(Fiber.await(fiber))
watcher.close()
report.finished = true
report.success = Exit.isSuccess(exit) || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
save()
if (Exit.isFailure(exit) && !report.success) process.stderr.write(Cause.pretty(exit.cause) + "\n")
process.exitCode = report.success ? 0 : 1
