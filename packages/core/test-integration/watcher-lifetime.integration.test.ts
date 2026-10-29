import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { Schema } from "effect"

const fixtures = path.join(import.meta.dir, "fixtures")

const WatcherCounts = { started: Schema.Number, stopped: Schema.Number, fallback: Schema.Number }
const NativeEvent = Schema.Struct({
  event: Schema.Literal("native"),
  operation: Schema.Literals(["subscribe", "unsubscribe"]),
  stage: Schema.Literals(["invoked", "resolved", "rejected"]),
  counts: Schema.Struct({
    subscribeInvoked: Schema.Number,
    subscribeResolved: Schema.Number,
    subscribeRejected: Schema.Number,
    unsubscribeInvoked: Schema.Number,
    unsubscribeResolved: Schema.Number,
    unsubscribeRejected: Schema.Number,
  }),
})
const TraceEvent = Schema.Union([
  NativeEvent,
  Schema.Struct({ event: Schema.Literal("seeded") }),
  Schema.Struct({
    event: Schema.Literal("credential-resolved"),
    documents: Schema.Number,
    diagnostics: Schema.Number,
    defaultAgent: Schema.optional(Schema.String),
    profiles: Schema.Array(Schema.String),
  }),
  Schema.Struct({ event: Schema.Literal("scope-closed"), ...WatcherCounts }),
  Schema.Struct({ event: Schema.Literal("before-exit"), ...WatcherCounts }),
])
type TraceEvent = typeof TraceEvent.Type
const decodeTraceEvent = Schema.decodeUnknownSync(Schema.fromJsonString(TraceEvent), { onExcessProperty: "error" })

type Exited = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly diagnostics: string
  readonly stdoutEOF: boolean
  readonly stderrEOF: boolean
  readonly diagnosticEOF: boolean
  readonly signals: number
  readonly groupRemaining: boolean
}

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

function run(command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }) {
  return new Promise<Exited>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    })
    const output = { stdout: "", stderr: "", diagnostics: "" }
    const ended = { stdoutEOF: false, stderrEOF: false, diagnosticEOF: false }
    let signals = 0
    const kill = () => {
      if (!child.pid || !groupAlive(child.pid)) return
      process.kill(-child.pid, "SIGKILL")
      signals++
    }
    child.on("error", reject)
    const [, stdout, stderr, diagnostics] = child.stdio
    if (!(stdout instanceof Readable && stderr instanceof Readable && diagnostics instanceof Readable)) {
      kill()
      reject(new Error("child stdout, stderr, and diagnostic pipes must be readable"))
      return
    }
    stdout.on("data", (data) => (output.stdout += data))
    stderr.on("data", (data) => (output.stderr += data))
    diagnostics.on("data", (data) => (output.diagnostics += data))
    stdout.on("end", () => (ended.stdoutEOF = true))
    stderr.on("end", () => (ended.stderrEOF = true))
    diagnostics.on("end", () => (ended.diagnosticEOF = true))
    const bound = setTimeout(kill, options.timeoutMs)
    child.once("close", (code, signal) => {
      clearTimeout(bound)
      const groupRemaining = child.pid ? groupAlive(child.pid) : false
      if (groupRemaining) kill()
      resolve({ code, signal, ...output, ...ended, signals, groupRemaining })
    })
  })
}

function exitedNaturally(result: Exited) {
  expect({
    code: result.code,
    signal: result.signal,
    signals: result.signals,
    groupRemaining: result.groupRemaining,
    stdoutEOF: result.stdoutEOF,
    stderrEOF: result.stderrEOF,
  }).toEqual({ code: 0, signal: null, signals: 0, groupRemaining: false, stdoutEOF: true, stderrEOF: true })
}

async function scenario(name: string) {
  const result = await run(process.execPath, [path.join(fixtures, "watcher-scenario.ts"), name], {
    env: { ...process.env, YCODING_PARCEL_WATCHER_PATH: path.join(fixtures, "watcher-controlled-binding.cjs") },
    timeoutMs: 15_000,
  })
  if (result.code !== 0) console.error(result.stderr)
  exitedNaturally(result)
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null")
}

