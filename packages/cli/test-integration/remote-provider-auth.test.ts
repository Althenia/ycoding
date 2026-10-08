import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createLocalServer } from "../src/remote-local"
import { createOperationCache, createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"
import type { ProviderAuthAttempt, ProviderAuthInfo, ProviderAuthOperation, ProviderAuthStatus } from "@ycoding-ai/remote"
import { password, startServer } from "../test/remote-harness"

test("remote provider authentication reaches real credential and attempt persistence without leaking secrets or command diagnostics", async () => {
  const home = await mkdtemp(join(tmpdir(), "ycoding-auth-boundary-"))
  await mkdir(join(home, "workspace"))
  const server = await startServer(home, { provider: { text: "unused" }, plugins: [new URL("../test/fixture/remote-provider-auth.ts", import.meta.url).href] })
  try {
    const created = await server.request("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ses_auth", location: { directory: join(home, "workspace") }, model: { providerID: server.provider!.providerID, id: server.provider!.modelID } }) })
    expect(created.status).toBe(200)
    expect(server.logs.filter((entry) => entry.includes("failed to load") || entry.includes("failed to reload"))).toEqual([])
    const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
    const sessions = createSessionRegistry({ local })
    await sessions.refresh()
    const subscriptions = createSubscriptions()
    const cache = createOperationCache()
    const responses: string[] = []
    const run = async <T>(operation: ProviderAuthOperation, fields: Record<string, unknown> = {}) => {
      const frames = await executeRemoteOperation({ request: { type: "request", id: crypto.randomUUID(), operation, input: { target: { sessionID: "ses_auth" }, ...fields } }, local, sessions, subscriptions, cache })
      responses.push(JSON.stringify(frames))
      expect(frames).toHaveLength(1)
      const frame = frames[0]
      if (!frame.ok) throw new Error(`${frame.error.code}: ${frame.error.message}`)
      return frame.value as { data: T }
    }
    const list = async () => (await run<ProviderAuthInfo[]>("provider.auth.list")).data.find((item) => item.id === "auth-fixture")!
    expect((await list()).methods.map((method) => method.type)).toEqual(["key", "command", "oauth"])
    await run("provider.auth.key", { integrationID: "auth-fixture", label: "Work", key: "synthetic-key-secret" })
    await run("provider.auth.key", { integrationID: "auth-fixture", label: "Personal", key: "synthetic-second-secret" })
    expect((await list()).profiles).toEqual(expect.arrayContaining([{ name: "Work", active: false }, { name: "Personal", active: true }]))
    await run("provider.auth.key", { integrationID: "auth-fixture", label: "Work", key: "synthetic-replaced-secret" })
    expect((await list()).profiles).toHaveLength(2)
    expect((await list()).profiles.find((profile) => profile.name === "Work")?.active).toBe(true)
    const attempt = (await run<ProviderAuthAttempt>("provider.auth.begin", { integrationID: "auth-fixture", methodID: "code", label: "OAuth", inputs: {} })).data
    expect(attempt.mode).toBe("code")
    expect((await run<ProviderAuthStatus>("provider.auth.status", { integrationID: "auth-fixture", attemptID: attempt.attemptID })).data.status).toBe("pending")
    await run("provider.auth.complete", { integrationID: "auth-fixture", attemptID: attempt.attemptID, code: "synthetic-code" })
    expect((await run<ProviderAuthStatus>("provider.auth.status", { integrationID: "auth-fixture", attemptID: attempt.attemptID })).data.status).toBe("complete")
    const command = (await run<ProviderAuthAttempt>("provider.auth.begin", { integrationID: "auth-fixture", methodID: "command", label: "CLI", inputs: {} })).data
    for (let remaining = 100; remaining > 0; remaining--) {
      const status = (await run<ProviderAuthStatus>("provider.auth.status", { integrationID: "auth-fixture", attemptID: command.attemptID })).data
      if (status.status === "complete") break
      expect(status.status).toBe("pending")
      if (remaining === 1) throw new Error("Command authentication did not settle")
      await Bun.sleep(10)
    }
    expect((await list()).profiles.find((profile) => profile.name === "CLI")?.active).toBe(true)
    expect(responses.join("\n") + server.logs.join("\n")).not.toMatch(/synthetic-(?:key|second|replaced|command|access|refresh)-secret|synthetic-private-diagnostic|cred_/)
  } finally { await server.close(); await rm(home, { recursive: true, force: true }) }
}, 30000)
