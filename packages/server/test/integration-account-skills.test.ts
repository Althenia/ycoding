import { describe, expect, test } from "bun:test"
import { EOL } from "node:os"
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
import { AccountConnectors } from "@ycoding-ai/core/account-connectors"
import { Agent } from "@ycoding-ai/core/agent"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Credential } from "@ycoding-ai/core/credential"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { Permission } from "@ycoding-ai/core/permission"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Workspace } from "@ycoding-ai/core/workspace"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer, Option, Redacted, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { location } from "../../core/test/fixture/location"
import { Api } from "../src/api"
import { ServerAuth } from "../src/auth"
import { IntegrationHandler } from "../src/handlers/integration"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { authorizationLayer } from "../src/middleware/authorization"

const directory = "/synthetic-test-location"
const otherDirectory = "/synthetic-other-location"
const locationInfo = location({ directory: AbsolutePath.make(directory) })
const integrationID = Integration.ID.make("openai")
const methodID = Integration.MethodID.make("chatgpt-browser")
const validSessionID = SessionSchema.ID.make("ses_valid_test")
const otherSessionID = SessionSchema.ID.make("ses_cross_location")
const crossWorkspaceSessionID = SessionSchema.ID.make("ses_cross_workspace")
const missingAgentSessionID = SessionSchema.ID.make("ses_missing_agent")
const agentID = Agent.ID.make("build")

const privateListSentinel = "private_sentinel_list_secret_must_not_leak"
const privateDetailSentinel = "private_sentinel_detail_secret_must_not_leak"
const privateErrorSentinel = "private_sentinel_error_secret_must_not_leak"
const privateCursorSentinel = "private_sentinel_cursor_must_not_leak"
const returnedSkillID = "skill_real_id_456"

function createIntegrationProfile() {
  const credentialsMap = new Map<string, Credential.Value>()
  const connection = {
    id: Credential.ID.make("cred_lostq901"),
    label: "lostq901",
    type: "credential" as const,
    active: true,
  }
  const credentialValue = Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: "test-chatgpt-oauth-access-token",
    refresh: "test-refresh-token",
    expires: Date.now() + 3_600_000,
    metadata: { accountID: "account-lostq901" },
  })
  credentialsMap.set(connection.id, credentialValue)

  const integrations: Pick<Integration.Interface, "get" | "connection"> = {
    get: (id) =>
      Effect.succeed(
        id === integrationID
          ? {
              id: integrationID,
              name: "OpenAI",
              connections: [connection],
              methods: [],
            }
          : undefined,
      ),
    connection: {
      snapshot: (conn: { id: Credential.ID; label: string; active: boolean }) =>
        Effect.succeed({
          connection: conn,
          credential: {
            id: conn.id,
            integrationID,
            label: conn.label,
            accountGeneration: 1,
            active: true,
          },
          value: credentialsMap.get(conn.id),
        }),
    } as unknown as Integration.Interface["connection"],
  }
  return { integrations, connection, credentialValue }
}

