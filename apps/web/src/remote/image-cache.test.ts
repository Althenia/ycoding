import { expect, jest, test } from "bun:test"
import { createRemoteHttp } from "./http"
import { createRemoteStore } from "./store"

test("shares one validated image response by device, Session, and digest and releases it on selection change", async () => {
  const requested: string[] = []
  const source = "AAEC"
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: () => { throw new Error("No relay needed") },
    fetch: async (input) => {
      requested.push(input)
      return Response.json({ mime: "image/png", bytes: 3, data: source })
    },
  })
  const image = { deviceID: "dev_1", sessionID: "ses_a", digest: "a".repeat(64), mime: "image/png" }
  try {
    expect(await Promise.all([store.loadImageSource(image), store.loadImageSource(image)])).toEqual([
      `data:image/png;base64,${source}`, `data:image/png;base64,${source}`,
    ])
    expect(await store.loadImageSource(image)).toBe(`data:image/png;base64,${source}`)
    expect(requested).toHaveLength(1)
    await store.selectSession("ses_b")
    expect(await store.loadImageSource({ ...image, sessionID: "ses_b" })).toBe(`data:image/png;base64,${source}`)
    expect(requested).toHaveLength(2)
  } finally { store.dispose() }
})

test("rejects an invalid image response and permits an explicit retry", async () => {
  let calls = 0
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: () => { throw new Error("No relay needed") },
    fetch: async () => Response.json(++calls === 1 ? { mime: "text/html", bytes: 3, data: "AAEC" } : { mime: "image/png", bytes: 3, data: "AAEC" }),
  })
  const image = { deviceID: "dev_1", sessionID: "ses_a", digest: "a".repeat(64), mime: "image/png" }
  try {
    expect(await store.loadImageSource(image).then(() => undefined, (reason: unknown) => reason instanceof Error ? reason.message : undefined)).toBe("Invalid attachment")
    expect(await store.loadImageSource(image)).toBe("data:image/png;base64,AAEC")
    expect(calls).toBe(2)
  } finally { store.dispose() }
})

test("loads an 8 MiB managed image response", async () => {
  const data = Buffer.alloc(8 * 1024 * 1024, 42).toString("base64")
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: () => { throw new Error("No relay needed") },
    fetch: async () => Response.json({ mime: "image/png", bytes: 8 * 1024 * 1024, data }),
  })
  try {
    expect(await store.loadImageSource({ deviceID: "dev_1", sessionID: "ses_a", digest: "a".repeat(64), mime: "image/png" })).toBe(`data:image/png;base64,${data}`)
  } finally { store.dispose() }
})

test("a stalled managed image read settles and can be retried", async () => {
  jest.useFakeTimers()
  let calls = 0
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: () => { throw new Error("No relay needed") },
    fetch: async (_input, init) => {
      if (++calls > 1) return Response.json({ mime: "image/png", bytes: 3, data: "AAEC" })
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }))
    },
  })
  const image = { deviceID: "dev_1", sessionID: "ses_a", digest: "a".repeat(64), mime: "image/png" }
  try {
    const pending = store.loadImageSource(image)
    jest.advanceTimersByTime(120_001)
    expect(await pending.then(() => "loaded", () => "unavailable")).toBe("unavailable")
    expect(await store.loadImageSource(image)).toBe("data:image/png;base64,AAEC")
    expect(calls).toBe(2)
  } finally { store.dispose(); jest.useRealTimers() }
})

test("changing Sessions aborts pending image reads and clears the previous Session cache", async () => {
  let pendingSignal: AbortSignal | undefined
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: () => { throw new Error("No relay needed") },
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      pendingSignal = init?.signal ?? undefined
      pendingSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    }),
  })
  try {
    const pending = store.loadImageSource({ deviceID: "dev_1", sessionID: "ses_a", digest: "a".repeat(64), mime: "image/png" })
    await store.selectSession("ses_b")
    expect(pendingSignal?.aborted).toBe(true)
    expect(await pending.then(() => false, () => true)).toBe(true)
  } finally { store.dispose() }
})
