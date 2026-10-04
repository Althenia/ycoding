import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const workerSource = `
import { ServerProcess } from "./src/process.ts"
import { Effect, Exit, Scope } from "effect"
import { join } from "node:path"

const scope = await Effect.runPromise(Scope.make())
try {
  const start = ServerProcess.start({
    hostname: "127.0.0.1",
    port: Number(process.argv[1]),
    password: process.argv[2],
    database: { path: join(process.argv[3], "server.db") },
    config: { directory: process.argv[4], project: false, content: "{}" },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  }).pipe(Effect.provideService(Scope.Scope, scope))
  await Effect.runPromise(start)
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

type Sample = { readonly bootSignalMs: number; readonly healthMs: number; readonly idleRssMiB: number }

function numberOption(args: Map<string, string>, name: string, fallback: number, min: number, max: number) {
  const value = args.has(name) ? Number(args.get(name)) : fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid --${name}; expected ${min}..${max}`)
  return value
}

function distribution(values: readonly number[]) {
  if (values.length === 0) throw new Error("No completed samples")
  const sorted = values.toSorted((left, right) => left - right)
  return { n: sorted.length, median: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
}

function bootMetrics(results: readonly Sample[]) {
  const bootSignalSamplesMs = results.map((item) => item.bootSignalMs)
  const healthSamplesMs = results.map((item) => item.healthMs)
  const idleRssSamplesMiB = results.map((item) => item.idleRssMiB)
  return {
    bootSignalMs: distribution(bootSignalSamplesMs), bootSignalSamplesMs,
    healthMs: distribution(healthSamplesMs), healthSamplesMs,
    idleRssMiB: distribution(idleRssSamplesMiB), idleRssSamplesMiB,
  }
}

async function deadline<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((done, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", done)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Could not reserve a loopback port")
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
  return address.port
}

async function rssMiB(pid: number) {
  const probe = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
  try {
    const output = await deadline(new Response(probe.stdout).text(), 3_000, "RSS probe")
    if (await probe.exited !== 0) throw new Error("RSS probe failed")
    const kib = Number(output.trim())
    if (!Number.isFinite(kib) || kib <= 0) throw new Error("RSS probe returned no live process")
    return kib / 1024
  } finally {
    if (probe.exitCode === null) probe.kill("SIGTERM")
    await probe.exited
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let tail = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return tail
    tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-4_096)
  }
}

async function start(checkout: string, root: string, maxRssMiB: number) {
  const port = await availablePort()
  const password = randomUUID()
  const auth = `Basic ${Buffer.from(`ycoding:${password}`).toString("base64")}`
  const base = `http://127.0.0.1:${port}`
  const started = performance.now()
  const child = Bun.spawn([process.execPath, "-e", workerSource, String(port), password, join(root, "data"), join(root, "workspace")], {
    cwd: join(checkout, "packages/server"),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const interrupt = () => { process.exitCode = 130; if (child.exitCode === null) child.kill("SIGTERM") }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  const unregister = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt) }
  const stderr = drain(child.stderr.getReader())
  try {
    const reader = child.stdout.getReader()
    const ready = (async () => {
      let buffer = ""
      for (;;) {
        const line = buffer.indexOf("\n")
        if (line !== -1) {
          if (buffer.slice(0, line).trim() === "READY") return
          buffer = buffer.slice(line + 1)
          continue
        }
        const chunk = await reader.read()
        if (chunk.done || buffer.length > 8_192) throw new Error("Server exited without a readiness signal")
        buffer += new TextDecoder().decode(chunk.value)
      }
    })()
    await deadline(ready, 30_000, "Server startup")
    const stdout = drain(reader)
    const bootSignalMs = performance.now() - started
    const health = await deadline(fetch(`${base}/api/health`, { headers: { authorization: auth }, signal: AbortSignal.timeout(5_000) }), 6_000, "Authenticated health")
    const healthBody: unknown = await health.json()
    if (health.status !== 200 || typeof healthBody !== "object" || healthBody === null || Reflect.get(healthBody, "pid") !== child.pid) {
      throw new Error("Authenticated health did not identify the isolated ready process")
    }
    const healthMs = performance.now() - started
    const idleRssMiB = await rssMiB(child.pid)
    if (idleRssMiB > maxRssMiB) throw new Error("Isolated server exceeded RSS bound at readiness")
    return { base, auth, pid: child.pid, child, stderr, stdout, unregister, sample: { bootSignalMs, healthMs, idleRssMiB } satisfies Sample }
  } catch (error) {
    child.kill("SIGTERM")
    try { await deadline(child.exited, 5_000, "Failed startup cleanup") }
    catch { child.kill("SIGKILL"); await deadline(child.exited, 5_000, "Forced failed startup cleanup") }
    await stderr
    unregister()
    throw error
  }
}

