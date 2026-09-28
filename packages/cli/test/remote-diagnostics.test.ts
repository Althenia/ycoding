import { expect, mock, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const marker = "REMOTE_DIAGNOSTIC_RESULT:"

if (process.env.YCODING_REMOTE_DIAGNOSTIC_MODE) await runChild()
else test("the server-owned connector writes a bridge diagnostic to the server log", async () => {
  for (const mode of ["service", "stdio"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-diagnostic-"))
    const env: Record<string, string | undefined> = { ...process.env,
      HOME: root,
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      YCODING_REMOTE_DIAGNOSTIC_MODE: mode,
      YCODING_PASSWORD: "test-password",
      YCODING_DB: ":memory:",
      YCODING_CONFIG_DIR: path.join(root, "config", "ycoding"),
      YCODING_CONFIG_CONTENT: "{}",
      YCODING_DISABLE_MODELS_FETCH: "1",
      YCODING_DISABLE_PROJECT_CONFIG: "1",
      YCODING_DISABLE_FILEWATCHER: "1",
      YCODING_DISABLE_FFF: "1",
    }
    delete env.YCODING_REMOTE_URL
    try {
      const child = Bun.spawn([process.execPath, import.meta.path], { cwd: process.cwd(), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(exit, `${mode}: ${stderr}\n${stdout.slice(-300)}`).toBe(0)
      const line = stdout.split("\n").find((value) => value.startsWith(marker))
      expect(line).toBeDefined()
      const entry = line?.slice(marker.length) ?? ""
      expect(entry).toContain("remote event authorization queue filled")
      expect(entry).toContain("remote-connector")
      expect(entry).toContain("level=WARN")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 30_000)

async function runChild() {
  const { Global } = await import("@ycoding-ai/core/global")
  const { Observability } = await import("@ycoding-ai/core/observability")
  const { Logging } = await import("@ycoding-ai/core/observability/logging")
  const { ServiceConfig } = await import("../src/services/service-config")
  const { Effect, Fiber } = await import("effect")
  const { availablePort } = await import("./remote-harness")
  await mkdir(Global.Path.state, { recursive: true })
  await mkdir(Global.Path.config, { recursive: true })
  await writeFile(path.join(Global.Path.config, ServiceConfig.filename()), JSON.stringify({ password: "test-password" }), { mode: 0o600 })
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
        this.options.onDiagnostic?.("the remote event authorization queue filled; closing for client reconciliation")
      }
      async close() {}
    },
  }))
  const { ServerProcess } = await import("../src/server-process")
  const port = await availablePort()
  const mode = process.env.YCODING_REMOTE_DIAGNOSTIC_MODE
  if (mode !== "service" && mode !== "stdio") throw new Error("Invalid diagnostic fixture mode")
  const fiber = Effect.runFork(ServerProcess.run({ mode, hostname: "127.0.0.1", port }).pipe(
    Effect.provide(Observability.layer({ client: "cli" })),
  ))
  try {
    const ready = Date.now() + 10_000
    let status = ""
    while (Date.now() < ready && !status.includes('"state":"on"')) {
      status = await fetch(`http://127.0.0.1:${port}/api/remote`, {
        headers: { authorization: `Basic ${Buffer.from("ycoding:test-password").toString("base64")}` },
      }).then((response) => response.text()).catch(() => "")
      if (!status.includes('"state":"on"')) await Bun.sleep(25)
    }
    if (!status.includes('"state":"on"')) throw new Error(`isolated ${mode} remote connector did not start: ${status.slice(0, 300)}`)
    const deadline = Date.now() + 10_000
    let line = ""
    while (Date.now() < deadline && !line.includes("remote event authorization queue filled")) {
      line = (await Bun.file(Logging.file()).text().catch(() => "")).split("\n")
        .find((value) => value.includes("remote event authorization queue filled")) ?? ""
      if (!line) await Bun.sleep(25)
    }
    if (!line) throw new Error("remote diagnostic did not reach the server log")
    process.stdout.write(`${marker}${line}\n`)
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    mock.restore()
  }
}
