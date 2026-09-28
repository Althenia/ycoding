import { expect, test } from "bun:test"
import { RemoteLimits } from "@ycoding-ai/remote"
import { assertRemoteRequestSize, uploadAttachments } from "./attachment-upload"

test("rejects a prompt whose text and uploaded references exceed the complete relay frame", () => {
  expect(() => assertRemoteRequestSize("session.prompt", "ses_1", { text: "x".repeat(RemoteLimits.maxClientMessageChars), files: [{ uri: "ycoding-upload://4ab94d33-6e6b-41a3-a638-f0a6596854a9" }] })).toThrow("32,768")
  expect(() => assertRemoteRequestSize("session.command", "ses_1", { command: "build", files: [{ uri: "ycoding-upload://4ab94d33-6e6b-41a3-a638-f0a6596854a9" }] })).not.toThrow()
})

test("uploads a large image in ordered bounded chunks before replacing its prompt file URI", async () => {
  const data = Buffer.alloc(120_000, 42).toString("base64")
  const requests: { index: number; last: boolean; data: string; uploadID: string }[] = []
  let inFlight = 0
  let maximum = 0
  const progress: number[] = []
  const files = await uploadAttachments({ sessionID: "ses_1", files: [{ uri: `data:image/png;base64,${data}`, name: "capture.png" }], request: async (operation, request) => {
    expect(operation).toBe("session.attachment.upload")
    expect(request?.sessionID).toBe("ses_1")
    const fields = request?.input
    if (typeof fields?.index !== "number" || typeof fields.last !== "boolean" || typeof fields.data !== "string" || typeof fields.uploadID !== "string") throw new Error("Invalid upload request")
    const input = { index: fields.index, last: fields.last, data: fields.data, uploadID: fields.uploadID }
    requests.push(input)
    maximum = Math.max(maximum, ++inFlight)
    await Bun.sleep(1)
    inFlight--
    return { status: "ok" as const, value: input.last ? { uri: `ycoding-upload://${input.uploadID}` } : { received: input.data.length } }
  }, onProgress: (_, percent) => progress.push(percent) })
  expect(maximum).toBe(1)
  expect(requests.length).toBeGreaterThan(1)
  expect(requests.every((chunk, index) => chunk.index === index && chunk.data.length <= RemoteLimits.maxAttachmentChunkChars && chunk.last === (index === requests.length - 1))).toBe(true)
  expect(requests.map((chunk) => chunk.data).join("")).toBe(data)
  expect(files).toEqual([{ uri: `ycoding-upload://${requests[0]!.uploadID}`, name: "capture.png" }])
  expect(progress.at(-1)).toBe(100)
})

test("uploads an 8 MiB image without rejecting valid base64 on JavaScriptCore", async () => {
  const data = Buffer.alloc(8 * 1024 * 1024, 42).toString("base64")
  let chunks = 0
  const files = await uploadAttachments({ sessionID: "ses_1", files: [{ uri: `data:image/png;base64,${data}` }], request: async (_operation, request) => {
    chunks++
    const uploadID = request?.input?.uploadID
    if (typeof uploadID !== "string") throw new Error("Missing upload ID")
    return { status: "ok" as const, value: request?.input?.last ? { uri: `ycoding-upload://${uploadID}` } : { received: 1 } }
  } })
  expect(chunks).toBeGreaterThan(300)
  expect(files[0]?.uri).toStartWith("ycoding-upload://")
})

test("rejects malformed base64 uploads before sending any chunks", async () => {
  for (const data of ["AA!A", "AA=A", "AAA", ""]) {
    let chunks = 0
    await uploadAttachments({ sessionID: "ses_1", files: [{ uri: `data:image/png;base64,${data}` }], request: async () => {
      chunks++
      return { status: "ok" as const, value: null }
    } }).then(() => { throw new Error("Malformed upload was accepted") }, (error: unknown) => expect(String(error)).toContain("Attachment data is not canonical base64."))
    expect(chunks).toBe(0)
  }
})

test("upload cancellation and a failed chunk never produce a sendable reference", async () => {
  const data = Buffer.alloc(50_000, 42).toString("base64")
  const controller = new AbortController()
  let calls = 0
  await uploadAttachments({ sessionID: "ses_1", files: [{ uri: `data:image/png;base64,${data}` }], signal: controller.signal, request: async () => {
    calls++
    controller.abort()
    return { status: "ok" as const, value: { received: 21_000 } }
  } }).then(() => { throw new Error("Cancelled upload was accepted") }, (error: unknown) => expect(String(error)).toContain("cancelled"))
  expect(calls).toBe(1)
  await uploadAttachments({ sessionID: "ses_1", files: [{ uri: `data:image/png;base64,${data}` }], request: async () => ({ status: "failed" as const, error: { code: "message_too_large" as const, message: "Too large" } }) }).then(() => { throw new Error("Failed upload was accepted") }, (error: unknown) => expect(String(error)).toContain("Too large"))
})

test("an old connector's silent first chunk fails quickly with an update instruction", async () => {
  let firstTimeout: number | undefined
  await uploadAttachments({ sessionID: "ses_1", files: [{ uri: "data:image/png;base64,AAAA" }], request: async (_operation, request) => {
    firstTimeout = request?.timeoutMs
    return { status: "unknown" as const, error: { code: "outcome_unknown" as const, message: "Timed out" } }
  } }).then(() => { throw new Error("Silent upload was accepted") }, (error: unknown) => expect(String(error)).toContain("Update YCoding"))
  expect(firstTimeout).toBe(10_000)
})
