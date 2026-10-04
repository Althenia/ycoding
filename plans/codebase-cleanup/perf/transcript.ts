import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const MESSAGE_COUNT = 2_000
const MAX_RSS_MIB = 8_192
const worker = `
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { YCoding } from "@ycoding-ai/client"
import { ServerProcess } from "../server/src/process.ts"
import { Effect, Exit, Scope } from "effect"
import { join } from "node:path"

const [root, portText, password, warmupText, samplesText] = process.argv.slice(1)
const count = ${MESSAGE_COUNT}
const sessionID = SessionV2.ID.make("ses_perf_transcript")
const directory = join(root, "workspace")
const lastText = "Transcript prompt " + String(count - 1).padStart(4, "0")
const distribution = (values) => {
  const sorted = values.toSorted((a, b) => a - b)
  return { median: sorted[Math.ceil(sorted.length / 2) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }
}
const verify = (messages) => {
  if (messages.length !== count) throw new Error("Expected " + count + " messages, got " + messages.length)
  messages.forEach((message, index) => {
    const expected = "Transcript prompt " + String(index).padStart(4, "0")
    if (message.type !== "user" || message.id !== "msg_perf_" + String(index).padStart(4, "0") || message.text !== expected)
      throw new Error("Canonical order or projected content differs at index " + index)
  })
}
const scope = await Effect.runPromise(Scope.make())
let screen
try {
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).run()
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Created, {
      sessionID, projectID: Project.ID.global, location: { directory }, title: "Transcript performance", created: Date.now(),
    })
    for (let index = 0; index < count; index++) {
      const inputID = SessionMessage.ID.make("msg_perf_" + String(index).padStart(4, "0"))
      yield* events.publish(SessionEvent.InputAdmitted, {
        sessionID, inputID,
        input: { type: "user", data: { text: "Transcript prompt " + String(index).padStart(4, "0") }, delivery: "steer" },
      })
      yield* events.publish(SessionEvent.InputPromoted, { sessionID, inputID })
    }
  }).pipe(Effect.provide(AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node]),
    [[Database.node, Database.configured({ path: join(root, "data", "session.db") })]],
  ))))

  const server = await Effect.runPromise(ServerProcess.start({
    hostname: "127.0.0.1", port: Number(portText), password,
    database: { path: join(root, "data", "session.db") },
    config: { directory, project: false, content: "{}" },
    models: { fetch: false }, fs: { filewatcher: false, fff: false },
  }).pipe(Effect.provideService(Scope.Scope, scope)))
  if (server.address._tag !== "TcpAddress") throw new Error("Expected a TCP loopback server")
  const base = "http://127.0.0.1:" + server.address.port
  const auth = "Basic " + Buffer.from("ycoding:" + password).toString("base64")
  const authenticatedFetch = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", auth)
    return fetch(input, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(15_000) })
  }
  const client = YCoding.make({ baseUrl: base, fetch: authenticatedFetch })
  const readSamplesMs = []
  const readRssMiB = []
  for (let index = 0; index < Number(warmupText) + Number(samplesText); index++) {
    const start = performance.now()
    const messages = await client.message.list({ sessionID })
    const elapsed = performance.now() - start
    verify(messages)
    if (index >= Number(warmupText)) {
      readSamplesMs.push(elapsed)
      readRssMiB.push(process.memoryUsage().rss / 1024 / 1024)
    }
  }

  const { renderScreen } = await import("./test/screen/harness")
  const { json } = await import("./test/fixture/tui-client")
  screen = await renderScreen({
    width: 120, height: 35, args: { sessionID }, settle: lastText,
    config: { animations: false },
    route: (url, request) => {
      if (url.pathname === "/api/location") return json({ directory, project: { id: Project.ID.global, directory } })
      if (url.pathname === "/api/session" || url.pathname.startsWith("/api/session/"))
        return authenticatedFetch(base + url.pathname + url.search, { method: request.method })
    },
  })
  if (!screen.frame().includes(lastText)) throw new Error("Real session route did not render the last projected row")
  const renderSamplesMs = []
  const renderRssMiB = []
  for (let index = 0; index < Number(warmupText) + Number(samplesText); index++) {
    const start = performance.now()
    await screen.renderOnce()
    const frame = screen.frame()
    const elapsed = performance.now() - start
    if (!frame.includes(lastText)) throw new Error("Resident frame lost the last projected row")
    if (index >= Number(warmupText)) {
      renderSamplesMs.push(elapsed)
      renderRssMiB.push(process.memoryUsage().rss / 1024 / 1024)
    }
  }
  process.stdout.write("RESULT " + JSON.stringify({
    messages: count, readMs: { ...distribution(readSamplesMs), samples: readSamplesMs },
    residentFrameMs: { ...distribution(renderSamplesMs), samples: renderSamplesMs },
    readRssMiB: { ...distribution(readRssMiB), samples: readRssMiB },
    residentRssMiB: { ...distribution(renderRssMiB), samples: renderRssMiB },
  }) + "\\n")
} finally {
  if (screen) await screen.dispose()
  await Effect.runPromise(Scope.close(scope, Exit.void))
}
`