describe("watcher subscription lifetime", () => {
  test("closing the owner while the native subscription is pending releases it once after it resolves", async () => {
    expect(await scenario("close-during-pending")).toEqual({
      subscribes: 1,
      unsubscribes: 1,
      unsubscribedSubscribedCallback: true,
      started: 1,
      stopped: 1,
      fallback: 0,
    })
  })

  test("owners of one normalized target share one native subscription until the last owner closes", async () => {
    expect(await scenario("shared-key")).toEqual({
      subscribes: 1,
      subscribesWhileShared: 1,
      unsubscribesAfterFirstClose: 0,
      unsubscribes: 1,
      unsubscribedSubscribedCallback: true,
      started: 1,
      stopped: 1,
      fallback: 0,
    })
  })

  test("a rejected native subscription falls back to a recursive watcher that closing releases", async () => {
    expect(await scenario("native-rejection")).toEqual({
      subscribes: 1,
      unsubscribes: 0,
      unsubscribedSubscribedCallback: true,
      started: 1,
      stopped: 1,
      fallback: 1,
      fallbackDelivered: true,
    })
  })

  test("the native subscription times out after 10 seconds and a late subscription is unsubscribed once", async () => {
    expect(await scenario("native-timeout")).toEqual({
      subscribes: 1,
      unsubscribes: 1,
      unsubscribedSubscribedCallback: true,
      started: 1,
      stopped: 1,
      fallback: 1,
      sleeps: [10_000],
      readyBeforeDeadline: false,
      fallbackDelivered: true,
    })
  })

  test("cancelling a pending acquisition before the native timeout leaves no fallback or native subscription", async () => {
    expect(await scenario("cancel-then-timeout")).toEqual({
      subscribes: 1,
      unsubscribes: 1,
      unsubscribedSubscribedCallback: true,
      started: 1,
      stopped: 1,
      fallback: 1,
      sleeps: [10_000],
    })
  })

  test.if(process.platform === "darwin")(
    "a short Config.global and Credential scope with the real native watcher exits naturally in a network-denied sandbox",
    async () => {
      const binding = createRequire(path.join(import.meta.dir, "..", "package.json")).resolve(
        `@parcel/watcher-${process.platform}-${process.arch}`,
      )
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-watcher-lifetime-"))
      try {
        const dirs = Object.fromEntries(
          ["home", "config", "data", "state", "cache", "tmp"].map((name) => [name, path.join(root, name)]),
        )
        const config = path.join(dirs.config, "ycoding")
        for (const directory of [...Object.values(dirs), config]) await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(
          path.join(config, "ycoding.json"),
          JSON.stringify({ default_agent: "synthetic-watcher-agent" }),
          { mode: 0o600, flag: "wx" },
        )
        const result = await run(
          "/usr/bin/sandbox-exec",
          [
            "-f",
            path.join(fixtures, "watcher-network-deny.sb"),
            process.execPath,
            path.join(fixtures, "watcher-config-credential.ts"),
          ],
          {
            cwd: root,
            env: {
              PATH: "/usr/bin:/bin",
              HOME: dirs.home,
              YCODING_TEST_HOME: dirs.home,
              XDG_CONFIG_HOME: dirs.config,
              XDG_DATA_HOME: dirs.data,
              XDG_STATE_HOME: dirs.state,
              XDG_CACHE_HOME: dirs.cache,
              TMPDIR: dirs.tmp,
              YCODING_CONFIG_DIR: config,
              YCODING_DB: path.join(dirs.data, "synthetic.sqlite"),
              YCODING_PARCEL_WATCHER_PATH: path.join(fixtures, "watcher-native-trace.cjs"),
              YCODING_TEST_REAL_PARCEL_WATCHER: binding,
            },
            timeoutMs: 30_000,
          },
        )
        if (result.code !== 0) console.error(result.stderr)
        exitedNaturally(result)
        expect(result.diagnosticEOF).toBe(true)
        const events = result.diagnostics
          .trim()
          .split("\n")
          .map((line) => decodeTraceEvent(line))
        const index = (match: (event: TraceEvent) => boolean) => events.findIndex(match)
        expect(events.find((event) => event.event === "credential-resolved")).toEqual({
          event: "credential-resolved",
          documents: 1,
          diagnostics: 0,
          defaultAgent: "synthetic-watcher-agent",
          profiles: ["synthetic-watcher-profile"],
        })
        const native = events.findLast((event): event is typeof NativeEvent.Type => event.event === "native")
        expect(native?.counts).toEqual({
          subscribeInvoked: 1,
          subscribeResolved: 1,
          subscribeRejected: 0,
          unsubscribeInvoked: 1,
          unsubscribeResolved: 1,
          unsubscribeRejected: 0,
        })
        expect(events.find((event) => event.event === "scope-closed")).toEqual({
          event: "scope-closed",
          started: 1,
          stopped: 1,
          fallback: 0,
        })
        const unsubscribed = index(
          (event) => event.event === "native" && event.operation === "unsubscribe" && event.stage === "resolved",
        )
        expect(unsubscribed).toBeLessThan(index((event) => event.event === "scope-closed"))
        expect(events.at(-1)).toEqual({ event: "before-exit", started: 1, stopped: 1, fallback: 0 })
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
  )
})
