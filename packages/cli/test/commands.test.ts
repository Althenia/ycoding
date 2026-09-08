import { describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"

const cli = path.resolve(import.meta.dir, "../src/tui.ts")
setDefaultTimeout(30_000)

describe("shipped TUI command surface", () => {
  test.each([
    [[], "run", "update"],
    [["run"], "Run YCoding with a message", "--model"],
    [["update"], "Update ycoding", "--version"],
  ])("shows the expected help for %j", async (args, first, second) => {
    const result = Bun.spawnSync([process.execPath, cli, ...args, "--help"], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain(first)
    expect(result.stdout.toString()).toContain(second)
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
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "--model",
        "test/model",
        "prompt_xyz",
        "--session",
        "ses_test",
        "--server",
        server.url.toString(),
      ],
      { cwd: path.resolve(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [exitCode] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(1)
    } finally {
      clearTimeout(timeout)
    }
    expect(calls.map((call) => call.path)).toContain("/api/session/ses_test/model")
    expect(calls.find((call) => call.path === "/api/session/ses_test/model")?.body).toEqual({
      model: { providerID: "test", id: "model" },
    })
    expect(calls.find((call) => call.path === "/api/session/ses_test/prompt")?.body).toMatchObject({
      text: "prompt_xyz",
    })
  })

  test("root --model without a prompt fails instead of silently opening the TUI", () => {
    const result = Bun.spawnSync([process.execPath, cli, "--model", "test/model"], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("--model requires a positional prompt")
  })
})
