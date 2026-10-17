import { describe, expect, test } from "bun:test"
import { Shell } from "@ycoding-ai/schema/shell"
import { Schema, Struct } from "effect"

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

  test("preserves queued shell positions and admission timestamps", () => {
    const info = {
      id: Shell.ID.make("sh_queued"),
      status: "queued" as const,
      command: "printf ready",
      cwd: "/workspace",
      shell: "/bin/sh",
      file: "/workspace/output",
      metadata: {},
      queuePosition: 1,
      time: { started: 0, queued: 20 },
    }
    const decode = Schema.decodeUnknownSync(Shell.Info)
    expect(decode(info)).toEqual(info)
    for (const queuePosition of [0, -1, 1.5]) expect(() => decode({ ...info, queuePosition })).toThrow()
    expect(
      decode({ ...Struct.omit(info, ["queuePosition"]), status: "running", time: { started: 30, queued: 20 } }).time,
    ).toEqual({ started: 30, queued: 20 })
    expect(Shell.Event.Definitions.map((event) => event.type)).toContain("shell.updated")
  })
})
