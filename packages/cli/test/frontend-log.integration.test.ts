import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ptyOutput } from "./pty-output"

const fixture = path.join(import.meta.dir, "frontend-log-pty.fixture.ts")
const ptyTest = process.platform === "win32" ? test.skip : test

describe("frontend logs", () => {
  ptyTest("go to the active log file, not the terminal the TUI renders on", async () => {
    await using profile = await isolatedProfile()
    const terminal = await runFixture(profile.env)
    expect(terminal).toContain("FIXTURE-DONE")
    expect(terminal).not.toContain("event stream connected")
    const file = path.join(profile.data, "ycoding", "log", "ycoding-local.log")
    expect(await readFile(file, "utf8")).toMatch(/ level=INFO .*message="event stream connected" component=client/)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700)
  })

  ptyTest("also reach the terminal when YCODING_PRINT_LOGS is 1", async () => {
    await using profile = await isolatedProfile()
    const terminal = await runFixture({ ...profile.env, YCODING_PRINT_LOGS: "1" })
    expect(terminal).toContain('message="event stream connected" component=client')
    const file = path.join(profile.data, "ycoding", "log", "ycoding-local.log")
    expect(await readFile(file, "utf8")).toContain('message="event stream connected" component=client')
  })
})

async function isolatedProfile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-frontend-log-"))
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: "xterm-256color",
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
  delete env.YCODING_PRINT_LOGS
  delete env.YCODING_CONFIG_DIR
  return {
    env,
    data: path.join(root, "data"),
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function runFixture(env: Record<string, string | undefined>) {
  const output = ptyOutput()
  const child = Bun.spawn([process.execPath, fixture], {
    env,
    terminal: {
      cols: 120,
      rows: 30,
      data(_terminal, data) {
        output.data(data)
      },
      exit(_terminal, code) {
        output.exit(code)
      },
    },
  })
  const text = await output.waitFor("FIXTURE-DONE")
  expect(await child.exited).toBe(0)
  child.terminal!.close()
  return text
}
