import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  ccaProofRpcMethods,
  ccaProofRpcOutcomes,
  createCcaProofJournal,
  CcaProofJournalError,
} from "../src/remote-control/cca-proof-journal"

const directories: string[] = []

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function makeDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cca-proof-journal-"))
  directories.push(directory)
  return directory
}

function readRecords(file: string) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function createFailure(file: string) {
  try {
    createCcaProofJournal(file)
    return undefined
  } catch (error) {
    return error
  }
}

describe("createCcaProofJournal", () => {
  test("exclusively creates a 0600 JSONL journal with bounded scalar records", () => {
    const directory = makeDirectory()
    const file = path.join(directory, "status.jsonl")
    const journal = createCcaProofJournal(file)

    journal.record({ phase: "script", event: "started" })
    journal.record({
      phase: "channel-established",
      event: "observed",
      channels: 1,
      requests: 2,
      responses: 1,
      notifications: 1,
    })
    journal.close()
    journal.close()

    expect(statSync(file).mode & 0o777).toBe(0o600)
    const records = readRecords(file)
    expect(records.map((record) => record.seq)).toEqual([1, 2])
    expect(records.map((record) => `${record.phase}:${record.event}`)).toEqual([
      "script:started",
      "channel-established:observed",
    ])
    expect(records.every((record) => typeof record.elapsedMs === "number" && record.elapsedMs >= 0)).toBe(true)
    expect(Object.keys(records[1]!)).toEqual([
      "seq",
      "phase",
      "event",
      "elapsedMs",
      "channels",
      "requests",
      "responses",
      "notifications",
    ])
  })

  test("rejects existing files and symlinks without overwriting their data", () => {
    const directory = makeDirectory()
    const existing = path.join(directory, "existing.jsonl")
    writeFileSync(existing, "synthetic-sentinel", "utf8")

    expect(createFailure(existing)).toBeInstanceOf(CcaProofJournalError)
    expect(readFileSync(existing, "utf8")).toBe("synthetic-sentinel")

    const danglingTarget = path.join(directory, "dangling-target.jsonl")
    const link = path.join(directory, "link.jsonl")
    symlinkSync(danglingTarget, link)
    const error = createFailure(link)
    expect(error).toBeInstanceOf(CcaProofJournalError)
    expect((error as Error).message).toBe("CCA proof status journal failed")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(danglingTarget)).toBe(false)
  })

  test("rejects relative paths and missing parents without creating anything", () => {
    const relative = `cca-proof-journal-relative-${process.pid}.jsonl`
    expect(createFailure(relative)).toBeInstanceOf(CcaProofJournalError)
    expect(existsSync(path.resolve(relative))).toBe(false)

    const directory = makeDirectory()
    const parent = path.join(directory, "missing-parent")
    expect(createFailure(path.join(parent, "status.jsonl"))).toBeInstanceOf(CcaProofJournalError)
    expect(existsSync(parent)).toBe(false)
  })

  test("overflow at the real 64 KiB cap keeps a complete prefix and surfaces a fixed failure at close", () => {
    const directory = makeDirectory()
    const file = path.join(directory, "status.jsonl")
    const journal = createCcaProofJournal(file)
    const input = {
      phase: "channel-established",
      event: "observed",
      channels: 1_000_000_000,
      requests: 1_000_000_000,
      responses: 1_000_000_000,
      notifications: 1_000_000_000,
      bridges: 1_000_000_000,
    } as const

    for (let index = 0; index < 2_000 && !journal.failed; index++) journal.record(input)
    const contents = readFileSync(file, "utf8")
    journal.record({ phase: "script", event: "completed" })

    expect(journal.failed).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(contents)
    expect(() => journal.close()).toThrow("CCA proof status journal failed")
    expect(statSync(file).size).toBeLessThanOrEqual(64 * 1024)
    expect(statSync(file).size).toBeGreaterThan(60_000)
    const records = readRecords(file)
    expect(records.length).toBeGreaterThan(0)
    expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index + 1))
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true)
  })

  test("partial writes at an operating-system file-size limit preserve the complete prefix", async () => {
    const directory = makeDirectory()
    const file = path.join(directory, "status.jsonl")
    const cliRoot = path.join(import.meta.dir, "..")
    const childCode = [
      'const { createCcaProofJournal } = await import("./src/remote-control/cca-proof-journal.ts");',
      'const fs = await import("node:fs");',
      "const file = process.env.CCA_JOURNAL_TEST_FILE;",
      "const journal = createCcaProofJournal(file);",
      'const input = { phase: "channel-established", event: "observed", channels: 1000000000, requests: 1000000000, responses: 1000000000, notifications: 1000000000, bridges: 1000000000 };',
      "for (let index = 0; index < 20; index++) journal.record(input);",
      "let closeFailed = false;",
      "try { journal.close(); } catch { closeFailed = true; }",
      "console.log(JSON.stringify({ failed: journal.failed, closeFailed, size: fs.statSync(file).size }));",
    ].join(" ")
    const proc = Bun.spawn(["sh", "-c", `ulimit -f 1; exec bun -e ${JSON.stringify(childCode)}`], {
      cwd: cliRoot,
      env: { ...process.env, CCA_JOURNAL_TEST_FILE: file },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    const summary = JSON.parse(stdout) as Record<string, unknown>
    expect(summary.failed).toBe(true)
    expect(summary.closeFailed).toBe(true)
    expect(summary.size).toBeLessThanOrEqual(1024)
    const lines = readFileSync(file, "utf8").split("\n")
    expect(lines.at(-1)).not.toBe("")
    const complete = lines.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(complete.length).toBeGreaterThan(0)
    expect(complete.map((record) => record.seq)).toEqual(complete.map((_, index) => index + 1))
    expect(() => JSON.parse(lines.at(-1)!)).toThrow()
  }, 30_000)

  test("close is terminal and later records cannot append", () => {
    const directory = makeDirectory()
    const file = path.join(directory, "status.jsonl")
    const journal = createCcaProofJournal(file)
    journal.record({ phase: "script", event: "completed" })
    journal.close()
    const contents = readFileSync(file, "utf8")

    journal.record({ phase: "script", event: "failed" })

    expect(readFileSync(file, "utf8")).toBe(contents)
    expect(journal.failed).toBe(true)
    expect(() => journal.close()).toThrow("CCA proof status journal failed")
    expect(readFileSync(file, "utf8")).toBe(contents)
  })

  test("strips unrecognized fields and rejects invalid closed-set or numeric input", () => {
    const directory = makeDirectory()
    const file = path.join(directory, "status.jsonl")
    const journal = createCcaProofJournal(file)
    journal.record({ phase: "script", event: "started" })
    journal.record(
      Object.assign(
        { phase: "channel-established", event: "observed", channels: 1 },
        JSON.parse('{"secret":"synthetic-secret","path":"/private/synthetic","payload":{"method":"synthetic"}}'),
      ),
    )
    journal.record(JSON.parse('{"phase":"synthetic-phase","event":"started"}'))
    journal.record(JSON.parse('{"phase":"script","event":"synthetic-event"}'))
    journal.record(JSON.parse('{"phase":"script","event":"started","channels":-1}'))
    journal.record(JSON.parse('{"phase":"script","event":"started","requests":1.5}'))
    journal.record(JSON.parse('{"phase":"script","event":"started","notifications":"synthetic-secret"}'))
    journal.record({ phase: "script", event: "completed" })

    expect(journal.failed).toBe(true)
    expect(() => journal.close()).toThrow("CCA proof status journal failed")
    const contents = readFileSync(file, "utf8")
    expect(contents).not.toContain("synthetic-secret")
    expect(contents).not.toContain("/private/")
    expect(contents).not.toContain("synthetic-phase")
    expect(contents).not.toContain("synthetic-event")
    expect(contents).not.toContain("payload")
    const records = readRecords(file)
    expect(records.map((record) => record.seq)).toEqual([1, 2])
    expect(Object.keys(records[1]!)).toEqual(["seq", "phase", "event", "elapsedMs", "channels"])
  })
})

