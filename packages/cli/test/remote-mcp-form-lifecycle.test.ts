import { afterEach, expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { LocalFailure, type LocalServer } from "../src/remote-local"
import { createRemoteMcp } from "../src/remote-mcp"
import { createSessionRegistry, createSubscriptions } from "../src/remote-operations"

const resource = "https://relay.example.com/api/mcp/devices/dev_forms"
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function fixture(failure?: LocalFailure) {
  const session = {
    id: "ses_forms", projectID: "prj_forms", model: { providerID: "test", id: "test" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, title: "Forms", location: { directory: "/work", workspaceID: undefined },
  } as unknown as SessionInfo
  const pending = new Map([
    ["frm_owned", { id: "frm_owned", sessionID: session.id }],
    ["frm_other", { id: "frm_other", sessionID: "ses_other" }],
  ])
  const replies: unknown[][] = []
  const cancellations: string[] = []
  const local = {
    listPage: async () => ({ data: [session] }),
    getSession: async () => session,
    formList: async () => [...pending.values()],
    formReply: async (...args: unknown[]) => {
      replies.push(args)
      if (failure) throw failure
      pending.delete(String(args[2]))
    },
    formCancel: async (_sessionID: string, _location: unknown, id: string) => {
      cancellations.push(id)
      pending.delete(id)
    },
  } as unknown as LocalServer
  const sessions = createSessionRegistry({ local })
  await sessions.refresh()
  const mcp = createRemoteMcp({ local, sessions, subscriptions: createSubscriptions(), resource, allowed: () => true })
  closers.push(() => mcp.close())
  const run = async (name: string, input: Record<string, unknown>) => {
    const response = await mcp.fetch(new Request(resource, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name, arguments: { sessionID: session.id, input },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } },
      } }),
    }), { requestID: "request_fixture", epoch: "epoch_forms", principal: { ownerID: "owner", deviceID: "dev_forms", clientID: "client" } })
    expect(response.status).toBe(200)
    return (await response.json()).result as { isError?: boolean; structuredContent?: unknown }
  }
  return { run, replies, cancellations }
}

test("MCP form replies preserve typed answers and cannot replay a settled form", async () => {
  const { run, replies, cancellations } = await fixture()
  const answer = { text: "hello", count: 2, approved: false, choices: ["first", "second"] }
  expect((await run("session_form_reply", { formID: "frm_owned", answer })).isError).toBeUndefined()
  expect(replies).toEqual([["ses_forms", { directory: "/work" }, "frm_owned", answer]])
  expect((await run("session_form_reply", { formID: "frm_owned", answer })).structuredContent).toMatchObject({ error: { code: "invalid_message" } })
  expect((await run("session_form_cancel", { formID: "frm_owned" })).isError).toBe(true)
  expect(replies).toHaveLength(1)
  expect(cancellations).toEqual([])
})

test("MCP rejects another Session's form and malformed answers before replying", async () => {
  const { run, replies, cancellations } = await fixture()
  expect((await run("session_form_reply", { formID: "frm_other", answer: { approved: true } })).isError).toBe(true)
  expect((await run("session_form_cancel", { formID: "frm_other" })).isError).toBe(true)
  expect((await run("session_form_reply", { formID: "frm_owned", answer: { invalid: { nested: true } } })).isError).toBe(true)
  expect(replies).toEqual([])
  expect(cancellations).toEqual([])
  expect((await run("session_form_cancel", { formID: "frm_owned" })).isError).toBeUndefined()
  expect(cancellations).toEqual(["frm_owned"])
})

test.each([
  ["conflict", "invalid_message"],
  ["not_found", "invalid_message"],
  ["transport", "outcome_unknown"],
] as const)("MCP form %s failures are reported without an automatic retry", async (kind, code) => {
  const { run, replies } = await fixture(new LocalFailure(kind, "synthetic failure"))
  expect((await run("session_form_reply", { formID: "frm_owned", answer: { approved: true } })).structuredContent).toMatchObject({ error: { code } })
  expect(replies).toHaveLength(1)
  if (kind !== "transport") return
  expect((await run("session_form_reply", { formID: "frm_owned", answer: { approved: true } })).structuredContent).toMatchObject({ error: { code: "outcome_unknown" } })
  expect(replies).toHaveLength(1)
})
