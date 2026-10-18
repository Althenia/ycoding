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

describe("shell lifecycle contract", () => {
  test("accepts only running and terminal process statuses", () => {
    const decode = Schema.decodeUnknownSync(Shell.Status)
    for (const status of ["running", "exited", "timeout", "memory-limit", "killed"] as const) {
      expect(decode(status)).toBe(status)
    }
    expect(() => decode("queued")).toThrow()
  })

  test("exposes process timing and metadata without scheduler fields", () => {
    expect(Object.keys(Shell.Time.fields).sort()).toEqual(["completed", "started"])
    expect(Object.keys(Shell.Info.fields).sort()).toEqual([
      "command",
      "cwd",
      "exit",
      "file",
      "id",
      "metadata",
      "pid",
      "shell",
      "status",
      "time",
      "toolCallID",
    ])
  })

  test("publishes only process creation, exit, and deletion events", () => {
    expect(Shell.Event.Definitions.map((event) => event.type).sort()).toEqual([
      "shell.created",
      "shell.deleted",
      "shell.exited",
    ])
  })
})
