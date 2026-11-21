import { expect, test } from "bun:test"
import { createApi, createEventStream, createFetch, createLogStream, json, sessionSnapshot } from "./fixture/tui-client"

test("Ready produces a local connection event and snapshot paging preserves opaque cursors", async () => {
  const events = createEventStream()
  const queries: string[] = []
  const fixture = createFetch((url) => {
    if (!url.pathname.endsWith("/snapshot")) return
    queries.push(url.search)
    return sessionSnapshot("ses_binary", [], { before: "opaque/before+next" })
  }, events)
  const api = createApi(fixture.fetch)
  const subscription = api.event.subscribe()[Symbol.asyncIterator]()
  try {
    await api.transport.ready()
    expect((await subscription.next()).value).toMatchObject({ type: "server.connected", sourceEpoch: "source-1" })
    expect((await api.session.snapshot({ sessionID: "ses_binary", limit: 100 })).before).toBe("opaque/before+next")
    await api.session.snapshot({ sessionID: "ses_binary", limit: 100, before: "opaque/before+next" })
    expect(queries).toEqual(["?limit=100", "?limit=100&before=opaque%2Fbefore%2Bnext"])
  } finally {
    api.transport.close()
  }
})

test("reconnect never replays a transmitted prompt and keeps unsent distinct from unknown", async () => {
  const admitted = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  let calls = 0
  const fixture = createFetch((url) => {
    if (!url.pathname.endsWith("/prompt")) return
    calls++
    admitted.resolve()
    return response.promise
  })
  const api = createApi(fixture.fetch)
  const prompt = api.session
    .prompt({ sessionID: "ses_binary", text: "do not replay", id: "msg_once" })
    .catch((error: unknown) => error)
  try {
    await admitted.promise
    await api.transport.reconnect()
    expect(await prompt).toMatchObject({ _tag: "V5ClientError", status: "unknown" })
    expect(calls).toBe(1)
    const cancel = new AbortController()
    cancel.abort()
    await expect(
      api.session.prompt({ sessionID: "ses_binary", text: "unsent" }, { signal: cancel.signal }),
    ).rejects.toMatchObject({ status: "unsent" })
    expect(calls).toBe(1)
  } finally {
    api.transport.close()
    response.resolve(json({ data: {} }))
  }
})

test("reconnect never replays a transmitted global Form reply or cancel", async () => {
  const sent = Promise.withResolvers<void>()
  const cancelSent = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  let mutations = 0
  const fixture = createFetch((url) => {
    if (!url.pathname.endsWith("/reply") && !url.pathname.endsWith("/cancel")) return
    mutations++
    sent.resolve()
    if (mutations === 2) cancelSent.resolve()
    return response.promise
  })
  const api = createApi(fixture.fetch)
  try {
    const result = api.form
      .reply({ sessionID: "global", formID: "frm_global", answer: {} })
      .catch((error: unknown) => error)
    await sent.promise
    await api.transport.reconnect()
    expect(await result).toMatchObject({ status: "unknown" })
    expect(mutations).toBe(1)
    const cancelled = api.form.cancel({ sessionID: "global", formID: "frm_global" }).catch((error: unknown) => error)
    await cancelSent.promise
    await api.transport.reconnect()
    expect(await cancelled).toMatchObject({ status: "unknown" })
    expect(mutations).toBe(2)
  } finally {
    api.transport.close()
    response.resolve(new Response(null, { status: 204 }))
  }
})

test("the absent wire model default remains undefined rather than an invented selection", async () => {
  const api = createApi()
  try {
    const result = await api.model.default()
    expect(result.data).toBeUndefined()
    expect(Object.hasOwn(result, "data")).toBe(false)
  } finally {
    api.transport.close()
  }
})

test("reads canonical review, guardrail, and keep-awake routes through the V5 transport", async () => {
  const sessionID = "ses_startup_reads"
  const paths: string[] = []
  const fixture = createFetch((url) => {
    paths.push(url.pathname)
  })
  const api = createApi(fixture.fetch)
  try {
    const results = await Promise.allSettled([
      api.review.list({ sessionID }),
      api.guardrail.status({ sessionID }),
      api.keepAwake.get(),
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
    expect(new Set(paths)).toEqual(
      new Set([`/api/session/${sessionID}/review`, `/api/session/${sessionID}/guardrail`, "/api/keep-awake"]),
    )
  } finally {
    api.transport.close()
  }
})

test("finite log export receives decoded items and succeeds only after StreamEnd", async () => {
  const log = createLogStream([{ type: "log.synced", aggregateID: "ses_binary", sourceEpoch: "source-1", seq: 12 }])
  const api = createApi(createFetch((url) => (url.pathname.endsWith("/log") ? log.response : undefined)).fetch)
  try {
    expect(await Array.fromAsync(api.session.log({ sessionID: "ses_binary", follow: false }))).toEqual([
      { type: "log.synced", aggregateID: "ses_binary", sourceEpoch: "source-1", seq: 12 },
    ])
  } finally {
    api.transport.close()
  }
})

test("log.synced without terminal StreamEnd remains incomplete on disconnect", async () => {
  const log = createLogStream(
    [{ type: "log.synced", aggregateID: "ses_binary", sourceEpoch: "source-1", seq: 12 }],
    false,
  )
  const api = createApi(createFetch((url) => (url.pathname.endsWith("/log") ? log.response : undefined)).fetch)
  const stream = api.session.log({ sessionID: "ses_binary", follow: false })[Symbol.asyncIterator]()
  try {
    expect((await stream.next()).value).toMatchObject({ type: "log.synced" })
    log.disconnect()
    await expect(stream.next()).rejects.toMatchObject({ status: "unavailable" })
  } finally {
    await stream.return?.()
    api.transport.close()
  }
})
