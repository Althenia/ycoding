import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cliRoot = path.join(import.meta.dir, "..")
const connectScript = path.join(cliRoot, "script", "cca-executor-connect-proof.ts")
const taskScript = path.join(cliRoot, "script", "cca-executor-task-proof.ts")

const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "cca-proof-scripts-"))
afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true })
})

async function runScript(
  script: string,
  args: readonly string[],
  envOverrides: Readonly<Record<string, string>> = {},
) {
  const proc = Bun.spawn(["bun", "run", script, ...args], {
    cwd: cliRoot,
    env: {
      ...process.env,
      HOME: isolatedHome,
      YCODING_DB: path.join(isolatedHome, "nonexistent-sign-in.db"),
      YCODING_CONFIG_DIR: isolatedHome,
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

function expectSanitized(output: string) {
  expect(output).not.toContain("Bearer")
  expect(output).not.toContain("ccarenv")
  expect(output).not.toContain("accessToken")
}

async function readStatusPhases(file: string) {
  const text = await readFile(file, "utf8")
  const records = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { text, records, phases: records.map((record) => `${record.phase}:${record.event}`) }
}

describe("cca proof scripts", () => {
  test(
    "connect proof without arguments exits 2 with sanitized usage error",
    async () => {
      const { stdout, stderr, exitCode } = await runScript(connectScript, [])
      expect(exitCode).toBe(2)
      expect(stderr).toContain("Missing --state")
      expectSanitized(stdout + stderr)
    },
    30_000,
  )

  test(
    "connect proof exits 2 at the sign-in database precheck in an isolated home",
    async () => {
      const { stdout, stderr, exitCode } = await runScript(connectScript, [
        "--state",
        path.join(isolatedHome, "missing-state.json"),
      ])
      expect(exitCode).toBe(2)
      expect(stderr).toContain("No stored YCoding sign-in database")
      expectSanitized(stdout + stderr)
    },
    30_000,
  )

  test(
    "task proof help returns naturally without status diagnostics",
    async () => {
      const statusFile = path.join(isolatedHome, "help-status.jsonl")
      const { stdout, stderr, exitCode } = await runScript(taskScript, ["--help", "--status-file", statusFile])
      expect(exitCode).toBe(0)
      expect(stdout).toStartWith("Usage: bun run script/cca-executor-task-proof.ts")
      expect(stdout.trim().split("\n")).toHaveLength(1)
      expect(stderr).toBe("")
      expect(await Bun.file(statusFile).exists()).toBe(false)
    },
    30_000,
  )

  test(
    "task proof without --root exits 2",
    async () => {
      const { stdout, stderr, exitCode } = await runScript(taskScript, [
        "--state",
        path.join(isolatedHome, "missing-state.json"),
      ])
      expect(exitCode).toBe(2)
      expect(stderr).toContain("Missing --root")
      expectSanitized(stdout + stderr)
    },
    30_000,
  )

  test(
    "task proof exits 2 at the sign-in database precheck before guarded runtime creation",
    async () => {
      const { stdout, stderr, exitCode } = await runScript(taskScript, [
        "--state",
        path.join(isolatedHome, "missing-state.json"),
        "--root",
        isolatedHome,
      ])
      expect(exitCode).toBe(2)
      expect(stderr).toContain("No stored YCoding sign-in database")
      expect(stdout).not.toContain("authorize=proof-root-consent")
      expectSanitized(stdout + stderr)
    },
    30_000,
  )

  test(
    "task proof rejects a nonexistent --root with exit 2",
    async () => {
      const { stdout, stderr, exitCode } = await runScript(taskScript, [
        "--state",
        path.join(isolatedHome, "missing-state.json"),
        "--root",
        path.join(isolatedHome, "no-such-directory"),
      ])
      expect(exitCode).toBe(2)
      expect(stderr).toContain("--root")
      expectSanitized(stdout + stderr)
    },
    30_000,
  )

  test(
    "task proof status file preserves sanitized credential failure evidence",
    async () => {
      const stateFile = path.join(isolatedHome, "synthetic-completed-state.json")
      const statusFile = path.join(isolatedHome, "synthetic-task-status.jsonl")
      const databaseFile = path.join(isolatedHome, "synthetic-empty-sign-in.db")
      await writeFile(databaseFile, "", "utf8")
      await writeFile(
        stateFile,
        JSON.stringify({
          installationID: "synthetic-installation",
          accountHash: "a".repeat(64),
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          executorID: "ccarenv_b64_synthetic",
        }),
        "utf8",
      )

      const { stdout, stderr, exitCode } = await runScript(
        taskScript,
        ["--state", stateFile, "--root", isolatedHome, "--status-file", statusFile],
        { YCODING_DB: databaseFile },
      )

      expect(exitCode).toBe(2)
      expect(stderr).toContain("No Dots profile")
      expectSanitized(stdout + stderr)
      expect((await stat(statusFile)).mode & 0o777).toBe(0o600)
      const { text: journalText, records, phases } = await readStatusPhases(statusFile)
      expect(phases).toEqual([
        "script:started",
        "preflight:started",
        "preflight:completed",
        "state-load:started",
        "state-load:completed",
        "credential-selection:started",
        "credential-selection:failed",
        "script-completion:failed",
      ])
      expect(records.every((record) => typeof record.elapsedMs === "number")).toBe(true)
      expect(journalText).not.toContain("synthetic")
      expect(journalText).not.toContain(isolatedHome)
      expect(journalText).not.toContain("a".repeat(64))
      expectSanitized(journalText)
    },
    60_000,
  )

  test(
    "task proof status file finalizes a missing-database preflight failure",
    async () => {
      const statusFile = path.join(isolatedHome, "missing-database-status.jsonl")

      const { stdout, stderr, exitCode } = await runScript(taskScript, [
        "--state",
        path.join(isolatedHome, "missing-state.json"),
        "--root",
        isolatedHome,
        "--status-file",
        statusFile,
      ])

      expect(exitCode).toBe(2)
      expect(stderr).toContain("No stored YCoding sign-in database")
      expectSanitized(stdout + stderr)
      expect((await stat(statusFile)).mode & 0o777).toBe(0o600)
      const { text, phases } = await readStatusPhases(statusFile)
      expect(phases).toEqual([
        "script:started",
        "preflight:started",
        "preflight:failed",
        "script-completion:failed",
      ])
      expect(text).not.toContain(isolatedHome)
      expectSanitized(text)
    },
    30_000,
  )

  test(
    "task proof status file finalizes a missing-state load failure",
    async () => {
      const statusFile = path.join(isolatedHome, "missing-state-status.jsonl")
      const databaseFile = path.join(isolatedHome, "synthetic-empty-state-sign-in.db")
      await writeFile(databaseFile, "", "utf8")

      const { stdout, stderr, exitCode } = await runScript(
        taskScript,
        [
          "--state",
          path.join(isolatedHome, "missing-state.json"),
          "--root",
          isolatedHome,
          "--status-file",
          statusFile,
        ],
        { YCODING_DB: databaseFile },
      )

      expect(exitCode).toBe(2)
      expect(stderr).toContain("Could not load CCA executor registration state")
      expectSanitized(stdout + stderr)
      expect((await stat(statusFile)).mode & 0o777).toBe(0o600)
      const { text, phases } = await readStatusPhases(statusFile)
      expect(phases).toEqual([
        "script:started",
        "preflight:started",
        "preflight:completed",
        "state-load:started",
        "state-load:failed",
        "script-completion:failed",
      ])
      expect(text).not.toContain(isolatedHome)
      expectSanitized(text)
    },
    30_000,
  )

  test(
    "task proof rejects an existing status file before credential activity",
    async () => {
      const statusFile = path.join(isolatedHome, "existing-task-status.jsonl")
      await writeFile(statusFile, "synthetic-sentinel", "utf8")

      const { stdout, stderr, exitCode } = await runScript(taskScript, [
        "--state",
        path.join(isolatedHome, "missing-state.json"),
        "--root",
        isolatedHome,
        "--status-file",
        statusFile,
      ])

      expect(exitCode).toBe(2)
      expect(stderr).toContain("status file unavailable")
      expect(stderr).not.toContain("No stored YCoding sign-in database")
      expect(await readFile(statusFile, "utf8")).toBe("synthetic-sentinel")
      expectSanitized(stdout + stderr)
    },
    30_000,
  )
})
