import { describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { modelFixture, sessionFixture, v5Server } from "./fixture/v5-server"

const cli = path.resolve(import.meta.dir, "../src/tui.ts")
setDefaultTimeout(30_000)

describe("shipped TUI command surface", () => {
  test.each([
    [[], "run", "update"],
    [["update"], "Update ycoding", "--version"],
  ] as const)("shows the expected help for %j", async (args, first, second) => {
    const result = await spawnCli([...args, "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(first)
    expect(result.stdout).toContain(second)
  })

  test("run help exposes model selection and durable YOLO levels", async () => {
    const result = await spawnCli(["run", "--help"])
    expect(result.exitCode).toBe(0)
    for (const text of [
      "Run YCoding with a message",
      "--model",
      "--yolo",
      "choices: 0, 1, 2, 3",
      "Set durable Session YOLO level",
      "omitted preserves it",
    ])
      expect(result.stdout).toContain(text)
    expect(result.stdout).not.toContain("--auto")
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
  test("run rejects --auto", async () => {
    const result = await spawnCli(["run", "hello", "--auto"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("--auto")
  })
  test.each([0, 1, 2, 3] as const)("run persists --yolo %d before prompt admission", async (level) => {
    const result = await runTransport(["--yolo", String(level)])
    expect(result.exitCode).toBe(1)
    expect(result.calls.filter((call) => call.name === "session.autonomy.set")).toEqual([
      { name: "session.autonomy.set", body: { yolo: level } },
    ])
    expect(result.calls.findIndex((call) => call.name === "session.autonomy.set")).toBeLessThan(
      result.calls.findIndex((call) => call.name === "session.prompt"),
    )
  })
  test("run without --yolo preserves adopted Session autonomy", async () => {
    const result = await runTransport([])
    expect(result.exitCode).toBe(1)
    expect(result.calls.some((call) => call.name === "session.autonomy.set")).toBe(false)
    expect(result.calls.some((call) => call.name === "session.prompt")).toBe(true)
  })
  test("run does not admit a prompt when the autonomy update fails", async () => {
    const result = await runTransport(["--yolo", "2"], true)
    expect(result.exitCode).toBe(1)
    expect(result.calls.some((call) => call.name === "session.autonomy.set")).toBe(true)
    expect(result.calls.some((call) => call.name === "session.prompt")).toBe(false)
  })
  test("root --model forwards the prompt and session through v5", async () => {
    const result = await runTransport([], false, true)
    expect(result.exitCode).toBe(1)
    expect(result.calls.find((call) => call.name === "session.switchModel")?.body).toEqual({
      model: { providerID: "test", id: "model" },
    })
    expect(result.calls.find((call) => call.name === "session.prompt")?.body).toMatchObject({ text: "prompt_xyz" })
  })
  test("root --model without a prompt fails instead of opening the TUI", async () => {
    const result = await spawnCli(["--model", "test/model"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("--model requires a positional prompt")
  })
})

async function runTransport(args: string[], rejectAutonomy = false, root = false) {
  const calls: { name: string; body: unknown }[] = []
  const directory = import.meta.dir
  const location = { directory, project: { id: "global", directory } }
  const server = v5Server((name, data) => {
    const body = typeof data === "object" && data !== null && "payload" in data ? data.payload : undefined
    calls.push({ name, body })
    if (name === "health.get")
      return { data: { healthy: true, version: "local", pid: process.pid, sourceEpoch: "source-1" } }
    if (name === "session.get") return { data: sessionFixture("ses_test", directory) }
    if (name === "location.get") return { data: location }
    if (name === "model.list") return { location, data: [modelFixture()] }
    if (name === "session.switchModel") return { data: {} }
    if (name === "session.autonomy.set")
      return rejectAutonomy
        ? new Error("Rejected")
        : {
            data: { mode: "normal", yolo: typeof body === "object" && body !== null && "yolo" in body ? body.yolo : 0 },
          }
    if (name === "session.prompt") return new Error("Stop after transport assertions")
    throw new Error(name)
  })
  try {
    const command = root ? ["--model", "test/model", "prompt_xyz"] : ["run", "hello", "--model", "test/model"]
    return { calls, ...(await spawnCli([...command, "--session", "ses_test", "--server", server.url, ...args])) }
  } finally {
    await server.close()
  }
}

async function spawnCli(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
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
