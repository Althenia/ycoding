import { expect, test } from "bun:test"
import { make } from "../src/v5/index.js"
import type { V5Client, RemoteDevice } from "../src/v5/index.js"
import { encodeDomain, decodeDomain } from "../src/v5/codec.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const target = { scope: "project", path: "/backend/project/ycoding.jsonc" }
const device = {
  deviceID: "dev_1",
  name: "Test",
  relayOrigin: "https://relay.example",
  enrolledAt: 0,
  credentialState: "not_authenticated",
} satisfies RemoteDevice
const cases: { operation: string; call: (client: V5Client) => Promise<unknown>; payload: unknown; output: unknown }[] =
  [
    {
      operation: "provider.configure",
      call: (client) =>
        client.provider.configure({
          providerID: "custom",
          scope: "project",
          endpoint: { baseURL: "https://models.example/v1", api: "responses" },
          catalog: "openai-models",
          models: [{ id: "model", disabled: false, tools: false }],
        }),
      payload: {
        providerID: "custom",
        scope: "project",
        endpoint: { baseURL: "https://models.example/v1", api: "responses" },
        catalog: "openai-models",
        models: [{ id: "model", disabled: false, tools: false }],
      },
      output: { providerID: "custom", target, registered: true },
    },
    {
      operation: "mcp.configure",
      call: (client) =>
        client.mcp.configure({
          name: "test",
          scope: "project",
          config: { type: "local", command: ["test-server"], environment: { TOKEN: "synthetic" }, disabled: false },
        }),
      payload: {
        name: "test",
        scope: "project",
        config: { type: "local", command: ["test-server"], environment: { TOKEN: "synthetic" }, disabled: false },
      },
      output: { name: "test", target, reloaded: true },
    },
    {
      operation: "frontendPackage.resolve",
      call: (client) => client.frontendPackage.resolve({ spec: "@example/tui@1.0.0" }),
      payload: { spec: "@example/tui@1.0.0" },
      output: {
        name: "@example/tui",
        version: "1.0.0",
        digest: "a".repeat(64),
        root: "/backend/package",
        entrypoint: { path: "tui.js", digest: "b".repeat(64) },
        assets: [],
      },
    },
    {
      operation: "remote.enroll",
      call: (client) =>
        client.remote.enroll({
          relayOrigin: "https://relay.example",
          enrollmentID: "enr_1",
          code: "TEST-CODE",
          name: "Test",
          replace: false,
        }),
      payload: {
        relayOrigin: "https://relay.example",
        enrollmentID: "enr_1",
        code: "TEST-CODE",
        name: "Test",
        replace: false,
      },
      output: device,
    },
  ]

