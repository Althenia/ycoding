import { afterAll, describe, expect } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppProcess } from "@ycoding-ai/core/process"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Service, type Interface, node, layer, NotFoundError } from "@ycoding-ai/core/shell"
import { ShellQueue } from "@ycoding-ai/core/shell/queue"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { ShellTable } from "@ycoding-ai/core/shell/sql"
import { Shell } from "@ycoding-ai/schema/shell"
import { eq, sql } from "drizzle-orm"
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const workspace = await mkdtemp(join(tmpdir(), "ycoding-shell-queued-"))
afterAll(() => rm(workspace, { recursive: true, force: true }))
const state = join(workspace, "state")

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    diagnostics: () => Effect.succeed([]),
    reload: () => Effect.void,
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ shell: "/bin/sh", shell_sandbox: "disabled", shell_queue: { max_running: 1 } }),
        }),
      ]),
  }),
)

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(workspace) })),
)

// While set, the next spawn runs `hook` once the process exists, before the spawn returns.
const spawnHook: { current?: Effect.Effect<void> } = {}

const appProcess = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const real = yield* AppProcess.Service
    return AppProcess.Service.of({
      ...real,
      spawn: (command) => {
        const hook = spawnHook.current
        spawnHook.current = undefined
        return hook ? Effect.uninterruptible(real.spawn(command).pipe(Effect.tap(() => hook))) : real.spawn(command)
      },
    })
  }),
).pipe(Layer.provide(AppNodeBuilder.build(AppProcess.node)))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      Database.node,
      Config.node,
      EventRuntime.node,
      Global.node,
      Location.node,
      ShellSandbox.node,
      ShellQueue.node,
      node,
    ]),
    [
      [AppProcess.node, appProcess],
      [Config.node, config],
      [Global.node, Global.layerWith({ data: join(workspace, "data"), state })],
      [
        ShellQueue.node,
        ShellQueue.configured({
          sample: Effect.succeed({ availableMb: 1_000_000, load: 0 }),
          backstopMs: 100,
          heartbeatMs: 50,
        }),
      ],
      [Location.node, locationLayer],
    ],
  ),
)

const posixIt = process.platform === "win32" ? it.live.skip : it.live
const sessionA = SessionSchema.ID.make("ses_queued_a")
const sessionB = SessionSchema.ID.make("ses_queued_b")
const sessionC = SessionSchema.ID.make("ses_queued_c")

const running = (shell: Interface, id: Shell.ID) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 250; attempt++) {
      if ((yield* shell.get(id)).status === "running") return
      yield* Effect.sleep(20)
    }
    return yield* Effect.die(new Error(`shell ${id} did not start`))
  })

const entries = Effect.promise(() => readdir(join(state, "shell-queue", "entries")).catch(() => [] as string[]))

// A slot is released just after the command's waiters resolve, when its managing fiber ends.
const drained = Effect.gen(function* () {
  for (let attempt = 0; attempt < 250; attempt++) {
    if ((yield* entries).length === 0) return
    yield* Effect.sleep(20)
  }
  return yield* Effect.die(new Error("shell queue entries were not released"))
})

