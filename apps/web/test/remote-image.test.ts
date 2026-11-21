import { expect, test } from "bun:test"
import type { RemoteRequestOutcome } from "../src/remote/transport"
import { imageOutcome, imageStoreFixture } from "./wire-peer"

const input = (index: number) => ({ deviceID: "dev_image", sessionID: "ses_image", digest: index.toString(16).padStart(64, "0"), mime: "image/png" })

test("bounds resolved image entries while keeping recently used and mounted sources valid", async () => {
  let requests = 0
  const { store } = imageStoreFixture(async () => { requests++; return imageOutcome(new Uint8Array(3)) })
  try {
    const mounted = await store.loadImageSource(input(0))
    for (let index = 1; index < 32; index++) await store.loadImageSource(input(index))
    expect(await store.loadImageSource(input(0))).toBe(mounted)
    await store.loadImageSource(input(32))
    expect(await store.loadImageSource(input(0))).toBe(mounted)
    expect(requests).toBe(33)
    await store.loadImageSource(input(1))
    expect(requests).toBe(34)
    expect(mounted).toBe("data:image/png;base64,AAAA")
  } finally { store.dispose() }
})

test("bounds image text retention by size rather than only by entry count", async () => {
  let requests = 0
  const { store } = imageStoreFixture(async () => { requests++; return imageOutcome(new Uint8Array(3 * 1024 * 1024)) })
  try {
    const mounted = await store.loadImageSource(input(0))
    await store.loadImageSource(input(1))
    expect(await store.loadImageSource(input(1))).toHaveLength(mounted.length)
    expect(requests).toBe(2)
    expect(await store.loadImageSource(input(0))).toBe(mounted)
    expect(requests).toBe(3)
  } finally { store.dispose() }
})

test("resolved eviction never aborts or duplicates an in-flight image read", async () => {
  const held = Promise.withResolvers<RemoteRequestOutcome>()
  let signal: AbortSignal | null | undefined
  let reads = 0
  const { store } = imageStoreFixture(async (request) => {
    if (request?.input?.digest === input(0).digest) { reads++; signal = request.signal; return held.promise }
    return imageOutcome(new Uint8Array(3))
  })
  try {
    const pending = store.loadImageSource(input(0))
    for (let index = 1; index < 40; index++) await store.loadImageSource(input(index))
    expect(store.loadImageSource(input(0))).toBe(pending)
    expect(reads).toBe(1)
    expect(signal?.aborted).toBe(false)
    held.resolve(imageOutcome(new Uint8Array(3)))
    expect(await pending).toBe("data:image/png;base64,AAAA")
  } finally { store.dispose() }
})

test("a cached MIME conflict preserves the valid image source", async () => {
  let reads = 0
  const { store } = imageStoreFixture(async () => {
    reads++
    return imageOutcome(new Uint8Array(3))
  })
  try {
    const source = await store.loadImageSource(input(0))
    await expect(store.loadImageSource({ ...input(0), mime: "image/webp" })).rejects.toThrow("Invalid attachment")
    expect(await store.loadImageSource(input(0))).toBe(source)
    expect(reads).toBe(1)
  } finally { store.dispose() }
})
