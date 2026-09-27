import { expect, test } from "bun:test"
import { attachmentKey, toolContentKey } from "./conversation"

test("managed image rows keep one identity across fresh snapshot objects and distinguish repeated files", () => {
  const file = { name: "screen.png", mime: "image/png", bytes: 3, digest: "a".repeat(64) }
  expect(attachmentKey(file, 0)).toBe(attachmentKey({ ...file }, 0))
  expect(attachmentKey(file, 0)).not.toBe(attachmentKey(file, 1))
  expect(attachmentKey(file, 0)).not.toBe(attachmentKey({ ...file, digest: "b".repeat(64) }, 0))
})

test("tool image rows keep their ordinal identity when content is reprojected", () => {
  const image = { kind: "image" as const, uri: "data:image/png;base64,AAEC", mime: "image/png", name: "plot.png" }
  expect(toolContentKey(image, 0)).toBe(toolContentKey({ ...image }, 0))
  expect(toolContentKey(image, 0)).not.toBe(toolContentKey(image, 1))
  expect(toolContentKey(image, 0)).not.toBe(toolContentKey({ kind: "text", text: "result" }, 0))
})
