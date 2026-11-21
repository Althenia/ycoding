import { expect, test } from "bun:test"
import { imageOutcome, imageStoreFixture } from "../../test/wire-peer"
import type { RemoteRequestOutcome } from "./transport"

const image = { deviceID: "dev_image", sessionID: "ses_image", digest: "a".repeat(64), mime: "image/png" }
const rejection = (error: unknown) => error instanceof Error ? error.message : undefined

test("shares one validated image response by device, Session, and digest and releases it on selection change", async () => {
  const requested: (string | undefined)[] = []
  let releases = 0
  const { store } = imageStoreFixture(async (request) => {
    requested.push(request?.sessionID)
    expect(request?.httpBulk?.deviceID).toBe(image.deviceID)
    expect(request?.input?.digest).toBe(image.digest)
    return imageOutcome(Uint8Array.of(0, 1, 2), image.mime, () => { releases++ })
  })
  const source = "data:image/png;base64,AAEC"
  try {
    expect(await Promise.all([store.loadImageSource(image), store.loadImageSource(image)])).toEqual([source, source])
    expect(await store.loadImageSource(image)).toBe(source)
    expect(requested).toEqual(["ses_image"])
    await store.selectSession("ses_b")
    expect(await store.loadImageSource({ ...image, sessionID: "ses_b" })).toBe(source)
    expect(requested).toEqual(["ses_image", "ses_b"])
    expect(releases).toBe(2)
  } finally { store.dispose() }
})

test("releases an invalid image response and permits an explicit retry", async () => {
  let calls = 0
  let releases = 0
  const { store } = imageStoreFixture(async () =>
    imageOutcome(Uint8Array.of(0, 1, 2), ++calls === 1 ? "text/html" : image.mime, () => { releases++ }))
  try {
    expect(await store.loadImageSource(image).then(() => undefined, rejection)).toBe("Invalid attachment")
    expect(releases).toBe(1)
    expect(await store.loadImageSource(image)).toBe("data:image/png;base64,AAEC")
    expect(calls).toBe(2)
    expect(releases).toBe(2)
  } finally { store.dispose() }
})

test("loads an 8 MiB managed image response", async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 42)
  const { store } = imageStoreFixture(async () => imageOutcome(bytes))
  try {
    expect(await store.loadImageSource(image)).toBe(`data:image/png;base64,${bytes.toString("base64")}`)
  } finally { store.dispose() }
})

test("an unsettled attachment permits an explicit retry", async () => {
  let calls = 0
  const { store } = imageStoreFixture(async () => ++calls === 1
    ? { status: "unknown", error: { code: "outcome_unknown", message: "Timed out" } }
    : imageOutcome(Uint8Array.of(0, 1, 2)))
  try {
    expect(await store.loadImageSource(image).then(() => undefined, rejection)).toBe("Attachment unavailable")
    expect(await store.loadImageSource(image)).toBe("data:image/png;base64,AAEC")
    expect(calls).toBe(2)
  } finally { store.dispose() }
})

test("changing Sessions aborts a pending image read and discards a late result", async () => {
  let pendingSignal: AbortSignal | undefined
  let releases = 0
  const held = Promise.withResolvers<RemoteRequestOutcome>()
  const { store } = imageStoreFixture((request) => {
    pendingSignal = request?.signal
    return held.promise
  })
  try {
    const pending = store.loadImageSource(image).then(() => "published", () => "refused")
    await store.selectSession("ses_b")
    expect(pendingSignal?.aborted).toBe(true)
    held.resolve(imageOutcome(Uint8Array.of(1), image.mime, () => { releases++ }))
    expect(await pending).toBe("refused")
    expect(releases).toBe(1)
  } finally { store.dispose() }
})

test("a foreign device never acquires an image read", async () => {
  let requests = 0
  const { store } = imageStoreFixture(async () => { requests++; return imageOutcome(Uint8Array.of(1)) })
  try {
    expect(await store.loadImageSource({ ...image, deviceID: "dev_other" }).then(() => undefined, rejection)).toBe("Attachment unavailable")
    expect(requests).toBe(0)
  } finally { store.dispose() }
})
