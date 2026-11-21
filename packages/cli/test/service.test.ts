import { NodeFileSystem } from "@effect/platform-node"
import { Service, type Info } from "@ycoding-ai/client/effect/service"
import { Database } from "@ycoding-ai/core/database/database"
import { DatabaseFormat } from "@ycoding-ai/core/database/format"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { ShellLedger } from "@ycoding-ai/core/shell/ledger"
import { ShellTable } from "@ycoding-ai/core/shell/sql"
import { Shell as ShellSchema } from "@ycoding-ai/schema/shell"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"

test("managed service writes its registration once", async () => {
  const service = await startManagedService("ycoding-service-once-")
  try {
    const before = await fs.stat(service.registration)
    await Bun.sleep(6_000)
    const after = await fs.stat(service.registration)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await Bun.file(service.registration).json()).toEqual(service.info)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("deleting a managed service registration stops its owner", async () => {
  const service = await startManagedService("ycoding-service-delete-")
  try {
    await fs.rm(service.registration)
    await service.owner.exited
    expect(await Bun.file(service.registration).exists()).toBe(false)
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("deleting a failed service registration stops its owner", async () => {
  const service = await startManagedService("ycoding-service-failed-delete-", true)
  try {
    await waitForFailed(service.info)
    await fs.rm(service.registration)
    await service.owner.exited
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("managed service backs up an unsupported default database and starts fresh", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-database-reset-"))
  const port = await availablePort()
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  const directory = path.join(root, "data", "ycoding")
  const database = path.join(directory, "ycoding.db")
  await fs.mkdir(path.join(root, "config", "ycoding"), { recursive: true })
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(root, "config", "ycoding", "service-local.json"), JSON.stringify({ port }))
  const sqlite = await import("bun:sqlite")
  const preCurrent = new sqlite.Database(database)
  preCurrent.run("CREATE TABLE sentinel (value TEXT NOT NULL)")
  preCurrent.run("INSERT INTO sentinel (value) VALUES ('preserved')")
  preCurrent.close()

  const env: Record<string, string | undefined> = {
    ...serviceEnv(root),
    YCODING_DB: undefined,
    YCODING_DISABLE_CHANNEL_DB: "1",
  }
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env,
    stderr: "pipe",
    stdout: "ignore",
  })

  try {
    const info = await waitForInfo(registration)
    await waitForReady(info)

    const current = new sqlite.Database(database, { readonly: true })
    expect(current.query("SELECT id FROM database_format").get()).toEqual({ id: DatabaseFormat.CurrentID })
    current.close()

    const backups = await fs.readdir(path.join(directory, "unsupported"))
    expect(backups).toHaveLength(1)
    const preserved = new sqlite.Database(path.join(directory, "unsupported", backups[0]!, "ycoding.db"), {
      readonly: true,
    })
    expect(preserved.query("SELECT value FROM sentinel").get()).toEqual({ value: "preserved" })
    preserved.close()
  } finally {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("corrupting a managed service registration stops its owner", async () => {
  const service = await startManagedService("ycoding-service-corrupt-")
  try {
    await fs.writeFile(service.registration, "not-json")
    await service.owner.exited
    expect(await Bun.file(service.registration).text()).toBe("not-json")
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("replacing a managed service registration stops its owner and preserves the foreign owner", async () => {
  const service = await startManagedService("ycoding-service-foreign-")
  const foreign = { ...service.info, id: "foreign-owner", pid: process.pid }
  try {
    await fs.writeFile(service.registration, JSON.stringify(foreign))
    await service.owner.exited
    expect(await Bun.file(service.registration).json()).toEqual(foreign)
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("clean managed service shutdown removes its registration", async () => {
  const service = await startManagedService("ycoding-service-clean-")
  try {
    await Effect.runPromise(Service.stop({ file: service.registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await service.owner.exited
    expect(await Bun.file(service.registration).exists()).toBe(false)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("concurrent service processes elect one server without resuming suspended Sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-election-"))
  const database = path.join(root, "ycoding.db")
  const env = {
    ...process.env,
    HOME: root,
    YCODING_DB: database,
    YCODING_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  const sessionID = Session.ID.make("ses_service_recovery")
  await withDatabase(
    database,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          directory: root,
          title: "recovery",
          time_suspended: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
    }),
  )
  const command = [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"]
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  const port = await availablePort()
  const config = path.join(root, "config", "ycoding", "service-local.json")
  await fs.mkdir(path.join(root, "config", "ycoding"), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port }))
  const processes = Array.from({ length: 10 }, () => Bun.spawn(command, { env, stderr: "pipe", stdout: "pipe" }))

  try {
    const info = await waitForInfo(registration)
    const winner = processes.find((process) => process.pid === info.pid)
    if (!winner) throw new Error(`Registered service process ${info.pid} was not one of the contenders`)
    const losers = processes.filter((process) => process.pid !== info.pid)
    await Promise.all(losers.map((process) => process.exited))
    const errors = await Promise.all(
      losers.map(
        async (process) => (await new Response(process.stdout).text()) + (await new Response(process.stderr).text()),
      ),
    )
    const loserOutput = errors.filter(Boolean).join("\n")
    expect(
      losers.map((process) => process.exitCode),
      loserOutput,
    ).toEqual(losers.map(() => 0))
    expect(loserOutput).not.toContain("database is locked")
    expect(winner.exitCode).toBe(null)
    expect(new URL(info.url).port).toBe(String(port))
    expect((await Bun.file(config).json()).password).toBe(info.password)
    expect(await Bun.file(registration + ".lock").exists()).toBe(false)
    expect(
      await fetch(new URL("/api/health", info.url), {
        headers: { authorization: "Basic " + btoa(`ycoding:${info.password}`) },
      }).then((response) => response.json()),
    ).toEqual({
      healthy: true,
      version: info.version,
      pid: info.pid,
      sourceEpoch: expect.stringMatching(/\S/),
    })
    const contender = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })
    try {
      expect(await contender.exited).toBe(0)
      expect((await waitForInfo(registration)).id).toBe(info.id)
    } finally {
      contender.kill("SIGTERM")
      await contender.exited
    }
    await Bun.sleep(250)
    expect(
      await withDatabase(
        database,
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db
            .select({ timeSuspended: SessionTable.time_suspended })
            .from(SessionTable)
            .get()
            .pipe(Effect.orDie)
        }),
      ),
    ).toMatchObject({ timeSuspended: expect.any(Number) })
    expect(await executionStarts(database, sessionID)).toBe(0)
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await winner.exited
    const winnerOutput = (await new Response(winner.stdout).text()) + (await new Response(winner.stderr).text())
    expect(winnerOutput).not.toContain("database is locked")
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    processes.forEach((process) => process.kill("SIGTERM"))
    await Promise.all(processes.map((process) => process.exited))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 120_000)

test("installation channels cannot own a shared service database concurrently", async () => {
  const service = await startManagedService("ycoding-service-shared-database-")
  await waitForReady(service.info)
  const port = await availablePort()
  const filename = ServiceConfig.filename("prod")
  const registration = path.join(service.root, "state", "ycoding", filename)
  const startupError = path.join(service.root, "contender.startup-error")
  await Bun.write(path.join(service.root, "config", "ycoding", filename), JSON.stringify({ port }))
  const contender = Bun.spawn([
    process.execPath,
    "--preload", path.join(import.meta.dir, "fixture/service-channel.ts"),
    path.join(import.meta.dir, "../src/index.ts"), "serve", "--service",
  ], {
    env: {
      ...serviceEnv(service.root),
      YCODING_TEST_SERVICE_CHANNEL: "prod",
      YCODING_SERVICE_STARTUP_ERROR_FILE: startupError,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  try {
    for (let attempt = 0; attempt < 400 && contender.exitCode === null; attempt++) {
      if (await Bun.file(registration).exists()) {
        await waitForReady(await waitForInfo(registration))
        break
      }
      await Bun.sleep(25)
    }
    expect(contender.exitCode).toBe(1)
    expect(await Bun.file(startupError).text()).toContain("Process lock is already held")
    expect(await Bun.file(registration).exists()).toBe(false)
    expect(await healthStatus(service.info)).toBe(200)
    expect(service.owner.exitCode).toBe(null)
    await expectPortAvailable(port)
  } finally {
    contender.kill("SIGTERM")
    await contender.exited
    await stopManagedService(service)
  }
}, 30_000)

test("managed service startup settles an unterminated execution as a failed run without resuming it", async () => {
  const sessionID = Session.ID.make("ses_service_killed")
  const startedType = EventRuntime.versionedType(
    SessionEvent.Execution.Started.type,
    SessionEvent.Execution.Started.durable.version,
  )
  const service = await startManagedService("ycoding-service-interrupted-", false, (database, root) =>
    withDatabase(
      database,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({ id: sessionID, project_id: Project.ID.global, directory: root, title: "killed" })
          .run()
          .pipe(Effect.orDie)
        yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 1 }).run().pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values({
            id: EventRuntime.ID.create(),
            aggregate_id: sessionID,
            seq: 1,
            created: Date.now(),
            type: startedType,
            data: { sessionID },
          })
          .run()
          .pipe(Effect.orDie)
      }),
    ),
  )
  try {
    await waitForReady(service.info)
    const outstanding = await fetch(new URL("/api/session/outstanding?failures=true", service.info.url), {
      headers: { authorization: "Basic " + btoa(`ycoding:${service.info.password}`) },
    }).then((response) => response.json())
    expect(outstanding).toEqual({ data: [], running: [], failed: [sessionID], lost: [] })
    expect(await executionStarts(path.join(service.root, "ycoding.db"), sessionID)).toBe(1)
  } finally {
    await stopManagedService(service)
  }
}, 60_000)

test("a crashed managed service loses its own background shell, then replacement reports the owed notice", async () => {
  const service = await startManagedService("ycoding-service-shell-crash-")
  const sessionID = Session.ID.make("ses_service_shell_crash")
  const database = path.join(service.root, "ycoding.db")
  let shellPID: number | undefined
  let replacement: Bun.Subprocess | undefined
  try {
    await waitForReady(service.info)
    await withDatabase(database, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(service.root), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global,
        directory: service.root, title: "crashed shell" }).run()
    }))
    const created = await fetch(new URL("/api/shell", service.info.url), {
      method: "POST",
      headers: { authorization: "Basic " + btoa(`ycoding:${service.info.password}`),
        "content-type": "application/json", "x-ycoding-directory": service.root },
      body: JSON.stringify({ command: "sleep 300", timeout: 0, metadata: { sessionID } }),
    })
    expect(created.status).toBe(200)
    const body: unknown = await created.json()
    if (typeof body !== "object" || body === null || !("data" in body)) throw new Error("Shell create response was unreadable")
    const shell = Schema.decodeUnknownSync(ShellSchema.Info)(body.data)
    if (shell.pid === undefined) throw new Error("Shell create response omitted its process ID")
    shellPID = shell.pid
    await withDatabase(database, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect((yield* db.select().from(ShellTable).all()).find((row) => row.id === shell.id)?.session_id).toBeNull()
      yield* ShellLedger.noticeOwed(db, shell.id, sessionID)
    }))

    service.owner.kill("SIGKILL")
    await service.owner.exited
    replacement = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
      env: serviceEnv(service.root), stderr: "pipe", stdout: "ignore",
    })
    const info = await waitForInfo(service.registration, (candidate) => candidate.pid === replacement?.pid)
    await waitForReady(info)
    const response = await fetch(new URL("/api/session/outstanding?failures=true", info.url), {
      headers: { authorization: "Basic " + btoa(`ycoding:${info.password}`) },
    })
    expect(await response.json()).toEqual({ data: [], running: [], failed: [], lost: [sessionID] })
    expect(await executionStarts(database, sessionID)).toBe(0)
    expect(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(shellPID)]).stdout.toString().trim()).toMatch(/^(|Z.*)$/)
  } finally {
    replacement?.kill("SIGTERM")
    if (replacement) await replacement.exited
    service.owner.kill("SIGKILL")
    await service.owner.exited
    if (shellPID !== undefined) try { process.kill(-shellPID, "SIGKILL") } catch {}
    await fs.rm(service.root, { recursive: true, force: true })
  }
}, 60_000)

test("configured managed service port overrides the channel default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-port-"))
  const port = await availablePort()
  const env = serviceEnv(root)
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  const config = path.join(root, "config", "ycoding", "service-local.json")
  await fs.mkdir(path.join(root, "config", "ycoding"), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port, password: "" }))
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env,
    stderr: "pipe",
    stdout: "ignore",
  })
  try {
    const info = await waitForInfo(registration)
    expect(new URL(info.url).port).toBe(String(port))
    expect(info.password).not.toBe("")
    expect((await Bun.file(config).json()).password).toBe(info.password)
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await owner.exited
  } finally {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("the default terminal launch uses the registered server when versions differ", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-tui-service-reuse-"))
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  const password = "terminal-reuse-test"
  const version = "0.11.8"
  const requests: string[] = []
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== "Basic " + btoa(`ycoding:${password}`))
        return new Response(null, { status: 401 })
      const route = new URL(request.url).pathname
      requests.push(route)
      if (route === "/api/health")
        return Response.json({ healthy: true, version, pid: process.pid, sourceEpoch: "source_test" })
      // End startup at the first TUI data request without requiring a renderer.
      return new Response(null, { status: 409 })
    },
  })
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    registration,
    JSON.stringify({ id: "existing-service", version, url: listener.url, pid: process.pid, password }),
  )
  const client = Bun.spawn([process.execPath, "--conditions=browser", path.join(import.meta.dir, "../src/tui.ts"), root], {
    env: serviceEnv(root),
    timeout: 10_000,
    stderr: "pipe",
    stdout: "ignore",
  })
  try {
    const output = await new Response(client.stderr).text()
    await client.exited
    expect(requests, output).toContain("/api/fs/list")
    expect(requests).not.toContain("/api/service/stop")
    expect((await waitForInfo(registration)).id).toBe("existing-service")
  } finally {
    client.kill("SIGTERM")
    await client.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 15_000)

