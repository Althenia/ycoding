import { expect, test } from "bun:test"
import {
  operations,
  PeerRole,
  ScopeKind,
  MutationClass,
  Settlement,
  Paging,
  Streaming,
  schemas,
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  toBinary,
  Sensitivity,
  ScopeSchema,
} from "../src/v5/index.js"
import { messages } from "../src/generated/v5/contract.js"
import { Connection } from "../src/v5/connection/index.js"
import { send } from "./connection-fixtures.js"

const text = encodeLossless
const target = { scope: 1, path: text("/backend/ycoding.jsonc") }
const device = {
  deviceID: text("dev_1"),
  name: text("Test"),
  relayOrigin: text("https://relay.example"),
  enrolledAt: 0n,
  credentialState: 1,
}
const schemaFor = (name: string) => schemas.find((schema) => schema.typeName === `ycoding.v5.${name}`)!
const roundTrip = (name: string, value: Record<string, unknown>) => {
  const schema = schemaFor(name)
  const message = create(schema, value)
  const bytes = encodeStrict(schema, message)
  expect(decodeStrict(schema, bytes)).toEqual(message)
  expect(encodeStrict(schema, decodeStrict(schema, bytes))).toEqual(bytes)
  return bytes
}

test("M3/M4/M5/M10 have closed local-only completed mutation descriptors", () => {
  for (const [name, id, scope] of [
    ["provider.configure", 2060, ScopeKind.LOCATION],
    ["mcp.configure", 2061, ScopeKind.LOCATION],
    ["frontendPackage.resolve", 2062, ScopeKind.LOCATION],
    ["remote.enroll", 3053, ScopeKind.MACHINE],
  ] as const) {
    const descriptor = operations.find((operation) => operation.diagnosticName === name)
    expect(descriptor, name).toBeDefined()
    expect(descriptor!.operationId).toBe(id)
    expect(descriptor!.roles).toEqual([PeerRole.LOCAL_CLIENT])
    expect(descriptor!.scope).toBe(scope)
    expect(descriptor!.mutation).toBe(MutationClass.MUTATION)
    expect(descriptor!.settlement).toBe(Settlement.COMPLETED)
    expect(descriptor!.paging).toBe(Paging.UNPAGED)
    expect(descriptor!.streaming).toBe(Streaming.TYPED_BULK)
    expect(descriptor!.errorTypes).toContain("ycoding.v5.InvalidRequestError")
    expect(descriptor!.errorTypes).toContain("ycoding.v5.UnauthorizedError")
  }
})

test("M3/M4/M5/M10 descriptors declare exact closed errors and secret inputs", () => {
  const common = ["ServiceUnavailableError", "UnauthorizedError", "InvalidRequestError"]
  for (const [name, errors] of [
    ["provider.configure", ["ConfigurationWriteError", "ConfigurationPartialFailure", ...common]],
    ["mcp.configure", ["ConfigurationWriteError", "ConfigurationPartialFailure", ...common]],
    ["frontendPackage.resolve", ["FrontendPackageError", ...common]],
    ["remote.enroll", ["RemoteEnrollmentError", "RemoteEnrollmentPartialFailure", ...common]],
  ] as const)
    expect(operations.find((operation) => operation.diagnosticName === name)!.errorTypes).toEqual(
      errors.map((error) => `ycoding.v5.${error}`),
    )
  for (const [name, field] of [
    ["mcp.configure", "payload.config"],
    ["remote.enroll", "payload.code"],
  ]) {
    const operation = operations.find((operation) => operation.diagnosticName === name)!
    expect(operation.sensitivity).toBe(Sensitivity.SECRET)
    expect(operation.sensitiveFields.map((item) => [item.fieldPath, item.sensitivity])).toEqual([
      [field, Sensitivity.SECRET],
    ])
  }
})

