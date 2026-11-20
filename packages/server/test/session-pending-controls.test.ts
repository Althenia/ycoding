import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter } from "effect/unstable/http"
import { Session } from "@ycoding-ai/core/session"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { createRoutes } from "../src/routes"

let root: string
let sessionID: Session.ID | undefined
let sessions: Session.Interface | undefined

const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from("ycoding:fixture").toString("base64")}`,
}

const call = (method: string, path: string, body?: unknown) =>
  handler.handler(
    new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    Context.empty(),
  )

const admitQueued = async (id: string) => {
  const response = await call("POST", `/api/session/${sessionID}/prompt`, { id, text: "synthetic draft", delivery: "queue", resume: false })
  expect(response.status).toBe(200)
}

const pendingIDs = async () =>
  ((await (await call("GET", `/api/session/${sessionID}/pending`)).json()).data as { id: string }[]).map((entry) => entry.id)

function createHandler(directory: string) {
  return HttpRouter.toWebHandler(
    createRoutes({
      password: "fixture",
      database: { path: join(root, "session.db") },
      config: { directory: join(root, "config"), project: false },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    }).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          sessions = Context.get(context, Session.Service)
          sessionID = (yield* sessions.create({ location: { directory: AbsolutePath.make(directory) }, title: "Synthetic" })).id
        }),
      ),
    ),
  )
}

let handler: ReturnType<typeof createHandler>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ycoding-pending-controls-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  handler = createHandler(directory)
  await handler.handler(new Request("http://localhost/api/session", { headers }), Context.empty())
}, 30_000)

afterAll(async () => {
  await handler.dispose()
  await rm(root, { recursive: true, force: true })
})

describe("pending input controls over HTTP", () => {
  test("DELETE withdraws a pending user input and answers 204", async () => {
    await admitQueued("msg_http_withdraw")
    expect(await pendingIDs()).toContain("msg_http_withdraw")

    const response = await call("DELETE", `/api/session/${sessionID}/pending/msg_http_withdraw`)

    expect(response.status).toBe(204)
    expect(await pendingIDs()).not.toContain("msg_http_withdraw")
  })

  test("DELETE and POST steer answer 404 PendingInputNotFoundError for a withdrawn or unknown input", async () => {
    for (const [method, suffix] of [["DELETE", ""], ["POST", "/steer"]] as const) {
      const response = await call(method, `/api/session/${sessionID}/pending/msg_http_withdraw${suffix}`)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ _tag: "PendingInputNotFoundError", messageID: "msg_http_withdraw" })
    }
  })

  test("both operations answer 404 SessionNotFoundError for an unknown Session", async () => {
    for (const [method, suffix] of [["DELETE", ""], ["POST", "/steer"]] as const) {
      const response = await call(method, `/api/session/ses_http_missing/pending/msg_any${suffix}`)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError" })
    }
  })

  test("both operations answer 400 InvalidRequestError for synthetic pending work, which stays pending", async () => {
    const synthetic = await Effect.runPromise(
      sessions!.synthetic({ sessionID: sessionID!, text: "synthetic notice", delivery: "queue", resume: false }),
    )
    for (const [method, suffix] of [["DELETE", ""], ["POST", "/steer"]] as const) {
      const response = await call(method, `/api/session/${sessionID}/pending/${synthetic.id}${suffix}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ _tag: "InvalidRequestError", kind: "pending_input_not_user" })
    }
    expect(await pendingIDs()).toContain(synthetic.id)
  })

  test("POST steer answers 204 for a queued input", async () => {
    await admitQueued("msg_http_steer")

    const response = await call("POST", `/api/session/${sessionID}/pending/msg_http_steer/steer`)

    expect(response.status).toBe(204)
    const entry = ((await (await call("GET", `/api/session/${sessionID}/pending`)).json()).data as { id: string; delivery: string }[]).find(
      (item) => item.id === "msg_http_steer",
    )
    expect(entry === undefined || entry.delivery === "steer").toBe(true)
  })
})