test("concurrent managed starts share a free port when the configured port is occupied", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-port-fallback-"))
  using listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated") })
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  const config = path.join(root, "config", "ycoding", "service-local.json")
  await fs.mkdir(path.dirname(config), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port: listener.port }))
  const command = [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "service", "start"]
  const launch = () => Bun.spawn(command, { env: serviceEnv(root), stdout: "pipe", stderr: "pipe" })
  const starters = [launch(), launch()]
  try {
    for (const starter of starters) {
      const error = await new Response(starter.stderr).text()
      expect(await starter.exited, error).toBe(0)
    }
    const info = await waitForInfo(registration)
    expect(new URL(info.url).port).not.toBe(String(listener.port))
    expect(await healthStatus(info)).toBe(200)
    expect((await Bun.file(config).json()).port).toBe(listener.port)
    expect(await fetch(listener.url).then((response) => response.text())).toBe("unrelated")
    for (const starter of starters) {
      expect((await new Response(starter.stdout).text()).trim()).toBe(info.url)
    }
    const later = launch()
    starters.push(later)
    expect(await later.exited).toBe(0)
    expect((await new Response(later.stdout).text()).trim()).toBe(info.url)
    expect((await waitForInfo(registration)).id).toBe(info.id)
  } finally {
    for (const starter of starters) starter.kill("SIGTERM")
    await Promise.all(starters.map((starter) => starter.exited))
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)