test("M3 both endpoint kinds, model overrides and optional empty lists round trip", () => {
  for (const endpoint of [
    { kind: { case: "openai", value: { baseURL: text("https://models.example/v1"), api: 2 } } },
    { kind: { case: "runpod", value: { baseURL: text("https://api.runpod.ai/v2/test"), worker: 1 } } },
  ]) {
    for (const models of [
      undefined,
      { items: [] },
      {
        items: [
          {
            id: text("model"),
            modelID: text("upstream"),
            name: text("Model"),
            family: text("test"),
            api: 1,
            disabled: false,
            tools: false,
          },
        ],
      },
    ])
      roundTrip("provider_configure_Request", {
        query: {},
        payload: { providerID: text("custom"), scope: 2, endpoint, catalog: 1, models },
      })
  }
  roundTrip("provider_configure_Result", { data: { providerID: text("custom"), target, registered: true } })
  const bytes = roundTrip("ProviderEndpoint_OpenAI", { baseURL: text("https://models.example/v1"), api: 1 })
  expect(Buffer.from(bytes).toString("hex")).toBe("0a1b0a1968747470733a2f2f6d6f64656c732e6578616d706c652f76311001")
})

test("M4 persistent requests reuse both existing ServerConfig branches without echoing secrets", () => {
  for (const config of [
    {
      kind: {
        case: "value1",
        value: {
          type: 1,
          command: { items: [text("test-server")] },
          environment: { entries: [{ key: text("TOKEN"), value: text("synthetic") }] },
        },
      },
    },
    {
      kind: {
        case: "value2",
        value: {
          type: 1,
          url: text("https://mcp.example"),
          headers: { entries: [{ key: text("Authorization"), value: text("synthetic") }] },
        },
      },
    },
  ])
    roundTrip("mcp_configure_Request", { query: {}, payload: { name: text("test"), scope: 1, config } })
  roundTrip("mcp_configure_Result", { data: { name: text("test"), target, reloaded: true } })
})

test("M5 package identity, digests and same-host presentation assets round trip", () => {
  roundTrip("frontendPackage_resolve_Request", { query: {}, payload: { spec: text("@example/tui@1.0.0") } })
  for (const assets of [
    undefined,
    { items: [] },
    { items: [{ path: text("assets/icon.svg"), digest: text("b".repeat(64)) }] },
  ])
    roundTrip("frontendPackage_resolve_Result", {
      data: {
        name: text("@example/tui"),
        version: text("1.0.0"),
        digest: text("a".repeat(64)),
        root: text("/backend/package"),
        entrypoint: { path: text("tui.js"), digest: text("b".repeat(64)) },
        assets,
      },
    })
})

test("M10 enrollment preserves optional replace and returns only redacted device status", () => {
  for (const replace of [undefined, false, true])
    roundTrip("remote_enroll_Request", {
      payload: {
        relayOrigin: text("https://relay.example"),
        enrollmentID: text("enr_1"),
        code: text("TEST-CODE"),
        name: text("Test"),
        replace,
      },
    })
  roundTrip("remote_enroll_Result", { data: device })
  roundTrip("remote_get_Result", { data: { state: 1, device } })
  roundTrip("RemoteEnrollmentPartialFailure", { Tag: 1, device })
})

test("M3/M4/M5/M10 all declared failure codes round trip and reject open enums", () => {
  for (const [name, count] of [
    ["ConfigurationWriteError", 4],
    ["FrontendPackageError", 5],
    ["RemoteEnrollmentError", 7],
  ] as const) {
    for (let code = 1; code <= count; code++) roundTrip(name, { Tag: 1, code })
    const schema = schemaFor(name)
    expect(() => decodeStrict(schema, new Uint8Array([8, 1, 16, count + 1]))).toThrow("enum")
  }
  for (const stage of [1, 2]) roundTrip("ConfigurationPartialFailure", { Tag: 1, target, stage })
})

