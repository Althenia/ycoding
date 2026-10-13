import { expect, test } from "bun:test"
import { decodeStrict, operations, PeerRole, schemas } from "@ycoding-ai/protocol/v5"
import { make, methodCoverage } from "../src/v5/index.js"
import type { V5Client } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

const cases: [string, string, (client: V5Client) => Promise<unknown>][] = [
  ["health", "health.get", (client) => client.health.get()],
  ["server", "server.get", (client) => client.server.get()],
  [
    "telemetry",
    "telemetry.consent.set",
    (client) => client.server.telemetry.consent.set({ enabled: false, noticeVersion: 1 }),
  ],
  ["location", "location.get", (client) => client.location.get()],
  ["agent", "agent.list", (client) => client.agent.list()],
  ["plugin", "plugin.list", (client) => client.plugin.list()],
  ["session", "session.list", (client) => client.session.list({ parentID: null, limit: 1, search: "" })],
  [
    "guardrail",
    "session.guardrail.request.reply",
    (client) => client.guardrail.request.reply({ sessionID: "ses_owner", requestID: "review_1", reply: "once" }),
  ],
  ["message", "session.messages", (client) => client.message.list({ sessionID: "ses_owner" })],
  ["model", "model.list", (client) => client.model.list()],
  ["generate", "generate.text", (client) => client.generate.text({ prompt: "fixture" })],
  ["provider", "provider.refresh", (client) => client.provider.refresh()],
  ["providerUsage", "providerUsage.list", (client) => client.providerUsage.list()],
  [
    "integration",
    "integration.oauth.status",
    (client) => client.integration.oauth.status({ integrationID: "fixture", attemptID: "attempt_1" }),
  ],
  ["mcp", "mcp.connect", (client) => client.mcp.connect({ server: "fixture" })],
  ["credential", "credential.activate", (client) => client.credential.activate({ credentialID: "credential_fixture" })],
  [
    "project",
    "project.forget",
    (client) => client.project.forget({ projectID: "project_fixture", directory: "/fixture" }),
  ],
  [
    "form",
    "session.form.reply",
    (client) =>
      client.form.reply({
        sessionID: "ses_owner",
        formID: "form_1",
        answer: { accepted: false, count: 0, text: "\ud800", selected: [] },
      }),
  ],
  [
    "permission",
    "session.permission.reply",
    (client) => client.permission.reply({ sessionID: "ses_owner", requestID: "permission_1", reply: "once" }),
  ],
  ["file", "fs.find", (client) => client.file.find({ query: "fixture" })],
  ["command", "command.list", (client) => client.command.list()],
  ["skill", "skill.list", (client) => client.skill.list()],
  [
    "pty",
    "pty.connectToken",
    (client) =>
      client.pty.connect.token({
        ptyID: "pty_fixture",
        "x-ycoding-ticket": "1",
        sessionID: "ses_owner",
        access: "inspect",
        generation: 1,
      }),
  ],
  ["shell", "shell.output", (client) => client.shell.output({ id: "shell_fixture", cursor: 0, limit: 1 })],
  [
    "question",
    "session.question.reject",
    (client) => client.question.reject({ sessionID: "ses_owner", requestID: "question_1" }),
  ],
  ["reference", "reference.list", (client) => client.reference.list()],
  ["projectCopy", "projectCopy.refresh", (client) => client.projectCopy.refresh({ projectID: "project_fixture" })],
  ["vcs", "vcs.diff", (client) => client.vcs.diff({ mode: "working" })],
  [
    "projectArtifact",
    "artifact.list",
    (client) => client.projectArtifact.artifact.list({ scope: "project", kind: "skill", stage: "active" }),
  ],
  ["debug", "debug.location", (client) => client.debug.location.list()],
  ["browser", "browser.status", (client) => client.browser.status({ sessionID: "ses_owner" })],
  ["isolatedBrowser", "isolatedBrowser.status", (client) => client.isolatedBrowser.status({ sessionID: "ses_owner" })],
  ["usage", "usage.get", (client) => client.usage.get()],
  ["remote", "remote.set", (client) => client.remote.set({ enabled: false })],
  ["keepAwake", "keepAwake.set", (client) => client.keepAwake.set({ enabled: false })],
  ["config", "config.diagnostics", (client) => client.config.diagnostics()],
]

test.each(cases)("REQ-WIRE-001 %s group dispatches its canonical %s operation", async (_group, name, call) => {
  const peer = new ScriptedPeer()
  peer.onRequest = (dispatch) => peer.reject(dispatch)
  const client = make({
    endpoint: { url: "http://127.0.0.1:12345" },
    location: { directory: "/fixture", workspaceID: "workspace_fixture" },
    socket: () => {
      queueMicrotask(() => peer.socket.open())
      return peer.socket
    },
  })
  try {
    await expect(call(client)).rejects.toEqual({ _tag: "InvalidRequestError", message: "Scripted rejection" })
    expect(peer.requests).toHaveLength(1)
    const request = peer.requests[0]
    expect(request.operation.diagnosticName).toBe(name)
    const schema = schemas.find((schema) => schema.typeName === request.operation.requestType)!
    expect(decodeStrict(schema, request.request.payload).$typeName).toBe(request.operation.requestType)
  } finally {
    client.transport.close()
  }
})

test("REQ-WIRE-001 the complete existing 196-method surface has one canonical LocalClient descriptor", () => {
  expect(methodCoverage).toHaveLength(196)
  expect(new Set(methodCoverage.map((entry) => entry.method)).size).toBe(196)
  for (const entry of methodCoverage) {
    const operation = operations.find((operation) => operation.operationId === entry.operationID)!
    expect(operation.diagnosticName).toBe(entry.operation)
    expect(operation.roles).toContain(PeerRole.LOCAL_CLIENT)
  }
  expect(new Set(methodCoverage.map((entry) => entry.method.split(".")[0]))).toEqual(
    new Set([...cases.map((entry) => entry[0]).filter((group) => group !== "telemetry"), "event"]),
  )
})
