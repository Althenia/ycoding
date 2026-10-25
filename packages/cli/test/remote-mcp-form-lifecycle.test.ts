import { afterEach, expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import type { RemoteRequest } from "@ycoding-ai/remote"
import { LocalFailure, type LocalServer } from "../src/remote-local"
import { createRemoteMcp } from "../src/remote-mcp"
import { createSessionRegistry, createSubscriptions, executeRemoteOperation } from "../src/remote-operations"

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
  const subscriptions = createSubscriptions()
  const mcp = createRemoteMcp({ local, sessions, subscriptions, resource, allowed: () => true })
  closers.push(() => mcp.close())
  const call = async (name: string, input?: Record<string, unknown>) => {
    const response = await mcp.fetch(new Request(resource, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name, arguments: { sessionID: session.id, ...(input === undefined ? {} : { input }) },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } },
      } }),
    }), { requestID: "request_fixture", epoch: "epoch_forms", principal: { ownerID: "owner", deviceID: "dev_forms", clientID: "client" } })
    expect(response.status).toBe(200)
    return (await response.json()) as { result?: { isError?: boolean; structuredContent?: unknown }; error?: { message?: string } }
  }
  const native = async (operation: RemoteRequest["operation"], input: Record<string, unknown>) => {
    const frames = await executeRemoteOperation({
      request: { type: "request", id: "req_forms", operation, sessionID: session.id, input },
      local, sessions, subscriptions,
    })
    expect(frames).toHaveLength(1)
    const frame = frames[0]!
    return frame.ok ? { ok: true as const, value: frame.value } : { ok: false as const, code: frame.error.code }
  }
  return { call, native, pending, replies, cancellations }
}

test("MCP automation cannot reply to or cancel a pending form, which stays pending", async () => {
  const { call, native, pending, replies, cancellations } = await fixture()
  for (const [name, input] of [
    ["session_form_reply", { formID: "frm_owned", answer: { approved: true } }],
    ["session_form_reply", { formID: "frm_owned", answer: { approved: true }, humanAttestation: true }],
    ["session_form_cancel", { formID: "frm_owned" }],
  ] as const) {
    const body = await call(name, input)
    expect(body.error !== undefined || body.result?.isError === true).toBe(true)
  }
  expect(replies).toEqual([])
  expect(cancellations).toEqual([])
  expect([...pending.keys()]).toContain("frm_owned")
  const listed = await call("session_form_list")
  expect(listed.result?.isError).toBeUndefined()
  expect(JSON.stringify(listed.result?.structuredContent)).toContain("frm_owned")
  expect((await native("session.form.list", {})).ok).toBe(true)
})

test("native form replies preserve typed answers and cannot replay a settled form", async () => {
  const { native, replies, cancellations } = await fixture()
  const answer = { text: "hello", count: 2, approved: false, choices: ["first", "second"] }
  expect(await native("session.form.reply", { formID: "frm_owned", answer })).toEqual({ ok: true, value: null })
  expect(replies).toEqual([["ses_forms", { directory: "/work" }, "frm_owned", answer]])
  expect(await native("session.form.reply", { formID: "frm_owned", answer })).toEqual({ ok: false, code: "invalid_message" })
  expect((await native("session.form.cancel", { formID: "frm_owned" })).ok).toBe(false)
  expect(replies).toHaveLength(1)
  expect(cancellations).toEqual([])
})

test("native settlement rejects another Session's form and malformed answers before replying", async () => {
  const { native, replies, cancellations } = await fixture()
  expect((await native("session.form.reply", { formID: "frm_other", answer: { approved: true } })).ok).toBe(false)
  expect((await native("session.form.cancel", { formID: "frm_other" })).ok).toBe(false)
  expect((await native("session.form.reply", { formID: "frm_owned", answer: { invalid: { nested: true } } })).ok).toBe(false)
  expect(replies).toEqual([])
  expect(cancellations).toEqual([])
  expect(await native("session.form.cancel", { formID: "frm_owned" })).toEqual({ ok: true, value: null })
  expect(cancellations).toEqual(["frm_owned"])
})

test.each([
  ["conflict", "invalid_message"],
  ["not_found", "invalid_message"],
  ["transport", "outcome_unknown"],
] as const)("native form %s failures are reported without an automatic retry", async (kind, code) => {
  const { native, replies } = await fixture(new LocalFailure(kind, "synthetic failure"))
  expect(await native("session.form.reply", { formID: "frm_owned", answer: { approved: true } })).toEqual({ ok: false, code })
  expect(replies).toHaveLength(1)
})
