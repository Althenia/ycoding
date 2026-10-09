import { afterAll, afterEach, expect } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Shell as ShellSchema } from "@ycoding-ai/schema/shell"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AppProcess } from "@ycoding-ai/core/process"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Shell } from "@ycoding-ai/core/shell"
import { ShellLedger } from "@ycoding-ai/core/shell/ledger"
import { ShellTable } from "@ycoding-ai/core/shell/sql"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const workspace = await mkdtemp(join(tmpdir(), "ycoding-shell-ledger-"))
afterAll(() => rm(workspace, { recursive: true, force: true }))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      Config.node,
      Database.node,
      EventRuntime.node,
      Global.node,
      Location.node,
      ShellSandbox.node,
      Shell.node,
    ]),
    [
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({ diagnostics: () => Effect.succeed([]),
            reload: () => Effect.void,
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({ shell: "/bin/sh", shell_sandbox: "disabled" }),
                }),
              ]),
          }),
        ),
      ],
      [Global.node, Global.layerWith({ data: join(workspace, "data") })],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workspace) }))),
      ],
    ],
  ),
)

const posix = process.platform === "win32" ? it.live.skip : it.live
const spawned: ChildProcess[] = []
afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.pid === undefined) continue
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
  }
})

const orphan = (script: string) => {
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" })
  spawned.push(child)
  return child
}

const exited = (child: ChildProcess) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once("exit", () => resolve())
      }),
  )

posix("keeps caller-supplied shell metadata out of the durable Session owner", () =>
  Effect.gen(function* () {
    const shell = yield* Shell.Service
    const db = (yield* Database.Service).db
    const claimed = SessionSchema.ID.make("ses_untrusted_claim")
    const trusted = SessionSchema.ID.make("ses_trusted_owner")
    const info = yield* shell.create(
      yield* shell.prepare({ command: "sleep 30", timeout: 0, metadata: { sessionID: claimed } }),
    )
    const row = () => db.select().from(ShellTable).where(eq(ShellTable.id, info.id)).get().pipe(Effect.orDie)
    expect((yield* row())?.session_id).toBeNull()
    yield* shell.noticeOwed(info.id, trusted)
    expect((yield* row())?.session_id).toBe(trusted)
    yield* shell.noticeAdmitted(info.id)
    expect(yield* row()).toBeUndefined()
    yield* shell.remove(info.id)
  }),
)

posix("reconciles a dead owner's surviving shell group and retains only its owed notice", () =>
  Effect.gen(function* () {
    const child = orphan("sleep 300")
    const appProcess = yield* AppProcess.Service
    const db = (yield* Database.Service).db
    const identity = yield* ShellLedger.identify(appProcess, child.pid!)
    expect(identity?.pgid).toBe(child.pid)
    const id = ShellSchema.ID.create()
    const sessionID = SessionSchema.ID.make("ses_owed_shell")
    yield* ShellLedger.record(db, {
      id,
      pid: child.pid!,
      started: identity?.started,
      owner: { pid: 2_000_000_000, pgid: 2_000_000_000, started: "Thu Jan  1 00:00:00 1970" },
    })
    yield* ShellLedger.noticeOwed(db, id, sessionID)
    yield* ShellLedger.reconcile(db, appProcess, 100)
    yield* exited(child)
    expect(child.signalCode).toBe("SIGTERM")
    expect(yield* db.select().from(ShellTable).where(eq(ShellTable.id, id)).get()).toMatchObject({
      session_id: sessionID,
      notice_pending: true,
      time_lost: expect.any(Number),
    })
  }),
)

posix("leaves a shell owned by a live server alone and refuses to signal a mismatched process identity", () =>
  Effect.gen(function* () {
    const child = orphan("sleep 300")
    const appProcess = yield* AppProcess.Service
    const db = (yield* Database.Service).db
    const owner = yield* ShellLedger.identify(appProcess, process.pid)
    expect(owner).toBeDefined()
    const live = ShellSchema.ID.create()
    yield* ShellLedger.record(db, { id: live, pid: child.pid!, owner: owner! })
    const stale = ShellSchema.ID.create()
    yield* ShellLedger.record(db, {
      id: stale,
      pid: child.pid!,
      started: "Thu Jan  1 00:00:00 1970",
      owner: { pid: 2_000_000_000, pgid: 2_000_000_000, started: "Thu Jan  1 00:00:00 1970" },
    })
    yield* ShellLedger.reconcile(db, appProcess, 100)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    expect(yield* db.select().from(ShellTable).where(eq(ShellTable.id, live)).get()).toBeDefined()
    expect(yield* db.select().from(ShellTable).where(eq(ShellTable.id, stale)).get()).toBeUndefined()
  }),
)

posix("escalates an orphaned group that ignores SIGTERM to SIGKILL", () =>
  Effect.gen(function* () {
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; printf ready; while :; do sleep 1; done"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    spawned.push(child)
    yield* Effect.promise(() => new Promise<void>((resolve) => child.stdout.once("data", () => resolve())))
    const appProcess = yield* AppProcess.Service
    const db = (yield* Database.Service).db
    const id = ShellSchema.ID.create()
    yield* ShellLedger.record(db, {
      id,
      pid: child.pid!,
      started: (yield* ShellLedger.identify(appProcess, child.pid!))?.started,
      owner: { pid: 2_000_000_000, pgid: 2_000_000_000, started: "Thu Jan  1 00:00:00 1970" },
    })
    yield* ShellLedger.reconcile(db, appProcess, 100)
    yield* exited(child)
    expect(child.signalCode).toBe("SIGKILL")
    expect(yield* db.select().from(ShellTable).where(eq(ShellTable.id, id)).get()).toBeUndefined()
  }),
)

posix("terminates a shell group after its original leader dies", () =>
  Effect.gen(function* () {
    const child = orphan("sleep 300 & wait")
    const appProcess = yield* AppProcess.Service
    const db = (yield* Database.Service).db
    const id = ShellSchema.ID.create()
    yield* ShellLedger.record(db, {
      id,
      pid: child.pid!,
      started: (yield* ShellLedger.identify(appProcess, child.pid!))?.started,
      owner: { pid: 2_000_000_000, pgid: 2_000_000_000, started: "Thu Jan  1 00:00:00 1970" },
    })
    const group = ShellLedger.processes(appProcess).pipe(
      Effect.map((rows) => rows.filter((row) => row.pgid === child.pid)),
    )
    yield* Effect.gen(function* () {
      while ((yield* group).length < 2) yield* Effect.sleep(10)
    }).pipe(Effect.timeout(3_000))
    process.kill(child.pid!, "SIGKILL")
    yield* exited(child)
    expect((yield* group).length).toBeGreaterThan(0)
    yield* ShellLedger.reconcile(db, appProcess, 100)
    yield* Effect.gen(function* () {
      while ((yield* group).length > 0) yield* Effect.sleep(10)
    }).pipe(Effect.timeout(3_000))
    expect(yield* db.select().from(ShellTable).where(eq(ShellTable.id, id)).get()).toBeUndefined()
  }),
)
