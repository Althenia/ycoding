import { expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmbeddedRoutes } from "../src/routes"

test("provider refresh picks up a project config file created after the location booted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-provider-refresh-"))
  const directory = join(root, "workspace")
  await Promise.all([mkdir(directory), mkdir(join(root, "config"))])
  const handler = HttpRouter.toWebHandler(
    createEmbeddedRoutes({
      database: { path: join(root, "ycoding.db") },
      config: { directory: join(root, "config") },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(Layer.provide(NodeHttpServer.layerHttpServices)),
  )
  const query = `location[directory]=${encodeURIComponent(directory)}`
  const models = async () => {
    const response = await handler.handler(new Request(`http://localhost/api/model?${query}`), Context.empty())
    expect(response.status).toBe(200)
    const body: { data: Array<{ providerID: string; id: string }> } = await response.json()
    return body.data.map((model) => `${model.providerID}/${model.id}`)
  }

  try {
    expect(await models()).not.toContain("fixture/fixture-model")
    await writeFile(
      join(directory, "ycoding.json"),
      JSON.stringify({
        providers: {
          fixture: {
            name: "Fixture",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-key" },
            models: { "fixture-model": {} },
          },
        },
      }),
    )
    expect(await models()).not.toContain("fixture/fixture-model")

    const refreshed = await handler.handler(
      new Request(`http://localhost/api/provider/refresh?${query}`, { method: "POST" }),
      Context.empty(),
    )
    expect(refreshed.status).toBe(204)

    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await models()).includes("fixture/fixture-model")) break
      if (attempt === 99) throw new Error("refreshed provider model was not listed")
      await Bun.sleep(50)
    }
  } finally {
    await handler.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
