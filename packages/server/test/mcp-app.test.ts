import { expect, test } from "bun:test"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { McpHandler } from "../src/handlers/mcp"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { SessionLocationMiddleware } from "../src/middleware/session-location"

test("MCP App HTTP reads only a unique completed call in the requested Session", async () => {
  const id = Session.ID.make("ses_app_http")
  const decode = Schema.decodeUnknownSync(Schema.toCodecJson(SessionMessage.Info))
  const result = { resourceUri: "ui://fixture/result", html: "<p>Result</p>", tool: "report", input: {}, output: {} }
  const location = Context.makeUnsafe<LocationServices>(new Map())
  let parts: unknown[] = []
  let reads = 0
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.mcp"])).pipe(
    Layer.provide(McpHandler.pipe(Layer.provide(Layer.mergeAll(
      Layer.mock(Session.Service, {
        daybreak: { set: () => Effect.die("unused") },
        autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused"), effective: () => Effect.die("unused") },
        revert: { stage: () => Effect.die("unused"), clear: () => Effect.die("unused"), commit: () => Effect.die("unused") },
        get: () => Effect.succeed(Schema.decodeUnknownSync(Schema.toCodecJson(Session.Info))({
          id, projectID: "global", scope: "bound", title: "Report", cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 }, location: { directory: "/project" },
        })),
        message: ({ sessionID, messageID }) => Effect.succeed(sessionID === id && messageID === "msg_app_http" ? decode({
          id: messageID, type: "assistant", agent: "build", model: { id: "fixture", providerID: "fixture" },
          content: parts, time: { created: 1 },
        }) : undefined),
      }),
      Layer.mock(MCP.Service, { appView: () => Effect.sync(() => { reads++; return result }) }),
      Layer.succeed(LocationMiddleware, () => Effect.die("An App view must use the Session placement")),
      Layer.succeed(SessionLocationMiddleware, (effect) => Effect.provide(effect, location)),
      Layer.succeed(Authorization, (effect) => effect),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )))),
    Layer.provide(HttpServer.layerServices),
  ))
  const request = (sessionID: string = id, callID = "call_report") =>
    handler.handler(new Request(`http://localhost/api/session/${sessionID}/mcp/app?messageID=msg_app_http&callID=${callID}`), Context.empty())
  const tool = { type: "tool", id: "call_report", name: "report", time: { created: 1 }, state: { input: {}, content: [], structured: {} } }
  const completed = { ...tool, state: { ...tool.state, status: "completed" } }
  try {
    parts = [{ ...tool, state: { ...tool.state, status: "running" } }]
    expect(await (await request()).json()).toEqual({})
    parts = [completed, completed]
    expect(await (await request()).json()).toEqual({})
    parts = [completed]
    expect(await (await request(id, "call_other")).json()).toEqual({})
    expect(await (await request("ses_other")).json()).toEqual({})
    expect(reads).toBe(0)
    expect(await (await request()).json()).toEqual({ data: result })
    expect(reads).toBe(1)
  } finally {
    await handler.dispose()
  }
})
