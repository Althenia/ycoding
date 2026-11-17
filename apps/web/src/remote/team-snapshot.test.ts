import { expect, test } from "bun:test"
import { createRemoteQueries, createRemoteQueryClient, remoteKeys, type QueryScope, type RemoteLink } from "./queries"
import type { RemoteRequestOutcome } from "./transport"

const scope: QueryScope = { deviceID: "device_fixture", generation: 1 }
const response = (id: string): RemoteRequestOutcome => ({ status: "ok", value: { session: { id }, messages: [{ id: `message_${id}`, type: "user", text: `Reported message for ${id}`, time: { created: 1, consumed: 1 } }] } })
const link = (request: RemoteLink["request"]): RemoteLink => ({ request, recoveries: () => 0, recovered: async () => false })

test("child inspection reads its bounded snapshot through the supplied connection scope", async () => {
  const client = createRemoteQueryClient()
  const calls: unknown[] = []
  const queries = createRemoteQueries(link(async (...input) => { calls.push(input); return response("ses_child") }), client)
  try {
    const snapshot = await client.fetchQuery(queries.childSnapshot(scope, true, "ses_child", 1))
    expect(snapshot.sessionID).toBe("ses_child")
    expect(snapshot.messages).toMatchObject([{ kind: "user", text: "Reported message for ses_child" }])
    expect(calls).toEqual([[scope, "session.snapshot", { sessionID: "ses_child", input: { limit: 40 } }]])
  } finally { client.clear() }
})

for (const [replacement, nextScope] of [
  ["connection", { ...scope, generation: 2 }],
  ["machine", { deviceID: "device_other", generation: 1 }],
] as const) test(`late child inspection cannot replace another child's or another ${replacement}'s cached snapshot`, async () => {
  const client = createRemoteQueryClient()
  let release!: (outcome: RemoteRequestOutcome) => void
  const queries = createRemoteQueries(link(async (_scope, _operation, request) => request?.sessionID === "ses_first" ? new Promise((resolve) => { release = resolve }) : response("ses_second")), client)
  try {
    const first = client.fetchQuery(queries.childSnapshot(scope, true, "ses_first", 1))
    const second = await client.fetchQuery(queries.childSnapshot(nextScope, true, "ses_second", 1))
    release(response("ses_first"))
    await first
    expect(second.sessionID).toBe("ses_second")
    expect(client.getQueryData(remoteKeys.childSnapshot(nextScope, "ses_second", 1))).toMatchObject({ sessionID: "ses_second" })
    expect(client.getQueryData(remoteKeys.childSnapshot(scope, "ses_second", 1))).toBeUndefined()
  } finally { client.clear() }
})

test("child inspection rejects a different Session instead of displaying its messages", async () => {
  const client = createRemoteQueryClient()
  const queries = createRemoteQueries(link(async () => response("ses_other")), client)
  try {
    const request = client.fetchQuery(queries.childSnapshot(scope, true, "ses_child", 1))
    await Promise.allSettled([request])
    expect(request).rejects.toThrow("different or unreadable child conversation")
    expect(client.getQueryData(remoteKeys.childSnapshot(scope, "ses_child", 1))).toBeUndefined()
  } finally { client.clear() }
})

for (const failure of [
  { name: "unavailable", outcome: { status: "unavailable", reason: "request-limit" }, message: "Child conversation is unavailable because the relay request limit was reached." },
  { name: "failed", outcome: { status: "failed", error: { code: "unknown_operation", message: "Child snapshots are unavailable on this connector." } }, message: "Child conversation: Child snapshots are unavailable on this connector." },
] as const) test(`${failure.name} child inspection recovers only after an explicit refresh`, async () => {
  const client = createRemoteQueryClient()
  const calls: Parameters<RemoteLink["request"]>[] = []
  const queries = createRemoteQueries(link(async (...input) => {
    calls.push(input)
    return calls.length === 1 ? failure.outcome : response("ses_child")
  }), client)
  const options = queries.childSnapshot(scope, true, "ses_child", 1)
  try {
    const request = client.fetchQuery(options)
    await Promise.allSettled([request])
    expect(request).rejects.toThrow(failure.message)
    expect(calls).toHaveLength(1)
    expect(client.getQueryData(options.queryKey)).toBeUndefined()
    await client.refetchQueries({ queryKey: options.queryKey, exact: true }, { throwOnError: true })
    expect(calls).toEqual([
      [scope, "session.snapshot", { sessionID: "ses_child", input: { limit: 40 } }],
      [scope, "session.snapshot", { sessionID: "ses_child", input: { limit: 40 } }],
    ])
    expect(client.getQueryData(options.queryKey)).toMatchObject({ sessionID: "ses_child", messages: [{ kind: "user", text: "Reported message for ses_child" }] })
  } finally { client.clear() }
})

test("child inspection keeps separate account query clients isolated", async () => {
  const first = createRemoteQueryClient()
  const second = createRemoteQueryClient()
  const firstQueries = createRemoteQueries(link(async () => response("ses_child")), first)
  const secondQueries = createRemoteQueries(link(async () => ({ status: "ok", value: { session: { id: "ses_child" }, messages: [
    { id: "message_second_account", type: "user", text: "The second account's child transcript.", time: { created: 1, consumed: 1 } },
  ] } })), second)
  try {
    await first.fetchQuery(firstQueries.childSnapshot(scope, true, "ses_child", 1))
    expect(second.getQueryData(remoteKeys.childSnapshot(scope, "ses_child", 1))).toBeUndefined()
    const snapshot = await second.fetchQuery(secondQueries.childSnapshot(scope, true, "ses_child", 1))
    expect(snapshot.messages).toMatchObject([{ kind: "user", text: "The second account's child transcript." }])
    expect(first.getQueryData(remoteKeys.childSnapshot(scope, "ses_child", 1))).toMatchObject({ messages: [{ kind: "user", text: "Reported message for ses_child" }] })
  } finally { first.clear(); second.clear() }
})

test("child inspection rejects a watermark belonging to another Session", async () => {
  const client = createRemoteQueryClient()
  const queries = createRemoteQueries(link(async () => ({ status: "ok", value: { session: { id: "ses_child" }, messages: [], watermark: { aggregateID: "ses_other", seq: 1 } } })), client)
  try {
    const request = client.fetchQuery(queries.childSnapshot(scope, true, "ses_child", 1))
    await Promise.allSettled([request])
    expect(request).rejects.toThrow("different or unreadable child conversation")
    expect(client.getQueryData(remoteKeys.childSnapshot(scope, "ses_child", 1))).toBeUndefined()
  } finally { client.clear() }
})
