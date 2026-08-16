import { expect, test } from "bun:test"
import {
  DEFAULT_INSTRUCTION_MAX_BYTES,
  MAX_INSTRUCTION_MAX_BYTES,
  renderInstructionContent,
} from "@ycoding-ai/core/instruction-content"

test("keeps instruction content unchanged within the UTF-8 byte budget", () => {
  const result = renderInstructionContent({
    source: "/repo/AGENTS.md",
    content: "สวัสดี",
    maxBytes: 18,
    retrieval: "read",
  })

  expect(result).toMatchObject({ content: "สวัสดี", bytes: 18, omitted: false })
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
})

test("omits oversized local instructions without retaining a partial prefix", () => {
  const content = "secret-rule\n".repeat(10)
  const result = renderInstructionContent({
    source: "/repo/AGENTS.md",
    content,
    maxBytes: 32,
    retrieval: "read",
  })

  expect(result.omitted).toBe(true)
  expect(result.bytes).toBe(new TextEncoder().encode(content).byteLength)
  expect(result.content).toContain("exceeds the 32-byte inline limit")
  expect(result.content).toContain("read tool")
  expect(result.content).toContain("/repo/AGENTS.md")
  expect(result.content).toContain(result.digest)
  expect(result.content).not.toContain("secret-rule")
})

test("uses webfetch for oversized remote instructions", () => {
  const result = renderInstructionContent({
    source: "https://example.com/instructions.md",
    content: "x".repeat(100),
    maxBytes: 10,
    retrieval: "webfetch",
  })

  expect(result.content).toContain("webfetch tool")
  expect(result.content).not.toContain("read tool")
})

test("digest changes with source bytes even when omitted size stays equal", () => {
  const left = renderInstructionContent({
    source: "/repo/AGENTS.md",
    content: "a".repeat(100),
    maxBytes: 10,
    retrieval: "read",
  })
  const right = renderInstructionContent({
    source: "/repo/AGENTS.md",
    content: "b".repeat(100),
    maxBytes: 10,
    retrieval: "read",
  })

  expect(left.bytes).toBe(right.bytes)
  expect(left.digest).not.toBe(right.digest)
  expect(left.content).not.toBe(right.content)
})

test("publishes bounded defaults", () => {
  expect(DEFAULT_INSTRUCTION_MAX_BYTES).toBe(51_200)
  expect(MAX_INSTRUCTION_MAX_BYTES).toBe(1_048_576)
})
