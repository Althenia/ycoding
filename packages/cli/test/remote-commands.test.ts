import { describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSession, password, startServer } from "./remote-harness"

const cli = path.join(import.meta.dir, "../src/index.ts")
setDefaultTimeout(30_000)

function isolatedEnv(root: string, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: root,
    YCODING_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...extra,
  }
  delete env.YCODING_DB
  delete env.YCODING_PASSWORD
  delete env.YCODING_CONFIG_DIR
  delete env.YCODING_CONFIG
  delete env.YCODING_REMOTE_URL
  return { ...env, ...extra }
}

// The isolated server runs in this process, so the CLI child must run
// asynchronously; a blocking spawn would starve the event loop it needs.
async function run(env: Record<string, string | undefined>, args: readonly string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
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
  return { exitCode, stdout, stderr, output: stdout + stderr }
}

async function withHome<A>(run: (root: string) => Promise<A>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-remote-commands-"))
  try {
    return await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("remote command surface", () => {
  test("exposes enrollment, connection, and sharing commands", async () => {
    const help = await run({}, ["remote", "--help"])
    expect(help.exitCode).toBe(0)
    for (const command of ["enroll", "connect", "status", "sessions", "allow", "deny"]) {
      expect(help.stdout).toContain(command)
    }
  })

  test("reports an unenrolled machine without failing", async () => {
    await withHome(async (root) => {
      const status = await run(isolatedEnv(root), ["remote", "status"])
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain("Not enrolled")
    })
  })

  test("requires a relay origin and refuses a relay URL with a path before prompting", async () => {
    await withHome(async (root) => {
      const missing = await run(isolatedEnv(root), ["remote", "enroll", "enr_1"])
      expect(missing.exitCode).not.toBe(0)
      expect(missing.output).toContain("relay origin is required")

      const pathed = await run(isolatedEnv(root), ["remote", "enroll", "enr_1", "--relay", "https://relay.example/ws/agent"])
      expect(pathed.exitCode).not.toBe(0)
      expect(pathed.output).toContain("without a path")
    })
  })

  test("tells an unenrolled machine how to enroll before connecting", async () => {
    await withHome(async (root) => {
      const connect = await run(isolatedEnv(root), ["remote", "connect"])
      expect(connect.exitCode).not.toBe(0)
      expect(connect.output).toContain("not enrolled")
    })
  })

  test("reports sessions that are not shared and rejects malformed session IDs", async () => {
    await withHome(async (root) => {
      const sessions = await run(isolatedEnv(root), ["remote", "sessions"])
      expect(sessions.exitCode).toBe(0)
      expect(sessions.stdout).toContain("No sessions are shared")

      const deny = await run(isolatedEnv(root), ["remote", "deny", "ses_missing"])
      expect(deny.exitCode).not.toBe(0)
      expect(deny.output).toContain("not shared")

      const malformed = await run(isolatedEnv(root), ["remote", "deny", "not-a-session"])
      expect(malformed.exitCode).not.toBe(0)
      expect(malformed.output).toContain("not a YCoding session ID")
    })
  })

  test("shares and unshares a real isolated session", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-remote-commands-work-"))
    const server = await startServer(directory)
    try {
      await withHome(async (root) => {
        await createSession(server, "ses_cli_shared", directory)
        const env = isolatedEnv(root, { YCODING_PASSWORD: password })

        const allow = await run(env, ["remote", "allow", "ses_cli_shared", "--server", server.base])
        expect(allow.exitCode, allow.output).toBe(0)
        expect(allow.stdout).toContain("Shared ses_cli_shared")

        const listed = await run(env, ["remote", "sessions"])
        expect(listed.stdout).toContain("ses_cli_shared")
        expect(listed.stdout).toContain(directory)

        const status = await run(env, ["remote", "status"])
        expect(status.stdout).toContain("Shared        1 session(s)")

        const unknown = await run(env, ["remote", "allow", "ses_cli_absent", "--server", server.base])
        expect(unknown.exitCode).not.toBe(0)
        expect(unknown.output).toContain("No local session")

        const deny = await run(env, ["remote", "deny", "ses_cli_shared"])
        expect(deny.exitCode, deny.output).toBe(0)
        expect((await run(env, ["remote", "sessions"])).stdout).toContain("No sessions are shared")
      })
    } finally {
      await server.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
