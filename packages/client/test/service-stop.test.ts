import { afterEach, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Service as PromiseService } from "../src/promise/service"
import { Service as EffectService } from "../src/effect/service"
import type { StopOptions } from "../src/service"

const originalFetch = globalThis.fetch
const directories: string[] = []
afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

const clients = [
  { name: "Promise", stop: (options: StopOptions) => PromiseService.stop(options) },
  { name: "Effect", stop: (options: StopOptions) => Effect.runPromise(EffectService.stop(options).pipe(Effect.provide(NodeFileSystem.layer))) },
]

async function fixture(accepted = true) {
  const directory = await fs.mkdtemp("/Users/viadz/.local/share/ycoding/tasks/service-stop-synthetic-")
  directories.push(directory)
  const file = path.join(directory, "service.json")
  const info = { id: "synthetic-service", version: "test", pid: 2147483647, url: "http://127.0.0.1:43123", password: "test-only" }
  await fs.writeFile(file, JSON.stringify(info))
  let stopped = false
  const requests: Request[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.method === "POST") { stopped = accepted; return Response.json({ accepted }) }
    return stopped ? Response.json({}, { status: 404 }) : Response.json({ healthy: true, version: "test", pid: info.pid, sourceEpoch: info.id })
  }, { preconnect: () => {} })
  return { file, info, requests, expected: { url: info.url, pid: info.pid, auth: { type: "basic" as const, username: "ycoding", password: "test-only" } } }
}

for (const client of clients) {
  test(`${client.name} stop refuses a replacement process without sending a stop request`, async () => {
    const f = await fixture()
    await expect(client.stop({ file: f.file, expected: { ...f.expected, pid: f.expected.pid - 1 } })).rejects.toThrow(/changed/)
    expect(f.requests.map((request) => request.method)).toEqual(["GET"])
  })

  test(`${client.name} stop refuses a changed endpoint or authentication capability`, async () => {
    for (const expected of [{ url: "http://127.0.0.1:43124", pid: 2147483647 }, { url: "http://127.0.0.1:43123", pid: 2147483647, auth: { type: "basic" as const, username: "ycoding", password: "different-test-value" } }]) {
      const f = await fixture()
      await expect(client.stop({ file: f.file, expected })).rejects.toThrow(/changed/)
      expect(f.requests.map((request) => request.method)).toEqual(["GET"])
    }
  })

  test(`${client.name} stop confirms the selected service and sends its instance identity`, async () => {
    const f = await fixture()
    await client.stop({ file: f.file, expected: f.expected })
    const request = f.requests.find((request) => request.method === "POST")!
    expect(await request.json()).toEqual({ instanceID: "synthetic-service" })
    expect(new URL(request.url).pathname).toBe("/api/service/stop")
  })

  test(`${client.name} stop reports an unconfirmed refusal rather than successful retirement`, async () => {
    const f = await fixture(false)
    await expect(client.stop({ file: f.file, expected: f.expected })).rejects.toThrow(/did not stop/)
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  })

  test(`${client.name} stop refuses a missing selected registration without sending requests`, async () => {
    const f = await fixture()
    await fs.unlink(f.file)
    await expect(client.stop({ file: f.file, expected: f.expected })).rejects.toThrow(/changed/)
    expect(f.requests).toEqual([])
  })

  test(`${client.name} registration-only stop retains its existing refusal behavior`, async () => {
    const f = await fixture(false)
    await client.stop({ file: f.file })
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  })
}
