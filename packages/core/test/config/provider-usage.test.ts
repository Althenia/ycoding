import { describe, expect, test } from "bun:test"
import { Config } from "@ycoding-ai/core/config"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(Config.Info)

describe("Config provider usage", () => {
  test("accepts an explicit bounded Codex app-server command", () => {
    expect(
      decode({
        provider_usage: {
          codex_app_server: {
            command: "/usr/local/bin/codex",
            args: ["app-server", "--stdio"],
            cwd: "/workspace",
            timeout_ms: 5000,
          },
        },
      }),
    ).toMatchObject({
      provider_usage: {
        codex_app_server: {
          command: "/usr/local/bin/codex",
          args: ["app-server", "--stdio"],
          cwd: "/workspace",
          timeout_ms: 5000,
        },
      },
    })
  })

  test("rejects shell fragments and excessive timeouts only through explicit field validation", () => {
    expect(() =>
      decode({ provider_usage: { codex_app_server: { command: "", timeout_ms: 30_001 } } }),
    ).toThrow()
  })
})
