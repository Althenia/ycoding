import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@ycoding-ai/core/global"
import { expect, mock, spyOn, test } from "bun:test"
import { Effect, Option } from "effect"
import { appendFileSync, rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"

const marker = "UPDATE_HANDLER_RESULT:"

type Scenario = {
  readonly server: "absent" | { readonly outstanding: ReadonlyArray<string> | "error"; readonly running?: ReadonlyArray<string> }
  readonly install?: "fails"
  readonly force?: boolean
  readonly requested?: string
  readonly spawn?: "fails"
}

type Outcome = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly installs: ReadonlyArray<string>
  readonly oldRequests: ReadonlyArray<string>
  readonly newRequests: ReadonlyArray<string>
  readonly registration: { readonly id: string; readonly version: string } | undefined
  readonly newServerAlive: boolean
}

if (process.argv[2] === "serve") await serveReplacement()
else if (process.env.YCODING_UPDATE_SCENARIO) await runHandler(JSON.parse(process.env.YCODING_UPDATE_SCENARIO))
else {
  const outstandingOnly = ["GET /api/session/outstanding"]

  test("an idle background server is restarted after the update installs", async () => {
    const outcome = await run({ server: { outstanding: [] } })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stderr).toBe("")
    expect(outcome.installs).toEqual(["2.0.0"])
    expect(outcome.stdout).toContain("Updated ycoding to 2.0.0")
    expect(outcome.stdout).toContain("Restarted the background server")
    expect(withoutHealth(outcome.oldRequests)).toEqual([...outstandingOnly, "POST /api/service/stop"])
    expect(outcome.registration).toEqual({ id: "new-service", version: "2.0.0" })
    expect(outcome.newServerAlive).toBe(true)
    expect(outcome.newRequests).not.toContain("POST /api/service/stop")
  }, 30_000)

  test("a busy background server is left running and the manual command is printed", async () => {
    for (const sessions of [["ses_a"], ["ses_a", "ses_b"]]) {
      const outcome = await run({ server: { outstanding: [...sessions, "ses_notice", "ses_goal"], running: sessions } })

      expect(outcome.exitCode).toBe(0)
      expect(outcome.stderr).toBe("")
      expect(outcome.stdout).toContain("Updated ycoding to 2.0.0")
      expect(outcome.stdout).toContain(
        sessions.length === 1 ? "1 Session has running work" : "2 Sessions have running work",
      )
      expect(outcome.stdout).not.toContain("4 Sessions")
      expect(outcome.stdout).toContain("ycoding service restart")
      expect(outcome.stdout).not.toContain("Restarted the background server")
      expect(withoutHealth(outcome.oldRequests)).toEqual(outstandingOnly)
      expect(outcome.registration).toEqual({ id: "old-service", version: "1.0.0" })
      expect(outcome.newRequests).toEqual([])
    }
  }, 30_000)

  test("outstanding Sessions that are not running do not block the restart", async () => {
    const outcome = await run({ server: { outstanding: ["ses_notice", "ses_goal"], running: [] } })

    expect(outcome.stdout).toContain("Restarted the background server")
    expect(outcome.stdout).not.toContain("running work")
    expect(withoutHealth(outcome.oldRequests)).toEqual([...outstandingOnly, "POST /api/service/stop"])
    expect(outcome.registration).toEqual({ id: "new-service", version: "2.0.0" })
  }, 30_000)

  test("a forced update restarts a busy background server and reports the interrupted Sessions", async () => {
    for (const sessions of [["ses_a"], ["ses_a", "ses_b"]]) {
      const outcome = await run({
        server: { outstanding: [...sessions, "ses_notice", "ses_goal"], running: sessions },
        force: true,
      })

      expect(outcome.exitCode).toBe(0)
      expect(outcome.stderr).toBe("")
      expect(outcome.stdout).toContain(
        sessions.length === 1
          ? "Interrupting 1 running Session to restart the background server"
          : "Interrupting 2 running Sessions to restart the background server",
      )
      expect(outcome.stdout).not.toContain("4 ")
      expect(outcome.stdout).toContain("Restarted the background server")
      expect(outcome.stdout).not.toContain("was not restarted")
      expect(withoutHealth(outcome.oldRequests)).toEqual([...outstandingOnly, "POST /api/service/stop"])
      expect(outcome.registration).toEqual({ id: "new-service", version: "2.0.0" })
    }
  }, 30_000)

  test("a forced update restarts an idle background server without reporting interrupted Sessions", async () => {
    const outcome = await run({ server: { outstanding: ["ses_notice"], running: [] }, force: true })

    expect(outcome.stdout).toContain("Restarted the background server")
    expect(outcome.stdout).not.toContain("Interrupting")
    expect(withoutHealth(outcome.oldRequests)).toEqual([...outstandingOnly, "POST /api/service/stop"])
  }, 30_000)

  test("a forced update does not restart a background server whose running work cannot be read", async () => {
    const outcome = await run({ server: { outstanding: "error" }, force: true })

    expect(outcome.stderr).toContain("Could not check the background server for running work")
    expect(withoutHealth(outcome.oldRequests)).toEqual(outstandingOnly)
    expect(outcome.registration).toEqual({ id: "old-service", version: "1.0.0" })
  }, 30_000)

  test("a background server whose running work cannot be read is treated as busy", async () => {
    const outcome = await run({ server: { outstanding: "error" } })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain("Updated ycoding to 2.0.0")
    expect(outcome.stderr).toContain("Could not check the background server for running work")
    expect(outcome.stderr).toContain("ycoding service restart")
    expect(outcome.stderr).not.toContain("update failed")
    expect(withoutHealth(outcome.oldRequests)).toEqual(outstandingOnly)
    expect(outcome.registration).toEqual({ id: "old-service", version: "1.0.0" })
  }, 30_000)

  test("nothing is restarted or started when no background server is running", async () => {
    const outcome = await run({ server: "absent" })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain("Updated ycoding to 2.0.0")
    expect(outcome.stdout).toContain("No background server is running")
    expect(outcome.registration).toBeUndefined()
    expect(outcome.newRequests).toEqual([])
  }, 30_000)

  test("a failed restart reports the manual command without reporting the update as failed", async () => {
    const outcome = await run({ server: { outstanding: [] }, spawn: "fails" })

    expect(outcome.stdout).toContain("Updated ycoding to 2.0.0")
    expect(outcome.exitCode).toBe(1)
    expect(outcome.stderr).toContain("ycoding 2.0.0 is installed")
    expect(outcome.stderr).toContain("Server process exited with code 1")
    expect(outcome.stderr).toContain("ycoding service restart")
    expect(outcome.stderr).not.toContain("update failed")
    expect(withoutHealth(outcome.oldRequests)).toEqual([...outstandingOnly, "POST /api/service/stop"])
  }, 30_000)

  test("a failed install neither queries nor restarts the background server", async () => {
    const outcome = await run({ server: { outstanding: [] }, install: "fails" })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stderr).toContain("ycoding update failed: Checksum verification failed")
    expect(outcome.oldRequests).toEqual([])
    expect(outcome.registration).toEqual({ id: "old-service", version: "1.0.0" })
  }, 30_000)

  test("an already current install neither queries nor restarts the background server", async () => {
    const outcome = await run({ server: { outstanding: [] }, requested: "1.0.0" })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain("already up to date")
    expect(outcome.installs).toEqual([])
    expect(outcome.oldRequests).toEqual([])
    expect(outcome.registration).toEqual({ id: "old-service", version: "1.0.0" })
  }, 30_000)
}

