import { createHash } from "node:crypto"
import { readFileSync, renameSync, watch, writeFileSync } from "node:fs"
import path from "node:path"

export type NativeReport = {
  pid: number
  args: string[]
  version?: string
  channel?: string
  passwordFingerprint: string
  eof: boolean
  stopped: boolean
  reason?: string
  outputFlushed?: boolean
}

const file = process.env.YCODING_TEST_NATIVE_REPORT
const cleanup = process.env.YCODING_TEST_NATIVE_CLEANUP
if (!file || !cleanup) throw new Error("Native process fixture requires private report and cleanup paths")
const reportPath = file
const report: NativeReport = {
  pid: process.pid,
  args: process.argv.slice(2),
  version: process.env.YCODING_VERSION,
  channel: process.env.YCODING_CHANNEL,
  passwordFingerprint: createHash("sha256").update(process.env.YCODING_PASSWORD ?? "").digest("hex"),
  eof: false,
  stopped: false,
}
const stdio = report.args.includes("--stdio")
const lifetime = setTimeout(() => stop("fixture-timeout", 1), 15_000)

function save() {
  writeFileSync(reportPath + ".next", JSON.stringify(report), { mode: 0o600 })
  renameSync(reportPath + ".next", reportPath)
}

function stop(reason: string, code = 0) {
  report.stopped = true
  report.reason = reason
  save()
  clearTimeout(lifetime)
  watcher.close()
  process.exit(code)
}

const watcher = watch(path.dirname(cleanup), (_event, name) => {
  if (String(name) === path.basename(cleanup) && readFileSync(cleanup, "utf8") === "cleanup")
    stop("fixture-cleanup")
})
process.on("SIGTERM", () => stop("SIGTERM"))
process.on("SIGINT", () => stop("SIGINT"))
process.stdin.on("end", () => {
  report.eof = true
  save()
  if (stdio) stop("eof")
})
process.stdin.resume()
save()
if (readFileSync(cleanup, "utf8") === "cleanup") stop("fixture-cleanup")

if (process.env.YCODING_TEST_NATIVE_FAIL === "1") {
  if (process.env.YCODING_SERVICE_STARTUP_ERROR_FILE)
    writeFileSync(process.env.YCODING_SERVICE_STARTUP_ERROR_FILE, "synthetic native startup failure", { mode: 0o600 })
  process.stderr.write("synthetic native startup failure\n")
  stop("startup-failure", 27)
}
if (process.env.YCODING_TEST_NATIVE_HOLD !== "1") {
  const url = "http://127.0.0.1:42617"
  process.stdout.write(
    process.env.YCODING_TEST_NATIVE_MALFORMED === "1"
      ? "not-json\n"
      : stdio ? JSON.stringify({ url }) + "\n" : `server listening on ${url}\n`,
  )
  if (process.env.YCODING_TEST_NATIVE_FLOOD === "1")
    process.stdout.write("fixture output\n".repeat(32_768), () => {
      report.outputFlushed = true
      save()
    })
}