describe("createCcaProofJournal rpc and resource fields", () => {
  const newPhases = [
    "rpc-received",
    "rpc-response",
    "rpc-notification",
    "main-returned",
    "process-before-exit",
  ] as const

  test("exports the closed method and outcome tuples", () => {
    expect([...ccaProofRpcMethods]).toEqual([
      "initialize",
      "initialized",
      "environment/info",
      "environment/status",
      "process/start",
      "process/read",
      "process/write",
      "process/signal",
      "process/terminate",
      "fs/readFile",
      "fs/writeFile",
      "fs/getMetadata",
      "fs/readDirectory",
      "fs/canonicalize",
      "capabilities/discoverV2",
      "capabilityRoots/discoverV1",
      "process/output",
      "process/exited",
      "process/closed",
      "other",
    ])
    expect([...ccaProofRpcOutcomes]).toEqual([
      "result",
      "invalid_request",
      "method_not_found",
      "invalid_params",
      "internal_error",
      "permission_denied",
      "other_error",
      "notification",
      "send_failed",
      "aborted",
    ])
  })

  test("serializes new phases and closed fields in fixed order, preserving false resume and count edges", () => {
    const file = path.join(makeDirectory(), "status.jsonl")
    const journal = createCcaProofJournal(file)
    for (const phase of newPhases) journal.record({ phase, event: "observed" })
    journal.record({
      phase: "rpc-response",
      event: "observed",
      method: "initialize",
      outcome: "result",
      resumeRequested: false,
      resourceStatus: "available",
      resourceTimers: 0,
      resourceSockets: 1_000_000_000,
      resourcePipes: 2,
      resourceProcesses: 3,
      resourceFilesystem: 4,
      resourceOther: 5,
    })
    journal.record({
      phase: "rpc-received",
      event: "observed",
      method: "initialize",
      resumeRequested: true,
      resourceStatus: "unavailable",
    })
    journal.close()
    const records = readRecords(file)
    expect(records.slice(0, 5).map((record) => record.phase)).toEqual([...newPhases])
    expect(Object.keys(records[5]!)).toEqual([
      "seq",
      "phase",
      "event",
      "elapsedMs",
      "method",
      "outcome",
      "resumeRequested",
      "resourceStatus",
      "resourceTimers",
      "resourceSockets",
      "resourcePipes",
      "resourceProcesses",
      "resourceFilesystem",
      "resourceOther",
    ])
    expect(records[5]).toMatchObject({ resumeRequested: false, resourceTimers: 0, resourceSockets: 1_000_000_000 })
    expect(records[6]).toMatchObject({ resumeRequested: true, resourceStatus: "unavailable" })
    for (const method of ccaProofRpcMethods) {
      const each = path.join(makeDirectory(), "m.jsonl")
      const j = createCcaProofJournal(each)
      j.record({ phase: "rpc-received", event: "observed", method })
      j.close()
      expect(readRecords(each)[0]!.method).toBe(method)
    }
    for (const outcome of ccaProofRpcOutcomes) {
      const each = path.join(makeDirectory(), "o.jsonl")
      const j = createCcaProofJournal(each)
      j.record({ phase: "rpc-response", event: "observed", outcome })
      j.close()
      expect(readRecords(each)[0]!.outcome).toBe(outcome)
    }
  })

  const invalid: Array<[string, string]> = [
    ["method", '"synthetic-method"'],
    ["method", "1"],
    ["outcome", '"synthetic-outcome"'],
    ["outcome", "null"],
    ["resumeRequested", '"false"'],
    ["resumeRequested", "0"],
    ["resourceStatus", '"synthetic-status"'],
    ["resourceStatus", "true"],
    ["resourceTimers", "-1"],
    ["resourceSockets", "1.5"],
    ["resourcePipes", "1000000001"],
    ["resourceProcesses", '"synthetic-secret"'],
    ["resourceFilesystem", "[1]"],
    ["resourceOther", '{"a":1}'],
  ]
  for (const [name, value] of invalid) {
    test(`invalid ${name}=${value} fails the journal with a fixed error and writes nothing`, () => {
      const file = path.join(makeDirectory(), "status.jsonl")
      const journal = createCcaProofJournal(file)
      journal.record(JSON.parse(`{"phase":"rpc-received","event":"observed","${name}":${value}}`))
      expect(journal.failed).toBe(true)
      journal.record({ phase: "script", event: "completed" })
      let message: unknown
      try {
        journal.close()
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toBe("CCA proof status journal failed")
      expect(readFileSync(file, "utf8")).toBe("")
    })
  }

  const contradictory: Array<[string, string]> = [
    ["resumeRequested without method", '{"resumeRequested":false}'],
    ["resumeRequested true without method", '{"resumeRequested":true}'],
    ["resumeRequested with non-initialize method", '{"method":"process/start","resumeRequested":false}'],
    ["resumeRequested with initialized method", '{"method":"initialized","resumeRequested":true}'],
    ["unavailable with timers", '{"resourceStatus":"unavailable","resourceTimers":0}'],
    ["unavailable with sockets", '{"resourceStatus":"unavailable","resourceSockets":1}'],
    ["unavailable with pipes", '{"resourceStatus":"unavailable","resourcePipes":0}'],
    ["unavailable with processes", '{"resourceStatus":"unavailable","resourceProcesses":2}'],
    ["unavailable with filesystem", '{"resourceStatus":"unavailable","resourceFilesystem":0}'],
    ["unavailable with other", '{"resourceStatus":"unavailable","resourceOther":3}'],
  ]
  for (const [name, fields] of contradictory) {
    test(`contradictory record (${name}) fails the journal with a fixed error and writes nothing`, () => {
      const file = path.join(makeDirectory(), "status.jsonl")
      const journal = createCcaProofJournal(file)
      journal.record({ ...JSON.parse(fields), phase: "rpc-received", event: "observed" })
      expect(journal.failed).toBe(true)
      journal.record({ phase: "script", event: "completed" })
      let message: unknown
      try {
        journal.close()
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toBe("CCA proof status journal failed")
      expect(readFileSync(file, "utf8")).toBe("")
    })
  }

  test("sentinel fields, arrays, errors and payloads never reach the journal", () => {
    const file = path.join(makeDirectory(), "status.jsonl")
    const journal = createCcaProofJournal(file)
    journal.record(
      Object.assign(
        { phase: "rpc-notification", event: "observed", method: "process/output", outcome: "notification" },
        JSON.parse('{"id":"synthetic-id","params":{"x":"synthetic-payload"},"list":["synthetic-item"]}'),
        { error: new Error("synthetic-error") },
      ),
    )
    journal.close()
    const contents = readFileSync(file, "utf8")
    expect(contents).not.toContain("synthetic")
    expect(Object.keys(readRecords(file)[0]!)).toEqual(["seq", "phase", "event", "elapsedMs", "method", "outcome"])
  })
})
