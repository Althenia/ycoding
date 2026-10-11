import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Service } from "../src/promise/service"
import { ensure } from "../src/effect/service"

for (const kind of ["promise", "effect"] as const) {
  for (const initial of ["waiting", "ready", "wrong-pid", "wrong-version", "unauthorized"] as const) {
    test(`${kind} detects readiness promptly after ${initial} health`, async () => {
      const directory = await mkdtemp(join(import.meta.dir, ".service-readiness-"))
      const registration = join(directory, "service.json")
      const firstProbe = Promise.withResolvers<void>()
      const starts: string[] = []
      let requests = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          expect(request.headers.get("authorization")).toBe("Basic " + btoa("ycoding:synthetic"))
          requests += 1
          if (requests === 1) firstProbe.resolve()
          return Response.json(
            {
              healthy: true,
              version: requests === 1 && initial === "wrong-version" ? "old" : "test",
              pid: requests === 1 && initial === "wrong-pid" ? process.pid + 1 : process.pid,
              sourceEpoch: "synthetic",
            },
            {
              status:
                requests === 1 && initial === "waiting"
                  ? 503
                  : requests === 1 && initial === "unauthorized"
                    ? 401
                    : 200,
            },
          )
        },
      })
      let pending: Promise<unknown> | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await writeFile(
          registration,
          JSON.stringify({ url: server.url.toString(), pid: process.pid, version: "test", password: "synthetic" }),
        )
        const options = {
          file: registration,
          version: "test",
          command: [],
          onStart: (reason: string) => starts.push(reason),
        }
        pending =
          kind === "promise"
            ? Service.ensure(options)
            : Effect.runPromise(ensure(options).pipe(Effect.provide(NodeFileSystem.layer)))
        await firstProbe.promise
        const endpoint = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Readiness was not detected within 500ms of the waiting probe")),
              500,
            )
          }),
        ])
        expect(endpoint).toEqual({
          url: server.url.toString(),
          auth: { type: "basic", username: "ycoding", password: "synthetic" },
        })
        expect(requests).toBe(initial === "ready" ? 1 : 2)
        expect(starts).toEqual([])
      } finally {
        clearTimeout(timeout)
        await pending?.catch(() => undefined)
        await server.stop(true)
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  test(`${kind} bounds health requests during a slow compatible startup without spawning`, async () => {
    const directory = await mkdtemp(join(import.meta.dir, ".service-readiness-"))
    const registration = join(directory, "service.json")
    const firstProbe = Promise.withResolvers<void>()
    const starts: string[] = []
    const probes: number[] = []
    let ready = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        probes.push(performance.now())
        firstProbe.resolve()
        return Response.json(
          { healthy: true, version: "test", pid: process.pid, sourceEpoch: "synthetic" },
          { status: ready ? 200 : 503 },
        )
      },
    })
    let pending: Promise<unknown> | undefined
    try {
      await writeFile(registration, JSON.stringify({ url: server.url.toString(), pid: process.pid, version: "test" }))
      const options = {
        file: registration,
        version: "test",
        command: [],
        onStart: (reason: string) => starts.push(reason),
      }
      pending =
        kind === "promise"
          ? Service.ensure(options)
          : Effect.runPromise(ensure(options).pipe(Effect.provide(NodeFileSystem.layer)))
      await firstProbe.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 6_000))
      ready = true
      expect(await pending).toEqual({ url: server.url.toString(), auth: undefined })
      expect(probes.length).toBeLessThanOrEqual(55)
      expect(probes.filter((at) => at - probes[0] >= 5_000).length).toBeLessThanOrEqual(2)
      expect(starts).toEqual([])
    } finally {
      ready = true
      await pending?.catch(() => undefined)
      await server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
}