describe("queued shell commands", () => {
  posixIt("start once admitted, report queue updates, and count their timeout from start", () =>
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const shell = yield* Service
      const seen: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          const data = event.data as { info?: Shell.Info; id?: string; status?: string }
          if (event.type === "shell.created" || event.type === "shell.updated")
            seen.push(`${event.type}:${data.info?.id}:${data.info?.status}`)
          if (event.type === "shell.exited") seen.push(`${event.type}:${data.id}:${data.status}`)
        }),
      )
      const release = join(workspace, "release-first")
      const first = yield* shell.enqueue(
        yield* shell.prepare({ command: `while [ ! -e '${release}' ]; do sleep 0.02; done`, timeout: 0 }),
        sessionA,
      )
      expect(first).toMatchObject({ status: "queued", queuePosition: 1 })
      yield* running(shell, first.id)

      const second = yield* shell.enqueue(
        yield* shell.prepare({ command: "sleep 0.2; printf ok", timeout: 500 }),
        sessionB,
      )
      expect(second).toMatchObject({ status: "queued", queuePosition: 1 })
      expect((yield* shell.list()).map((info) => [info.id, info.status])).toEqual([
        [first.id, "running"],
        [second.id, "queued"],
      ])
      expect((yield* shell.get(second.id)).status).toBe("queued")

      // Keep the second command queued for longer than its own 500 ms timeout before it can start.
      yield* Effect.sleep(700)
      expect((yield* shell.get(second.id)).status).toBe("queued")
      yield* Effect.promise(() => Bun.write(release, ""))
      const firstFinal = yield* shell.wait(first.id)
      const final = yield* shell.wait(second.id)
      expect(final).toMatchObject({ status: "exited", exit: 0 })
      expect(final.queuePosition).toBeUndefined()
      expect(final.time.queued).toBe(second.time.started)
      expect(final.time.started).toBeGreaterThanOrEqual(firstFinal.time.completed!)
      expect((yield* shell.output(second.id)).output).toBe("ok")
      expect(seen.filter((event) => event.includes(second.id))).toEqual([
        `shell.created:${second.id}:queued`,
        `shell.updated:${second.id}:running`,
        `shell.exited:${second.id}:exited`,
      ])
      yield* drained
    }),
  )

  posixIt("cancel when removed, without starting, and release their queue entry first", () =>
    Effect.gen(function* () {
      const shell = yield* Service
      const marker = join(workspace, "must-not-exist")
      const holder = yield* shell.enqueue(yield* shell.prepare({ command: "sleep 30", timeout: 0 }), sessionA)
      yield* running(shell, holder.id)
      const removed = yield* shell.enqueue(yield* shell.prepare({ command: `touch ${marker}`, timeout: 0 }), sessionB)
      const other = yield* shell.enqueue(yield* shell.prepare({ command: "printf other", timeout: 0 }), sessionC)

      const removedWait = yield* shell.wait(removed.id).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* shell.remove(removed.id)
      expect(yield* Fiber.join(removedWait)).toMatchObject({ status: "killed" })
      expect(yield* shell.get(removed.id).pipe(Effect.flip)).toBeInstanceOf(NotFoundError)
      expect((yield* entries).toSorted()).toEqual([`${holder.id}.json`, `${other.id}.json`].toSorted())

      yield* shell.remove(holder.id)
      expect((yield* shell.wait(other.id)).status).toBe("exited")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      yield* drained
    }),
  )

  posixIt("cancel only while still queued", () =>
    Effect.gen(function* () {
      const shell = yield* Service
      const holder = yield* shell.enqueue(yield* shell.prepare({ command: "sleep 30", timeout: 0 }), sessionA)
      yield* running(shell, holder.id)
      const waiting = yield* shell.enqueue(yield* shell.prepare({ command: "printf never", timeout: 0 }), sessionB)
      const waited = yield* shell.wait(waiting.id).pipe(Effect.forkScoped({ startImmediately: true }))
      expect(yield* shell.cancelQueued(holder.id)).toBe(false)
      expect((yield* shell.get(holder.id)).status).toBe("running")
      expect(yield* shell.cancelQueued(waiting.id)).toBe(true)
      expect(yield* Fiber.join(waited)).toMatchObject({ status: "killed" })
      expect(yield* shell.cancelQueued(waiting.id)).toBe(false)
      expect(yield* shell.cancelQueued(Shell.ID.make("sh_unknown"))).toBe(false)
      yield* shell.remove(holder.id)
      yield* drained
    }),
  )

  posixIt(
    "release their slot when they time out or exceed their memory limit",
    () =>
      Effect.gen(function* () {
        const shell = yield* Service
        const timed = yield* shell.enqueue(yield* shell.prepare({ command: "sleep 30", timeout: 200 }), sessionA)
        const hog = yield* shell.enqueue(
          yield* shell.prepare({
            command: `"${process.execPath}" -e 'const retained = [Buffer.alloc(160 * 1024 * 1024, 1)]; setInterval(() => void retained.length, 1000)'`,
            timeout: 0,
            memoryLimitMb: 64,
          }),
          sessionB,
        )
        const last = yield* shell.enqueue(yield* shell.prepare({ command: "printf done", timeout: 0 }), sessionC)
        expect((yield* shell.wait(timed.id)).status).toBe("timeout")
        expect((yield* shell.wait(hog.id).pipe(Effect.timeout(20_000))).status).toBe("memory-limit")
        expect((yield* shell.wait(last.id)).status).toBe("exited")
        yield* drained
      }),
    30_000,
  )

  posixIt("releases the queue entry and registration when registration fails after the entry is queued", () =>
    Effect.gen(function* () {
      const shell = yield* Service
      const db = (yield* Database.Service).db
      const marker = join(workspace, "failed-registration")
      yield* db.run(sql`ALTER TABLE shell RENAME TO shell_unavailable`).pipe(Effect.orDie)
      const failed = yield* shell
        .enqueue(yield* shell.prepare({ command: `touch ${marker}`, timeout: 0 }), sessionA)
        .pipe(
          Effect.exit,
          Effect.ensuring(db.run(sql`ALTER TABLE shell_unavailable RENAME TO shell`).pipe(Effect.orDie)),
        )
      expect(failed._tag).toBe("Failure")
      expect(yield* shell.list()).toEqual([])
      yield* drained
      const other = yield* shell.enqueue(yield* shell.prepare({ command: "printf ok", timeout: 0 }), sessionB)
      expect((yield* shell.wait(other.id).pipe(Effect.timeout(5_000))).status).toBe("exited")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      yield* drained
    }),
  )

  posixIt("never starts a queued command after the Shell service shuts down", () =>
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const marker = join(workspace, "after-shutdown")
      const started: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          const data = event.data as { info?: Shell.Info }
          if (event.type === "shell.updated" && data.info?.status === "running") started.push(data.info.id)
        }),
      )
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        layer().pipe(Layer.provide(Layer.mergeAll(config, locationLayer))),
        scope,
      )
      const shell = Context.get(context, Service)
      const holder = yield* shell.enqueue(yield* shell.prepare({ command: "sleep 30", timeout: 0 }), sessionA)
      yield* running(shell, holder.id)
      const queued = yield* shell.enqueue(yield* shell.prepare({ command: `touch ${marker}`, timeout: 0 }), sessionB)
      yield* Scope.close(scope, Exit.void)
      yield* drained
      yield* Effect.sleep(300)
      expect(started).toEqual([holder.id])
      expect(started).not.toContain(queued.id)
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  )

  posixIt("never run, record, or report running when cancelled while their admitted command spawns", () =>
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const shell = yield* Service
      const db = (yield* Database.Service).db
      const marker = join(workspace, "cancelled-during-spawn")
      const holder = yield* shell.enqueue(yield* shell.prepare({ command: "sleep 30", timeout: 0 }), sessionA)
      yield* running(shell, holder.id)
      const target = yield* shell.enqueue(
        yield* shell.prepare({ command: `sleep 0.3; touch '${marker}'`, timeout: 0 }),
        sessionB,
      )
      const updates: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          const data = event.data as { info?: Shell.Info }
          if (event.type === "shell.updated" && data.info?.id === target.id) updates.push(data.info.status)
        }),
      )
      const waited = yield* shell.wait(target.id).pipe(Effect.forkScoped({ startImmediately: true }))
      spawnHook.current = Effect.gen(function* () {
        yield* shell.remove(target.id).pipe(Effect.forkDetach({ startImmediately: true }))
        for (let attempt = 0; attempt < 250; attempt++) {
          if (
            yield* shell.get(target.id).pipe(
              Effect.as(false),
              Effect.catch(() => Effect.succeed(true)),
            )
          )
            return
          yield* Effect.sleep(5)
        }
      })
      yield* shell.remove(holder.id)
      expect(yield* Fiber.join(waited)).toMatchObject({ status: "killed" })
      yield* drained
      yield* Effect.sleep(600)
      expect(updates).not.toContain("running")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      expect(
        yield* db.select().from(ShellTable).where(eq(ShellTable.id, target.id)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(spawnHook.current).toBeUndefined()
    }),
  )

  posixIt("rejects a Session's command beyond the configured waiting limit", () =>
    Effect.gen(function* () {
      const shell = yield* Service
      const holder = yield* shell.enqueue(yield* shell.prepare({ command: "sleep 30", timeout: 0 }), sessionA)
      yield* running(shell, holder.id)
      const waiting = yield* Effect.forEach(Array.from({ length: 16 }), () =>
        Effect.gen(function* () {
          return yield* shell.enqueue(yield* shell.prepare({ command: "true", timeout: 0 }), sessionB)
        }),
      )
      expect(waiting.at(-1)?.queuePosition).toBe(16)
      const error = yield* Effect.gen(function* () {
        return yield* shell.enqueue(yield* shell.prepare({ command: "true", timeout: 0 }), sessionB)
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ShellQueue.FullError)
      yield* Effect.forEach([holder, ...waiting], (info) => shell.remove(info.id), { discard: true })
      yield* drained
    }),
  )
})