async function stop(server: Awaited<ReturnType<typeof start>>) {
  if (server.child.exitCode === null) server.child.kill("SIGTERM")
  try {
    const exit = await deadline(server.child.exited, 5_000, "Server shutdown")
    if (exit !== 0) throw new Error("Isolated server exited unsuccessfully")
  } catch {
    if (server.child.exitCode === null) {
      server.child.kill("SIGKILL")
      await deadline(server.child.exited, 5_000, "Forced server shutdown")
      throw new Error("Isolated server required a forced shutdown")
    }
    throw new Error("Isolated server exited unsuccessfully")
  } finally {
    server.unregister()
    await Promise.all([server.stdout, server.stderr])
  }
}

async function request(server: Awaited<ReturnType<typeof start>>, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", server.auth)
  const response = await fetch(`${server.base}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Local server request failed: ${response.status}`)
  return response
}

async function createSession(server: Awaited<ReturnType<typeof start>>, workspace: string) {
  const id = `ses_perf_${randomUUID()}`
  const response = await request(server, "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, location: { directory: workspace } }),
  })
  const value: unknown = await response.json()
  const data = typeof value === "object" && value !== null ? Reflect.get(value, "data") : undefined
  if (typeof data !== "object" || data === null || Reflect.get(data, "id") !== id) throw new Error("Session create returned the wrong ID")
  return id
}

async function subscribe(server: Awaited<ReturnType<typeof start>>) {
  const controller = new AbortController()
  const response = await deadline(request(server, "/api/event", { signal: controller.signal }), 10_000, "Event feed subscription")
    .catch((error: unknown) => { controller.abort(); throw error })
  if (!response.body || response.headers.get("content-type")?.includes("text/event-stream") !== true) {
    controller.abort()
    throw new Error("Event feed was not an SSE stream")
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = async (): Promise<{ type?: string; data?: { sessionID?: string } }> => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split("\n").find((line) => line.startsWith("data: "))
        if (data) return JSON.parse(data.slice(6))
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Event feed closed before the expected event")
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
      if (buffer.length > 1_048_576) throw new Error("Event feed exceeded the frame buffer bound")
    }
  }
  try {
    const connected = await deadline(next(), 10_000, "Event feed connection")
    if (connected.type !== "server.connected") throw new Error("Event feed did not announce its source")
    return { next, close: () => controller.abort() }
  } catch (error) {
    controller.abort()
    throw error
  }
}

async function fanout(server: Awaited<ReturnType<typeof start>>, workspace: string, subscribers: number, warmup: number, samples: number) {
  const streams: Awaited<ReturnType<typeof subscribe>>[] = []
  const first: number[] = []
  const last: number[] = []
  try {
    for (let index = 0; index < subscribers; index++) streams.push(await subscribe(server))
    for (let index = -warmup; index < samples; index++) {
      const id = `ses_perf_${randomUUID()}`
      const waiting = streams.map(async (stream) => {
        const event = await stream.next()
        if (event.type !== "session.created" || event.data?.sessionID !== id) throw new Error("Fan-out event mismatch")
        return performance.now()
      })
      const began = performance.now()
      try {
        const response = await request(server, "/api/session", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, location: { directory: workspace } }),
        })
        const body: unknown = await response.json()
        const data = typeof body === "object" && body !== null ? Reflect.get(body, "data") : undefined
        if (typeof data !== "object" || data === null || Reflect.get(data, "id") !== id) throw new Error("Fan-out mutation returned the wrong ID")
        const received = await deadline(Promise.all(waiting), 10_000, "Event fan-out")
        if (index >= 0) { first.push(Math.min(...received) - began); last.push(Math.max(...received) - began) }
      } catch (error) {
        streams.forEach((stream) => stream.close())
        await Promise.allSettled(waiting)
        throw error
      }
    }
  } finally {
    streams.forEach((stream) => stream.close())
  }
  return { subscribers, firstMs: distribution(first), firstSamplesMs: first, lastMs: distribution(last), lastSamplesMs: last }
}

