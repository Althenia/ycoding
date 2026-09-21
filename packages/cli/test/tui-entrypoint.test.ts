import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function isolatedEnv(root: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: root,
    YCODING_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  delete env.YCODING_DB
  delete env.YCODING_PASSWORD
  delete env.YCODING_CONFIG_DIR
  delete env.YCODING_CONFIG
  delete env.YCODING_REMOTE_URL
  return env
}

async function tui(args: readonly string[], env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn([process.execPath, "run", "src/tui.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function withHome<A>(run: (root: string) => Promise<A>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-tui-entrypoint-"))
  try {
    return await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("TUI entrypoint", () => {
  test("registers remote subcommands and dispatches their existing handlers", async () => {
    const help = await tui(["remote", "--help"])

    expect(help.exitCode).toBe(0)
    for (const command of ["enroll", "connect", "status", "sessions"]) {
      expect(help.stdout).toContain(command)
    }

    await withHome(async (root) => {
      const status = await tui(["remote", "status"], isolatedEnv(root))

      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain("Not enrolled")
    })
  })
})
