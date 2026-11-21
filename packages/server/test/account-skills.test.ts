import { expect, test } from "bun:test"
import { AccountConnectors } from "@ycoding-ai/core/account-connectors"
import type { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Agent } from "@ycoding-ai/core/agent"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Session } from "@ycoding-ai/core/session"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { WellKnown } from "@ycoding-ai/core/wellknown"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { IntegrationHandler } from "../src/handlers/integration"
import { layer as locationLayer } from "../src/location"

const directory = AbsolutePath.make("/synthetic/skills")
const sessionID = Session.ID.make("ses_http_skills")
const agentID = Agent.ID.make("fixture-agent")
const session = Schema.decodeUnknownSync(Session.Info)({
  id: sessionID,
  projectID: "global",
  agent: agentID,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: "Synthetic",
  time: { created: 0, updated: 0 },
  location: { directory },
})

test("account skills HTTP preserves canonical provenance, proof and refusal kinds", async () => {
  const calls: Parameters<AccountConnectors.Interface["skillsRead"]>[0][] = []
  let target = session
  let fail: string | undefined
  let details = 0
  const requests: { ref: Location.Ref; nodes: LocationServiceMap.Nodes }[] = []
  const sessionReads: Session.ID[] = []
  const sessions = Layer.mock(Session.Service, {
    daybreak: { set: () => Effect.die("Unexpected daybreak update") },
    autonomy: {
      get: () => Effect.die("Unexpected autonomy read"),
      set: () => Effect.die("Unexpected autonomy update"),
      effective: () => Effect.die("Unexpected autonomy resolution"),
    },
    revert: {
      stage: () => Effect.die("Unexpected revert stage"),
      clear: () => Effect.die("Unexpected revert clear"),
      commit: () => Effect.die("Unexpected revert commit"),
    },
    get: (id) => {
      sessionReads.push(id)
      return fail === "missing-session" ? Effect.fail(new Session.NotFoundError({ sessionID })) : Effect.succeed(target)
    },
  })
  const connectors = Layer.mock(AccountConnectors.Service, {
    skillsRead: (input) => {
      calls.push(input)
      if (fail === "configuration") return Effect.fail(new Error("Synthetic configuration error"))
      return Effect.succeed({
        list: () =>
          fail === "permission"
            ? Effect.fail(new Error("Permission denied"))
            : Effect.succeed({
                status: 200,
                keys: ["hazelnuts"],
                count: 1,
                hasNext: false,
                paginationKeys: [],
                ids: ["skill-fixture"],
              }),
        detail: () => {
          details++
          return fail === "detail"
            ? Effect.fail(new Error("Synthetic detail error"))
            : Effect.succeed({ status: 200, keys: ["id"] })
        },
      })
    },
  })
  const locations = Layer.mock(LocationServiceMap.Service, {
    get: <const Items extends LocationServiceMap.Nodes>(ref: Location.Ref, nodes: Items) => {
      requests.push({ ref, nodes })
      const selected = Layer.mergeAll(
        nodes.includes(LocationServiceMap.full)
          ? Layer.succeed(Location.Service, { directory, project: { id: session.projectID, directory } })
          : Layer.empty,
        nodes.includes(AccountConnectors.node) ? connectors : Layer.empty,
      )
      return Layer.unwrap(
        Layer.build(selected).pipe(
          Effect.map((context) =>
            Layer.succeedContext(Context.makeUnsafe<LayerNode.Output<Items[number]>>(context.mapUnsafe)),
          ),
        ),
      )
    },
  })
  const runtime = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.integration"])).pipe(
      Layer.provide(IntegrationHandler.pipe(Layer.provide(Layer.mergeAll(sessions, locations)))),
      Layer.provide(
        Layer.mergeAll(
          locationLayer.pipe(Layer.provide(locations)),
          Layer.succeed(Authorization, (effect) => effect),
          Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
      Layer.provideMerge(
        Layer.mock(WellKnown.Service, {
          snapshot: () => {
            throw new Error("Unexpected well-known snapshot")
          },
        }),
      ),
    ),
  )
  const request = (query = `sessionID=${sessionID}`, integrationID = "openai") =>
    runtime.handler(
      new Request(`http://localhost/api/integration/${integrationID}/account-skills?${query}`, {
        headers: { "x-ycoding-directory": encodeURIComponent(directory) },
      }),
      Context.empty(),
    )
  const refusal = async (query: string, kind: string, integrationID = "openai") => {
    const response = await request(query, integrationID)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ kind })
  }
  try {
    const result = await request(`sessionID=${sessionID}&profile=fixture-profile`)
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      data: { status: 200, keys: ["hazelnuts"], count: 1, hasNext: false, detail: { status: 200, keys: ["id"] } },
    })
    expect(calls).toEqual([{ profile: "fixture-profile", permission: { sessionID, agent: agentID } }])
    const ref = Location.Ref.make({ directory, workspaceID: undefined })
    expect(requests).toEqual([
      { ref, nodes: [LocationServiceMap.full] },
      { ref, nodes: [AccountConnectors.node] },
    ])
    expect(sessionReads).toEqual([sessionID])
    await refusal("", "missing_provenance")
    await refusal(`sessionID=${sessionID}`, "unsupported_integration", "other")
    await refusal(`sessionID=${sessionID}&agent=other-agent`, "agent_mismatch")
    target = { ...session, location: { directory: AbsolutePath.make("/synthetic/elsewhere") } }
    await refusal(`sessionID=${sessionID}`, "cross_location_session")
    target = { ...session, agent: undefined }
    await refusal(`sessionID=${sessionID}`, "missing_session_agent")
    target = session
    expect(calls).toHaveLength(1)
    fail = "missing-session"
    await refusal(`sessionID=${sessionID}`, "session_not_found")
    fail = undefined
    const priorDetails = details
    await refusal(`sessionID=${sessionID}&id=not-listed`, "unlisted_skill_id")
    expect(details).toBe(priorDetails)
    for (const [failure, kind] of [
      ["configuration", "account_skills_configuration"],
      ["permission", "permission_denied"],
      ["detail", "account_skills_read"],
    ]) {
      fail = failure
      await refusal(`sessionID=${sessionID}`, kind!)
    }
  } finally {
    await runtime.dispose()
  }
})
