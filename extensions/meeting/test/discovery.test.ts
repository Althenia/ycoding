import { expect, test } from "bun:test"
import { validateDescriptor } from "../src/discovery"

test("native meeting discovery refuses public hosts and malformed credentials", () => {
  expect(() => validateDescriptor({ url: "http://example.org:9000", token: "x".repeat(64), pid: 12 })).toThrow()
  expect(() => validateDescriptor({ url: "http://127.0.0.1:9000", token: "short", pid: 12 })).toThrow()
  expect(validateDescriptor({ url: "http://127.0.0.1:9000", token: "a".repeat(64), pid: 12 }).pid).toBe(12)
})