test("M3/M5/M10 reject missing presence, unknown credential fields and budget overflow", () => {
  for (const name of [
    "provider_configure_Request",
    "mcp_configure_Request",
    "frontendPackage_resolve_Request",
    "remote_enroll_Request",
    "ConfigurationPartialFailure",
    "RemoteEnrollmentPartialFailure",
  ])
    expect(() => decodeStrict(schemaFor(name), new Uint8Array())).toThrow("required")
  const provider = schemaFor("provider_configure_Request_payload")
  const input = create(provider, {
    providerID: text("custom"),
    scope: 1,
    endpoint: { kind: { case: "openai", value: { baseURL: text("https://models.example"), api: 1 } } },
  })
  expect(() => decodeStrict(provider, new Uint8Array([...encodeStrict(provider, input), 50, 0]))).toThrow(
    "unknown field",
  )
  for (const [name, field, limit] of [
    ["frontendPackage_resolve_Request_payload", "spec", 2048],
    ["ProviderEndpointModel", "id", 128],
    ["FrontendPackageAsset", "digest", 64],
  ] as const) {
    const schema = schemaFor(name)
    const values = name === "FrontendPackageAsset" ? { path: text("asset") } : {}
    roundTrip(name, { ...values, [field]: text("x".repeat(limit)) })
    expect(() => encodeStrict(schema, create(schema, { ...values, [field]: text("x".repeat(limit + 1)) }))).toThrow(
      "text constraint",
    )
  }
  for (const [name, count, item] of [
    ["ProviderEndpointModels", 256, { id: text("model") }],
    ["FrontendPackageAssets", 1024, { path: text("asset"), digest: text("a".repeat(64)) }],
  ] as const) {
    roundTrip(name, { items: Array.from({ length: count }, () => item) })
    expect(() =>
      encodeStrict(schemaFor(name), create(schemaFor(name), { items: Array.from({ length: count + 1 }, () => item) })),
    ).toThrow("collection limit")
  }
})

test("S2/M8 append optional metadata and retain absent projections", () => {
  const location = {
    directory: text("/backend/project"),
    project: { id: text("prj_1"), directory: text("/backend/project") },
  }
  roundTrip("Location_Info", location)
  roundTrip("Location_Info", {
    ...location,
    backendPaths: {
      home: text("/backend/home"),
      state: text("/backend/state"),
      worktree: text("/backend/worktree"),
      config: text("/backend/config"),
    },
  })
  for (const scope of [undefined, 1, 2])
    roundTrip("Skill_Info", {
      id: text("test"),
      name: text("Test"),
      location: text("/backend/skill"),
      content: text("Test"),
      scope,
    })
  expect(messages["ycoding.v5.Location_Info"].fields.map((field) => field.tag)).toEqual([1, 2, 3, 4])
  expect(messages["ycoding.v5.Skill_Info"].fields.map((field) => field.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(messages["ycoding.v5.remote_get_Result_data"].fields.map((field) => field.tag)).toEqual([1, 2, 3])
})

test("M3/M4/M5/M10 results and provider writes have no credential-shaped fields", () => {
  const forbidden = new Set([
    "key",
    "apiKey",
    "privateKey",
    "publicKey",
    "refreshToken",
    "accessToken",
    "headers",
    "environment",
    "client_secret",
    "config",
  ])
  const visit = (name: string, seen = new Set<string>()) => {
    if (seen.has(name)) return
    seen.add(name)
    const schema = schemaFor(name.replace("ycoding.v5.", ""))
    for (const field of schema.fields) {
      expect(forbidden.has(field.name), `${name}.${field.name}`).toBe(false)
      if (field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message"))
        visit(field.message.typeName, seen)
    }
  }
  for (const name of [
    "provider_configure_Request_payload",
    "provider_configure_Result",
    "mcp_configure_Result",
    "frontendPackage_resolve_Result",
    "remote_enroll_Result",
    "RemoteEnrollmentPartialFailure",
    "ConfigurationPartialFailure",
  ])
    visit(name)
})

test("M3/M4/M5/M10 remote and relay request admission rejects local-only descriptors", () => {
  for (const role of [PeerRole.REMOTE_CLIENT, PeerRole.RELAY]) {
    const initiator = role === PeerRole.REMOTE_CLIENT ? PeerRole.REMOTE_CLIENT : PeerRole.AGENT
    const client = new Connection({ role: initiator, peer: PeerRole.RELAY, operations, eventTypes: [], now: 0 })
    const server = new Connection({
      role: PeerRole.RELAY,
      peer: initiator,
      operations,
      eventTypes: [],
      now: 0,
      epoch: "connection",
      sourceEpoch: "source",
    })
    client.start(0)
    send(client, server)
    send(server, client)
    send(client, server)
    send(server, client)
    for (const id of [2060, 2061, 2062, 3053]) {
      const scope =
        id === 3053
          ? create(ScopeSchema, { target: { case: "machine", value: {} } })
          : create(ScopeSchema, { target: { case: "location", value: text("/backend/project") } })
      expect(
        (role === PeerRole.RELAY ? server : client).request(
          id,
          scope,
          toBinary(schemaFor("Empty"), create(schemaFor("Empty"))),
          512,
          0,
        ).requestID,
      ).toBeUndefined()
    }
  }
})
