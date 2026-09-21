import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@ycoding-ai/core/global"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agentURL, assertEnrolledRelay, read, relayURL } from "../src/remote-config"

async function withHome<A>(run: (root: string) => Promise<A>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-remote-config-"))
  try {
    return await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function provide(root: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") }),
        ),
        Effect.provide(NodeFileSystem.layer),
      ) as Effect.Effect<A, E, never>,
    )
}

describe("relay URL resolution", () => {
  test("prefers the flag, then the environment, then the stored configuration", async () => {
    await withHome(async (root) => {
      await expect(provide(root)(relayURL())).rejects.toThrow(/relay URL/)
      expect(await provide(root)(relayURL({ flag: "https://flag.example" }))).toBe("https://flag.example")
      expect(await provide(root)(relayURL({ env: "https://env.example" }))).toBe("https://env.example")
      expect(await provide(root)(relayURL({ flag: "https://flag.example", env: "https://env.example" }))).toBe(
        "https://flag.example",
      )
    })
  })

  test("rejects insecure or credential-bearing relay URLs and derives the agent socket", async () => {
    await withHome(async (root) => {
      await expect(provide(root)(relayURL({ flag: "http://relay.example" }))).rejects.toThrow(/HTTPS/)
      await expect(provide(root)(relayURL({ flag: "not a url" }))).rejects.toThrow(/HTTPS/)
      await expect(provide(root)(relayURL({ flag: "https://user:pass@relay.example" }))).rejects.toThrow(/credentials/)
      await expect(provide(root)(relayURL({ flag: "https://relay.example?a=b" }))).rejects.toThrow(/query or fragment/)
      await expect(provide(root)(relayURL({ flag: "https://relay.example/ws/agent" }))).rejects.toThrow(/without a path/)
      expect(await provide(root)(relayURL({ flag: "https://relay.example/" }))).toBe("https://relay.example")
      expect(await provide(root)(relayURL({ flag: "http://127.0.0.1:8787" }))).toBe("http://127.0.0.1:8787")
      expect(agentURL("https://relay.example")).toBe("wss://relay.example/ws/v3/agent")
      expect(agentURL("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/ws/v3/agent")
      expect(assertEnrolledRelay({ requested: "https://relay.example", enrolled: "https://relay.example/" })).toBe(
        "https://relay.example",
      )
      expect(() =>
        assertEnrolledRelay({ requested: "https://other.example", enrolled: "https://relay.example" }),
      ).toThrow(/Refusing to send device credentials/)
    })
  })
})

describe("legacy remote configuration", () => {
  test("reads existing data without using or rewriting its session entries", async () => {
    await withHome(async (root) => {
      const file = path.join(root, "config", "remote.json")
      await fs.mkdir(path.dirname(file), { recursive: true })
      const text = JSON.stringify({ relayURL: "https://relay.example", sessions: [{ sessionID: "ses_old", directory: "/old" }] })
      await fs.writeFile(file, text)
      expect(await provide(root)(read())).toMatchObject({ relayURL: "https://relay.example" })
      expect(await fs.readFile(file, "utf8")).toBe(text)
    })
  })

  test("fails explicitly on malformed data and preserves it", async () => {
    await withHome(async (root) => {
      const file = path.join(root, "config", "remote.json")
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, "{ not json")
      await expect(provide(root)(read())).rejects.toThrow(/remote configuration/)
      expect(await fs.readFile(file, "utf8")).toBe("{ not json")
    })
  })
})
