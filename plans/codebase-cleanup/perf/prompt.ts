#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const MODEL = "perf-model"
const PROVIDER = "perf-local"
const KEY = "local-perf-key"
const workerSource = `
import { ServerProcess } from "./src/process.ts"
import { Effect, Exit, Scope } from "effect"
import { join } from "node:path"

const scope = await Effect.runPromise(Scope.make())
try {
  await Effect.runPromise(ServerProcess.start({
    hostname: "127.0.0.1",
    port: Number(process.argv[1]),
    password: process.argv[2],
    database: { path: join(process.argv[3], "server.db") },
    config: { directory: process.argv[4], project: false, content: process.argv[5] },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  }).pipe(Effect.provideService(Scope.Scope, scope)))
  process.stdout.write("READY\\n")
  process.on("SIGTERM", () => {
    void Effect.runPromise(Scope.close(scope, Exit.void)).then(() => process.exit(0), () => process.exit(1))
  })
  await new Promise(() => {})
} catch (error) {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  console.error(error)
  process.exitCode = 1
}
`

type Sample = {
  readonly firstRequestMs: number
  readonly stepTerminalMs: number
  readonly serverRssMiB: number
  readonly sessionID: string
  readonly inputID: string
  readonly assistantMessageID: string
}

function option(args: Map<string, string>, name: string, fallback: number, min: number, max: number) {
  const value = args.has(name) ? Number(args.get(name)) : fallback
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid --${name}; expected ${min}..${max}`)
  return value
}

function distribution(values: readonly number[]) {
  if (values.length === 0) throw new Error("No completed samples")
  const sorted = values.toSorted((a, b) => a - b)
  return { median: sorted[Math.ceil(sorted.length / 2) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
}

async function deadline<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function port() {
  const socket = createServer()
  await new Promise<void>((done, reject) => {
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", done)
  })
  const address = socket.address()
  if (address === null || typeof address === "string") throw new Error("No loopback port")
  await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()))
  return address.port
}

async function rssMiB(pid: number) {
  const probe = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
  try {
    const text = await deadline(new Response(probe.stdout).text(), 3_000, "RSS probe")
    if (await deadline(probe.exited, 3_000, "RSS probe exit") !== 0) throw new Error("RSS probe failed")
    const kib = Number(text.trim())
    if (!Number.isFinite(kib) || kib <= 0) throw new Error("RSS probe found no live server")
    return kib / 1024
  } finally {
    if (probe.exitCode === null) probe.kill()
    await probe.exited
  }
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let tail = ""
  for (;;) {
    const part = await reader.read()
    if (part.done) return tail
    tail = (tail + new TextDecoder().decode(part.value)).slice(-4_096)
  }
}

async function stop(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode === null) child.kill("SIGTERM")
  try {
    if (await deadline(child.exited, 5_000, "Server shutdown") !== 0) throw new Error("Server exited unsuccessfully")
  } catch {
    if (child.exitCode !== null) throw new Error(`Server exited with status ${child.exitCode}`)
    child.kill("SIGKILL")
    await deadline(child.exited, 5_000, "Forced server shutdown")
    throw new Error("Server required forced shutdown")
  }
}

async function request(base: string, auth: string, directory: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", auth)
  headers.set("x-ycoding-directory", directory)
  const response = await fetch(`${base}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Local server ${path} returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  return response
}

function data(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected JSON object")
  return Object.fromEntries(Object.entries(value))
}

async function json(base: string, auth: string, directory: string, path: string, method: string, body: unknown) {
  return data(await (await request(base, auth, directory, path, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).json())
}

async function watch(base: string, auth: string, directory: string, sessionID: string) {
  const controller = new AbortController()
  try {
    const response = await request(base, auth, directory, `/api/experimental/session/${sessionID}/log?after=0&follow=true`, {
      signal: controller.signal,
    })
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
      throw new Error("Durable Session log was not an SSE stream")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const next = async () => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const payload = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n")
          if (payload) return data(JSON.parse(payload) as unknown)
          continue
        }
        const chunk = await reader.read()
        if (chunk.done) throw new Error("Session log ended before Step terminal")
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
        if (buffer.length > 1_000_000) throw new Error("Session log frame exceeded bound")
      }
    }
    for (;;) {
      const event = await deadline(next(), 10_000, "Session log synchronization")
      if (event.type === "log.synced") {
        if (event.aggregateID !== sessionID) throw new Error("Session log synchronized the wrong aggregate")
        break
      }
    }
    return { next, close: () => controller.abort() }
  } catch (error) {
    controller.abort()
    throw error
  }
}

