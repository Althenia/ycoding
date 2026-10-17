import { describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cli = path.resolve(import.meta.dir, "../src/tui.ts")
setDefaultTimeout(30_000)

describe("shipped TUI command surface", () => {
  test.each([
    [[], "run", "update"],
    [["update"], "Update ycoding", "--version"],
  ])("shows the expected help for %j", async (args, first, second) => {
    const result = await spawnCli([...args, "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(first)
    expect(result.stdout).toContain(second)
  })

  test("run help describes the command, exposes --model and the durable YOLO levels, and removes --auto", async () => {
    const result = await spawnCli(["run", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Run YCoding with a message")
    expect(result.stdout).toContain("--model")
    expect(result.stdout).toContain("--yolo")
    expect(result.stdout).toContain("choices: 0, 1, 2")
    expect(result.stdout).not.toContain("choices: 0, 1, 2, 3")
    expect(result.stdout).toContain("Set durable Session YOLO level")
    expect(result.stdout).toContain("omitted preserves it")
    expect(result.stdout).not.toContain("--auto")
  })

  test("run help exposes the per-run config document and isolated data directory flags", async () => {
    const result = await spawnCli(["run", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("--config")
    expect(result.stdout).toContain("highest-priority layer of a private server")
    expect(result.stdout).toContain("--isolated")
    expect(result.stdout).toContain("stored credentials are unavailable")
  })

  test.each([
    [["--config", "missing.json", "--server", "http://127.0.0.1:9"], "cannot be combined with --server"],
    [["--isolated", "--server", "http://127.0.0.1:9"], "cannot be combined with --server"],
    [["--config", "missing-run-config.json"], "Cannot read --config file"],
  ])("run rejects %j before starting a server", async (args, message) => {
    const result = await spawnCli(["run", "hello", ...args])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain(message)
  })

  test("run rejects an unparsable --config document and a competing YCODING_CONFIG_CONTENT", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-run-config-"))
    try {
      const invalid = path.join(directory, "invalid.jsonc")
      const valid = path.join(directory, "valid.jsonc")
      await fs.writeFile(invalid, "{ \"capabilities\": ")
      await fs.writeFile(valid, "{ // per-run\n \"capabilities\": { \"home_roots\": false, }, }")
      const parsed = await spawnCli(["run", "hello", "--config", invalid])
      expect(parsed.exitCode).not.toBe(0)
      expect(parsed.stdout + parsed.stderr).toContain("is not valid JSON/JSONC")
      const competing = await spawnCli(["run", "hello", "--config", valid], { YCODING_CONFIG_CONTENT: "{}" })
      expect(competing.exitCode).not.toBe(0)
      expect(competing.stdout + competing.stderr).toContain("--config cannot be combined with YCODING_CONFIG_CONTENT")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test.each(["4", "-1", "true"])("run rejects invalid --yolo level %s", async (level) => {
    const result = await spawnCli(["run", "hello", "--yolo", level])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).not.toBe("")
  })

  test("run requires an explicit --yolo value", async () => {
    const result = await spawnCli(["run", "hello", "--yolo"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("--yolo")
  })

  test("run rejects the removed --auto flag", async () => {
    const result = await spawnCli(["run", "hello", "--auto"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("--auto")
  })

  test("run rejects level 3 before contacting the server", async () => {
    const result = await runTransport(["--yolo", "3"])
    expect(result.exitCode).not.toBe(0)
    expect(result.calls).toEqual([])
  })

  test.each([0, 1, 2] as const)("run persists --yolo %d before prompt admission", async (level) => {
    const result = await runTransport(["--yolo", String(level)])
    expect(result.exitCode).toBe(1)
    expect(result.calls.filter((call) => call.path.endsWith("/autonomy"))).toEqual([
      expect.objectContaining({ method: "PUT", body: { yolo: level } }),
    ])
    expect(result.calls.findIndex((call) => call.path.endsWith("/autonomy"))).toBeLessThan(
      result.calls.findIndex((call) => call.path.endsWith("/prompt")),
    )
  })

  test("run without --yolo preserves adopted Session autonomy", async () => {
    const result = await runTransport([])
    expect(result.exitCode).toBe(1)
    expect(result.calls.some((call) => call.path.endsWith("/autonomy"))).toBe(false)
    expect(result.calls.some((call) => call.path.endsWith("/prompt"))).toBe(true)
  })

  test("run does not admit a prompt when the autonomy update fails", async () => {
    const result = await runTransport(["--yolo", "2"], { autonomyStatus: 500 })
    expect(result.exitCode).toBe(1)
    expect(result.calls.some((call) => call.path.endsWith("/autonomy"))).toBe(true)
    expect(result.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false)
  })

  test("root --model forwards the prompt and session through the run transport", async () => {
    const calls: Array<{ path: string; body?: unknown }> = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        const body = request.method === "POST" ? await request.json() : undefined
        calls.push({ path: url.pathname, body })
        if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "local", pid: process.pid })
        if (url.pathname === "/api/session/ses_test" && request.method === "GET")
          return Response.json({ data: { id: "ses_test", location: { directory: import.meta.dir } } })
        if (url.pathname === "/api/location") return Response.json({ directory: import.meta.dir })
        if (url.pathname === "/api/model") return Response.json({ data: [{ providerID: "test", id: "model" }] })
        if (url.pathname === "/api/session/ses_test/model") return new Response(null, { status: 204 })
        if (url.pathname === "/api/event")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ id: "evt_connected", created: 0, type: "server.connected", data: {} })}\n\n`,
                  ),
                )
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        if (url.pathname === "/api/session/ses_test/prompt")
          return Response.json({ error: "stop after transport assertion" }, { status: 500 })
        return Response.json({ error: `unexpected ${request.method} ${url.pathname}` }, { status: 404 })
      },
    })
    const result = await spawnCli(["--model", "test/model", "prompt_xyz", "--session", "ses_test", "--server", server.url.toString()])
    expect(result.exitCode).toBe(1)
    expect(calls.map((call) => call.path)).toContain("/api/session/ses_test/model")
    expect(calls.find((call) => call.path === "/api/session/ses_test/model")?.body).toEqual({
      model: { providerID: "test", id: "model" },
    })
    expect(calls.find((call) => call.path === "/api/session/ses_test/prompt")?.body).toMatchObject({
      text: "prompt_xyz",
    })
  })

  test("root --model without a prompt fails instead of silently opening the TUI", async () => {
    const result = await spawnCli(["--model", "test/model"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("--model requires a positional prompt")
  })
})

async function runTransport(args: string[], options: { autonomyStatus?: number } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "POST" || request.method === "PUT" ? await request.json() : undefined
      calls.push({ method: request.method, path: url.pathname, body })
      if (url.pathname === "/api/health") return Response.json({ healthy: true, version: "local", pid: process.pid })
      if (url.pathname === "/api/session/ses_yolo" && request.method === "GET")
        return Response.json({ data: { id: "ses_yolo", location: { directory: import.meta.dir } } })
      if (url.pathname === "/api/location") return Response.json({ directory: import.meta.dir })
      if (url.pathname === "/api/model") return Response.json({ data: [{ providerID: "test", id: "model" }] })
      if (url.pathname === "/api/session/ses_yolo/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_yolo/autonomy") {
        if (options.autonomyStatus)
          return Response.json({ error: "autonomy update failed" }, { status: options.autonomyStatus })
        const yolo = Reflect.get(body ?? {}, "yolo")
        return Response.json({ data: { mode: "normal", yolo,
          effective: { yolo, asleep: false, guardrailsEnabled: true, ordinaryReviewsAuto: yolo === 2, modelReviews: false, hardModelReviews: false } } })
      }
      if (url.pathname === "/api/event")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ id: "evt_connected", created: 0, type: "server.connected", data: {} })}\n\n`,
                ),
              )
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      if (url.pathname === "/api/session/ses_yolo/prompt")
        return Response.json({ error: "stop after transport assertion" }, { status: 500 })
      return Response.json({ error: `unexpected ${request.method} ${url.pathname}` }, { status: 404 })
    },
  })
  const result = await spawnCli(["run", "hello", "--session", "ses_yolo", "--model", "test/model", "--server", server.url.toString(), ...args])
  return { calls, ...result }
}

async function spawnCli(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    child.kill()
  }
}