test("explicit managed port occupancy reports an actionable conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-conflict-"))
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated") })
  const port = listener.port
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  await fs.mkdir(path.join(root, "config", "ycoding"), { recursive: true })
  await fs.writeFile(path.join(root, "config", "ycoding", "service-local.json"), JSON.stringify({ port }))
  const contender = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service", "--port", String(port)],
    { env: serviceEnv(root), stderr: "pipe", stdout: "pipe" },
  )
  try {
    expect(await contender.exited).not.toBe(0)
    const output = (await new Response(contender.stdout).text()) + (await new Response(contender.stderr).text())
    expect(output).toContain(`Managed service port ${port} on 127.0.0.1 is already in use by another process`)
    expect(output).toContain("Omit `--port` to select a free port automatically")
    expect(output).toContain("ycoding --standalone")
    expect(output).not.toContain("ycoding service set")
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    await listener.stop(true)
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("unresponsive occupancy of an explicit managed port reports a bounded conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-unresponsive-conflict-"))
  const recognizing = Promise.withResolvers<void>()
  const requests = { count: 0 }
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests.count += 1
      if (requests.count === 2) recognizing.resolve()
      return new Promise<Response>(() => {})
    },
  })
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  await fs.mkdir(path.join(root, "config", "ycoding"), { recursive: true })
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    path.join(root, "config", "ycoding", "service-local.json"),
    JSON.stringify({ port: listener.port }),
  )
  const stale = {
    id: "stale",
    version: InstallationVersion,
    url: listener.url.toString(),
    pid: process.pid,
    password: "stale",
  }
  await fs.writeFile(registration, JSON.stringify(stale))
  const contender = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service", "--port", String(listener.port)],
    { env: serviceEnv(root), stderr: "pipe", stdout: "pipe" },
  )

  try {
    await recognizing.promise
    expect(await contender.exited).toBe(1)
    const output = (await new Response(contender.stdout).text()) + (await new Response(contender.stderr).text())
    expect(output).toContain(`Managed service port ${listener.port} on 127.0.0.1 is already in use by another process`)
    expect(await Bun.file(registration).json()).toEqual(stale)
  } finally {
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)