async function run() {
  const args = new Map(process.argv.slice(2).map((item) => {
    const match = /^--([a-z-]+)=(.*)$/.exec(item)
    if (!match) throw new Error("Expected --name=value arguments")
    return [match[1], match[2]] as const
  }))
  const checkoutArg = args.get("checkout")
  if (!checkoutArg || !isAbsolute(checkoutArg)) throw new Error("Supply --checkout=/absolute/path/to/target checkout")
  const checkout = resolve(checkoutArg)
  if (checkout === resolve(import.meta.dir, "../../..")) throw new Error("Select an explicit target checkout, not the harness checkout")
  if (!(await Bun.file(join(checkout, "packages/server/src/process.ts")).exists())) throw new Error("Target checkout has no ServerProcess source")
  const mode = args.get("mode") ?? "sanity"
  if (mode !== "sanity" && mode !== "boot" && mode !== "memory" && mode !== "fanout") throw new Error("Invalid --mode")
  const selected = mode
  const maxRssMiB = numberOption(args, "max-rss-mib", 8192, 128, 8192)
  const samples = selected === "sanity" ? 1 : numberOption(args, "samples", 30, 30, 200)
  const warmup = selected === "sanity" ? 0 : numberOption(args, "warmup", 5, 3, 20)
  const subscribers = selected === "sanity" ? 2 : numberOption(args, "subscribers", 4, 1, 16)
  const sessions = selected === "sanity" ? 2 : numberOption(args, "sessions", 50, 1, 500)
  const root = await mkdtemp(join(tmpdir(), "ycoding-perf-server-"))
  try {
    await Promise.all(["config", "data", "cache", "state", "tmp", "workspace"].map((name) => mkdir(join(root, name))))
    if (selected === "boot") {
      const results: Sample[] = []
      for (let index = -warmup; index < samples; index++) {
        const sampleRoot = join(root, `boot-${index}`)
        try {
          await Promise.all(["config", "data", "cache", "state", "tmp", "workspace"].map((name) => mkdir(join(sampleRoot, name), { recursive: true })))
          const server = await start(checkout, sampleRoot, maxRssMiB)
          try { if (index >= 0) results.push(server.sample) }
          finally { await stop(server) }
        } finally { await rm(sampleRoot, { recursive: true, force: true }) }
      }
      console.log(JSON.stringify({ mode: selected, boundary: "direct-server-component", samples, warmup,
        readiness: "spawn to direct ServerProcess.start ready signal; then authenticated health 200 with matching PID", ...bootMetrics(results) }))
      return
    }
    const server = await start(checkout, root, maxRssMiB)
    try {
      const workspace = join(root, "workspace")
      const idleRssMiB = server.sample.idleRssMiB
      for (let index = 0; index < sessions; index++) await createSession(server, workspace)
      const postLoadRssMiB = await rssMiB(server.pid)
      if (postLoadRssMiB > maxRssMiB) throw new Error("Isolated server exceeded RSS bound after load")
      const common = { mode: selected, boundary: "direct-server-component", sessions,
        bootSignalMs: server.sample.bootSignalMs, healthMs: server.sample.healthMs, idleRssMiB, postLoadRssMiB,
        ...(selected === "sanity" ? { bootContract: bootMetrics([server.sample]) } : {}) }
      if (selected === "memory") {
        const readings = [postLoadRssMiB]
        const soakStart = performance.now()
        while (performance.now() - soakStart < 600_000) {
          await Bun.sleep(Math.min(10_000, Math.max(1, 600_000 - (performance.now() - soakStart))))
          const value = await rssMiB(server.pid)
          if (value > maxRssMiB) throw new Error("Isolated server exceeded RSS bound during soak")
          readings.push(value)
        }
        console.log(JSON.stringify({ ...common, soakMs: performance.now() - soakStart, intervalMs: 10_000, readings: readings.length,
          rssMiB: readings, firstMiB: readings[0], lastMiB: readings.at(-1), maxMiB: Math.max(...readings), minMiB: Math.min(...readings) }))
        return
      }
      const result = await fanout(server, workspace, subscribers, warmup, samples)
      console.log(JSON.stringify({ ...common, warmup, ...result,
        latencyDefinition: "before authenticated Session create POST to first/last matching SSE event at ready subscribers" }))
    } finally { await stop(server) }
  } finally { await rm(root, { recursive: true, force: true }) }
}

await run()
