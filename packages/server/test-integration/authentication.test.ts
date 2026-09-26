import { expect, test } from "bun:test"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("process authentication ignores URL credentials on lifecycle and application routes", async () => {
  const port = await availablePort()
  const scope = await Effect.runPromise(Scope.make())
  const directory = await mkdtemp(join(tmpdir(), "ycoding-server-auth-"))
  try {
    const startingRaw = ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port,
      password: "test-password",
      database: { path: ":memory:" },
      config: { directory, project: false, content: "{}" },
      fs: { filewatcher: false, fff: false },
    }).pipe(Effect.provideService(Scope.Scope, scope))
    const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
    await Effect.runPromise(starting)

    const base = `http://127.0.0.1:${port}`
    const token = encodeURIComponent(Buffer.from("ycoding:test-password").toString("base64"))
    const authorization = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`
    for (const route of ["/api/health", "/openapi.json"]) {
      expect((await fetch(`${base}${route}?auth_token=${token}`)).status).toBe(401)
      expect((await fetch(`${base}${route}`, { headers: { authorization } })).status).toBe(200)
    }
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

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