test("port contender recognizes an incumbent registered during the bind race", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-bind-race-"))
  const recognizing = Promise.withResolvers<void>()
  const requests = { count: 0 }
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests.count += 1
      if (requests.count === 2) recognizing.resolve()
      return Response.json(
        { healthy: true, version: InstallationVersion, pid: process.pid, sourceEpoch: "source_test" },
        { status: 503 },
      )
    },
  })
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  const config = path.join(root, "config", "ycoding", "service-local.json")
  await fs.mkdir(path.dirname(config), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port: listener.port }))
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    registration,
    JSON.stringify({
      id: "stale",
      version: InstallationVersion,
      url: listener.url.toString(),
      pid: 2_147_483_647,
      password: "stale",
    }),
  )
  const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: serviceEnv(root),
    stderr: "pipe",
    stdout: "ignore",
  })

  try {
    await recognizing.promise
    await Bun.sleep(8_000)
    const info = {
      id: "incumbent",
      version: InstallationVersion,
      url: `http://127.0.0.1:${listener.port}`,
      pid: process.pid,
      password: "incumbent",
    }
    await fs.writeFile(registration, JSON.stringify(info))

    expect(await contender.exited).toBe(0)
    expect(await Bun.file(registration).json()).toEqual(info)
  } finally {
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)