function createHarness(options: {
  fetchSpy: FetchLike
  permissionAssert?: (input: Permission.AssertInput) => Effect.Effect<void, Error>
  settings?: { enabled: boolean; profile?: string }
  serverPassword?: string
  sessions?: Map<
    string,
    { id: SessionSchema.ID; location: { directory: string; workspaceID?: string }; agent?: Agent.ID }
  >
}) {
  const { integrations, connection } = createIntegrationProfile()
  const assertions: Permission.AssertInput[] = []
  const permissionService = {
    assert: (input: Permission.AssertInput) => {
      assertions.push(input)
      if (options.permissionAssert) return options.permissionAssert(input)
      return Effect.void
    },
  } as unknown as Pick<Permission.Interface, "assert">

  const connectors = AccountConnectors.make({
    attachments: AttachmentStore.make("/synthetic-attachments"),
    integration: integrations,
    permission: permissionService,
    guardrail: { assert: () => Effect.succeed({ release: Effect.void }) },
    settings: () => Effect.succeed(options.settings ?? { enabled: true, profile: "lostq901" }),
    directory,
    fetch: options.fetchSpy,
  })

  const sessionStore =
    options.sessions ??
    new Map([
      [validSessionID, { id: validSessionID, location: { directory }, agent: agentID }],
      [otherSessionID, { id: otherSessionID, location: { directory: otherDirectory }, agent: agentID }],
      [crossWorkspaceSessionID, { id: crossWorkspaceSessionID, location: { directory, workspaceID: "wrk_foreign" }, agent: agentID }],
      [missingAgentSessionID, { id: missingAgentSessionID, location: { directory }, agent: undefined }],
    ])

  const sessionService = Session.Service.of({
    get: (id: Session.ID) => {
      const found = sessionStore.get(id as SessionSchema.ID)
      if (!found) return Effect.fail(new Session.NotFoundError({ sessionID: id as SessionSchema.ID }))
      return Effect.succeed({
        id: found.id,
        location: {
          directory: AbsolutePath.make(found.location.directory),
          workspaceID: found.location.workspaceID ? Workspace.ID.make(found.location.workspaceID) : undefined,
        },
        agent: found.agent,
      } as unknown as Session.Info)
    },
    list: () => Effect.succeed({ data: [], cursor: undefined }),
  } as unknown as Session.Interface)

  const locationLayer = Layer.succeed(Location.Service, Location.Service.of(locationInfo))
  const connectorsLayer = Layer.succeed(AccountConnectors.Service, connectors)
  const sessionLayer = Layer.succeed(Session.Service, sessionService)
  const locationServicesLayer = Layer.mergeAll(locationLayer, connectorsLayer, sessionLayer)

  const authConfigLayer = options.serverPassword
    ? ServerAuth.Config.configLayer({ password: Option.some(options.serverPassword) })
    : ServerAuth.Config.layer

  return {
    assertions,
    connection,
    buildHandler: Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const locationContext = yield* Layer.buildWithScope(locationServicesLayer, scope)

      const handler = HttpRouter.toWebHandler(
        HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.integration"])).pipe(
          Layer.provide(IntegrationHandler),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeedContext(locationContext),
              Layer.succeed(
                LocationMiddleware,
                (effect) => Effect.provide(effect, Context.makeUnsafe<LocationServices>(locationContext.mapUnsafe)),
              ),
              authorizationLayer,
              Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
            ),
          ),
          Layer.provide(authConfigLayer),
          Layer.provide(HttpServer.layerServices),
        ),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()))
      return handler
    }),
  }
}

