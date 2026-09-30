import { expect, test } from "bun:test"
import { KeepAwake } from "@ycoding-ai/protocol/groups/keep-awake"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const authorization = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`

test.skipIf(process.platform !== "darwin")(
  "a real backend holds one owned caffeinate assertion while enabled, releases it on disable, and releases it when the backend is killed",
  async () => {
    const port = await availablePort()
    const directory = await mkdtemp(join(tmpdir(), "ycoding-keep-awake-"))
    const backend = Bun.spawn([process.execPath, join(import.meta.dir, "keep-awake-backend.ts"), String(port), directory], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const base = `http://127.0.0.1:${port}/api/keep-awake`
    const call = async (method: "GET" | "PUT", enabled?: boolean) => {
      const response = await fetch(base, {
        method,
        headers: { authorization, ...(enabled === undefined ? {} : { "content-type": "application/json" }) },
        ...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }),
      })
      expect(response.status).toBe(200)
      return Schema.decodeUnknownSync(Schema.Struct({ data: KeepAwake.Status }))(await response.json())
    }
    try {
      await ready(backend)
      expect(await call("GET")).toEqual({ data: { state: "off" } })
      expect(await inhibitors(backend.pid)).toEqual([])

      expect(await call("PUT", true)).toEqual({ data: { state: "on" } })
      const [inhibitor] = await inhibitors(backend.pid)
      expect(inhibitor).toBeGreaterThan(0)
      expect(await inhibitors(backend.pid)).toEqual([inhibitor])
      expect(await assertionHeldBy(inhibitor)).toBe(true)
      expect(await call("PUT", true)).toEqual({ data: { state: "on" } })
      expect(await inhibitors(backend.pid)).toEqual([inhibitor])

      expect(await call("PUT", false)).toEqual({ data: { state: "off" } })
      expect(await eventually(() => alive(inhibitor), (running) => !running)).toBe(false)
      expect(await assertionHeldBy(inhibitor)).toBe(false)
      expect(await inhibitors(backend.pid)).toEqual([])

      expect(await call("PUT", true)).toEqual({ data: { state: "on" } })
      const [second] = await inhibitors(backend.pid)
      expect(second).not.toBe(inhibitor)
      expect(await assertionHeldBy(second)).toBe(true)

      backend.kill("SIGKILL")
      await backend.exited
      expect(await eventually(() => alive(second), (running) => !running, 15_000)).toBe(false)
      expect(await assertionHeldBy(second)).toBe(false)
    } finally {
      backend.kill("SIGKILL")
      await backend.exited
      for (const pid of await inhibitors(backend.pid)) process.kill(pid, "SIGKILL")
      await rm(directory, { recursive: true, force: true })
    }
  },
  90_000,
)

async function ready(backend: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const reader = backend.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  const deadline = Date.now() + 60_000
  while (!output.includes("ready")) {
    if (Date.now() > deadline) throw new Error("backend did not start")
    const chunk = await Promise.race([reader.read(), backend.exited.then(() => ({ done: true as const, value: undefined }))])
    if (chunk.done) throw new Error(`backend exited early: ${await new Response(backend.stderr).text()}`)
    output += decoder.decode(chunk.value)
  }
  reader.releaseLock()
}

async function inhibitors(backendPID: number) {
  const result = Bun.spawnSync(["/usr/bin/pgrep", "-f", `^/usr/bin/caffeinate -i -w ${backendPID}$`])
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(Number)
}

async function assertionHeldBy(pid: number) {
  const result = Bun.spawnSync(["/usr/bin/pmset", "-g", "assertions"])
  return new RegExp(`pid ${pid}\\(caffeinate\\).*PreventUserIdleSystemSleep`).test(result.stdout.toString())
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function eventually<A>(read: () => A, done: (value: A) => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout
  let value = read()
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(50)
    value = read()
  }
  return value
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
