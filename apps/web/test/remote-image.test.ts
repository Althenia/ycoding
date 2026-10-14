import { expect, test } from "bun:test"
import { resolveObjectURL } from "node:buffer"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayRequestHandler } from "./relay-double"

const input = (index: number) => ({
  deviceID: "dev_image",
  sessionID: "ses_image",
  digest: index.toString(16).padStart(64, "0"),
  mime: "image/png",
})

async function harness(handler: RelayRequestHandler) {
  const relay = await startRelayDouble({
    handler: (request) => (request.operation === "session.attachment.read" ? handler(request) : "default"),
  })
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: (_deviceID, handlers) => createRemoteTransport({ url: relay.wsURL("dev_image"), handlers }),
  })
  store.connect("dev_image")
  await waitFor(() => store.state().transport.kind === "open")
  await store.selectSession("ses_image")
  return {
    store,
    relay,
    reads: () => relay.requests.filter((request) => request.operation === "session.attachment.read"),
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

test("bounds resolved image entries while keeping recently used and mounted sources valid", async () => {
  const fixture = await harness(() => ({ asset: { mime: "image/png", data: Uint8Array.of(0, 1, 2) } }))
  const store = fixture.store
  try {
    const mounted = await store.loadImageSource(input(0))
    for (let index = 1; index < 32; index++) (await store.loadImageSource(input(index))).release()
    ;(await store.loadImageSource(input(0))).release()
    ;(await store.loadImageSource(input(32))).release()
    ;(await store.loadImageSource(input(0))).release()
    expect(fixture.reads()).toHaveLength(33)
    ;(await store.loadImageSource(input(1))).release()
    expect(fixture.reads()).toHaveLength(34)
    expect(await resolveObjectURL(mounted.source)?.arrayBuffer()).toEqual(Uint8Array.of(0, 1, 2).buffer)
    mounted.release()
    expect(resolveObjectURL(mounted.source)).toBeUndefined()
  } finally {
    await fixture.stop()
  }
})

test("bounds raw image retention by size rather than only by entry count", async () => {
  const fixture = await harness(() => ({ asset: { mime: "image/png", data: new Uint8Array(5 * 1024 * 1024) } }))
  const store = fixture.store
  try {
    const mounted = await store.loadImageSource(input(0))
    ;(await store.loadImageSource(input(1))).release()
    ;(await store.loadImageSource(input(1))).release()
    expect(fixture.reads()).toHaveLength(2)
    ;(await store.loadImageSource(input(0))).release()
    expect(fixture.reads()).toHaveLength(3)
    expect(resolveObjectURL(mounted.source)?.size).toBe(5 * 1024 * 1024)
    mounted.release()
  } finally {
    await fixture.stop()
  }
})

test("resolved eviction never aborts or duplicates an in-flight image read", async () => {
  const held = Promise.withResolvers<void>()
  let reads = 0
  const fixture = await harness(async (request) => {
    if (request.input?.digest === input(0).digest) {
      reads++
      await held.promise
    }
    return { asset: { mime: "image/png", data: Uint8Array.of(0, 1, 2) } }
  })
  const store = fixture.store
  try {
    const pending = store.loadImageSource(input(0))
    for (let index = 1; index < 40; index++) (await store.loadImageSource(input(index))).release()
    const concurrent = store.loadImageSource(input(0))
    expect(reads).toBe(1)
    expect(fixture.relay.rejectedFrames).toEqual([])
    held.resolve()
    const [first, second] = await Promise.all([pending, concurrent])
    expect(first.source).not.toBe(second.source)
    expect(resolveObjectURL(first.source)?.size).toBe(3)
    first.release()
    expect(resolveObjectURL(second.source)?.size).toBe(3)
    second.release()
  } finally {
    held.resolve()
    await fixture.stop()
  }
})

test("a cached MIME conflict preserves the valid image source", async () => {
  let reads = 0
  const fixture = await harness(() => {
    reads++
    return { asset: { mime: "image/png", data: Uint8Array.of(0, 1, 2) } }
  })
  const store = fixture.store
  try {
    const source = await store.loadImageSource(input(0))
    await expect(store.loadImageSource({ ...input(0), mime: "image/webp" })).rejects.toThrow("Invalid attachment")
    const cached = await store.loadImageSource(input(0))
    expect(await resolveObjectURL(cached.source)?.arrayBuffer()).toEqual(
      await resolveObjectURL(source.source)?.arrayBuffer(),
    )
    expect(reads).toBe(1)
    source.release()
    cached.release()
  } finally {
    await fixture.stop()
  }
})
