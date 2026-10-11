import { expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmbeddedRoutes } from "../src/routes"

type Page = { data: Array<{ directory: string; projectID: string; sessions: number }>; cursor: { next?: string } }

test("pages the directory inventory and forgets a directory through the real Server and Core graph", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ycoding-project-inventory-")))
  const first = join(root, "first")
  const second = join(root, "second")
  await Promise.all([mkdir(first), mkdir(second), mkdir(join(root, "config"))])
  const handler = HttpRouter.toWebHandler(
    createEmbeddedRoutes({
      database: { path: join(root, "ycoding.db") },
      config: { directory: join(root, "config"), project: false },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          const session = Context.get(context, Session.Service)
          yield* session.create({ location: Location.Ref.make({ directory: AbsolutePath.make(first) }) })
          yield* session.create({ location: Location.Ref.make({ directory: AbsolutePath.make(first) }) })
          yield* session.create({ location: Location.Ref.make({ directory: AbsolutePath.make(second) }) })
        }),
      ),
    ),
  )
  const request = (path: string, init?: RequestInit) =>
    handler.handler(new Request(`http://localhost${path}`, init), Context.empty())
  const page = async (query: string) => {
    const response = await request(`/api/project/inventory?${query}`)
    expect(response.status).toBe(200)
    const body: Page = await response.json()
    return body
  }

  try {
    const one = await page("limit=1")
    expect(one.data.map((entry) => [entry.directory, entry.sessions])).toEqual([[first, 2]])
    expect(one.cursor.next).toBeString()
    const two = await page(`limit=1&cursor=${encodeURIComponent(one.cursor.next ?? "")}`)
    expect(two.data.map((entry) => [entry.directory, entry.sessions])).toEqual([[second, 1]])
    expect(two.cursor.next).toBeUndefined()
    expect((await request("/api/project/inventory?cursor=not-a-cursor")).status).toBe(400)

    const forgotten = await request(`/api/project/${one.data[0]?.projectID}/directories`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: first }),
    })
    expect(forgotten.status).toBe(204)
    expect((await page("limit=50")).data.map((entry) => entry.directory)).toEqual([second])
    const sessions: { data: unknown[] } = await (
      await request(`/api/session?directory=${encodeURIComponent(first)}`)
    ).json()
    expect(sessions.data).toEqual([])
  } finally {
    await handler.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
