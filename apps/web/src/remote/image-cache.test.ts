import { expect, jest, test } from "bun:test"
import { resolveObjectURL } from "node:buffer"
import { imageStoreFixture } from "../../test/wire-peer"
import type { RemoteRequestOutcome, RemoteTransportRequest } from "./transport"

const image = (index = 0) => ({
  deviceID: "dev_image",
  sessionID: "ses_image",
  digest: index.toString(16).padStart(64, "0"),
  mime: "image/png",
})
const asset = (bytes: Uint8Array, release = () => {}, mime = "image/png"): RemoteRequestOutcome => ({
  status: "ok",
  value: { data: bytes, mime, release },
})
async function fixture(read: (request: RemoteTransportRequest | undefined) => Promise<RemoteRequestOutcome>) {
  const f = imageStoreFixture(read)
  await f.store.selectSession("ses_image")
  return f
}

test("coalesces raw reads while each mounted consumer owns and releases its own object URL", async () => {
  const requests: RemoteTransportRequest[] = []
  let released = 0
  const f = await fixture(async (request) => {
    requests.push(request!)
    return asset(Uint8Array.of(0, 1, 2), () => released++)
  })
  try {
    const [first, second] = await Promise.all([f.store.loadImageSource(image()), f.store.loadImageSource(image())])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toEqual({ digest: image().digest })
    expect(released).toBe(1)
    expect(first.source).toStartWith("blob:")
    expect(second.source).not.toBe(first.source)
    expect(await resolveObjectURL(first.source)?.arrayBuffer()).toEqual(Uint8Array.of(0, 1, 2).buffer)
    first.release()
    first.release()
    expect(resolveObjectURL(first.source)).toBeUndefined()
    expect(resolveObjectURL(second.source)?.size).toBe(3)
    await f.store.selectSession("ses_other")
    expect(resolveObjectURL(second.source)).toBeUndefined()
    const third = await f.store.loadImageSource({ ...image(), sessionID: "ses_other" })
    expect(requests).toHaveLength(2)
    third.release()
  } finally {
    f.store.dispose()
  }
})

test("invalid MIME releases the raw owner, rejects the image and permits an explicit retry", async () => {
  let calls = 0
  let released = 0
  const f = await fixture(async () =>
    asset(Uint8Array.of(0, 1, 2), () => released++, ++calls === 1 ? "text/html" : "image/png"),
  )
  try {
    await expect(f.store.loadImageSource(image())).rejects.toThrow("Invalid attachment")
    expect(released).toBe(1)
    const loaded = await f.store.loadImageSource(image())
    expect(resolveObjectURL(loaded.source)?.type).toBe("image/png")
    expect(calls).toBe(2)
    expect(released).toBe(2)
    loaded.release()
  } finally {
    f.store.dispose()
  }
})

test("an 8 MiB image is read as raw bytes without a JSON or base64 attachment endpoint", async () => {
  let calls = 0
  const f = await fixture(async () => {
    calls++
    return asset(new Uint8Array(8 * 1024 * 1024).fill(42))
  })
  try {
    const loaded = await f.store.loadImageSource(image())
    expect(resolveObjectURL(loaded.source)?.size).toBe(8 * 1024 * 1024)
    expect(calls).toBe(1)
    loaded.release()
  } finally {
    f.store.dispose()
  }
})

test("a stalled raw read is cancelled at its deadline and can be retried", async () => {
  let calls = 0
  const f = await fixture(async (request) => {
    if (++calls > 1) return asset(Uint8Array.of(0, 1, 2))
    return new Promise<RemoteRequestOutcome>((_resolve, reject) =>
      request?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      }),
    )
  })
  jest.useFakeTimers()
  try {
    const pending = f.store.loadImageSource(image())
    jest.advanceTimersByTime(120_001)
    await expect(pending).rejects.toThrow("Aborted")
    const retry = await f.store.loadImageSource(image())
    expect(calls).toBe(2)
    retry.release()
  } finally {
    f.store.dispose()
    jest.useRealTimers()
  }
})

test("Session replacement aborts pending reads and disposal revokes mounted URLs", async () => {
  let pendingSignal: AbortSignal | undefined
  const f = await fixture(
    async (request) =>
      new Promise<RemoteRequestOutcome>((_resolve, reject) => {
        pendingSignal = request?.signal
        pendingSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        })
      }),
  )
  try {
    const pending = f.store.loadImageSource(image())
    await f.store.selectSession("ses_other")
    expect(pendingSignal?.aborted).toBe(true)
    await expect(pending).rejects.toThrow("Aborted")
  } finally {
    f.store.dispose()
  }
  const g = await fixture(async () => asset(Uint8Array.of(1)))
  const mounted = await g.store.loadImageSource(image())
  g.store.dispose()
  expect(resolveObjectURL(mounted.source)).toBeUndefined()
  mounted.release()
})

test("the 32-source LRU budget evicts reuse without invalidating a mounted consumer", async () => {
  let calls = 0
  const f = await fixture(async () => {
    calls++
    return asset(Uint8Array.of(1, 2, 3))
  })
  try {
    const mounted = await f.store.loadImageSource(image(0))
    for (let index = 1; index < 32; index++) (await f.store.loadImageSource(image(index))).release()
    ;(await f.store.loadImageSource(image(0))).release()
    ;(await f.store.loadImageSource(image(32))).release()
    ;(await f.store.loadImageSource(image(0))).release()
    expect(calls).toBe(33)
    ;(await f.store.loadImageSource(image(1))).release()
    expect(calls).toBe(34)
    expect(resolveObjectURL(mounted.source)?.size).toBe(3)
    mounted.release()
  } finally {
    f.store.dispose()
  }
})

test("the 8 MiB Blob budget evicts by raw size independently of source count", async () => {
  let calls = 0
  const f = await fixture(async () => {
    calls++
    return asset(new Uint8Array(4 * 1024 * 1024))
  })
  try {
    const mounted = await f.store.loadImageSource(image(0))
    ;(await f.store.loadImageSource(image(1))).release()
    ;(await f.store.loadImageSource(image(2))).release()
    expect(calls).toBe(3)
    ;(await f.store.loadImageSource(image(0))).release()
    expect(calls).toBe(4)
    expect(resolveObjectURL(mounted.source)?.size).toBe(4 * 1024 * 1024)
    mounted.release()
  } finally {
    f.store.dispose()
  }
})

test("eviction never aborts or duplicates a pending read, and MIME conflict preserves valid reuse", async () => {
  const held = Promise.withResolvers<RemoteRequestOutcome>()
  let reads = 0
  let signal: AbortSignal | undefined
  const f = await fixture(async (request) => {
    if (request?.input?.digest === image(0).digest) {
      reads++
      signal = request.signal
      return held.promise
    }
    return asset(Uint8Array.of(1))
  })
  try {
    const pending = f.store.loadImageSource(image(0))
    for (let index = 1; index < 40; index++) (await f.store.loadImageSource(image(index))).release()
    const duplicate = f.store.loadImageSource(image(0))
    expect(reads).toBe(1)
    expect(signal?.aborted).toBe(false)
    held.resolve(asset(Uint8Array.of(1)))
    const [first, second] = await Promise.all([pending, duplicate])
    await expect(f.store.loadImageSource({ ...image(0), mime: "image/webp" })).rejects.toThrow("Invalid attachment")
    ;(await f.store.loadImageSource(image(0))).release()
    expect(reads).toBe(1)
    expect(resolveObjectURL(first.source)?.type).toBe("image/png")
    first.release()
    second.release()
  } finally {
    f.store.dispose()
  }
})
