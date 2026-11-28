import { describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { YCoding } from "@ycoding-ai/client/v5"
import { sourceRuntimeExecutable } from "../../../script/ycoding-runtime-source"
import { createUsageRelay } from "./support/native-usage-performance"
import { sessionFixture, v5Server } from "./fixture/v5-server"

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
async function run(env: Record<string, string | undefined>, args: readonly string[], input?: string) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdin: input === undefined ? "ignore" : new Blob([input]),
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

const password = "synthetic-remote-test"

async function startNativeServer(root: string) {
  const executable = await sourceRuntimeExecutable(path.resolve(import.meta.dir, "../../.."))
  const env = isolatedEnv(root, {
    YCODING_PASSWORD: password,
    YCODING_CONFIG_PROJECT_DISABLE: "1",
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_VERSION: "local",
  })
  const child = Bun.spawn([executable, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
  const timer = setTimeout(() => child.kill(), 25_000)
  try {
    let output = ""
    while (!output.includes("\n")) {
      const part = await reader.read()
      if (part.done) throw new Error(`Native runtime exited before readiness: ${await stderr}`)
      output += part.value
    }
    const ready: unknown = JSON.parse(output.slice(0, output.indexOf("\n")))
    if (typeof ready !== "object" || ready === null || !("url" in ready) || typeof ready.url !== "string")
      throw new Error("Native runtime did not report its URL")
    const url = ready.url
    return {
      url,
      client: YCoding.make({ endpoint: { url, auth: { type: "basic", username: "ycoding", password } }, location: { directory: root } }),
      async close() {
        await child.stdin.end()
        const timer = setTimeout(() => child.kill(), 10_000)
        try {
          const code = await child.exited
          if (code !== 0) throw new Error(`Native runtime exited with ${code}: ${await stderr}`)
        } finally { clearTimeout(timer) }
      },
    }
  } catch (error) {
    child.kill()
    await child.exited
    throw error
  } finally { clearTimeout(timer); reader.releaseLock() }
}

describe("remote command surface", () => {
  test("exposes enrollment, connection, status, and backend session commands", async () => {
    const help = await run({}, ["remote", "--help"])
    expect(help.exitCode).toBe(0)
    for (const command of ["enroll", "connect", "disconnect", "status", "sessions"]) {
      expect(help.stdout).toContain(command)
    }
    expect(help.stdout).not.toContain("mcp")
    expect(help.stdout).not.toContain("  allow")
    expect(help.stdout).not.toContain("  deny")
  })

  test("reports an unenrolled native backend without listing Sessions", async () => {
    const operations: string[] = []
    const server = v5Server((name) => {
      if (name === "health.get") return { data: { version: "local" } }
      operations.push(name)
      if (name === "remote.get") return { data: { state: "off" } }
      throw new Error(`Unexpected operation: ${name}`)
    })
    try {
      await withHome(async (root) => {
        const status = await run(isolatedEnv(root), ["remote", "status", "--server", server.url])
        expect(status.exitCode).toBe(0)
        expect(status.stdout).toContain("Not enrolled")
        expect(status.stdout).not.toContain("Connection")
      })
      expect(operations).toEqual(["remote.get"])
    } finally {
      await server.close()
    }
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

  const device = {
    deviceID: "dev_fixture", name: "Remote fixture", relayOrigin: "https://relay.example",
    enrolledAt: 1, credentialState: "valid",
  }

  test("remote status reads the native backend enrollment without a CLI identity file", async () => {
    const operations: string[] = []
    const server = v5Server((name) => {
      if (name === "health.get") return { data: { version: "local" } }
      operations.push(name)
      if (name === "remote.get") return { data: { state: "on", device } }
      if (name === "session.list") return { data: { data: [], cursor: {} } }
      throw new Error(`Unexpected operation: ${name}`)
    })
    try {
      await withHome(async (root) => {
        const status = await run(isolatedEnv(root), ["remote", "status", "--server", server.url])
        expect(status.exitCode, status.stderr).toBe(0)
        expect(status.stdout).toContain("Remote fixture (dev_fixture)")
        expect(status.stdout).toContain("Connection    on")
        expect(status.stdout).toContain("valid")
        expect(status.stdout).toContain(`Local server  ${new URL(server.url).origin}`)
        expect(operations).toEqual(["remote.get", "session.list"])
      })
    } finally { await server.close() }
  })

  test("remote sessions lists all pages from the native backend", async () => {
    const requests: unknown[] = []
    const server = v5Server((name, data) => {
      if (name === "health.get") return { data: { version: "local" } }
      if (name !== "session.list") throw new Error(`Unexpected operation: ${name}`)
      requests.push(data)
      return requests.length === 1
        ? { data: { data: [{ ...sessionFixture("ses_first", "/first"), scope: "bound" }], cursor: { next: "next" } } }
        : { data: { data: [{ ...sessionFixture("ses_second", "/second"), scope: "bound" }], cursor: {} } }
    })
    try {
      await withHome(async (root) => {
        const result = await run(isolatedEnv(root), ["remote", "sessions", "--server", server.url])
        expect(result.exitCode, result.stderr).toBe(0)
        expect(result.stdout).toContain("ses_first")
        expect(result.stdout).toContain("ses_second")
        expect(requests).toHaveLength(2)
      })
    } finally { await server.close() }
  })

  test("remote disconnect disables the native backend", async () => {
    const requests: { name: string; data: unknown }[] = []
    const server = v5Server((name, data) => {
      if (name === "health.get") return { data: { version: "local" } }
      requests.push({ name, data })
      if (name === "remote.set") return { data: { state: "off" } }
      throw new Error(`Unexpected operation: ${name}`)
    })
    try {
      await withHome(async (root) => {
        const result = await run(isolatedEnv(root), ["remote", "disconnect", "--server", server.url])
        expect(result.exitCode, result.stderr).toBe(0)
        expect(result.stdout).toContain("Remote connection off.")
        expect(requests).toEqual([{ name: "remote.set", data: { payload: { enabled: false } } }])
      })
    } finally { await server.close() }
  })

  test("remote sessions rejects a repeated pagination cursor", async () => {
    let calls = 0
    const server = v5Server((name) => {
      if (name === "health.get") return { data: { version: "local" } }
      if (name !== "session.list") throw new Error(`Unexpected operation: ${name}`)
      calls++
      return { data: { data: [{ ...sessionFixture("ses_first", "/first"), scope: "bound" }], cursor: { next: "same" } } }
    })
    try {
      await withHome(async (root) => {
        const result = await run(isolatedEnv(root), ["remote", "sessions", "--server", server.url])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Session inventory repeated a page cursor")
        expect(calls).toBe(2)
      })
    } finally { await server.close() }
  })

  test("remote enroll sends the one-use code to the native backend without writing a CLI identity", async () => {
    const requests: { name: string; data: unknown }[] = []
    const server = v5Server((name, data) => {
      if (name === "health.get") return { data: { version: "local" } }
      requests.push({ name, data })
      if (name === "remote.get") return { data: { state: "off" } }
      if (name === "remote.enroll") return { data: device }
      throw new Error(`Unexpected operation: ${name}`)
    })
    try {
      await withHome(async (root) => {
        const code = "ABCD-EFGH-JKLM-NPQR-STUV"
        const result = await run(isolatedEnv(root), ["remote", "enroll", "enr_fixture", "--relay", device.relayOrigin, "--name", device.name, "--server", server.url], code)
        expect(result.exitCode, result.stderr).toBe(0)
        expect(result.stdout).toContain("Remote fixture (dev_fixture)")
        expect(result.output).not.toContain(code)
        expect(requests).toEqual([
          { name: "remote.get", data: {} },
          { name: "remote.enroll", data: { payload: { relayOrigin: device.relayOrigin, enrollmentID: "enr_fixture", code, name: device.name, replace: false } } },
        ])
        expect(await Bun.file(path.join(root, "state", "ycoding", "remote-device.json")).exists()).toBe(false)
      })
    } finally { await server.close() }
  })

  test("remote connect enables the enrolled native backend once without a CLI identity file", async () => {
    const requests: { name: string; data: unknown }[] = []
    let state: "off" | "on" = "off"
    const server = v5Server((name, data) => {
      if (name === "health.get") return { data: { version: "local" } }
      requests.push({ name, data })
      if (name === "remote.get") return { data: { state, device } }
      if (name === "remote.set") {
        state = "on"
        return { data: { state: "connecting" } }
      }
      return new Error(`Unexpected operation: ${name}`)
    })
    try {
      await withHome(async (root) => {
        const connect = await run(isolatedEnv(root), ["remote", "connect", "--server", server.url, "--relay", device.relayOrigin])
        expect(connect.exitCode, connect.stderr).toBe(0)
        expect(connect.stdout).toContain("all backend Sessions are available to its owner")
        expect(connect.stdout).toContain("Remote connection on.")
        expect(requests).toEqual([
          { name: "remote.get", data: {} },
          { name: "remote.set", data: { payload: { enabled: true } } },
          { name: "remote.get", data: {} },
        ])
      })
    } finally {
      await server.close()
    }
  })

  for (const scenario of [
    { title: "asks an unenrolled native backend to enroll", device: undefined, args: [], error: "not enrolled", enables: false },
    { title: "refuses a relay that differs from the native enrollment", device, args: ["--relay", "https://other-relay.example"], error: `this device is enrolled at ${device.relayOrigin}`, enables: false },
    { title: "reports a failure returned by native enable", device, args: [], error: "The relay rejected this device.", enables: true },
  ]) {
    test(`remote connect ${scenario.title}`, async () => {
      const operations: string[] = []
      const server = v5Server((name) => {
        if (name === "health.get") return { data: { version: "local" } }
        operations.push(name)
        if (name === "remote.get") return { data: { state: "off", device: scenario.device } }
        if (name === "remote.set" && scenario.enables) return { data: { state: "error", message: scenario.error } }
        return new Error(`Unexpected operation: ${name}`)
      })
      try {
        await withHome(async (root) => {
          const connect = await run(isolatedEnv(root), ["remote", "connect", "--server", server.url, ...scenario.args])
          expect(connect.exitCode).toBe(1)
          expect(connect.stderr).toContain(scenario.error)
          expect(connect.stdout).not.toContain("Remote connection on.")
          expect(operations).toEqual(scenario.enables ? ["remote.get", "remote.set"] : ["remote.get"])
        })
      } finally {
        await server.close()
      }
    })
  }

  test("reports an empty backend inventory without per-session commands", async () => {
    await withHome(async (root) => {
      const server = await startNativeServer(root)
      try {
        const sessions = await run(isolatedEnv(root, { YCODING_PASSWORD: password }), [
          "remote", "sessions", "--server", server.url,
        ])
        expect(sessions.exitCode, sessions.output).toBe(0)
        expect(sessions.stdout).toContain("The backend has no Sessions")

        const deny = await run(isolatedEnv(root), ["remote", "deny", "ses_missing"])
        expect(deny.exitCode).not.toBe(0)
        expect(deny.output).toContain('Unknown subcommand "deny"')
      } finally {
        server.client.transport.close()
        await server.close()
      }
    })
  })

  test("lists every real isolated backend Session without a local allow step", async () => {
    await withHome(async (root) => {
      const directory = path.join(root, "work")
      await fs.mkdir(directory)
      const server = await startNativeServer(root)
      try {
        await server.client.session.create({ id: "ses_cli_shared", title: "fixture", location: { directory } })
        const env = isolatedEnv(root, { YCODING_PASSWORD: password })

        const listed = await run(env, ["remote", "sessions", "--server", server.url])
        expect(listed.exitCode, listed.output).toBe(0)
        expect(listed.stdout).toContain("ses_cli_shared")
        expect(listed.stdout).toContain(directory)
      } finally {
        server.client.transport.close()
        await server.close()
      }
    })
  }, 60_000)

  test("reports and disconnects the remote switch on one isolated server", async () => {
    await withHome(async (root) => {
      const relay = createUsageRelay("dev_fixture")
      try {
        const server = await startNativeServer(root)
        try {
          const env = isolatedEnv(root, { YCODING_PASSWORD: password })
          const denied = await run(isolatedEnv(root, { YCODING_PASSWORD: "incorrect" }), ["remote", "connect", "--server", server.url])
          expect(denied.exitCode).not.toBe(0)
          expect((await server.client.remote.get()).state).toBe("off")
          const enrolled = await run(env, ["remote", "enroll", "enr_fixture", "--relay", relay.origin, "--name", "fixture", "--server", server.url], "ABCD-EFGH-JKLM-NPQR-STUV")
          expect(enrolled.exitCode, enrolled.output).toBe(0)
          const duplicate = await run(env, ["remote", "enroll", "enr_fixture", "--relay", relay.origin, "--server", server.url])
          expect(duplicate.exitCode).not.toBe(0)
          expect(duplicate.stderr).toContain("already enrolled")
          const connect = await run(env, ["remote", "connect", "--server", server.url])
          expect(connect.exitCode, connect.output).toBe(0)
          const status = await run(env, ["remote", "status", "--server", server.url])
          expect(status.exitCode, status.output).toBe(0)
          expect(status.stdout).toContain("Connection    on")
          const disconnect = await run(env, ["remote", "disconnect", "--server", server.url])
          expect(disconnect.exitCode, disconnect.output).toBe(0)
          expect(disconnect.stdout).toContain("Remote connection off")
          expect((await server.client.remote.get()).state).toBe("off")
          expect(relay.failures).toEqual([])
        } finally {
          server.client.transport.close()
          await server.close()
        }
      } finally { await relay.close() }
    })
  }, 60_000)
  test("rejects every retired relay MCP command before contacting a server", async () => {
    await withHome(async (root) => {
      const requests: string[] = []
      const server = Bun.serve({ port: 0, fetch: (request) => { requests.push(request.url); return new Response(null, { status: 500 }) } })
      try {
        for (const command of ["on", "off", "status"]) {
          const result = await run(isolatedEnv(root), ["remote", "mcp", command, "--server", server.url.href])
          expect(result.exitCode).not.toBe(0)
          expect(result.output).toContain('Unknown subcommand "mcp"')
        }
        expect(requests).toEqual([])
      } finally {
        await server.stop(true)
      }
    })
  }, 60_000)
})
