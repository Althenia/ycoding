import { describe, expect, test } from "bun:test"
import { Shell } from "@ycoding-ai/schema/shell"
import { Schema } from "effect"

describe("Shell", () => {
  test("decodes optional process-tree memory limits", () => {
    const decode = Schema.decodeUnknownSync(Shell.CreateInput)

    expect(decode({ command: "bun run typecheck", timeout: 0 })).not.toHaveProperty("memoryLimitMb")
    expect(decode({ command: "bun run typecheck", timeout: 0, memoryLimitMb: 2048 }).memoryLimitMb).toBe(2048)
    expect(() => decode({ command: "bun run typecheck", timeout: 0, memoryLimitMb: -1 })).toThrow()
    expect(() => decode({ command: "bun run typecheck", timeout: 0, memoryLimitMb: 1.5 })).toThrow()
    expect(() =>
      decode({ command: "bun run typecheck", timeout: 0, memoryLimitMb: Shell.MAX_MEMORY_LIMIT_MB + 1 }),
    ).toThrow()
  })

  test("exposes memory-limit as a terminal status", () => {
    expect(Schema.decodeUnknownSync(Shell.Status)("memory-limit")).toBe("memory-limit")
  })
})
