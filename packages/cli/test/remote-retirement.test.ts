import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { RemoteCommand } from "../src/commands/remote"
import { createRemoteHost } from "../src/remote-host"
import { createRemoteConnector } from "../src/commands/handlers/remote/connector"
import { RemoteAgent } from "../src/remote-bridge"
import type { LocalServer } from "../src/remote-local"

test("remote command tree contains only enrollment, connection and session commands", () => {
  expect(Object.keys(RemoteCommand.commands).sort()).toEqual(["connect", "disconnect", "enroll", "sessions", "status"])
})

test("remote start and stop leave retired MCP state untouched and create only the browser connector", async () => {
  const directory = await mkdtemp(path.join(import.meta.dir, ".remote-retirement-"))
  const saved = '{"enabled":true,"epoch":"synthetic-retired-epoch"}'
  await writeFile(path.join(directory, "remote-mcp.json"), saved)
  const started = Promise.withResolvers<void>()
  const argumentsSeen: unknown[][] = []
  const host = await createRemoteHost({
    file: path.join(directory, "remote.json"),
    create: async (...args) => {
      argumentsSeen.push(args)
      const connector = createRemoteConnector({ directory, notice: "Synthetic owner access", makeBridge: () => ({ connect: async () => {}, close: async () => {} }) })
      connector.subscribe((status) => { if (status.state === "on") started.resolve() })
      return connector
    },
  })
  try {
    expect(Object.keys(host).sort()).toEqual(["set", "shutdown", "status"])
    await host.set(true)
    await started.promise
    expect((await host.status()).state).toBe("on")
    expect(argumentsSeen).toEqual([[]])
    await host.set(false)
    expect((await host.status()).state).toBe("off")
    expect(await Bun.file(path.join(directory, "remote-mcp.json")).text()).toBe(saved)
  } finally {
    await host.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

test("browser connector rejects retired MCP and app preview requests without local dispatch", async () => {
  const calls: string[] = []
  const local = new Proxy({} as LocalServer, {
    get: (_target, name) => async () => {
      calls.push(String(name))
      if (name === "listPage" || name === "completions") return { data: [] }
      if (name === "outstandingSessions") return { data: [], running: [], failed: [], lost: [] }
      if (name === "events") return async () => {}
      return []
    },
  })
  let receive: (frame: unknown) => void = () => {}
  const replies = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
  const agent = new RemoteAgent({
    local, relayURL: "https://relay.example.invalid",
    credentials: async () => ({ accessToken: "synthetic-access", accessExpiresAt: Date.now() + 600_000 }),
    createConnection: (input) => ({
      connect: async () => input.onOpen(), disconnect: async () => {},
      onMessage: (handler) => { receive = handler },
      send: async (raw) => {
        const frame = JSON.parse(raw)
        if (frame.type === "response") replies.get(frame.id)?.resolve(frame)
      },
    }),
  })
  try {
    expect("mcpEvents" in agent).toBe(false)
    await agent.connect()
    const before = calls.length
    for (const [index, operation] of ["mcp.request", "preview.request", "local.app.open", "artifact.demo.preview"].entries()) {
      const id = `req_retired_${index}`
      const result = Promise.withResolvers<unknown>()
      replies.set(id, result)
      const timeout = setTimeout(() => result.reject(new Error(`No response for retired operation ${operation}`)), 1_000)
      try {
        receive({ type: "request", id, operation, input: {} })
        expect(await result.promise).toMatchObject({ type: "response", id, ok: false, error: { code: "unknown_operation" } })
      } finally {
        clearTimeout(timeout)
        replies.delete(id)
      }
    }
    expect(calls.slice(before).some((name) => /mcp|preview|app/i.test(name))).toBe(false)
  } finally {
    await agent.close()
  }
})