function clientFor(peer: ScriptedPeer) {
  return make({
    endpoint: { url: "http://127.0.0.1:12345" },
    location: { directory: "/backend/project" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
}

test.each(cases)(
  "M3/M4/M5/M10 $operation dispatches a typed request and decodes its redacted settlement",
  async (item) => {
    const peer = new ScriptedPeer()
    peer.onRequest = (dispatch) => {
      const request = decodeDomain(dispatch.operation.requestType, dispatch.request.payload)
      expect(request).toEqual({
        ...(item.operation === "remote.enroll" ? {} : { query: { location: { directory: "/backend/project" } } }),
        payload: item.payload,
      })
      expect(dispatch.request.scope!.target.case).toBe(item.operation === "remote.enroll" ? "machine" : "location")
      peer.result(dispatch, {
        typeName: dispatch.operation.resultType,
        payload: encodeDomain(dispatch.operation.resultType, { data: item.output }),
      })
    }
    const client = clientFor(peer)
    try {
      expect(await item.call(client)).toEqual(item.output)
      expect(peer.requests.map((dispatch) => dispatch.operation.diagnosticName)).toEqual([item.operation])
    } finally {
      client.transport.close()
    }
  },
)

test.each([
  [0, "ConfigurationWriteError", { _tag: "ConfigurationWriteError", code: "provider_collision" }],
  [0, "ConfigurationPartialFailure", { _tag: "ConfigurationPartialFailure", target, stage: "registration" }],
  [1, "ConfigurationPartialFailure", { _tag: "ConfigurationPartialFailure", target, stage: "reload" }],
  [2, "FrontendPackageError", { _tag: "FrontendPackageError", code: "permission_denied" }],
  [3, "RemoteEnrollmentError", { _tag: "RemoteEnrollmentError", code: "already_enrolled" }],
  [3, "RemoteEnrollmentPartialFailure", { _tag: "RemoteEnrollmentPartialFailure", device }],
] as const)("M3/M4/M5/M10 %s %s errors settle once without replay", async (index, name, error) => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) =>
    peer.result(dispatch, { typeName: `ycoding.v5.${name}`, payload: encodeDomain(`ycoding.v5.${name}`, error) }, true)
  const client = clientFor(peer)
  try {
    await expect(cases[index].call(client)).rejects.toEqual(error)
    expect(peer.requests).toHaveLength(1)
  } finally {
    client.transport.close()
  }
})

test("M3/M4 alternate provider and remote MCP shapes keep global scope and optional lists", () => {
  for (const payload of [
    {
      providerID: "custom",
      scope: "global",
      endpoint: { baseURL: "https://models.example/v1", api: "responses" },
      models: [],
    },
    { providerID: "custom", scope: "global", endpoint: { baseURL: "https://models.example", api: "chat" } },
  ]) {
    const request = { query: {}, payload }
    expect(
      decodeDomain(
        "ycoding.v5.provider_configure_Request",
        encodeDomain("ycoding.v5.provider_configure_Request", request),
      ),
    ).toEqual(request)
  }
  const request = {
    query: {},
    payload: {
      name: "test",
      scope: "global",
      config: { type: "remote", url: "https://mcp.example", headers: { Authorization: "synthetic" }, oauth: false },
    },
  }
  expect(
    decodeDomain("ycoding.v5.mcp_configure_Request", encodeDomain("ycoding.v5.mcp_configure_Request", request)),
  ).toEqual(request)
})

test("S2/M8/M10 existing reads expose optional backend-owned metadata through typed bindings", async () => {
  const peer = new ScriptedPeer()
  const location = {
    directory: "/backend/project",
    project: { id: "prj_1", directory: "/backend/project" },
    backendPaths: {
      home: "/backend/home",
      state: "/backend/state",
      worktree: "/backend/worktree",
      config: "/backend/config",
    },
  }
  const skill = { id: "test", name: "Test", location: "/backend/skill", content: "Test", scope: "global" }
  peer.onRequest = (dispatch) => {
    const data =
      dispatch.operation.diagnosticName === "location.get"
        ? { data: location }
        : dispatch.operation.diagnosticName === "skill.list"
          ? { location, data: [skill] }
          : { data: { state: "off", device } }
    peer.result(dispatch, {
      typeName: dispatch.operation.resultType,
      payload: encodeDomain(dispatch.operation.resultType, data),
    })
  }
  const client = clientFor(peer)
  try {
    expect((await client.location.get()).backendPaths).toEqual(location.backendPaths)
    expect((await client.skill.list()).data[0].scope).toBe("global")
    expect((await client.remote.get()).device).toEqual(device)
  } finally {
    client.transport.close()
  }
})

test.each([
  ["remote.mcp.get", (client: V5Client) => client.remote.mcp.get(), {}, { state: "connecting" }],
  [
    "remote.mcp.set",
    (client: V5Client) => client.remote.mcp.set({ enabled: true }),
    { payload: { enabled: true } },
    { state: "on", url: "https://relay.example/api/mcp/devices/dev_1" },
  ],
  [
    "remote.mcp.set",
    (client: V5Client) => client.remote.mcp.set({ enabled: false }),
    { payload: { enabled: false } },
    { state: "error", message: "Remote is not connected" },
  ],
] as const)("relay MCP %s is a local machine-scoped control returning the MCP status", async (operation, call, request, output) => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => {
    expect(dispatch.operation.diagnosticName).toBe(operation)
    expect(dispatch.request.scope!.target.case).toBe("machine")
    expect(decodeDomain(dispatch.operation.requestType, dispatch.request.payload)).toEqual(request)
    peer.result(dispatch, {
      typeName: dispatch.operation.resultType,
      payload: encodeDomain(dispatch.operation.resultType, { data: output }),
    })
  }
  const client = clientFor(peer)
  try {
    expect(await call(client)).toEqual(output)
    expect(peer.requests).toHaveLength(1)
  } finally {
    client.transport.close()
  }
})
