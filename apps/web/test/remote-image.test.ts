import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"

const createTransport = () => {
  throw new Error("Image reads do not open a relay transport")
}

const input = (index: number) => ({ deviceID: "dev_image", sessionID: "ses_image", digest: index.toString(16).padStart(64, "0"), mime: "image/png" })

test("bounds resolved image entries while keeping recently used and mounted sources valid", async () => {
  const requests: string[] = []
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport, fetch: async (url) => {
    requests.push(url)
    return Response.json({ mime: "image/png", data: "AAAA", bytes: 3 })
  } })
  try {
    const mounted = await store.loadImageSource(input(0))
    for (let index = 1; index < 32; index++) await store.loadImageSource(input(index))
    expect(await store.loadImageSource(input(0))).toBe(mounted)
    await store.loadImageSource(input(32))
    expect(await store.loadImageSource(input(0))).toBe(mounted)
    expect(requests).toHaveLength(33)
    await store.loadImageSource(input(1))
    expect(requests).toHaveLength(34)
    expect(mounted).toBe("data:image/png;base64,AAAA")
  } finally { store.dispose() }
})

test("bounds image text retention by size rather than only by entry count", async () => {
  const requests: string[] = []
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport, fetch: async (url) => {
    requests.push(url)
    return Response.json({ mime: "image/png", data: "AAAA".repeat(1024 * 1024), bytes: 3 * 1024 * 1024 })
  } })
  try {
    const mounted = await store.loadImageSource(input(0))
    await store.loadImageSource(input(1))
    expect(await store.loadImageSource(input(1))).toHaveLength(mounted.length)
    expect(requests).toHaveLength(2)
    expect(await store.loadImageSource(input(0))).toBe(mounted)
    expect(requests).toHaveLength(3)
  } finally { store.dispose() }
})

test("resolved eviction never aborts or duplicates an in-flight image read", async () => {
  const held = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  let reads = 0
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport, fetch: async (url, init) => {
    if (url.endsWith(input(0).digest)) { reads++; signal = init?.signal; return held.promise }
    return Response.json({ mime: "image/png", data: "AAAA", bytes: 3 })
  } })
  try {
    const pending = store.loadImageSource(input(0))
    for (let index = 1; index < 40; index++) await store.loadImageSource(input(index))
    expect(store.loadImageSource(input(0))).toBe(pending)
    expect(reads).toBe(1)
    expect(signal?.aborted).toBe(false)
    held.resolve(Response.json({ mime: "image/png", data: "AAAA", bytes: 3 }))
    expect(await pending).toBe("data:image/png;base64,AAAA")
  } finally { store.dispose() }
})

test("a cached MIME conflict preserves the valid image source", async () => {
  let reads = 0
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport, fetch: async () => {
    reads++
    return Response.json({ mime: "image/png", data: "AAAA", bytes: 3 })
  } })
  try {
    const source = await store.loadImageSource(input(0))
    await expect(store.loadImageSource({ ...input(0), mime: "image/webp" })).rejects.toThrow("Invalid attachment")
    expect(await store.loadImageSource(input(0))).toBe(source)
    expect(reads).toBe(1)
  } finally { store.dispose() }
})
