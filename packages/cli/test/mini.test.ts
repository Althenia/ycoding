import { describe, expect, test } from "bun:test"
import { V5ClientError, YCoding } from "@ycoding-ai/client/v5"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import path from "node:path"
import { createMiniConnection, mergeInput as mergeInteractiveInput, resolveMiniTarget } from "../src/mini"
import { mergeInput as mergeNonInteractiveInput, parseRunModel } from "../src/run/run"
import { parseSessionTargetModel } from "../src/session-target"
import { modelFixture, v5Server } from "./fixture/v5-server"

async function cli(args: string[], environment: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("mini command", () => {
  test("uses piped stdin as the initial prompt", () => {
    expect(mergeInteractiveInput("from stdin", undefined)).toBe("from stdin")
    expect(mergeInteractiveInput("from stdin", "from flag")).toBe("from stdin\nfrom flag")
  })

  test("constructs a fresh authenticated client for a replacement endpoint", async () => {
    const health = () => ({
      data: { healthy: true, version: InstallationVersion, pid: process.pid, sourceEpoch: "source-1" },
    })
    const initial = v5Server(health)
    const replacement = v5Server(health)
    const controller = new AbortController()
    let signal: AbortSignal | undefined

    try {
      const connection = createMiniConnection({
        endpoint: { url: initial.url },
        reconnect: async (next) => {
          signal = next
          return {
            url: replacement.url,
            auth: { type: "basic", username: "replacement", password: "secret" },
          }
        },
      })
      expect(connection.address()).toBe(initial.url)
      const client = await connection.reconnect?.(controller.signal)
      if (!client) throw new Error("Expected a replacement client")
      await client.health.get()

      expect(client).not.toBe(connection.sdk)
      expect(connection.sdk.transport.state).toBe("closed")
      expect(connection.address()).toBe(replacement.url)
      expect(signal).toBe(controller.signal)
      expect(replacement.authorizations).toEqual([`Basic ${btoa("replacement:secret")}`])
      const unmanaged = createMiniConnection({ endpoint: { url: initial.url } })
      expect(unmanaged.reconnect).toBeUndefined()
      unmanaged.close()
      connection.close()
      expect(client.transport.state).toBe("closed")
    } finally {
      await initial.close()
      await replacement.close()
    }
  })

  test("re-resolves a managed target when the endpoint moves before transport construction", async () => {
    const initial = YCoding.make({ endpoint: { url: "http://127.0.0.1:1" } })
    const replacement = YCoding.make({ endpoint: { url: "http://127.0.0.1:1" } })
    const controller = new AbortController()
    const seen: unknown[] = []
    let reconnects = 0

    const result = await resolveMiniTarget({
      sdk: initial,
      reconnect: async (signal) => {
        expect(signal).toBe(controller.signal)
        reconnects++
        if (reconnects === 1) throw new Error("service still moving")
        return replacement
      },
      signal: controller.signal,
      resolve: async (sdk) => {
        seen.push(sdk)
        if (sdk === initial) throw new V5ClientError("unavailable")
        return "ses-replacement"
      },
    })

    expect(seen).toEqual([initial, replacement])
    expect(reconnects).toBe(2)
    expect(result).toEqual({ sdk: replacement, value: "ses-replacement" })
    initial.transport.close()
    replacement.transport.close()
  })

  test("merges non-interactive argument and stdin input", () => {
    expect(mergeNonInteractiveInput("from args", "from stdin")).toBe("from args\nfrom stdin")
    expect(mergeNonInteractiveInput(undefined, "from stdin")).toBe("from stdin")
  })

  test("does not replay target resolution after an unknown mutation settlement", async () => {
    const client = YCoding.make({ endpoint: { url: "http://127.0.0.1:1" } })
    let resolutions = 0
    let reconnects = 0
    try {
      const result = await resolveMiniTarget({
        sdk: client,
        signal: new AbortController().signal,
        reconnect: async () => {
          reconnects++
          return client
        },
        resolve: async () => {
          resolutions++
          throw new V5ClientError("unknown", "session.create")
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(result).toMatchObject({ status: "unknown", operation: "session.create" })
      expect(resolutions).toBe(1)
      expect(reconnects).toBe(0)
    } finally {
      client.transport.close()
    }
  })

  test("parses model variants from the model reference", () => {
    expect(JSON.stringify(parseRunModel("openrouter/openai/gpt-5#high"))).toBe(
      JSON.stringify({ model: { providerID: "openrouter", modelID: "openai/gpt-5" }, variant: "high" }),
    )
    expect(parseSessionTargetModel("openrouter/openai/gpt-5#high")).toEqual({
      providerID: "openrouter",
      id: "openai/gpt-5",
      variant: "high",
    })
    expect(parseRunModel("Work#openrouter/openai/gpt-5#high")).toEqual({
      model: { providerID: "openrouter", modelID: "openai/gpt-5" },
      variant: "high",
      profile: "Work",
    })
    expect(parseSessionTargetModel("Work#openrouter/openai/gpt-5#high")).toEqual({
      providerID: "openrouter",
      id: "openai/gpt-5",
      variant: "high",
      profile: "Work",
    })
  })

  test("is registered in the preview CLI", async () => {
    const result = await cli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("mini       Start the minimal interactive interface")
    expect(result.stdout).toContain("run        Run YCoding with a message")
  })

  test("exposes run without legacy attach or command modes", async () => {
    const result = await cli(["run", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("--server string")
    expect(result.stdout).not.toContain("--variant")
    expect(result.stdout).not.toContain("--attach")
    expect(result.stdout).not.toContain("--command")
  })

  test("keeps option-like prompt text after the argument separator", async () => {
    const result = await cli(["run", "--server", "http://127.0.0.1:1", "--", "--foo"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toContain("You must provide a message")
  })

  test("preserves a run failure exit code", async () => {
    let models = 0
    const directory = process.cwd()
    const location = { directory, project: { id: "global", directory } }
    const server = v5Server((name) => {
      if (name === "health.get")
        return { data: { healthy: true, version: InstallationVersion, pid: process.pid, sourceEpoch: "source-1" } }
      if (name === "location.get") return { data: location }
      if (name === "model.list")
        return { location, data: ++models === 1 ? [modelFixture("definitely", "missing")] : [] }
      throw new Error(name)
    })

    try {
      const result = await cli(["run", "--server", server.url, "--model", "definitely/missing", "hi"])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Model unavailable: definitely/missing")
    } finally {
      await server.close()
    }
  })

  test("reports pre-admission errors as JSON", async () => {
    const directory = process.cwd()
    const server = v5Server((name) => {
      if (name === "health.get")
        return { data: { healthy: true, version: "incompatible", pid: process.pid, sourceEpoch: "source-1" } }
      if (name === "location.get") return { data: { directory, project: { id: "global", directory } } }
      if (name === "model.default") return { location: { directory, project: { id: "global", directory } }, data: {} }
      if (name === "session.create") return new Error("Scripted rejection")
      throw new Error(name)
    })

    try {
      const result = await cli(["run", "--format", "json", "--server", server.url, "hi"])

      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        type: "error",
        sessionID: "",
        error: { type: "unknown", message: "Scripted rejection" },
      })
    } finally {
      await server.close()
    }
  })

  test("uses the shared server option instead of an attach command", async () => {
    const result = await cli(["mini", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("--server string")
    expect(result.stdout).not.toContain("SUBCOMMANDS")
  })

  test("routes local and explicit-server invocations into mini", async () => {
    for (const args of [["mini"], ["mini", "--server", "http://127.0.0.1:1"]]) {
      const result = await cli(args)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("ycoding mini requires a TTY stdout")
    }
  })
})
