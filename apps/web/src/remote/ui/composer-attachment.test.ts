import { expect, test } from "bun:test"
import { RemoteLimits } from "@ycoding-ai/remote"
import { encodeAttachment, attachmentLimit } from "./composer-attachment"

test("encodes a named image as canonical base64 data URL for the file input", async () => {
  const file = new File([new Uint8Array([0, 1, 2, 253, 254, 255])], "capture.png", { type: "image/png" })
  expect(await encodeAttachment(file)).toMatchObject({ name: "capture.png", size: 6, mime: "image/png", uri: "data:image/png;base64,AAEC/f7/" })
})

test("bounds each file and aggregate decoded bytes before reading or sending", async () => {
  expect(attachmentLimit([{ size: RemoteLimits.maxAttachmentBytes + 1, name: "large.png" }])).toContain("20 MiB")
  expect(attachmentLimit([{ size: RemoteLimits.maxAttachmentBytes, name: "one" }, { size: RemoteLimits.maxAttachmentBytes, name: "two" }])).toBeUndefined()
  expect(attachmentLimit([{ size: RemoteLimits.maxAttachmentBytes, name: "one" }, { size: RemoteLimits.maxAttachmentBytes, name: "two" }, { size: 1, name: "three" }])).toContain("40 MiB")
  expect(attachmentLimit([{ size: 0, name: "empty" }])).toContain("empty")
  expect(attachmentLimit([{ size: 1, name: "x".repeat(257) }])).toContain("256")
  const text = new File(["hello"], "readme.txt", { type: "text/plain" })
  expect(await encodeAttachment(text)).toMatchObject({ uri: `data:${text.type};base64,aGVsbG8=` })
})
