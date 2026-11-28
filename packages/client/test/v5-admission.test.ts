import { expect, test } from "bun:test"
import { make } from "../src/v5/index.js"
import { ScriptedPeer } from "./fixture/v5-peer.js"

async function flood(limit: number, count: number) {
  const peer = new ScriptedPeer()
  const client = make({ connect: () => peer.socket, budgets: { pendingRequests: limit } })
  try {
    peer.socket.open()
    await client.transport.ready()
    const arrivals = Array.from({ length: limit }, () => peer.nextRequest())
    const requests = Array.from({ length: limit }, (_, index) =>
      client.session.get({ sessionID: `ses_${index}` }).catch((error: unknown) => error),
    )
    const held = await Promise.all(arrivals)
    peer.onRequest = (dispatch) => peer.reject(dispatch)
    for (let index = limit; index < count; index++)
      requests.push(client.session.get({ sessionID: `ses_${index}` }).catch((error: unknown) => error))
    for (const dispatch of held) peer.reject(dispatch)
    const results = await Promise.all(requests)
    expect(results.map((result) => (result as { _tag?: string })._tag)).toEqual(
      Array.from({ length: count }, () => "InvalidRequestError"),
    )
    expect(peer.requests.map((request) => request.request.scope?.target)).toEqual(
      Array.from({ length: count }, (_, index) => ({ case: "session", value: `ses_${index}` })),
    )
  } finally {
    client.transport.close()
  }
}

test("requests wait in FIFO order when the in-flight budget is full", () => flood(1, 4))
test("a flood waits for admission without failing a healthy connection", () => flood(4, 24))

test("a queued request proceeds after a subscription is accepted", async () => {
  const peer = new ScriptedPeer()
  const client = make({ connect: () => peer.socket, budgets: { pendingRequests: 1 } })
  const iterator = client.event.subscribe()[Symbol.asyncIterator]()
  try {
    peer.socket.open()
    await client.transport.ready()
    const arrival = peer.nextRequest()
    const first = iterator.next()
    const subscription = await arrival
    const queued = client.session.get({ sessionID: "ses_after_stream" }).catch((error: unknown) => error)
    peer.onRequest = (dispatch) => peer.reject(dispatch)
    peer.subscribe(subscription)
    expect((await first).value).toMatchObject({ type: "server.connected" })
    expect(await queued).toMatchObject({ _tag: "InvalidRequestError" })
    expect(peer.requests.map((request) => request.operation.diagnosticName)).toEqual(["event.subscribe", "session.get"])
  } finally {
    client.transport.close()
    await iterator.return?.().catch(() => {})
  }
})

test("queued cancellation and timeout free their places without sending", async () => {
  const peer = new ScriptedPeer()
  const client = make({ connect: () => peer.socket, budgets: { pendingRequests: 1 } })
  try {
    peer.socket.open()
    await client.transport.ready()
    const arrived = peer.nextRequest()
    const first = client.session.get({ sessionID: "ses_first" }).catch((error: unknown) => error)
    const held = await arrived
    const abort = new AbortController()
    const cancelled = client.session.get({ sessionID: "ses_cancelled" }, { signal: abort.signal }).catch((error: unknown) => error)
    const timed = client.session.get({ sessionID: "ses_timeout" }, { signal: AbortSignal.timeout(10) }).catch((error: unknown) => error)
    const final = client.session.get({ sessionID: "ses_final" }).catch((error: unknown) => error)
    abort.abort()
    expect(await cancelled).toMatchObject({ status: "unsent", reason: "Request cancelled before transmission" })
    expect(await timed).toMatchObject({ status: "unsent", reason: "Request cancelled before transmission" })
    peer.onRequest = (dispatch) => peer.reject(dispatch)
    peer.reject(held)
    expect(await first).toMatchObject({ _tag: "InvalidRequestError" })
    expect(await final).toMatchObject({ _tag: "InvalidRequestError" })
    expect(peer.requests.map((request) => request.request.scope?.target)).toEqual([
      { case: "session", value: "ses_first" },
      { case: "session", value: "ses_final" },
    ])
  } finally {
    client.transport.close()
  }
})

test.each(["close", "reconnect"] as const)("%s rejects queued requests without sending them", async (action) => {
  const firstPeer = new ScriptedPeer()
  const secondPeer = new ScriptedPeer("connection-2")
  let connections = 0
  const client = make({ connect: () => connections++ === 0 ? firstPeer.socket : secondPeer.socket, budgets: { pendingRequests: 1 } })
  try {
    firstPeer.socket.open()
    await client.transport.ready()
    const arrived = firstPeer.nextRequest()
    const first = client.session.get({ sessionID: "ses_first" }).catch((error: unknown) => error)
    await arrived
    const queued = client.session.get({ sessionID: "ses_queued" }).catch((error: unknown) => error)
    if (action === "close") client.transport.close()
    else {
      const ready = client.transport.reconnect()
      secondPeer.socket.open()
      await ready
    }
    expect(await queued).toMatchObject({ status: "unsent", resendable: true })
    expect(await first).toMatchObject({ status: "unknown" })
    expect(firstPeer.requests).toHaveLength(1)
    expect(secondPeer.requests).toHaveLength(0)
  } finally {
    client.transport.close()
  }
})