function withoutHealth(requests: ReadonlyArray<string>) {
  return requests.filter((request) => request !== "GET /api/health")
}

async function run(scenario: Scenario) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-update-handler-"))
  try {
    // The child defines the release channel and version, so the real handler runs as an installed build.
    const child = Bun.spawn(
      [
        process.execPath,
        "--define",
        'YCODING_CHANNEL="latest"',
        "--define",
        'YCODING_VERSION="1.0.0"',
        import.meta.path,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"),
          YCODING_UPDATE_ROOT: root,
          YCODING_UPDATE_REGISTRATION: path.join(root, "state", ServiceConfig.filename("latest")),
          YCODING_UPDATE_SCENARIO: JSON.stringify(scenario),
          YCODING_UPDATE_SPAWN: scenario.spawn ?? "serves",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const line = stdout.split("\n").find((value) => value.startsWith(marker))
    if (!line) throw new Error(`Update handler fixture exited ${exit} without a result: ${stderr}\n${stdout.slice(-500)}`)
    const outcome: Outcome = JSON.parse(line.slice(marker.length))
    return outcome
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function runHandler(scenario: Scenario) {
  const root = requiredEnv("YCODING_UPDATE_ROOT")
  const registration = requiredEnv("YCODING_UPDATE_REGISTRATION")
  const oldRequests: string[] = []
  const installs: string[] = []
  await fs.mkdir(path.dirname(registration), { recursive: true })
  const old = scenario.server === "absent" ? undefined : await startOldServer(scenario.server.outstanding, scenario.server.running ?? [], registration, oldRequests)
  const actual = await import("../src/update/update")
  await mock.module("../src/update/update", () => ({
    ...actual,
    installRelease: async (input: { readonly version: string }) => {
      installs.push(input.version)
      if (scenario.install === "fails") throw new Error("Checksum verification failed")
      return { version: input.version, asset: "asset" }
    },
  }))
  const { default: update } = await import("../src/commands/handlers/update")
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutWrite = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  const layer = Global.layerWith({
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
  })
  try {
    await Effect.runPromise(
      update({ version: Option.some(scenario.requested ?? "2.0.0"), force: scenario.force ?? false }).pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
  } finally {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }
  const exitCode = Number(process.exitCode ?? 0)
  const final = await Bun.file(registration)
    .json()
    .catch(() => undefined)
  const newServerAlive = final?.id === "new-service" && isRunning(final.pid)
  const newRequests = await Bun.file(path.join(root, "new-service.log"))
    .text()
    .then((text) => text.split("\n").filter(Boolean))
    .catch(() => [])
  if (newServerAlive) process.kill(final.pid, "SIGKILL")
  old?.holder.kill()
  await old?.server.stop(true)
  const outcome: Outcome = {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode,
    installs,
    oldRequests,
    newRequests,
    registration: final === undefined ? undefined : { id: final.id, version: final.version },
    newServerAlive,
  }
  process.stdout.write(`${marker}${JSON.stringify(outcome)}\n`)
  process.exit(0)
}

async function startOldServer(
  outstanding: ReadonlyArray<string> | "error",
  running: ReadonlyArray<string>,
  registration: string,
  requests: string[],
) {
  // The stop handshake waits for the registered pid to exit, so it belongs to a separate holder process.
  const holder = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/api/health")
        return Response.json({ healthy: true, version: "1.0.0", pid: holder.pid, sourceEpoch: "epoch_old" })
      if (url.pathname === "/api/session/outstanding")
        return outstanding === "error"
          ? new Response("unavailable", { status: 500 })
          : Response.json({ data: outstanding, running, failed: [] })
      if (url.pathname === "/api/service/stop") {
        rmSync(registration, { force: true })
        holder.kill()
        return Response.json({ accepted: true })
      }
      return new Response(null, { status: 404 })
    },
  })
  await fs.writeFile(
    registration,
    JSON.stringify({ id: "old-service", version: "1.0.0", url: server.url.toString(), pid: holder.pid }),
  )
  return { server, holder }
}

async function serveReplacement() {
  if (process.env.YCODING_UPDATE_SPAWN === "fails") process.exit(1)
  const log = path.join(requiredEnv("YCODING_UPDATE_ROOT"), "new-service.log")
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      appendFileSync(log, `${request.method} ${url.pathname}\n`)
      if (url.pathname === "/api/health")
        return Response.json({ healthy: true, version: "2.0.0", pid: process.pid, sourceEpoch: "epoch_new" })
      return new Response(null, { status: 404 })
    },
  })
  await fs.writeFile(
    requiredEnv("YCODING_UPDATE_REGISTRATION"),
    JSON.stringify({ id: "new-service", version: "2.0.0", url: server.url.toString(), pid: process.pid }),
  )
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} was not set`)
  return value
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
