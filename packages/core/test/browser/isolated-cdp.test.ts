import { describe, expect, test } from "bun:test"
import { connect, MAX_MESSAGE_BYTES } from "@ycoding-ai/core/browser/isolated-cdp"
import { Buffer } from "node:buffer"
import { PassThrough } from "node:stream"

describe("isolated Chrome private controller", () => {
  test("rejects pending commands and closes when the controller transport is lost", async () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const cdp = connect(readable, writable)
    const pending = cdp.send("Browser.getVersion")
    readable.destroy()
    expect(await rejected(pending)).toMatchObject({ message: "Chrome control pipe closed" })
    await cdp.closed
    expect(await rejected(cdp.send("Browser.getVersion"))).toMatchObject({ message: "Chrome control pipe is closed" })
  })

  test("cancels one command, ignores its late result, and preserves the next command", async () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const requests: Array<{ readonly id: number; readonly method: string }> = []
    writable.on("data", (chunk: Buffer) => {
      chunk
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .forEach((frame) => requests.push(JSON.parse(frame)))
    })
    const cdp = connect(readable, writable)
    const controller = new AbortController()
    const canceled = cdp.send("Page.navigate", {}, "page", controller.signal)
    controller.abort()
    expect(await rejected(canceled)).toMatchObject({ name: "AbortError" })
    readable.write(`${JSON.stringify({ id: requests[0].id, result: { late: true } })}\0`)
    const current = cdp.send("Target.getTargetInfo")
    await waitFor(() => requests.length === 2, "second private controller request")
    readable.write(`${JSON.stringify({ id: requests[1].id, result: { current: true } })}\0`)
    expect(await current).toEqual({ current: true })
    cdp.close()
  })

  test("bounds incomplete controller messages and command settlement time", async () => {
    const oversizedReadable = new PassThrough()
    const oversized = connect(oversizedReadable, new PassThrough())
    const pending = oversized.send("Accessibility.getFullAXTree")
    oversizedReadable.write(Buffer.alloc(MAX_MESSAGE_BYTES + 1, "x"))
    expect(await rejected(pending)).toMatchObject({ message: "Chrome control message exceeded the configured limit" })
    await oversized.closed

    const timed = connect(new PassThrough(), new PassThrough(), 10)
    expect(await rejected(timed.send("Page.captureScreenshot"))).toMatchObject({
      message: "Chrome command timed out: Page.captureScreenshot",
    })
    timed.close()
  })
})

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function rejected(promise: Promise<unknown>) {
  return promise.then(
    () => new Error("Expected the private controller command to reject"),
    (cause: unknown) => cause,
  )
}
