import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRemoteConnector } from "../src/commands/handlers/remote/connector"
import { privateLocalServer } from "../src/commands/handlers/remote/connect"
import { RemoteAgent } from "../src/remote-bridge"
import { createLocalServer } from "../src/remote-local"

describe("shared remote connector", () => {
  test("refuses a nonprivate TUI backend before bridging it to the relay", () => {
    expect(() => privateLocalServer({ url: "http://192.0.2.10:4096" })).toThrow()
    expect(() => privateLocalServer({ url: "http://127.0.0.1:4096" })).not.toThrow()
  })

  test("connects and disconnects an actual bridge through an isolated fake relay", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-connector-"))
    let connections = 0
    let disconnections = 0
    const diagnostics: string[] = []
    const local = new Proxy(createLocalServer({ url: "http://127.0.0.1:1" }), {
      get: (_target, method) => {
        if (method === "listPage") return async () => ({ data: [] })
        if (method === "events") return async () => async () => {}
        if (method === "activeSessions") return async () => ({})
        return async () => []
      },
    })
    const connector = createRemoteConnector({
      directory, notice: "All backend Sessions are available to the owner.",
      onDiagnostic: (message) => diagnostics.push(message),
      makeBridge: (hooks) => new RemoteAgent({
        relayURL: "https://relay.invalid",
        local,
        credentials: async () => ({ accessToken: "synthetic-token", accessExpiresAt: Date.now() + 600_000 }),
        createConnection: (input) => ({
          connect: async () => { connections++; input.onOpen() },
          send: async () => {},
          onMessage: () => {},
          disconnect: async () => { disconnections++ },
        }),
        refreshIntervalMs: 3_600_000,
        onDiagnostic: hooks.onDiagnostic,
        onTerminal: hooks.onTerminal,
      }),
    })
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      await connector.start()
      expect(connector.status().state).toBe("on")
      expect(connections).toBe(1)
      await connector.stop()
      expect(connector.status().state).toBe("off")
      expect(disconnections).toBe(1)
      expect(diagnostics.every((message) => typeof message === "string")).toBe(true)
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
      await connector.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("starts one bridge, reports contention, then disconnects and releases the lock", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-connector-"))
    const calls: string[] = []
    try {
      const create = () => createRemoteConnector({
        directory,
        notice: "All backend Sessions are available to the machine owner.",
        makeBridge: () => ({
          connect: async () => { calls.push("connect") },
          close: async () => { calls.push("close") },
        }),
      })
      const first = create()
      const second = create()
      await first.start()
      expect(first.status()).toMatchObject({ state: "on", notice: "All backend Sessions are available to the machine owner." })
      await second.start()
      expect(second.status()).toMatchObject({ state: "other-process", message: expect.stringContaining("another process") })
      expect(calls).toEqual(["connect"])
      await first.stop()
      expect(first.status().state).toBe("off")
      await second.start()
      expect(second.status().state).toBe("on")
      await second.stop()
      expect(calls).toEqual(["connect", "close", "connect", "close"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("two simultaneous starts admit only one bridge", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-connector-"))
    let connections = 0
    const make = () => createRemoteConnector({
      directory, notice: "Owner access",
      makeBridge: () => ({ connect: async () => { connections++ }, close: async () => {} }),
    })
    const first = make()
    const second = make()
    try {
      await Promise.all([first.start(), second.start()])
      expect([first.status().state, second.status().state].sort()).toEqual(["on", "other-process"])
      expect(connections).toBe(1)
    } finally {
      await Promise.all([first.stop(), second.stop()])
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reports terminal failure and frees ownership without writing to stderr", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-connector-"))
    const diagnostics: string[] = []
    let terminal: ((message: string) => void) | undefined
    try {
      const connector = createRemoteConnector({
        directory, notice: "Owner access",
        onDiagnostic: (message) => diagnostics.push(message),
        makeBridge: (hooks) => {
          terminal = hooks.onTerminal
          return { connect: async () => hooks.onDiagnostic("connected"), close: async () => {} }
        },
      })
      await connector.start()
      terminal?.("Relay rejected the device")
      await connector.settled()
      expect(diagnostics).toEqual(["connected"])
      expect(connector.status()).toMatchObject({ state: "error", message: "Relay rejected the device" })
      const next = createRemoteConnector({ directory, notice: "Owner access", makeBridge: () => ({ connect: async () => {}, close: async () => {} }) })
      await next.start()
      expect(next.status().state).toBe("on")
      await next.stop()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