test("stale dead registration is replaced after binding the selected port", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-stale-"))
  const port = await availablePort()
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  await fs.mkdir(path.join(root, "config", "ycoding"), { recursive: true })
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(path.join(root, "config", "ycoding", "service-local.json"), JSON.stringify({ port }))
  await fs.writeFile(
    registration,
    JSON.stringify({ id: "dead", version: "dead", url: `http://127.0.0.1:${port}`, pid: 2_147_483_647 }),
  )
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: serviceEnv(root),
    stderr: "pipe",
    stdout: "ignore",
  })
  try {
    const info = await waitForInfo(registration, (value) => value.id !== "dead")
    expect(new URL(info.url).port).toBe(String(port))
    expect(info.pid).toBe(owner.pid)
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await owner.exited
  } finally {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("a failed service stays registered and owns the selected port until stopped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-service-failed-"))
  const database = path.join(root, "database")
  const port = await availablePort()
  await fs.mkdir(database)
  await fs.mkdir(path.join(root, "config", "ycoding"), { recursive: true })
  await fs.writeFile(path.join(root, "config", "ycoding", "service-local.json"), JSON.stringify({ port }))
  const env = {
    ...process.env,
    HOME: root,
    YCODING_DB: database,
    YCODING_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  const command = [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"]
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  const owner = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })

  try {
    const info = await waitForInfo(registration)
    expect(new URL(info.url).port).toBe(String(port))
    await waitForFailed(info)
    expect(owner.exitCode).toBe(null)

    const contender = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })
    expect(await contender.exited).toBe(0)
    expect((await waitForInfo(registration)).id).toBe(info.id)
    expect(owner.exitCode).toBe(null)

    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await owner.exited
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

