import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ccaProofResourceSnapshot } from "../src/remote-control/cca-proof-lifecycle"

const fixture = path.join(import.meta.dir, "fixture", "cca-proof-lifecycle.ts")
const workspace = await mkdtemp(path.join(os.tmpdir(), "cca-proof-lifecycle-"))
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const journalFailure = "CCA proof status journal failed\n"
const successStdout = [
  "synthetic-summary",
  "synthetic-before-exit=1 listeners=2",
  "synthetic-journal-closed",
  "synthetic-before-exit=2 listeners=1",
  "",
].join("\n")

let runs = 0
async function runFixture(mode: string, withStatus: boolean) {
  const directory = path.join(workspace, `run-${++runs}`)
  await mkdir(directory)
  const statusFile = path.join(directory, "status.jsonl")
  const child = Bun.spawn([process.execPath, fixture, mode, withStatus ? statusFile : "-"], {
    cwd: directory,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const completion = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  let deadline: ReturnType<typeof setTimeout> | undefined
  let stdout: string
  let stderr: string
  try {
    ;[stdout, stderr] = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("CCA lifecycle fixture deadline expired")), 20_000)
      }),
    ])
  } catch (error) {
    child.kill("SIGKILL")
    await Promise.allSettled([completion])
    throw error
  } finally {
    clearTimeout(deadline)
  }
  const files = await readdir(directory)
  const records = files.includes("status.jsonl")
    ? (await readFile(statusFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
  return {
    stdout,
    stderr,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    files,
    records,
    phases: records.map((record) => `${record.phase}:${record.event}`),
  }
}

describe("CCA proof resource snapshot", () => {
  test("maps synthetic resource names into aggregate buckets without names", () => {
    const snapshot = ccaProofResourceSnapshot({
      versions: {},
      getActiveResourcesInfo: () => [
        "Timeout",
        "Immediate",
        "TCPSocketWrap",
        "TCPServerWrap",
        "TLSWrap",
        "UDPWrap",
        "PipeWrap",
        "TTYWrap",
        "ProcessWrap",
        "FSReqCallback",
        "FSEventWrap",
        "StatWatcher",
        "synthetic-private-resource /synthetic/private/path",
      ],
    })
    expect(snapshot).toEqual({
      resourceStatus: "available",
      resourceTimers: 2,
      resourceSockets: 4,
      resourcePipes: 2,
      resourceProcesses: 1,
      resourceFilesystem: 3,
      resourceOther: 1,
    })
    expect(JSON.stringify(snapshot)).not.toContain("synthetic")
    expect(JSON.stringify(snapshot)).not.toContain("Wrap")
  })

  test("reports unavailable without counts when resource information cannot be trusted", () => {
    const throwing = ccaProofResourceSnapshot({
      versions: {},
      getActiveResourcesInfo: () => {
        throw new Error("synthetic-resource-failure")
      },
    })
    const missing = ccaProofResourceSnapshot({ versions: {} })
    const malformed = ccaProofResourceSnapshot({ versions: {}, getActiveResourcesInfo: () => "Timeout" })
    const bun = ccaProofResourceSnapshot({ versions: { bun: "1.0.0" }, getActiveResourcesInfo: () => [] })
    for (const snapshot of [throwing, missing, malformed, bun]) {
      expect(snapshot).toEqual({ resourceStatus: "unavailable" })
    }
  })
})

describe("CCA proof lifecycle child", () => {
  test(
    "records main-returned after completion and one process-before-exit, then exits naturally",
    async () => {
      const result = await runFixture("success", true)
      expect(result).toMatchObject({ exitCode: 0, signalCode: null, stderr: "", stdout: successStdout })
      expect(result.phases).toEqual([
        "script:started",
        "script-completion:completed",
        "main-returned:observed",
        "process-before-exit:observed",
      ])
      for (const record of result.records.slice(2)) {
        expect(Object.keys(record).sort()).toEqual(["elapsedMs", "event", "phase", "resourceStatus", "seq"])
        expect(record.resourceStatus).toBe("unavailable")
      }
      const elapsed = result.records.map((record) => Number(record.elapsedMs))
      expect(elapsed).toEqual([...elapsed].sort((left, right) => left - right))
    },
    30_000,
  )

  test(
    "adds no listener, file, or output when the status journal is disabled",
    async () => {
      const result = await runFixture("success", false)
      expect(result).toMatchObject({
        exitCode: 0,
        signalCode: null,
        stderr: "",
        files: [],
        stdout: ["synthetic-summary", "synthetic-before-exit=1 listeners=1", "synthetic-before-exit=2 listeners=1", ""].join(
          "\n",
        ),
      })
    },
    30_000,
  )

  test(
    "closes the journal on main failure and reports only the fixed primary failure",
    async () => {
      const result = await runFixture("main-failure", true)
      expect(result).toMatchObject({
        exitCode: 3,
        signalCode: null,
        stdout: "synthetic-journal-closed\n",
        stderr: "synthetic fixed failure\n",
      })
      expect(result.phases).toEqual(["script:started"])
    },
    30_000,
  )

  test(
    "keeps a nonzero primary failure when the journal also fails",
    async () => {
      const result = await runFixture("primary-close-failure", true)
      expect(result).toMatchObject({
        exitCode: 3,
        stdout: "synthetic-journal-closed\n",
        stderr: "synthetic fixed failure\n",
      })
    },
    30_000,
  )

  test(
    "turns an exit-zero primary outcome into the fixed journal failure",
    async () => {
      const result = await runFixture("aborted-close-failure", true)
      expect(result).toMatchObject({ exitCode: 1, stdout: "synthetic-journal-closed\n", stderr: journalFailure })
    },
    30_000,
  )

  test(
    "fails with the fixed journal error when the journal failed before main returned",
    async () => {
      const result = await runFixture("journal-failed", true)
      expect(result).toMatchObject({ exitCode: 1, stdout: "synthetic-journal-closed\n", stderr: journalFailure })
      expect(result.phases).toEqual(["script:started"])
    },
    30_000,
  )

  test(
    "reports a before-exit journal close failure through the exit code without forcing exit",
    async () => {
      const result = await runFixture("exit-close-failure", true)
      expect(result).toMatchObject({ exitCode: 1, signalCode: null, stdout: successStdout, stderr: journalFailure })
      expect(result.phases).toEqual([
        "script:started",
        "script-completion:completed",
        "main-returned:observed",
        "process-before-exit:observed",
      ])
    },
    30_000,
  )
})