async function main() {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg)
    if (!match) throw new Error(`Expected --name=value, got ${arg}`)
    return [match[1]!, match[2]!] as const
  }))
  const target = args.get("checkout")
  if (!target || !isAbsolute(target)) throw new Error("Specify an absolute --checkout=/path/to/target")
  const checkout = resolve(target)
  if (!(await Bun.file(join(checkout, "packages/server/src/process.ts")).exists()))
    throw new Error("Target checkout has no ServerProcess source")
  const revision = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "HEAD"])
  const targetRevision = revision.stdout.toString().trim()
  if (revision.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(targetRevision))
    throw new Error("Target checkout has no Git revision")
  const samples = option(args, "samples", 30, 1, 200)
  const warmups = option(args, "warmups", 5, 0, 50)
  const perRunMs = option(args, "per-run-ms", 30_000, 1_000, 120_000)
  const aggregateMs = option(args, "aggregate-ms", 900_000, 5_000, 3_600_000)
  const maxRssMiB = option(args, "max-rss-mib", 2_048, 64, 32_768)
  if (samples + warmups > 250) throw new Error("At most 250 total runs")
  const root = await mkdtemp(join(tmpdir(), "ycoding-prompt-perf-"))
  const workspace = join(root, "workspace")
  const started = performance.now()
  const aggregate = <T>(operation: Promise<T>, label: string) =>
    deadline(operation, Math.max(1, aggregateMs - (performance.now() - started)), `Aggregate deadline during ${label}`)
  let child: ReturnType<typeof Bun.spawn> | undefined
  let provider: ReturnType<typeof Bun.serve> | undefined
  let stderr: Promise<string> | undefined
  let stdout: Promise<string> | undefined
  let failure: unknown
  let summary: string | undefined
  let password: string | undefined
  let serverOutput = "unavailable"
  const interrupt = () => { process.exitCode = 130; if (child?.exitCode === null) child.kill("SIGTERM") }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    await Promise.all(["workspace", "config", "data", "cache", "state", "tmp"].map((part) => mkdir(join(root, part))))
    const seen = new Map<string, number[]>()
    const unexpected: string[] = []
    provider = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const received = performance.now()
        const path = new URL(req.url).pathname
        const body: unknown = await req.json().catch(() => undefined)
        const text = JSON.stringify(body)
        const marker = /prompt-perf-[a-f0-9-]{36}/.exec(text)?.[0]
        if (path !== "/api/v1/chat/completions" || req.headers.get("authorization") !== `Bearer ${KEY}` || !marker) {
          unexpected.push(`${path}: invalid endpoint, credential, or sample marker`)
          return Response.json({ error: { message: "Unexpected fake-provider request" } }, { status: 400 })
        }
        seen.set(marker, [...(seen.get(marker) ?? []), received])
        const id = `perf-${marker}`
        return new Response([
          { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL,
            choices: [{ index: 0, delta: { role: "assistant", content: "Measured local completion" }, finish_reason: null }] },
          { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL,
            choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } },
        ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const config = JSON.stringify({
      efficiency: { title: "local" },
      providers: { [PROVIDER]: { name: "Local Perf Provider", package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.port}/api/v1` },
        models: { [MODEL]: { name: "Local Perf", capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 4_096 }, cost: { input: 0, output: 0 } } } } },
    })
    password = randomUUID()
    const auth = `Basic ${Buffer.from(`ycoding:${password}`).toString("base64")}`
    const base = `http://127.0.0.1:${await port()}`
    child = Bun.spawn([process.execPath, "-e", workerSource, new URL(base).port, password, join(root, "data"), workspace, config], {
      cwd: join(checkout, "packages/server"), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root,
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), TMPDIR: join(root, "tmp"),
        NO_COLOR: "1", YCODING_DISABLE_CHANNEL_DB: "1" },
    })
    if (typeof child.stdout === "number" || typeof child.stderr === "number")
      throw new Error("Server pipes unavailable")
    const out = child.stdout.getReader()
    const ready = (async () => {
      let buffer = ""
      for (;;) {
        const line = buffer.indexOf("\n")
        if (line !== -1) {
          if (buffer.slice(0, line).trim() === "READY") return
          buffer = buffer.slice(line + 1)
          continue
        }
        const part = await out.read()
        if (part.done || buffer.length > 8_192) throw new Error("Server exited without readiness")
        buffer += new TextDecoder().decode(part.value)
      }
    })()
    stderr = drain(child.stderr)
    await aggregate(deadline(ready, 30_000, "Server startup"), "server startup")
    stdout = drain(new ReadableStream({ async pull(controller) {
      const part = await out.read()
      if (part.done) controller.close()
      else controller.enqueue(part.value)
    } }))
    const health = data(await aggregate(request(base, auth, workspace, "/api/health").then((response) => response.json()), "health"))
    if (health.pid !== child.pid) throw new Error("Health response did not identify isolated server")
    const integrationPath = `/api/integration?location[directory]=${encodeURIComponent(workspace)}`
    const readyUntil = performance.now() + 15_000
    while (true) {
      const integrationList = data(await aggregate(request(base, auth, workspace, integrationPath).then((response) => response.json()), "integration readiness"))
      if (Array.isArray(integrationList.data) && integrationList.data.some((entry) => data(entry).id === PROVIDER)) break
      if (performance.now() > readyUntil)
        throw new Error(`Configured provider integration not listed: ${Array.isArray(integrationList.data) ? integrationList.data.map((entry) => data(entry).id).join(", ") : "invalid list"}`)
      await aggregate(Bun.sleep(100), "integration readiness")
    }
    await aggregate(request(base, auth, workspace, `/api/integration/${PROVIDER}/connect/key?location[directory]=${encodeURIComponent(workspace)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: KEY }) }), "local credential")
    const modelList = data(await aggregate(request(base, auth, workspace, `/api/model?location[directory]=${encodeURIComponent(workspace)}`).then((response) => response.json()), "model readiness"))
    if (!Array.isArray(modelList.data) || !modelList.data.some((entry) => {
      const model = data(entry)
      return model.providerID === PROVIDER && model.id === MODEL
    })) throw new Error("Configured local model not listed")

    const measured: Sample[] = []
    const warmupResults: Sample[] = []
    for (let index = 0; index < warmups + samples; index++) {
      if (performance.now() - started > aggregateMs) throw new Error(`Aggregate deadline exceeded ${aggregateMs}ms`)
      const sessionID = `ses_perf_${randomUUID()}`
      const marker = `prompt-perf-${randomUUID()}`
      const created = data((await aggregate(json(base, auth, workspace, "/api/session", "POST", {
        id: sessionID, location: { directory: workspace }, model: { providerID: PROVIDER, id: MODEL },
      }), "session creation")).data)
      if (created.id !== sessionID) throw new Error("Session creation returned the wrong ID")
      const log = await aggregate(watch(base, auth, workspace, sessionID), "log subscription")
      try {
        const admissionStart = performance.now()
        const admitted = data((await deadline(json(base, auth, workspace, `/api/session/${sessionID}/prompt`, "POST", {
          text: marker,
        }), Math.min(perRunMs, Math.max(1, aggregateMs - (performance.now() - started))), "Prompt admission")).data)
        if (typeof admitted.id !== "string") throw new Error("Prompt admission omitted input ID")
        const eventTypes: string[] = []
        let promoted = false
        let assistantMessageID: string | undefined
        let terminalAt: number | undefined
        while (terminalAt === undefined) {
          const remaining = Math.min(perRunMs - (performance.now() - admissionStart), aggregateMs - (performance.now() - started))
          if (remaining <= 0) throw new Error(`Step terminal timed out for ${sessionID}`)
          const event = await deadline(log.next(), remaining, "Durable Step terminal")
          if (data(event.data).sessionID !== sessionID) throw new Error("Cross-session durable event")
          if (typeof event.type !== "string") throw new Error("Durable event missing type")
          eventTypes.push(event.type)
          if (event.type === "session.input.promoted" && data(event.data).inputID === admitted.id) promoted = true
          if (event.type === "session.step.started") {
            if (assistantMessageID) throw new Error("More than one Step started")
            const id = data(event.data).assistantMessageID
            if (typeof id !== "string") throw new Error("Step start omitted assistant message ID")
            assistantMessageID = id
          }
          if (event.type === "session.step.failed") throw new Error(`Step failed for ${sessionID}: ${JSON.stringify(event.data)}`)
          if (event.type === "session.step.ended") {
            if (!assistantMessageID || data(event.data).assistantMessageID !== assistantMessageID)
              throw new Error("Step terminal has no matching Step start")
            terminalAt = performance.now()
          }
        }
        await deadline(request(base, auth, workspace, `/api/session/${sessionID}/wait`, { method: "POST" }),
          Math.max(1, Math.min(perRunMs - (performance.now() - admissionStart), aggregateMs - (performance.now() - started))), "Session wait")
        const times = seen.get(marker)
        if (!promoted || !assistantMessageID || !times || times.length !== 1 || unexpected.length)
          throw new Error(`Invalid admission/Step/provider correlation for ${sessionID}: ${JSON.stringify({ eventTypes, providerRequests: times?.length, unexpected })}`)
        if (times[0]! < admissionStart || terminalAt < times[0]!) throw new Error("Invalid admission → request → terminal order")
        const serverRssMiB = await deadline(rssMiB(child.pid),
          Math.max(1, Math.min(perRunMs - (performance.now() - admissionStart), aggregateMs - (performance.now() - started))), "Per-run RSS")
        if (serverRssMiB > maxRssMiB) throw new Error(`Server RSS exceeded ${maxRssMiB} MiB`)
        const result = { sessionID, inputID: admitted.id, assistantMessageID,
          firstRequestMs: times[0]! - admissionStart, stepTerminalMs: terminalAt - admissionStart, serverRssMiB }
        ;(index < warmups ? warmupResults : measured).push(result)
        seen.delete(marker)
      } finally {
        log.close()
      }
    }
    if (child.exitCode !== null || measured.length !== samples || warmupResults.length !== warmups)
      throw new Error("Server exited or benchmark samples incomplete")
    summary = JSON.stringify({ targetRevision, warmups, samples, perRunMs, aggregateMs,
      boundary: "HTTP prompt admission start → fake provider request handler; HTTP prompt admission start → observed durable session.step.ended SSE",
      firstRequestMs: distribution(measured.map((sample) => sample.firstRequestMs)),
      stepTerminalMs: distribution(measured.map((sample) => sample.stepTerminalMs)),
      serverRssMiB: distribution(measured.map((sample) => sample.serverRssMiB)),
      warmupResults, raw: measured }, null, 2)
  } catch (error) {
    failure = error
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    try {
      if (provider) await provider.stop(true)
    } catch (error) {
      failure = new Error("Fake-provider cleanup failed", { cause: error })
    }
    try {
      if (child) await stop(child)
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Benchmark and cleanup failed") : error
    }
    try {
      const output = await Promise.all([stderr, stdout].filter((value) => value !== undefined))
      serverOutput = output[0]?.replaceAll(KEY, "[redacted]").replaceAll(password ?? KEY, "[redacted]").slice(-3_000) ?? "unavailable"
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
  if (failure) throw new Error(`Prompt benchmark failed: ${failure instanceof Error ? failure.message : "unknown error"}; server stderr: ${serverOutput}`, { cause: failure })
  if (process.exitCode) throw new Error("Prompt benchmark interrupted")
  if (!summary) throw new Error("Prompt benchmark produced no summary")
  console.log(summary)
}

if (import.meta.main) await main()
