import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter } from "effect/unstable/http"
import { Session } from "@ycoding-ai/core/session"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { createRoutes } from "../src/routes"

test("the typed prompt handler admits ordinary input without legacy remote authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-remote-prompt-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  const source = { requestID: "request_fixture", epoch: "epoch_fixture", principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" } }
  let sessionID: Session.ID | undefined
  const handler = HttpRouter.toWebHandler(createRoutes({
    password: "fixture", database: { path: join(root, "session.db") },
    config: { directory: join(root, "config"), project: false },
    models: { fetch: false }, fs: { filewatcher: false, fff: false },
  }).pipe(
    Layer.provide(NodeHttpServer.layerHttpServices),
    Layer.tap((context) => Effect.gen(function* () {
      sessionID = (yield* Context.get(context, Session.Service).create({ location: { directory: AbsolutePath.make(directory) }, title: "Synthetic" })).id
    })),
  ))
  const headers = { "content-type": "application/json", authorization: `Basic ${Buffer.from("ycoding:fixture").toString("base64")}` }
  const prompt = (body: unknown) => handler.handler(new Request(`http://localhost/api/session/${sessionID}/prompt`, { method: "POST", headers, body: JSON.stringify(body) }), Context.empty())
  try {
    await handler.handler(new Request("http://localhost/api/session", { headers }), Context.empty())
    expect(sessionID).toBeDefined()
    const native = await prompt({ id: "msg_native_source", text: "Native message", resume: false, metadata: { remoteMcp: source } })
    expect(native.status).toBe(200)
    expect((await native.json()).data.data.metadata).toEqual({ inputOrigin: "direct" })
    const remote = await prompt({ id: "msg_remote_source", text: "External message", resume: false, remoteSource: source, metadata: { inputOrigin: "human" } })
    expect(remote.status).toBe(400)
    const forged = await prompt({ id: "msg_forged_source", text: "No admission", resume: false, remoteSource: { ...source, principal: { ...source.principal, clientID: "forged" } } })
    expect(forged.status).toBe(400)
    const pending = await handler.handler(new Request(`http://localhost/api/session/${sessionID}/pending`, { headers }), Context.empty())
    expect(pending.status).toBe(200)
    expect((await pending.json()).data.map((item: { id: string }) => item.id)).toEqual(["msg_native_source"])
  } finally {
    await handler.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
