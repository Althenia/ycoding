import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Location } from "@ycoding-ai/schema/location"
import { Model } from "@ycoding-ai/schema/model"
import { Integration } from "@ycoding-ai/schema/integration"
import {
  create,
  encodeStrict,
  model_default_ResultSchema,
  model_default_Result_dataSchema,
  integration_get_ResultSchema,
  session_diagnostics_ResultSchema,
  ClearableStringSchema,
  Model_RefSchema,
  Model_VariantSchema,
  Model_Default_limitSchema,
  ProviderUsage_WindowSchema,
  Integration_OAuthMethodSchema,
  ProjectSchema,
  EmptySchema,
} from "@ycoding-ai/protocol/v5"
import { decodeDomain, encodeDomain } from "../src/v5/codec.js"
import { YCoding } from "../src/promise/index.js"
import { make } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const location = { directory: "/fixture", project: { id: "global", directory: "/fixture" } }
const wireLocation = {
  directory: { encoding: { case: "utf8" as const, value: "/fixture" } },
  project: {
    id: { encoding: { case: "utf8" as const, value: "global" } },
    directory: { encoding: { case: "utf8" as const, value: "/fixture" } },
  },
}

test("absent model.default matches UndefinedOr HTTP JSON instead of returning an empty object", async () => {
  const encoded = Schema.encodeUnknownSync(Location.response(Schema.UndefinedOr(Model.Default)))({
    location: Schema.decodeUnknownSync(Location.Info)(location),
    data: undefined,
  })
  const http = YCoding.make({
    baseUrl: "http://127.0.0.1:12345",
    fetch: Object.assign(async () => Response.json(encoded), { preconnect: fetch.preconnect }),
  })
  const expected = await http.model.default()
  expect<unknown>(expected).toEqual({ location })
  expect(Object.hasOwn(expected, "data")).toBe(false)
  expect(expected.data).toBeUndefined()
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: model_default_ResultSchema.typeName,
      payload: encodeStrict(
        model_default_ResultSchema,
        create(model_default_ResultSchema, { location: wireLocation, data: { kind: { case: "none", value: {} } } }),
      ),
    })
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    const actual = await client.model.default()
    expect(actual).toEqual(expected)
    expect(Object.hasOwn(actual, "data")).toBe(false)
    expect(actual.data).toBeUndefined()
  } finally {
    client.transport.close()
  }
})

for (const data of [undefined, { id: "fixture", name: "Fixture", methods: [], connections: [] }]) {
  test(`integration.get preserves the ${data === undefined ? "none" : "value"} branch and Location envelope`, async () => {
    const encoded = Schema.encodeUnknownSync(Location.response(Schema.UndefinedOr(Integration.Info)))({
      location: Schema.decodeUnknownSync(Location.Info)(location),
      data,
    })
    const http = YCoding.make({
      baseUrl: "http://127.0.0.1:12345",
      fetch: Object.assign(async () => Response.json(encoded), { preconnect: fetch.preconnect }),
    })
    const expected = await http.integration.get({ integrationID: "fixture" })
    expect<unknown>(expected).toEqual(data === undefined ? { location } : { location, data })
    const peer = new ScriptedPeer()
    peer.onRequest = (dispatch) =>
      peer.result(dispatch, {
        typeName: integration_get_ResultSchema.typeName,
        payload:
          data === undefined
            ? encodeStrict(
                integration_get_ResultSchema,
                create(integration_get_ResultSchema, {
                  location: wireLocation,
                  data: { kind: { case: "none", value: {} } },
                }),
              )
            : encodeDomain(integration_get_ResultSchema.typeName, { location, data }),
      })
    const client = make({
      endpoint: { url: "http://127.0.0.1:12345" },
      socket: () => {
        queueMicrotask(() => peer.socket.open())
        return peer.socket
      },
    })
    try {
      expect(await client.integration.get({ integrationID: "fixture" })).toEqual(expected)
    } finally {
      client.transport.close()
    }
  })
}

test("an omitted optional result-path field remains undefined like promise session.diagnostics", async () => {
  const http = YCoding.make({
    baseUrl: "http://127.0.0.1:12345",
    fetch: Object.assign(async () => Response.json({}), { preconnect: fetch.preconnect }),
  })
  expect(await http.session.diagnostics({ sessionID: "ses_fixture" })).toBeUndefined()
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, {
      typeName: session_diagnostics_ResultSchema.typeName,
      payload: encodeStrict(session_diagnostics_ResultSchema, create(session_diagnostics_ResultSchema)),
    })
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    expect(await client.session.diagnostics({ sessionID: "ses_fixture" })).toBeUndefined()
  } finally {
    client.transport.close()
  }
})

test("UndefinedOr none, NullOr clear and an ordinary empty message stay distinct", async () => {
  const encoded = Schema.encodeUnknownSync(Schema.Struct({ data: Schema.NullOr(Schema.String) }))({ data: null })
  expect(await Response.json(encoded).json()).toEqual({ data: null })
  expect(
    decodeDomain(
      ClearableStringSchema.typeName,
      encodeStrict(ClearableStringSchema, create(ClearableStringSchema, { state: { case: "clear", value: {} } })),
    ),
  ).toBeNull()
  expect(
    decodeDomain(
      model_default_Result_dataSchema.typeName,
      encodeStrict(
        model_default_Result_dataSchema,
        create(model_default_Result_dataSchema, { kind: { case: "none", value: {} } }),
      ),
    ),
  ).toBeUndefined()
  expect(decodeDomain(EmptySchema.typeName, encodeStrict(EmptySchema, create(EmptySchema)))).toEqual({})
})

test("optional result fields omit absence but preserve present empty, false, zero, enum and null values", () => {
  const cases = [
    {
      schema: Model_RefSchema,
      values: [
        { id: "fixture", providerID: "fixture" },
        { id: "fixture", providerID: "fixture", profile: "fixture", variant: "" },
      ],
    },
    {
      schema: Model_VariantSchema,
      values: [{ id: "fixture" }, { id: "fixture", headers: {}, settings: { null: null }, body: {} }],
    },
    {
      schema: Model_Default_limitSchema,
      values: [
        { context: 1, output: 1 },
        { context: 1, output: 1, input: 0 },
      ],
    },
    {
      schema: ProviderUsage_WindowSchema,
      values: [
        { id: "fixture", label: "Fixture", unit: "requests" },
        { id: "fixture", label: "Fixture", unit: "requests", used: 0, unlimited: false, resetAt: 0 },
      ],
    },
    {
      schema: Integration_OAuthMethodSchema,
      values: [
        { id: "fixture", type: "oauth", label: "Fixture" },
        { id: "fixture", type: "oauth", label: "Fixture", remote: false, prompts: [] },
      ],
    },
    {
      schema: ProjectSchema,
      values: [
        { id: "global", worktree: "/fixture", time: { created: 0, updated: 0 }, sandboxes: [] },
        {
          id: "global",
          worktree: "/fixture",
          time: { created: 0, updated: 0, initialized: 0 },
          sandboxes: [],
          vcs: "git",
          icon: {},
          commands: {},
        },
      ],
    },
  ]
  for (const { schema, values } of cases) {
    for (const value of values)
      expect(decodeDomain(schema.typeName, encodeDomain(schema.typeName, value))).toEqual(value)
  }
})
