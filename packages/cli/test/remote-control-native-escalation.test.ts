import { expect, test } from "bun:test"
import { createRemoteControlAppServer, type RemoteControlBackend } from "../src/remote-control/app-server"
import { pendingRequest, requestBackend, rootSnapshot } from "./remote-control-fixture"

test("pending decisions use the native user-input request, not an invented approval notification", async () => {
  const messages: Array<{ method: string; params: unknown }> = []
  const thread = rootSnapshot({ id: "ses_test", directory: "/synthetic" })
  const backend: RemoteControlBackend = {
    ...requestBackend,
    createThread: async () => thread,
    getThread: async () => thread,
    listThreads: async () => [thread],
    prompt: async () => ({ messageID: "msg_test" }),
    interrupt: async () => {},
    models: async () => [],
    skills: async () => [],
    account: async () => undefined,
    pending: async () => [pendingRequest(thread.session.id, "per_test")],
  }
  const server = createRemoteControlAppServer({ backend, codexHome: "/synthetic", requestScope: "fixture", send: (text) => messages.push(JSON.parse(text)) })
  await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }))
  await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
  await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/read", params: { threadId: "ses_test" } }))
  expect(messages.some((message) => message.method === "item/approvalRequested")).toBe(false)
  expect(messages.some((message) => message.method === "item/tool/requestUserInput")).toBe(true)
})
