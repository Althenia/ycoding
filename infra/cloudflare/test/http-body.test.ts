import { describe, expect, test } from "bun:test"
import { RemoteLimits } from "../../../packages/remote/src/index"
import { readBoundedText } from "../src/http"

describe("bounded body", () => {
  const stream = (chunks: readonly Uint8Array[]) => new ReadableStream<Uint8Array>({
    start: (controller) => {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })
  const bytes = (text: string) => new TextEncoder().encode(text)

  test("reads a body up to the byte cap and decodes multibyte text across chunks", async () => {
    const encoded = bytes("héllo✓")
    expect(await readBoundedText(stream([encoded.slice(0, 2), encoded.slice(2, 7), encoded.slice(7)]), encoded.byteLength)).toBe("héllo✓")
    expect(await readBoundedText(null, 10)).toBe("")
  })

  test("refuses a stream that exceeds the byte cap without a declared length and cancels it", async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(bytes("x".repeat(1024))),
      cancel: () => { cancelled = true },
    })
    expect(await readBoundedText(source, RemoteLimits.maxClientMessageChars * 4)).toBeUndefined()
    expect(cancelled).toBe(true)
  })

  test("a body exactly at the cap is accepted and one byte over is refused", async () => {
    expect(await readBoundedText(stream([bytes("abcd")]), 4)).toBe("abcd")
    expect(await readBoundedText(stream([bytes("abcde")]), 4)).toBeUndefined()
  })
})