function option(args: Map<string, string>, name: string, fallback: number, min: number, max: number) {
  const value = args.has(name) ? Number(args.get(name)) : fallback
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`--${name} must be an integer in ${min}..${max}`)
  return value
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((done, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", done)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing loopback port")
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
  return address.port
}

async function main() {
  const args = new Map<string, string>()
  for (let index = 0; index < process.argv.length - 2; index++) {
    if (!process.argv[index + 2]?.startsWith("--")) continue
    const name = process.argv[index + 2]!.slice(2)
    const value = process.argv[index + 3]
    if (!value || value.startsWith("--")) throw new Error(`Missing --${name} value`)
    args.set(name, value)
    index++
  }
  const checkout = args.get("checkout")
  if (!checkout || !isAbsolute(checkout)) throw new Error("Pass an explicit absolute --checkout path")
  const source = resolve(checkout)
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: source })
  const targetRevision = revision.stdout.toString().trim()
  if (revision.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(targetRevision))
    throw new Error("Target checkout has no Git revision")
  const samples = option(args, "samples", 30, 1, 100)
  const warmup = option(args, "warmup", 5, 1, 20)
  const timeout = option(args, "timeout-ms", 240_000, 10_000, 600_000)
  const root = await mkdtemp(join(tmpdir(), "ycoding-transcript-perf-"))
  try {
    await Promise.all(["workspace", "data", "config", "cache", "state", "tmp"].map((name) => mkdir(join(root, name))))
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        worker,
        root,
        String(await availablePort()),
        randomUUID(),
        String(warmup),
        String(samples),
      ],
      {
        cwd: join(source, "packages/tui"),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          TMPDIR: join(root, "tmp"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
          NO_COLOR: "1",
        },
      },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const watchdog = setInterval(() => {
      if (child.exitCode !== null) return
      const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(child.pid)])
      if (ps.exitCode === 0 && Number(ps.stdout.toString().trim()) / 1024 > MAX_RSS_MIB) child.kill("SIGKILL")
    }, 500)
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL")
    }, timeout)
    const interrupt = () => {
      if (child.exitCode === null) child.kill("SIGTERM")
    }
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", interrupt)
    try {
      const exit = await child.exited
      const output = await stdout
      const errors = await stderr
      if (exit !== 0)
        throw new Error(`Benchmark worker exit ${exit} (timeout/RSS bound or failure): ${errors.slice(-4_000)}`)
      const result = output.split("\n").find((line) => line.startsWith("RESULT "))
      if (!result) throw new Error(`No verified benchmark result: ${errors.slice(-4_000)}`)
      const parsed: unknown = JSON.parse(result.slice(7))
      if (!parsed || typeof parsed !== "object" || Reflect.get(parsed, "messages") !== MESSAGE_COUNT)
        throw new Error("Invalid benchmark result message count")
      for (const name of ["readMs", "residentFrameMs", "readRssMiB", "residentRssMiB"]) {
        const metric = Reflect.get(parsed, name)
        if (
          !metric ||
          !Array.isArray(metric.samples) ||
          metric.samples.length !== samples ||
          metric.samples.some(
            (sample: unknown) => typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0,
          )
        )
          throw new Error(`Invalid ${name} raw samples`)
      }
      console.log(JSON.stringify({ targetRevision, warmup, sanityOnly: samples < 30, ...parsed }))
    } finally {
      clearInterval(watchdog)
      clearTimeout(timer)
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", interrupt)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