function withDatabase<A, E>(file: string, effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Database.layer({ path: file })), Effect.scoped))
}

function executionStarts(file: string, sessionID: Session.ID) {
  return withDatabase(
    file,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db
        .select({ id: EventTable.id, sessionID: EventTable.aggregate_id, type: EventTable.type })
        .from(EventTable)
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.filter(
              (row) =>
                row.sessionID === sessionID &&
                row.type ===
                  EventRuntime.versionedType(
                    SessionEvent.Execution.Started.type,
                    SessionEvent.Execution.Started.durable.version,
                  ),
            ),
          ),
          Effect.map((rows) => rows.length),
        )
    }),
  )
}

async function waitForInfo(file: string, accept: (info: Info) => boolean = () => true) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value !== undefined) {
      const info = await Schema.decodeUnknownPromise(Service.Info)(value)
      if (accept(info)) return info
    }
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for service registration")
}

async function waitForFailed(info: Info) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await healthStatus(info)
    if (status === 500) return
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for service boot failure")
}

async function waitForReady(info: Info) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await healthStatus(info)
    if (status === 200) return
    if (status === 500) throw new Error("Managed service entered the failed state")
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for service readiness")
}

function healthStatus(info: Info) {
  return fetch(new URL("/api/health", info.url), {
    headers: { authorization: "Basic " + btoa(`ycoding:${info.password}`) },
  })
    .then((response) => response.status)
    .catch(() => undefined)
}

async function availablePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("Server did not bind a port")
  return port
}

function serviceEnv(root: string) {
  return {
    ...process.env,
    HOME: root,
    YCODING_DB: path.join(root, "ycoding.db"),
    YCODING_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
}

async function startManagedService(prefix: string, failBoot = false, seed?: (database: string, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  await seed?.(path.join(root, "ycoding.db"), root)
  const port = await availablePort()
  const registration = path.join(root, "state", "ycoding", "service-local.json")
  await fs.mkdir(path.join(root, "config", "ycoding"), { recursive: true })
  if (failBoot) await fs.mkdir(path.join(root, "database"))
  await fs.writeFile(path.join(root, "config", "ycoding", "service-local.json"), JSON.stringify({ port }))
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: failBoot ? { ...serviceEnv(root), YCODING_DB: path.join(root, "database") } : serviceEnv(root),
    stderr: "pipe",
    stdout: "ignore",
  })
  const info = await waitForInfo(registration).catch(async (cause) => {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
    throw cause
  })
  return { root, port, registration, owner, info }
}

async function stopManagedService(service: Awaited<ReturnType<typeof startManagedService>>) {
  service.owner.kill("SIGTERM")
  await service.owner.exited
  await fs.rm(service.root, { recursive: true, force: true })
}

async function expectPortAvailable(port: number) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() })
  await server.stop(true)
}
