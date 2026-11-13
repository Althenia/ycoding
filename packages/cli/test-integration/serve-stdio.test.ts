import { expect, mock, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { availablePort } from "../test/remote-harness"

const diagnostic = "stdio readiness synthetic diagnostic"
const entry = path.resolve(import.meta.dir, "../src/index.ts")

if (process.env.YCODING_STDIO_READINESS_CHILD) await runChild()
else {
  test("serve --stdio writes only the readiness line to stdout while a warning is logged", async () => {
    await withRoot(async (root, env) => {
      const port = await availablePort()
      const child = Bun.spawn(
        [process.execPath, import.meta.path, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", String(port)],
        { cwd: root, env: { ...env, YCODING_STDIO_READINESS_CHILD: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const logged = await waitForLog(root, diagnostic)
      child.stdin.end()
      const [exit, output, errors] = await Promise.all([child.exited, stdout, stderr])
      expect(logged, errors).toContain("level=WARN")
      expect(exit, errors).toBe(0)
      expect(output).toBe(JSON.stringify({ url: `http://127.0.0.1:${port}` }) + "\n")
    })
  }, 30_000)

  test("serve --stdio reports a startup failure on stderr and leaves stdout empty", async () => {
    await withRoot(async (root, env) => {
      const port = await availablePort()
      const blocker = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })
      try {
        const result = await cli(root, env, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", String(port)])
        expect(result.exit).toBe(1)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("ServeError")
      } finally {
        blocker.stop(true)
      }
    })
  }, 30_000)

  test("serve --stdio reports a failure before the server starts on stderr and leaves stdout empty", async () => {
    await withRoot(async (root, env) => {
      for (const name of ["ycoding.log", "ycoding-local.log"])
        await mkdir(path.join(root, "data", "ycoding", "log", name), { recursive: true })
      const result = await cli(root, env, ["serve", "--stdio", "--port", "0"])
      expect(result.exit).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("PlatformError")
    })
  }, 30_000)

  test("a failing non-serve command reports on stderr and exits 1", async () => {
    await withRoot(async (root, env) => {
      const result = await cli(root, env, ["service", "get", "no-such-key"])
      expect(result.exit).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("Unknown service config key: no-such-key")
    })
  }, 30_000)
}

async function cli(root: string, env: Record<string, string | undefined>, args: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  child.stdin.end()
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exit, stdout, stderr }
}

async function withRoot(body: (root: string, env: Record<string, string | undefined>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-stdio-readiness-"))
  const env: Record<string, string | undefined> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("YCODING_") && !key.startsWith("OTEL_"))),
    HOME: root,
    YCODING_TEST_HOME: root,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    YCODING_PASSWORD: "test-password",
    YCODING_DB: ":memory:",
    YCODING_CONFIG_DIR: path.join(root, "config", "ycoding"),
    YCODING_CONFIG_CONTENT: "{}",
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_DISABLE_PROJECT_CONFIG: "1",
    YCODING_DISABLE_FILEWATCHER: "1",
    YCODING_DISABLE_FFF: "1",
  }
  try {
    await body(root, env)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function waitForLog(root: string, text: string) {
  const directory = path.join(root, "data", "ycoding", "log")
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const files = await readdir(directory).catch(() => [])
    for (const file of files) {
      const line = (await readFile(path.join(directory, file), "utf8").catch(() => ""))
        .split("\n")
        .find((value) => value.includes(text))
      if (line) return line
    }
    await Bun.sleep(25)
  }
  return ""
}

async function runChild() {
  const { Global } = await import("@ycoding-ai/core/global")
  await mkdir(Global.Path.state, { recursive: true })
  await writeFile(path.join(Global.Path.state, "remote.json"), JSON.stringify({ enabled: true }), { mode: 0o600 })
  await writeFile(path.join(Global.Path.state, "remote-device.json"), JSON.stringify({
    deviceID: "dev_fixture", name: "fixture", relayURL: "https://relay.example",
    publicKey: { kty: "EC", crv: "P-256", x: "fixture", y: "fixture" },
    privateKey: { kty: "EC", crv: "P-256", x: "fixture", y: "fixture", d: "fixture" },
    enrolledAt: 1,
  }), { mode: 0o600 })
  await mock.module("../src/remote-bridge", () => ({
    RemoteAgent: class {
      constructor(private readonly options: { onDiagnostic?: (message: string) => void }) {}
      async connect() {
        this.options.onDiagnostic?.(diagnostic)
      }
      async close() {}
    },
  }))
  await import("../src/index")
}