describe("GET /api/integration/:integrationID/account-skills - boundary behavior", () => {
  const dispatch = (handler: { handler: (req: Request, ctx?: any) => Promise<Response> }, req: Request) =>
    handler.handler(req, Context.empty())

  test("success path: dispatches fixed upstream list and detail, proving privacy sentinels never leak", async () => {
    const upstreamRequests: Array<{ url: string; method: string; headers: Headers }> = []
    const fetchSpy: FetchLike = async (input, init) => {
      const req = new Request(input.toString(), init)
      upstreamRequests.push({ url: req.url, method: req.method, headers: req.headers })
      if (req.url.includes("/hazelnuts?")) {
        return Response.json({
          hazelnuts: [
            {
              id: returnedSkillID,
              name: "synthetic-skill",
              secret_instructions: privateListSentinel,
            },
          ],
          next_cursor: privateCursorSentinel,
        })
      }
      return Response.json({
        id: returnedSkillID,
        name: "synthetic-skill",
        sediment_id: privateDetailSentinel,
        permissions: { can_read: true },
      })
    }

    const harness = createHarness({ fetchSpy })
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}&profile=lostq901`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(200)

        const rawBody = yield* Effect.promise(() => response.text())
        const parsed = JSON.parse(rawBody) as {
          location: unknown
          data: {
            status: number
            keys: string[]
            count: number
            hasNext: boolean
            paginationKeys: string[]
            detail?: { status: number; keys: string[] }
          }
        }

        expect(upstreamRequests).toHaveLength(2)
        expect(upstreamRequests[0]?.url).toBe(
          "https://chatgpt.com/backend-api/hazelnuts?scope=installed&include_permissions=true",
        )
        expect(upstreamRequests[0]?.headers.get("authorization")).toBe("Bearer test-chatgpt-oauth-access-token")
        expect(upstreamRequests[0]?.headers.get("ChatGPT-Account-Id")).toBe("account-lostq901")
        expect(upstreamRequests[1]?.url).toBe(
          `https://chatgpt.com/backend-api/hazelnuts/${returnedSkillID}?include_permissions=true`,
        )

        expect(harness.assertions).toHaveLength(2)
        expect(harness.assertions[0]).toMatchObject({
          action: "chatgpt_account_skills_read",
          sessionID: validSessionID,
          agent: agentID,
          resources: [harness.connection.id],
          metadata: { profile: "lostq901", accountID: "account-lostq901" },
        })
        expect(harness.assertions[0]?.source).toBeUndefined()

        expect(parsed.data.status).toBe(200)
        expect(parsed.data.count).toBe(1)
        expect(parsed.data.hasNext).toBe(true)
        expect(parsed.data.paginationKeys).toEqual(["next_cursor"])
        expect(parsed.data.detail?.status).toBe(200)

        expect(rawBody).not.toContain(privateListSentinel)
        expect(rawBody).not.toContain(privateDetailSentinel)
        expect(rawBody).not.toContain(privateCursorSentinel)
        expect(rawBody).not.toContain(returnedSkillID)
        expect(rawBody).not.toContain("test-chatgpt-oauth-access-token")
      }).pipe(Effect.scoped),
    )
  })

  test("missing provenance: fails closed with 400 before any upstream fetch", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({ fetchSpy })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = "http://localhost/api/integration/openai/account-skills?profile=lostq901"
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("Session provenance is required")
      }).pipe(Effect.scoped),
    )
  })

  test("unknown session: fails closed with 400 before any upstream fetch", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({ fetchSpy })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const unknownID = SessionSchema.ID.make("ses_unknown_12345")
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${unknownID}`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("Session not found")
      }).pipe(Effect.scoped),
    )
  })

  test("cross-location session: fails closed with 400 before any upstream fetch", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({ fetchSpy })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${otherSessionID}`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("Session does not belong to the requested location")
      }).pipe(Effect.scoped),
    )
  })

  test("cross-workspace session: fails closed with 400 when session has a different workspaceID", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({ fetchSpy })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${crossWorkspaceSessionID}`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("Session does not belong to the requested location")
      }).pipe(Effect.scoped),
    )
  })

  test("missing agent: fails closed with 400 when session has no configured agent", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({ fetchSpy })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${missingAgentSessionID}`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("Session has no configured agent")
      }).pipe(Effect.scoped),
    )
  })

  test("agent mismatch: fails closed with 400 before any upstream fetch", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({ fetchSpy })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}&agent=plan`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("Agent does not match session agent")
      }).pipe(Effect.scoped),
    )
  })

  test("unlisted skill ID: fails closed with 400 when query ID was not returned by list and performs no detail fetch", async () => {
    const upstreamRequests: Array<{ url: string }> = []
    const fetchSpy: FetchLike = async (input, init) => {
      const req = new Request(input.toString(), init)
      upstreamRequests.push({ url: req.url })
      return Response.json({
        hazelnuts: [{ id: "skill_only_listed_1" }],
      })
    }
    const harness = createHarness({ fetchSpy })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}&id=skill_unlisted_999`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(1)
        expect(upstreamRequests[0]?.url).toContain("/hazelnuts?scope=installed")
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("Requested skill ID was not returned")
      }).pipe(Effect.scoped),
    )
  })

  test("omitted-config profile plus alternate input profile: fails closed with 400 before dispatch", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({
      fetchSpy,
      settings: { enabled: true },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}&profile=alternate-unconfigured-profile`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("conflicts")
      }).pipe(Effect.scoped),
    )
  })

  test("LocationServiceMap.full composition: normal location service map resolves AccountConnectors.Service with skillsRead", async () => {
    const { AccountConnectors } = await import("@ycoding-ai/core/account-connectors")
    const { LocationServiceMap } = await import("@ycoding-ai/core/location-service-map")
    const { buildLocationServiceMap } = await import("@ycoding-ai/core/location-services")
    const { Config } = await import("@ycoding-ai/core/config")
    const { SessionGuardrail } = await import("@ycoding-ai/core/session/guardrail")
    const { AttachmentStore } = await import("@ycoding-ai/core/attachment-store")

    const { integrations } = createIntegrationProfile()
    const assertions: Permission.AssertInput[] = []
    const permissionService = {
      assert: (input: Permission.AssertInput) => {
        assertions.push(input)
        return Effect.void
      },
    } as unknown as Pick<Permission.Interface, "assert">

    const fakeConfig = {
      entries: () =>
        Effect.succeed([
          {
            type: "document" as const,
            scope: "global" as const,
            path: "/synthetic/ycoding.json",
            info: { account_connectors: { chatgpt: { enabled: true, profile: "lostq901" } } },
          },
        ]),
    }

    const replacements: LayerNode.Replacements = [
      [Integration.node, Layer.succeed(Integration.Service, integrations as any)],
      [Config.node, Layer.succeed(Config.Service, fakeConfig as any)],
      [Permission.node, Layer.succeed(Permission.Service, permissionService as any)],
      [SessionGuardrail.node, Layer.succeed(SessionGuardrail.Service, { assert: () => Effect.succeed({ release: Effect.void }) } as any)],
      [AttachmentStore.node, Layer.succeed(AttachmentStore.Service, AttachmentStore.make("/tmp/synth-attach"))],
    ]

    const layer = buildLocationServiceMap(replacements)

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return Response.json({
        hazelnuts: [{ id: "skill_synthetic_123" }],
        has_more: false,
      })
    }) as any

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const located = locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }), [LocationServiceMap.full])
          const connectors = yield* AccountConnectors.Service.pipe(Effect.provide(located))
          expect(typeof connectors.skillsRead).toBe("function")
          const read = yield* connectors.skillsRead({ profile: "lostq901", permission: { sessionID: validSessionID, agent: agentID } })
          const list = yield* read.list()
          expect(list.status).toBe(200)
          expect(list.count).toBe(1)
          expect(list.ids).toEqual(["skill_synthetic_123"])
          expect(assertions).toHaveLength(1)
          expect(assertions[0]?.action).toBe("chatgpt_account_skills_read")
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("real permission denial: asserts permission before network and prevents dispatch", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({
      fetchSpy,
      permissionAssert: (input) =>
        Effect.fail(new Permission.BlockedError({ rules: [{ action: input.action, resource: "*", effect: "deny" }], permission: input.action, resources: input.resources })),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}&profile=lostq901`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        expect(harness.assertions).toHaveLength(1)
        expect(harness.assertions[0]?.action).toBe("chatgpt_account_skills_read")
        expect(harness.assertions[0]?.sessionID).toBe(validSessionID)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("Permission denied")
      }).pipe(Effect.scoped),
    )
  })

  test("config disabled: fails closed with 400 before any upstream fetch", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({
      fetchSpy,
      settings: { enabled: false },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("disabled by configuration")
      }).pipe(Effect.scoped),
    )
  })

  test("profile conflict: fails closed with 400 before any upstream fetch", async () => {
    const upstreamRequests: unknown[] = []
    const fetchSpy: FetchLike = async () => {
      upstreamRequests.push(1)
      return Response.json({})
    }
    const harness = createHarness({
      fetchSpy,
      settings: { enabled: true, profile: "different-profile" },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}&profile=lostq901`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        expect(upstreamRequests).toHaveLength(0)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("conflicts")
      }).pipe(Effect.scoped),
    )
  })

  test("upstream HTTP 401/403 rejection sanitization: status 400 with no leaked error body", async () => {
    const fetchSpy: FetchLike = async () =>
      new Response(`Sensitive auth failure: ${privateErrorSentinel} for user secret@example.com with Bearer leaked-key`, {
        status: 401,
      })

    const harness = createHarness({ fetchSpy })
    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}&profile=lostq901`
        const response = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(response.status).toBe(400)
        const text = yield* Effect.promise(() => response.text())
        expect(text).toContain("401")
        expect(text).not.toContain(privateErrorSentinel)
        expect(text).not.toContain("secret@example.com")
        expect(text).not.toContain("leaked-key")
        expect(text).not.toContain("Bearer")
      }).pipe(Effect.scoped),
    )
  })

  test("authorization middleware: enforces HTTP Basic auth and rejects unauthorized requests", async () => {
    const fetchSpy: FetchLike = async () => Response.json({ hazelnuts: [] })
    const harness = createHarness({ fetchSpy, serverPassword: "valid-server-secret" })

    await Effect.runPromise(
      Effect.gen(function* () {
        const handler = yield* harness.buildHandler
        const url = `http://localhost/api/integration/openai/account-skills?sessionID=${validSessionID}`

        const unauthed = yield* Effect.promise(() => dispatch(handler, new Request(url)))
        expect(unauthed.status).toBe(401)
        expect(unauthed.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')

        const wrongAuth = yield* Effect.promise(() =>
          dispatch(handler,
            new Request(url, {
              headers: { authorization: `Basic ${Buffer.from("ycoding:wrong-password").toString("base64")}` },
            }),
          ),
        )
        expect(wrongAuth.status).toBe(401)

        const authed = yield* Effect.promise(() =>
          dispatch(handler,
            new Request(url, {
              headers: { authorization: `Basic ${Buffer.from("ycoding:valid-server-secret").toString("base64")}` },
            }),
          ),
        )
        expect(authed.status).toBe(200)
      }).pipe(Effect.scoped),
    )
  })
})
