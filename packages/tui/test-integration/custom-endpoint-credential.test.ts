import { expect, test } from "bun:test"
import { YCoding } from "@ycoding-ai/client"
import { Effect, Exit, Logger, Scope } from "effect"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ServerProcess } from "../../server/src/process"
import { saveCustomEndpoint } from "../src/custom-endpoint-save"

test("a saved custom endpoint uses its named credential for discovery and Chat/Responses requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-endpoint-integration-"))
  const configDir = join(root, "config")
  const directory = join(root, "workspace")
  const requests: Array<{ path: string; authorization: string }> = []
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    requests.push({ path, authorization: request.headers.get("authorization") ?? "" })
    if (path === "/v1/models") {
      if (!request.headers.get("authorization")) return new Response("unauthorized", { status: 401 })
      return Response.json({ object: "list", data: [{ id: "fixture-model" }] })
    }
    const body = path === "/v1/responses"
      ? [
          { type: "response.output_text.delta", item_id: "msg_fixture", delta: "Responses ready" },
          { type: "response.completed", response: { id: "resp_fixture", usage: { input_tokens: 2, output_tokens: 2 } } },
        ]
      : [
          { id: "chatcmpl_fixture", choices: [{ delta: { role: "assistant", content: "Chat ready" }, finish_reason: null }], usage: null },
          { id: "chatcmpl_fixture", choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
        ]
    return new Response(`${body.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  } })
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await Promise.all([mkdir(configDir), mkdir(directory)])
    server = await startServer({ configDir, directory, database: join(root, "ycoding.db") })
    const client = YCoding.make({
      baseUrl: server.base,
      headers: { authorization: `Basic ${Buffer.from("ycoding:test-password").toString("base64")}` },
    })
    const location = { directory }
    const provider = "fixture-compatible"

    for (const api of ["chat", "responses"] as const) {
      const key = `key-${api}`
      let listed = [] as Awaited<ReturnType<typeof client.integration.list>>["data"]
      const saved = await saveCustomEndpoint(configDir, {
        provider,
        baseURL: `http://127.0.0.1:${endpoint.port}/v1`,
        api,
        catalog: "openai-models",
        apiKey: key,
        profile: `${api}-profile`,
        models: [{ id: "fixture-model" }],
      }, {
        async syncRegistration() { listed = (await client.integration.list({ location })).data },
        registered: (id) => listed.some((item) => item.id === id && item.methods.some((method) => method.type === "key")),
        connectKey: ({ integrationID, key, label }) => client.integration.connect.key({ integrationID, key, label, location }),
        activate: (credentialID) => client.credential.activate({ credentialID, location }),
        async refresh() { listed = (await client.integration.list({ location })).data },
      })
      expect(saved).toEqual({ providerID: provider, credentialConnected: true })
      const info = (await client.integration.get({ integrationID: provider, location })).data
      expect(info?.methods).toContainEqual({ type: "key", label: "API key" })
      expect(info?.connections).toContainEqual(expect.objectContaining({ type: "credential", label: `${api}-profile`, active: true }))
      expect(info?.connections.filter((connection) => connection.type === "credential" && connection.active)).toHaveLength(1)
      if (api === "responses")
        expect(info?.connections).toContainEqual(expect.objectContaining({ type: "credential", label: "chat-profile", active: false }))
      expect(JSON.stringify(info)).not.toContain(key)
      const config = await readFile(join(configDir, "ycoding.json"), "utf8")
      expect(config).not.toContain(key)
      expect(JSON.parse(config).providers[provider]).toMatchObject({
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { api, baseURL: `http://127.0.0.1:${endpoint.port}/v1` },
      })
      for (let attempt = 0; attempt < 50; attempt++) {
        if (requests.some((request) => request.path === "/v1/models" && request.authorization === `Bearer ${key}`)) break
        if (attempt === 49) throw new Error("selected credential did not reach catalog discovery")
        await Bun.sleep(50)
      }
      for (let attempt = 0; attempt < 50; attempt++) {
        const models = (await client.model.list({ location })).data
        if (models.some((model) => model.id === "fixture-model" && model.providerID === provider && model.settings?.api === api)) break
        if (attempt === 49) throw new Error("configured model route did not refresh")
        await Bun.sleep(50)
      }

      const generated = await client.generate.text({ location, prompt: "Say ready", model: { providerID: provider, id: "fixture-model" } })
      expect(generated.text).toBe(api === "chat" ? "Chat ready" : "Responses ready")
      expect(requests).toContainEqual({ path: api === "chat" ? "/v1/chat/completions" : "/v1/responses", authorization: `Bearer ${key}` })
    }
  } finally {
    try {
      await server?.close()
    } finally {
      await endpoint.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }
}, 60_000)

async function startServer(options: { configDir: string; directory: string; database: string }) {
  const port = await availablePort()
  const scope = await Effect.runPromise(Scope.make())
  const logger = Logger.map(Logger.formatStructured, () => {})
  const startingRaw = ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port,
    password: "test-password",
    database: { path: options.database },
    config: { directory: options.configDir, project: false, content: "{}" },
    fs: { filewatcher: true, fff: false },
  }).pipe(Effect.provideService(Scope.Scope, scope))
  // Runtime-owned request markers are supplied when the assembled router dispatches.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
  await Effect.runPromise(starting.pipe(Effect.provide(Logger.layer([logger]))))
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve endpoint integration test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
