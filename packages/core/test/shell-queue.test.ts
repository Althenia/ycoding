import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { mkdirSync, unlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { ConfigShell } from "@ycoding-ai/core/config/shell"
import { Global } from "@ycoding-ai/core/global"
import { AppProcess } from "@ycoding-ai/core/process"
import { ShellQueue } from "@ycoding-ai/core/shell/queue"
import { ProcessLock } from "@ycoding-ai/core/util/process-lock"
import { Hash } from "@ycoding-ai/core/util/hash"
import { Shell } from "@ycoding-ai/schema/shell"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { it } from "./lib/effect"

const worker = path.join(import.meta.dir, "fixture/shell-queue-worker.ts")
const posixIt = process.platform === "win32" ? it.live.skip : it.live

const temp = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "ycoding-shell-queue-"))),
  (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
)

const resources = { current: { availableMb: 1_000_000, load: 0 } as ShellQueue.Sample }

const queueLayer = (state: string, options: ShellQueue.Options = {}) =>
  AppNodeBuilder.build(
    ShellQueue.configured({
      sample: Effect.sync(() => resources.current),
      backstopMs: 100,
      heartbeatMs: 50,
      ...options,
    }),
    [[Global.node, Global.layerWith({ state })]],
  )

const withQueue = <A, E>(
  state: string,
  body: (queue: ShellQueue.Interface) => Effect.Effect<A, E, Scope.Scope>,
  options: ShellQueue.Options = {},
) =>
  Effect.gen(function* () {
    const queue = yield* ShellQueue.Service
    return yield* body(queue)
  }).pipe(Effect.provide(queueLayer(state, options)))

const limits = (input: ConfigShell.Queue = {}) => ConfigShell.queueLimits(input)

// Enqueues in its own scope so the test controls when the entry or its slot is released.
const enqueue = Effect.fn("test.enqueue")(function* (
  queue: ShellQueue.Interface,
  id: string,
  sessionID: string,
  options: { limits?: ConfigShell.Queue; memoryLimitMb?: number } = {},
) {
  const parent = yield* Scope.Scope
  const scope = yield* Scope.fork(parent)
  const ticket = yield* queue
    .enqueue({ id: Shell.ID.make(id), sessionID, limits: limits(options.limits), memoryLimitMb: options.memoryLimitMb })
    .pipe(Scope.provide(scope))
  const admitted = yield* Deferred.make<void>()
  const positions: number[] = []
  const fiber = yield* ticket
    .admitted((position) => Effect.sync(() => positions.push(position)))
    .pipe(Effect.andThen(Deferred.succeed(admitted, undefined)), Effect.forkScoped)
  return {
    ticket,
    positions,
    admitted,
    isAdmitted: Deferred.isDone(admitted),
    release: Fiber.interrupt(fiber).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
  }
})

const settle = Effect.sleep(200)

describe("ShellQueue", () => {
  it.live("cannot resurrect an entry cancelled after the admission-file rename", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const entryScope = yield* Scope.make()
      const publication = { cancelled: false }
      const closed = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Scope.close(entryScope, Exit.void))
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            yield* queue
              .enqueue({
                id: Shell.ID.make("sh_cancelled"),
                sessionID: "ses_cancelled",
                limits: limits({ max_running: 1 }),
              })
              .pipe(Scope.provide(entryScope))
            yield* Deferred.await(closed).pipe(Effect.timeout(2_000))
            const next = yield* enqueue(queue, "sh_next", "ses_other", { limits: { max_running: 1 } })
            yield* Deferred.await(next.admitted).pipe(Effect.timeout(2_000))
            expect(yield* Effect.promise(() => fs.readdir(path.join(state, "shell-queue", "entries")))).toEqual([
              "sh_next.json",
            ])
          }),
        {
          trace: (event) => {
            if (event !== "admission-written" || publication.cancelled) return
            publication.cancelled = true
            Effect.runFork(Scope.close(entryScope, Exit.void).pipe(Effect.andThen(Deferred.succeed(closed, undefined))))
          },
        },
      )
    }),
  )

  it.live("rejects waiting claims whose enclosing scope is already closed", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const closed = yield* Scope.make()
      yield* Scope.close(closed, Exit.void)
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const result = yield* queue
            .enqueue({ id: Shell.ID.make("sh_closed"), sessionID: "ses_closed", limits: limits() })
            .pipe(Scope.provide(closed), Effect.flip)
          expect(result._tag).toBe("ShellQueue.FullError")
          expect(yield* Effect.promise(() => fs.readdir(path.join(state, "shell-queue", "slots")))).toEqual([])
          const next = yield* enqueue(queue, "sh_next", "ses_other", { limits: { max_running: 1 } })
          yield* Deferred.await(next.admitted).pipe(Effect.timeout(2_000))
        }),
      )
    }),
  )

  for (const failure of ["lane", "entry"] as const) {
    it.live(`restores waiting ownership after an admission ${failure} write fails`, () =>
      Effect.gen(function* () {
        const state = yield* temp
        const root = path.join(state, "shell-queue")
        const target =
          failure === "lane"
            ? path.join(root, "lanes", Hash.sha256("ses_failed").slice(0, 32))
            : path.join(root, "entries", "sh_failed.json")
        const failed = yield* Deferred.make<void>()
        const publication = { written: false }
        yield* withQueue(
          state,
          (queue) =>
            Effect.gen(function* () {
              const head = yield* enqueue(queue, "sh_failed", "ses_failed", { limits: { max_running: 1 } })
              yield* Deferred.await(failed).pipe(Effect.timeout(2_000))
              yield* Effect.promise(() => fs.rmdir(target))
              const occupied = yield* Scope.make()
              yield* Effect.addFinalizer(() => Scope.close(occupied, Exit.void))
              yield* ProcessLock.claim(path.join(root, "slots", "run-0")).pipe(Scope.provide(occupied))
              if (failure === "lane")
                yield* Effect.promise(() => fs.unlink(path.join(root, "entries", "sh_failed.json")))
              const next = yield* enqueue(queue, "sh_next", "ses_other", { limits: { max_running: 1 } })
              const restored = yield* Effect.promise(() =>
                fs.readFile(path.join(root, "entries", "sh_failed.json"), "utf8"),
              )
              expect(
                Schema.decodeUnknownSync(
                  Schema.fromJsonString(Schema.Struct({ admitted: Schema.Undefined.pipe(Schema.optional) })),
                )(restored),
              ).toEqual({})
              yield* head.release
              yield* Scope.close(occupied, Exit.void)
              yield* Deferred.await(next.admitted).pipe(Effect.timeout(2_000))
            }),
          {
            backstopMs: 60_000,
            watch: () => ({ close() {} }),
            sample: Effect.never,
            trace: (event) => {
              if (event === "admission-written" && !publication.written) {
                if (failure === "entry") unlinkSync(target)
                mkdirSync(target, { recursive: true })
                publication.written = true
              }
              if (event === "wait-backstop" && publication.written) Effect.runSync(Deferred.succeed(failed, undefined))
            },
          },
        )
      }),
    )
  }

  it.live("reclaims old admission and entry temporaries and only unheld old bypass files", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const root = path.join(state, "shell-queue")
      yield* Effect.promise(() =>
        Promise.all(["entries", "slots"].map((name) => fs.mkdir(path.join(root, name), { recursive: true }))),
      )
      const uuid = "00000000-0000-4000-8000-000000000000"
      const old = [
        path.join(root, "entries", `sh_orphan.json.${uuid}.tmp`),
        path.join(root, `admission.${uuid}.tmp`),
        path.join(root, "slots", `bypass-${"a".repeat(64)}`),
      ]
      const keep = [
        path.join(root, "entries", `sh_recent.json.${uuid}.tmp`),
        path.join(root, `admission.11111111-1111-4111-8111-111111111111.tmp`),
        path.join(root, "slots", `bypass-${"b".repeat(64)}`),
        path.join(root, "unrelated.tmp"),
      ]
      const held = path.join(root, "slots", `bypass-${"c".repeat(64)}`)
      yield* ProcessLock.claim(held)
      yield* Effect.promise(async () => {
        await Promise.all([...old, ...keep].map((file) => fs.writeFile(file, "orphan")))
        const past = new Date(Date.now() - 60_000)
        await Promise.all([...old, held, keep[3]].map((file) => fs.utimes(file, past, past)))
      })
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const next = yield* enqueue(queue, "sh_next", "ses_other", { limits: { max_running: 1 } })
          yield* Deferred.await(next.admitted).pipe(Effect.timeout(2_000))
          expect(yield* Effect.promise(() => Promise.all(old.map((file) => Bun.file(file).exists())))).toEqual([
            false,
            false,
            false,
          ])
          expect(
            yield* Effect.promise(() => Promise.all([...keep, held].map((file) => Bun.file(file).exists()))),
          ).toEqual([true, true, true, true, true])
        }),
      )
    }),
  )

  posixIt("allows at most one foreign bypass while a failed head resamples after capacity is released", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const gate = path.join(state, "followers-go")
      const sampling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const samples = { count: 0, settled: 0 }
      const holder = spawn({
        state,
        log,
        id: "sh_holder",
        sessionID: "ses_holder",
        holdMs: -1,
        maxRunning: 1,
        stopAt: "claimed",
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          holder.kill("SIGKILL")
          await holder.exited
        }),
      )
      yield* waitFor(() => processStopped(holder.pid))
      const followers = Array.from({ length: 3 }, (_, index) =>
        spawn({
          state,
          log,
          id: `sh_foreign_${index}`,
          sessionID: `ses_foreign_${index}`,
          holdMs: -1,
          maxRunning: 4,
          enqueueGate: gate,
          evaluated: `${log}.${index}.evaluated`,
        }),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          followers.forEach((child) => child.kill("SIGKILL"))
          await Promise.all(followers.map((child) => child.exited))
        }),
      )
      yield* waitFor(() =>
        fs.readdir(state).then((names) => names.filter((name) => name.endsWith(".ready")).length === 3),
      )
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const head = yield* enqueue(queue, "sh_head", "ses_head", { limits: { max_running: 1 } })
            yield* Deferred.await(sampling).pipe(Effect.timeout(2_000))
            holder.kill("SIGKILL")
            yield* Effect.promise(() => holder.exited)
            yield* Effect.promise(() => fs.writeFile(gate, "go"))
            yield* waitFor(() =>
              fs.readdir(state).then((names) => names.filter((name) => name.endsWith(".evaluated")).length === 3),
            )
            yield* waitFor(() =>
              fs
                .readFile(log, "utf8")
                .then((text) => text.includes("start sh_foreign_"))
                .catch(() => false),
            )
            const starts = yield* Effect.promise(() => fs.readFile(log, "utf8").catch(() => ""))
            expect(samples.settled).toBe(0)
            expect(starts.split("\n").filter((line) => line.startsWith("start sh_foreign_"))).toHaveLength(1)
            expect(yield* head.isAdmitted).toBe(false)
            yield* Deferred.succeed(release, undefined)
          }),
        {
          sample: Effect.suspend(() =>
            ++samples.count === 1
              ? Effect.succeed({ availableMb: 1_000_000, load: 0 })
              : Deferred.succeed(sampling, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ availableMb: 0, load: 99 }),
                  Effect.ensuring(Effect.sync(() => samples.settled++)),
                ),
          ),
        },
      )
    }),
  )

  it.live("reuses an exhausted global range for eighty equal or narrower waiters in one pass", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const slots = path.join(state, "shell-queue", "slots")
      yield* Effect.promise(() => fs.mkdir(slots, { recursive: true }))
      yield* ProcessLock.claim(path.join(slots, "run-0"))
      yield* ProcessLock.claim(path.join(slots, "run-1"))
      const sampled = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const observations = { snapshots: 0, samples: 0, evaluating: false }
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const entries = yield* Effect.forEach(
              Array.from({ length: 80 }, (_, index) => index),
              (index) =>
                enqueue(queue, `sh_${index.toString().padStart(3, "0")}`, `ses_${index}`, {
                  limits: { max_running: index % 2 === 0 ? 2 : 1 },
                }),
              { concurrency: "unbounded" },
            )
            yield* Deferred.await(sampled)
            observations.snapshots = 0
            observations.samples = 0
            yield* Deferred.succeed(resume, undefined)
            yield* waitForEffect(Effect.sync(() => !observations.evaluating))
            expect(observations.snapshots).toBeLessThanOrEqual(5)
            expect(observations.samples).toBeLessThanOrEqual(3)
            expect(yield* Effect.forEach(entries, (entry) => entry.isAdmitted)).toEqual(
              Array.from({ length: 80 }, () => false),
            )
          }),
        {
          backstopMs: 60_000,
          watch: () => ({ close() {} }),
          sample: Deferred.succeed(sampled, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.tap(() => Effect.sync(() => observations.samples++)),
            Effect.as({ availableMb: 1_000_000, load: 0 }),
          ),
          trace: (event) => {
            if (event === "snapshot") observations.snapshots++
            if (event === "pass") observations.evaluating = true
            if (event === "wait-backstop") observations.evaluating = false
          },
        },
      )
    }),
  )

  it.live("keeps exhausted Session ranges separate and permits wider Session ranges", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const slots = path.join(state, "shell-queue", "slots")
      yield* Effect.promise(() => fs.mkdir(slots, { recursive: true }))
      yield* ProcessLock.claim(path.join(slots, `session-${Hash.sha256("ses_blocked").slice(0, 32)}-0`))
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const head = yield* enqueue(queue, "sh_head", "ses_blocked", { limits: { max_running: 4 } })
          const narrow = yield* enqueue(queue, "sh_narrow", "ses_blocked", { limits: { max_running: 4 } })
          const other = yield* enqueue(queue, "sh_other", "ses_other", { limits: { max_running: 4 } })
          const wider = yield* enqueue(queue, "sh_wider", "ses_blocked", {
            limits: { max_running: 4, max_running_per_session: 2 },
          })
          yield* Deferred.await(other.admitted).pipe(Effect.timeout(2_000))
          yield* Deferred.await(wider.admitted).pipe(Effect.timeout(2_000))
          expect(yield* head.isAdmitted).toBe(false)
          expect(yield* narrow.isAdmitted).toBe(false)
          expect(
            (yield* Effect.promise(() => fs.readdir(slots))).filter((name) => name.startsWith("run-")).toSorted(),
          ).toEqual(["run-0", "run-1"])
        }),
      )
    }),
  )

  for (const stopAt of ["entry-invalidated", "entry-released"] as const) {
    posixIt(`keeps terminal records invalidated while cleanup is stopped at ${stopAt}`, () =>
      Effect.gen(function* () {
        const state = yield* temp
        const log = path.join(state, "log")
        const retiring = spawn({
          state,
          log,
          id: "sh_retiring",
          sessionID: "ses_retiring",
          holdMs: 0,
          maxRunning: 1,
          stopAt,
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            retiring.kill("SIGKILL")
            await retiring.exited
          }),
        )
        yield* waitFor(() => processStopped(retiring.pid))
        const record = yield* Effect.promise(() =>
          fs.readFile(path.join(state, "shell-queue", "entries", "sh_retiring.json"), "utf8"),
        )
        expect(
          Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({ retiring: Schema.Literal(true), admitted: Schema.Undefined.pipe(Schema.optional) }),
            ),
          )(record).retiring,
        ).toBe(true)
        yield* withQueue(state, (queue) =>
          Effect.gen(function* () {
            const head = yield* enqueue(queue, "sh_head", "ses_head", { limits: { max_running: 1 } })
            if (stopAt === "entry-released") {
              yield* Deferred.await(head.admitted).pipe(Effect.timeout(2_000))
              expect(yield* head.isAdmitted).toBe(true)
              return
            }
            expect(
              (yield* Effect.scoped(ProcessLock.claim(path.join(state, "shell-queue", "slots", "run-0"))).pipe(
                Effect.flip,
              ))._tag,
            ).toBe("ProcessLockHeldError")
            const follower = yield* enqueue(queue, "sh_follower", "ses_follower", { limits: { max_running: 4 } })
            yield* Deferred.await(follower.admitted).pipe(Effect.timeout(2_000))
            expect(yield* head.isAdmitted).toBe(false)
            expect(
              (yield* Effect.scoped(ProcessLock.claim(path.join(state, "shell-queue", "slots", "run-1"))).pipe(
                Effect.flip,
              ))._tag,
            ).toBe("ProcessLockHeldError")
            process.kill(retiring.pid, "SIGCONT")
            yield* Effect.promise(() => retiring.exited)
            yield* Deferred.await(head.admitted).pipe(Effect.timeout(2_000))
            expect(
              yield* Effect.promise(() =>
                fs
                  .access(path.join(state, "shell-queue", "entries", "sh_retiring.json"))
                  .then(() => true)
                  .catch(() => false),
              ),
            ).toBe(false)
          }),
        )
      }),
    )
  }

  posixIt("starts a wider-range follower past a healthy foreign head blocked by unpublished claims", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const stopped = spawn({
        state,
        log,
        id: "sh_stopped",
        sessionID: "ses_stopped",
        holdMs: -1,
        maxRunning: 1,
        stopAt: "claimed",
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          stopped.kill("SIGKILL")
          await stopped.exited
        }),
      )
      yield* waitFor(() => processStopped(stopped.pid))
      const head = spawn({ state, log, id: "sh_head", sessionID: "ses_head", holdMs: -1, maxRunning: 1 })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          head.kill("SIGKILL")
          await head.exited
        }),
      )
      yield* waitFor(() =>
        fs
          .access(`${log}.sh_head.queued`)
          .then(() => true)
          .catch(() => false),
      )
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const follower = yield* enqueue(queue, "sh_follower", "ses_follower", { limits: { max_running: 4 } })
          yield* Deferred.await(follower.admitted).pipe(Effect.timeout(2_000))
          expect(yield* Effect.promise(() => fs.readFile(log, "utf8").catch(() => ""))).not.toContain("start sh_head")
          const slots = path.join(state, "shell-queue", "slots")
          expect(
            (yield* Effect.promise(() => fs.readdir(slots))).filter((name) => name.startsWith("run-")).toSorted(),
          ).toEqual(["run-0", "run-1"])
          expect((yield* Effect.scoped(ProcessLock.claim(path.join(slots, "run-0"))).pipe(Effect.flip))._tag).toBe(
            "ProcessLockHeldError",
          )
          expect((yield* Effect.scoped(ProcessLock.claim(path.join(slots, "run-1"))).pipe(Effect.flip))._tag).toBe(
            "ProcessLockHeldError",
          )
        }),
      )
    }),
  )

  it.live("admits the head of an idle queue at once and holds later entries behind the global cap", () =>
    Effect.gen(function* () {
      const state = yield* temp
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const first = yield* enqueue(queue, "sh_first", "ses_a", { limits: { max_running: 1 } })
          yield* Deferred.await(first.admitted).pipe(Effect.timeout(1_000))
          const second = yield* enqueue(queue, "sh_second", "ses_b", { limits: { max_running: 1 } })
          expect(first.ticket.position).toBe(1)
          expect(second.ticket.position).toBe(1)
          yield* settle
          expect(yield* second.isAdmitted).toBe(false)
          yield* first.release
          yield* Deferred.await(second.admitted).pipe(Effect.timeout(2_000))
          expect(second.positions).toEqual([])
          yield* second.release
          expect(yield* Effect.promise(() => fs.readdir(path.join(state, "shell-queue", "entries")))).toEqual([])
        }),
      )
    }),
  )

  it.live("clears a capacity failure hint and stops at an unmet ordered resource gate", () =>
    Effect.gen(function* () {
      const state = yield* temp
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          resources.current = { availableMb: 1_000_000, load: 0 }
        }),
      )
      const slots = path.join(state, "shell-queue", "slots")
      yield* Effect.promise(() => fs.mkdir(slots, { recursive: true }))
      const unpublished = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(unpublished, Exit.void))
      yield* ProcessLock.claim(path.join(slots, "run-0")).pipe(Scope.provide(unpublished))
      const decode = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ capacityBlocked: Schema.String.pipe(Schema.optional) })),
      )
      const blocked = () =>
        fs
          .readFile(path.join(state, "shell-queue", "entries", "sh_head.json"), "utf8")
          .then((raw) => Boolean(decode(raw).capacityBlocked))
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const holder = yield* enqueue(queue, "sh_holder", "ses_holder", { limits: { max_running: 4 } })
          yield* Deferred.await(holder.admitted)
          const head = yield* enqueue(queue, "sh_head", "ses_head", {
            limits: { max_running: 1 },
            memoryLimitMb: 4_096,
          })
          yield* waitFor(blocked)
          resources.current = { availableMb: 2_048, load: 0 }
          const follower = yield* enqueue(queue, "sh_follower", "ses_follower", {
            limits: { max_running: 4 },
            memoryLimitMb: 1_024,
          })
          yield* waitFor(() => blocked().then((value) => !value))
          expect(yield* head.isAdmitted).toBe(false)
          expect(yield* follower.isAdmitted).toBe(false)
          resources.current = { availableMb: 8_192, load: 0 }
          yield* Scope.close(unpublished, Exit.void)
          yield* Deferred.await(head.admitted).pipe(Effect.timeout(2_000))
          yield* Deferred.await(follower.admitted).pipe(Effect.timeout(2_000))
        }),
      )
    }),
  )

  it.live("serves Session lanes round-robin so one backlog cannot starve another Session", () =>
    Effect.gen(function* () {
      const state = yield* temp
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const blocker = yield* enqueue(queue, "sh_0_blocker", "ses_z", { limits: { max_running: 1 } })
          yield* Deferred.await(blocker.admitted)
          const entries = [
            yield* enqueue(queue, "sh_1_a1", "ses_a", { limits: { max_running: 1 } }),
            yield* enqueue(queue, "sh_2_a2", "ses_a", { limits: { max_running: 1 } }),
            yield* enqueue(queue, "sh_3_a3", "ses_a", { limits: { max_running: 1 } }),
            yield* enqueue(queue, "sh_4_b1", "ses_b", { limits: { max_running: 1 } }),
            yield* enqueue(queue, "sh_5_b2", "ses_b", { limits: { max_running: 1 } }),
          ]
          expect(entries.map((entry) => entry.ticket.position)).toEqual([1, 2, 3, 2, 4])
          const order: number[] = []
          const admitted = () => Effect.forEach(entries, (entry) => entry.isAdmitted)
          yield* blocker.release
          for (const step of entries.keys()) {
            yield* waitForEffect(admitted().pipe(Effect.map((flags) => flags.filter(Boolean).length > step)))
            const next = (yield* admitted()).findIndex((flag, index) => flag && !order.includes(index))
            order.push(next)
            yield* settle
            expect((yield* admitted()).filter(Boolean)).toHaveLength(step + 1)
            yield* entries[next]!.release
          }
          expect(order.map((index) => ["a1", "a2", "a3", "b1", "b2"][index])).toEqual(["a1", "b1", "a2", "b2", "a3"])
        }),
      )
    }),
  )

  it.live("keeps a second command of one Session waiting while another Session uses a free global slot", () =>
    Effect.gen(function* () {
      const state = yield* temp
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const a1 = yield* enqueue(queue, "sh_a1", "ses_a", { limits: { max_running: 2, max_running_per_session: 1 } })
          const a2 = yield* enqueue(queue, "sh_a2", "ses_a", { limits: { max_running: 2, max_running_per_session: 1 } })
          yield* Deferred.await(a1.admitted)
          yield* settle
          expect(yield* a2.isAdmitted).toBe(false)
          const b1 = yield* enqueue(queue, "sh_b1", "ses_b", { limits: { max_running: 2, max_running_per_session: 1 } })
          yield* Deferred.await(b1.admitted).pipe(Effect.timeout(2_000))
          expect(yield* a2.isAdmitted).toBe(false)
          yield* a1.release
          yield* Deferred.await(a2.admitted).pipe(Effect.timeout(2_000))
        }),
      )
    }),
  )

  it.live("rejects a Session's command beyond its waiting limit without counting its running command", () =>
    Effect.gen(function* () {
      const state = yield* temp
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const options = { limits: { max_running: 1, max_queued_per_session: 2 } }
          const running = yield* enqueue(queue, "sh_running", "ses_a", options)
          yield* Deferred.await(running.admitted)
          yield* enqueue(queue, "sh_wait_1", "ses_a", options)
          yield* enqueue(queue, "sh_wait_2", "ses_a", options)
          const error = yield* enqueue(queue, "sh_rejected", "ses_a", options).pipe(Effect.flip)
          expect(error).toBeInstanceOf(ShellQueue.FullError)
          expect(error.message).toContain("2 waiting commands")
          yield* enqueue(queue, "sh_other_session", "ses_b", options)
          expect(
            (yield* Effect.promise(() => fs.readdir(path.join(state, "shell-queue", "entries")))).toSorted(),
          ).toEqual(["sh_other_session.json", "sh_running.json", "sh_wait_1.json", "sh_wait_2.json"])
        }),
      )
    }),
  )

  it.live("uses its own slot range without counting higher indices reserved by another Location", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const slots = path.join(state, "shell-queue", "slots")
      const parent = yield* Scope.Scope
      const run = yield* Scope.fork(parent)
      const session = yield* Scope.fork(parent)
      const waiting = yield* Scope.fork(parent)
      const lane = "ses_shared"
      const hash = Hash.sha256(lane).slice(0, 32)
      yield* ProcessLock.claim(path.join(slots, "run-3")).pipe(Scope.provide(run))
      yield* ProcessLock.claim(path.join(slots, `session-${hash}-3`)).pipe(Scope.provide(session))
      yield* ProcessLock.claim(path.join(slots, `wait-${hash}-3`)).pipe(Scope.provide(waiting))
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const options = { limits: { max_running: 1, max_running_per_session: 1, max_queued_per_session: 1 } }
          const next = yield* enqueue(queue, "sh_next", lane, options)
          yield* Deferred.await(next.admitted).pipe(Effect.timeout(2_000))
          expect(yield* Effect.promise(() => fs.readdir(slots))).toEqual(
            expect.arrayContaining(["run-0", "run-3", `session-${hash}-0`, `session-${hash}-3`, `wait-${hash}-3`]),
          )
          yield* next.release
        }),
      )
    }),
  )

  it.live("acknowledges concurrent enqueues before a blocked admission sample settles", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const sampling = yield* Deferred.make<void>()
      const releaseSample = yield* Deferred.make<void>()
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const holder = yield* enqueue(queue, "sh_holder", "ses_holder", { limits: { max_running: 2 } })
            yield* Deferred.await(holder.admitted)
            const first = yield* enqueue(queue, "sh_0", "ses_0", { limits: { max_running: 2 } }).pipe(Effect.forkScoped)
            yield* Deferred.await(sampling)
            const acknowledged = yield* Effect.all(
              [
                Fiber.join(first),
                ...[1, 2, 3].map((index) =>
                  enqueue(queue, `sh_${index}`, `ses_${index}`, { limits: { max_running: 2 } }),
                ),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.timeout(600))
            expect(yield* Deferred.isDone(releaseSample)).toBe(false)
            expect(acknowledged).toHaveLength(4)
            expect(yield* Effect.forEach(acknowledged, (entry) => entry.isAdmitted)).toEqual([
              false,
              false,
              false,
              false,
            ])
            yield* Deferred.succeed(releaseSample, undefined)
            yield* Deferred.await(acknowledged[0].admitted).pipe(Effect.timeout(2_000))
            yield* Effect.forEach(acknowledged, (entry) => entry.release, { discard: true })
            yield* holder.release
          }),
        {
          sample: Deferred.succeed(sampling, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSample)),
            Effect.as({ availableMb: 1_000_000, load: 0 }),
          ),
        },
      )
    }),
  )

  posixIt("bounds mixed running caps by slot indices while a claimant is stopped", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const stopped = spawn({
        state,
        log,
        id: "sh_stopped",
        sessionID: "ses_stopped",
        holdMs: -1,
        maxRunning: 2,
        stopAt: "run-claimed",
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          stopped.kill("SIGKILL")
          await stopped.exited
        }),
      )
      yield* waitFor(() => processStopped(stopped.pid))
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const entries = yield* Effect.forEach([1, 2, 3], (index) =>
            enqueue(queue, `sh_other_${index}`, `ses_other_${index}`, { limits: { max_running: 4 } }),
          )
          yield* Effect.forEach(entries, (entry) => Deferred.await(entry.admitted))
          const slots = path.join(state, "shell-queue", "slots")
          expect((yield* Effect.scoped(ProcessLock.claim(path.join(slots, "run-0"))).pipe(Effect.flip))._tag).toBe(
            "ProcessLockHeldError",
          )
          expect(
            (yield* Effect.promise(() => fs.readdir(slots))).filter((name) => name.startsWith("run-")).toSorted(),
          ).toEqual(["run-0", "run-1", "run-2", "run-3"])
          const bounded = yield* enqueue(queue, "sh_bounded", "ses_bounded", { limits: { max_running: 2 } })
          process.kill(stopped.pid, "SIGCONT")
          yield* waitFor(() =>
            fs
              .readFile(log, "utf8")
              .then((text) => text.includes("start sh_stopped"))
              .catch(() => false),
          )
          const actual = yield* Effect.promise(async () =>
            Promise.all(
              (await fs.readdir(path.join(state, "shell-queue", "entries")))
                .filter((name) => name.endsWith(".json"))
                .map((name) =>
                  fs
                    .readFile(path.join(state, "shell-queue", "entries", name), "utf8")
                    .then((raw) => JSON.parse(raw) as { admitted?: number }),
                ),
            ),
          )
          expect(actual.filter((entry) => entry.admitted !== undefined)).toHaveLength(4)
          expect(yield* bounded.isAdmitted).toBe(false)
          stopped.kill("SIGKILL")
          yield* Effect.promise(() => stopped.exited)
          yield* Deferred.await(bounded.admitted).pipe(Effect.timeout(2_000))
          expect((yield* Effect.scoped(ProcessLock.claim(path.join(slots, "run-0"))).pipe(Effect.flip))._tag).toBe(
            "ProcessLockHeldError",
          )
        }),
      )
    }),
  )

  it.live("waits for memory and load while queued work runs, and admits the head when nothing queued runs", () =>
    Effect.gen(function* () {
      const state = yield* temp
      yield* Effect.addFinalizer(() => Effect.sync(() => (resources.current = { availableMb: 1_000_000, load: 0 })))
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          resources.current = { availableMb: 100, load: 9 }
          const options = {
            limits: { max_running: 2, max_running_per_session: 2, memory_reserve_mb: 2_048, max_load: 1 },
          }
          const idle = yield* enqueue(queue, "sh_idle", "ses_a", options)
          yield* Deferred.await(idle.admitted).pipe(Effect.timeout(2_000))

          const memory = yield* enqueue(queue, "sh_memory", "ses_a", { ...options, memoryLimitMb: 4_096 })
          resources.current = { availableMb: 3_000, load: 0.2 }
          yield* settle
          expect(yield* memory.isAdmitted).toBe(false)
          resources.current = { availableMb: 5_000, load: 1.5 }
          yield* settle
          expect(yield* memory.isAdmitted).toBe(false)
          resources.current = { availableMb: 5_000, load: 0.5 }
          yield* Deferred.await(memory.admitted).pipe(Effect.timeout(2_000))
          yield* memory.release

          resources.current = { availableMb: 1_000, load: 0 }
          const reserve = yield* enqueue(queue, "sh_reserve", "ses_a", options)
          yield* settle
          expect(yield* reserve.isAdmitted).toBe(false)
          yield* idle.release
          yield* Deferred.await(reserve.admitted).pipe(Effect.timeout(2_000))
        }),
      )
    }),
  )

  posixIt("bounds running commands across independent processes sharing one state directory", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const children = ["sh_proc_a", "sh_proc_b", "sh_proc_c"].map((id, index) =>
        spawn({ state, id, sessionID: `ses_${index}`, log, holdMs: 300, maxRunning: 1 }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => children.forEach((child) => child.kill("SIGKILL"))))
      const codes = yield* Effect.promise(() => Promise.all(children.map((child) => child.exited)))
      expect(codes).toEqual([0, 0, 0])
      const events = (yield* Effect.promise(() => fs.readFile(log, "utf8")))
        .trim()
        .split("\n")
        .map((line) => line.split(" "))
      expect(events).toHaveLength(6)
      const running = events.reduce(
        (state, [kind]) => {
          const current = state.current + (kind === "start" ? 1 : -1)
          return { current, max: Math.max(state.max, current) }
        },
        { current: 0, max: 0 },
      )
      expect(running.max).toBe(1)
    }),
  )

  posixIt("reclaims the slot and the waiting entry of a process that dies", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const holder = spawn({ state, id: "sh_holder", sessionID: "ses_holder", log, holdMs: -1, maxRunning: 1 })
      yield* Effect.addFinalizer(() => Effect.sync(() => holder.kill("SIGKILL")))
      yield* waitFor(() =>
        fs
          .readFile(log, "utf8")
          .then((text) => text.includes("start sh_holder"))
          .catch(() => false),
      )
      const waiter = spawn({ state, id: "sh_waiter", sessionID: "ses_waiter", log, holdMs: -1, maxRunning: 1 })
      yield* Effect.addFinalizer(() => Effect.sync(() => waiter.kill("SIGKILL")))
      yield* waitFor(() =>
        fs
          .access(`${log}.sh_waiter.queued`)
          .then(() => true)
          .catch(() => false),
      )
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const local = yield* enqueue(queue, "sh_local", "ses_local", { limits: { max_running: 1 } })
          expect(local.ticket.position).toBe(2)
          waiter.kill("SIGKILL")
          yield* Effect.promise(() => waiter.exited)
          yield* waitFor(() => Promise.resolve(local.positions.includes(1)))
          yield* settle
          expect(yield* local.isAdmitted).toBe(false)
          holder.kill("SIGKILL")
          yield* Effect.promise(() => holder.exited)
          yield* Deferred.await(local.admitted).pipe(Effect.timeout(2_000))
          const after = yield* enqueue(queue, "sh_after", "ses_after", { limits: { max_running: 1 } })
          yield* waitFor(() =>
            fs.readdir(path.join(state, "shell-queue", "entries")).then((names) => !names.includes("sh_holder.json")),
          )
          expect(yield* after.isAdmitted).toBe(false)
          expect(yield* Effect.promise(() => fs.readdir(path.join(state, "shell-queue", "entries")))).toEqual([
            "sh_after.json",
            "sh_local.json",
          ])
          yield* local.release
          yield* Deferred.await(after.admitted).pipe(Effect.timeout(2_000))
        }),
      )
    }),
  )

  posixIt(
    "starts the next entry while a live owner at the head stops evaluating, and keeps the stalled entry's place",
    () =>
      Effect.gen(function* () {
        const state = yield* temp
        const log = path.join(state, "log")
        yield* withQueue(state, (queue) =>
          Effect.gen(function* () {
            const holder = yield* enqueue(queue, "sh_holder", "ses_holder", { limits: { max_running: 1 } })
            yield* Deferred.await(holder.admitted)
            const stalled = spawn({ state, id: "sh_stalled", sessionID: "ses_stalled", log, holdMs: -1, maxRunning: 1 })
            yield* Effect.addFinalizer(() => Effect.sync(() => stalled.kill("SIGKILL")))
            yield* waitFor(() =>
              fs
                .access(`${log}.sh_stalled.queued`)
                .then(() => true)
                .catch(() => false),
            )
            const local = yield* enqueue(queue, "sh_local", "ses_local", { limits: { max_running: 1 } })
            expect(local.ticket.position).toBe(2)
            process.kill(stalled.pid, "SIGSTOP")
            yield* holder.release
            yield* Deferred.await(local.admitted).pipe(Effect.timeout(3_000))
            expect(yield* Effect.promise(() => fs.readFile(log, "utf8").catch(() => ""))).not.toContain(
              "start sh_stalled",
            )
            process.kill(stalled.pid, "SIGCONT")
            yield* settle
            expect(yield* Effect.promise(() => fs.readFile(log, "utf8").catch(() => ""))).not.toContain(
              "start sh_stalled",
            )
            yield* local.release
            yield* waitFor(() =>
              fs
                .readFile(log, "utf8")
                .then((text) => text.includes("start sh_stalled"))
                .catch(() => false),
            )
          }),
        )
      }),
  )

  posixIt("hands a freed slot to the next entry through file events, across processes, before the backstop", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const long = { backstopMs: 60_000 }
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const holder = yield* enqueue(queue, "sh_local_holder", "ses_local", { limits: { max_running: 1 } })
            yield* Deferred.await(holder.admitted)
            const remote = spawn({
              state,
              id: "sh_remote",
              sessionID: "ses_remote",
              log,
              holdMs: 300,
              maxRunning: 1,
              ...long,
            })
            yield* Effect.addFinalizer(() => Effect.sync(() => remote.kill("SIGKILL")))
            yield* waitFor(() =>
              fs
                .access(`${log}.sh_remote.queued`)
                .then(() => true)
                .catch(() => false),
            )
            const local = yield* enqueue(queue, "sh_local_next", "ses_local_next", { limits: { max_running: 1 } })
            yield* settle
            const released = Date.now()
            yield* holder.release
            yield* waitFor(() => logTime(log, "start").then((time) => time !== undefined))
            expect((yield* Effect.promise(() => logTime(log, "start")))! - released).toBeLessThan(1_500)
            yield* waitFor(() => logTime(log, "end").then((time) => time !== undefined))
            yield* Deferred.await(local.admitted).pipe(Effect.timeout(1_500))
            expect(Date.now() - (yield* Effect.promise(() => logTime(log, "end")))!).toBeLessThan(1_500)
          }),
        long,
      )
    }),
  )

  posixIt("admits on the backstop alone when the directory cannot be watched", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const traces: ShellQueue.Trace[] = []
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const remote = spawn({ state, id: "sh_remote", sessionID: "ses_remote", log, holdMs: 300, maxRunning: 1 })
            yield* Effect.addFinalizer(() => Effect.sync(() => remote.kill("SIGKILL")))
            yield* waitFor(() => logTime(log, "start").then((time) => time !== undefined))
            const local = yield* enqueue(queue, "sh_local", "ses_local", { limits: { max_running: 1 } })
            yield* settle
            expect(yield* local.isAdmitted).toBe(false)
            yield* Deferred.await(local.admitted).pipe(Effect.timeout(3_000))
            expect(traces).not.toContain("watch-open")
            expect(traces).toContain("wait-backstop")
          }),
        {
          watch: () => {
            throw new Error("EMFILE: too many open files, watch")
          },
          trace: (event) => traces.push(event),
        },
      )
    }),
  )

  it.live("evaluates on its backstop without heartbeat writes waking further passes", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const traces: ShellQueue.Trace[] = []
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const holder = yield* enqueue(queue, "sh_holder", "ses_a", { limits: { max_running: 1 } })
            yield* Deferred.await(holder.admitted)
            yield* enqueue(queue, "sh_waiting", "ses_b", { limits: { max_running: 1 } })
            yield* settle
            traces.length = 0
            yield* Effect.sleep(1_000)
            const passes = traces.filter((event) => event === "pass").length
            expect(passes).toBeGreaterThanOrEqual(5)
            expect(passes).toBeLessThanOrEqual(15)
          }),
        { trace: (event) => traces.push(event) },
      )
    }),
  )

  it.live("does not mistake entries being published concurrently for removed queue files", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const traces: ShellQueue.Trace[] = []
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const holder = yield* enqueue(queue, "sh_holder", "ses_holder", { limits: { max_running: 1 } })
            yield* Deferred.await(holder.admitted)
            const entries = yield* Effect.forEach(
              Array.from({ length: 20 }, (_, index) => index),
              (index) => enqueue(queue, `sh_wait_${index}`, `ses_${index % 2}`, { limits: { max_running: 1 } }),
              { concurrency: "unbounded" },
            )
            expect(traces).not.toContain("restore")
            yield* Effect.forEach(entries, (entry) => entry.release, { discard: true })
            yield* holder.release
          }),
        { trace: (event) => traces.push(event) },
      )
    }),
  )

  it.live("closes its watcher and timer when nothing waits and when the service shuts down", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const traces: ShellQueue.Trace[] = []
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(queueLayer(state, { trace: (event) => traces.push(event) }), scope)
      const queue = Context.get(context, ShellQueue.Service)
      const holder = yield* enqueue(queue, "sh_holder", "ses_a", { limits: { max_running: 1 } })
      yield* Deferred.await(holder.admitted)
      const waiting = yield* enqueue(queue, "sh_waiting", "ses_b", { limits: { max_running: 1 } })
      yield* settle
      expect(traces).toContain("watch-open")
      yield* holder.release
      yield* Deferred.await(waiting.admitted).pipe(Effect.timeout(1_000))
      yield* settle
      const watches = traces.filter((event) => event.startsWith("watch-"))
      expect(watches.filter((event) => event === "watch-open").length).toBe(
        watches.filter((event) => event === "watch-close").length,
      )
      expect(watches.at(-1)).toBe("watch-close")
      expect(traces.at(-1)).toBe("wait-idle")
      traces.length = 0
      yield* Effect.sleep(400)
      expect(traces).toEqual([])

      const blocked = yield* enqueue(queue, "sh_blocked", "ses_c", { limits: { max_running: 1 } })
      yield* settle
      expect(yield* blocked.isAdmitted).toBe(false)
      expect(traces).toContain("watch-open")
      yield* Scope.close(scope, Exit.void)
      expect(traces.at(-1)).toBe("watch-close")
      traces.length = 0
      yield* Effect.sleep(400)
      expect(traces).toEqual([])
      yield* waiting.release
      yield* blocked.release
    }),
  )

  it.live(
    "judges a foreign owner stale by its own recorded heartbeat interval, skips it while stalled, and reclaims it once dead",
    () =>
      Effect.gen(function* () {
        const state = yield* temp
        const root = path.join(state, "shell-queue")
        const ownerFile = path.join(root, "owners", "foreign.lock")
        yield* Effect.promise(() => fs.mkdir(path.join(root, "entries"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "owners"), { recursive: true }))
        const past = (seconds: number) => new Date(Date.now() - seconds * 1_000)
        const recordOwner = (heartbeatMs: number) =>
          Effect.promise(async () => {
            await fs.writeFile(ownerFile, JSON.stringify({ heartbeatMs }))
            await fs.utimes(ownerFile, past(2), past(2))
          })
        yield* recordOwner(60_000)
        const foreignLock = yield* Scope.make()
        yield* ProcessLock.claim(ownerFile).pipe(Scope.provide(foreignLock))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(root, "entries", "sh_foreign.json"),
            JSON.stringify({
              id: "sh_foreign",
              owner: "foreign",
              sessionID: "ses_foreign",
              enqueued: Date.now() - 10_000,
              reserveMb: 0,
              maxRunning: 1,
              maxRunningPerSession: 1,
              maxLoad: 100,
            }),
          ),
        )
        yield* withQueue(state, (queue) =>
          Effect.gen(function* () {
            const local = yield* enqueue(queue, "sh_local", "ses_local", { limits: { max_running: 1 } })
            expect(local.ticket.position).toBe(2)
            yield* Effect.sleep(400)
            expect(yield* local.isAdmitted).toBe(false)

            yield* recordOwner(50)
            yield* Deferred.await(local.admitted).pipe(Effect.timeout(2_000))
            expect(yield* Effect.promise(() => fs.readdir(path.join(root, "entries")))).toContain("sh_foreign.json")

            yield* Scope.close(foreignLock, Exit.void)
            const after = yield* enqueue(queue, "sh_after", "ses_after", { limits: { max_running: 1 } })
            expect(after.ticket.position).toBe(1)
            expect((yield* Effect.promise(() => fs.readdir(path.join(root, "entries")))).toSorted()).toEqual([
              "sh_after.json",
              "sh_local.json",
            ])
            yield* local.release
            yield* Deferred.await(after.admitted).pipe(Effect.timeout(2_000))
          }),
        )
      }),
  )

  it.live("refreshes its heartbeat while an evaluation waits on a resource sample", () =>
    Effect.gen(function* () {
      const state = yield* temp
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const holder = yield* enqueue(queue, "sh_holder", "ses_a", { limits: { max_running: 2 } })
            yield* Deferred.await(holder.admitted)
            yield* enqueue(queue, "sh_waiting", "ses_b", { limits: { max_running: 2 } })
            const owners = path.join(state, "shell-queue", "owners")
            const owner = path.join(owners, (yield* Effect.promise(() => fs.readdir(owners)))[0]!)
            const mtime = () => Effect.promise(() => fs.stat(owner)).pipe(Effect.map((info) => info.mtimeMs))
            const before = yield* mtime()
            yield* Effect.sleep(500)
            expect((yield* mtime()) - before).toBeGreaterThan(200)
          }),
        { heartbeatMs: 50, backstopMs: 50, sample: Effect.never },
      )
    }),
  )

  it.live("re-registers and restores its running slot when the queue directory is removed", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const root = path.join(state, "shell-queue")
      yield* withQueue(state, (local) =>
        withQueue(state, (other) =>
          Effect.gen(function* () {
            const holder = yield* enqueue(local, "sh_1_holder", "ses_holder", { limits: { max_running: 1 } })
            yield* Deferred.await(holder.admitted)
            yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))

            const next = yield* enqueue(local, "sh_2_next", "ses_next", { limits: { max_running: 1 } })
            expect(next.ticket.position).toBe(1)
            expect((yield* Effect.promise(() => fs.readdir(path.join(root, "entries")))).toSorted()).toEqual([
              "sh_1_holder.json",
              "sh_2_next.json",
            ])
            const owners = yield* Effect.promise(() => fs.readdir(path.join(root, "owners")))
            expect(owners).toHaveLength(1)
            const probe = yield* Effect.scoped(ProcessLock.claim(path.join(root, "owners", owners[0]!))).pipe(
              Effect.flip,
            )
            expect(probe._tag).toBe("ProcessLockHeldError")

            const foreign = yield* enqueue(other, "sh_3_foreign", "ses_foreign", { limits: { max_running: 1 } })
            yield* settle
            expect(yield* next.isAdmitted).toBe(false)
            expect(yield* foreign.isAdmitted).toBe(false)
            yield* holder.release
            yield* Deferred.await(next.admitted).pipe(Effect.timeout(2_000))
            yield* settle
            expect(yield* foreign.isAdmitted).toBe(false)
            yield* next.release
            yield* Deferred.await(foreign.admitted).pipe(Effect.timeout(2_000))
            yield* foreign.release
          }),
        ),
      )
    }),
  )

  for (const removed of ["owner", "entries"] as const) {
    it.live(`restores a missing ${removed} without another enqueue while only running commands remain`, () =>
      Effect.gen(function* () {
        const state = yield* temp
        const root = path.join(state, "shell-queue")
        yield* withQueue(state, (local) =>
          withQueue(state, (other) =>
            Effect.gen(function* () {
              const holder = yield* enqueue(local, "sh_holder", "ses_holder", { limits: { max_running: 1 } })
              yield* Deferred.await(holder.admitted)
              const owners = yield* Effect.promise(() => fs.readdir(path.join(root, "owners")))
              const owner = path.join(root, "owners", owners[0]!)
              yield* Effect.promise(() =>
                fs.rm(removed === "owner" ? owner : path.join(root, "entries"), { recursive: true, force: true }),
              )
              yield* waitFor(() =>
                fs
                  .access(path.join(root, "entries", "sh_holder.json"))
                  .then(() => fs.access(owner).then(() => true))
                  .catch(() => false),
              )
              expect((yield* Effect.scoped(ProcessLock.claim(owner)).pipe(Effect.flip))._tag).toBe(
                "ProcessLockHeldError",
              )
              const foreign = yield* enqueue(other, "sh_foreign", "ses_foreign", { limits: { max_running: 1 } })
              yield* settle
              expect(yield* foreign.isAdmitted).toBe(false)
              yield* holder.release
              yield* Deferred.await(foreign.admitted).pipe(Effect.timeout(2_000))
              yield* foreign.release
            }),
          ),
        )
      }),
    )
  }

  for (const stopAt of ["pass", "snapshot", "run-claimed", "claimed"] as const) {
    posixIt(`keeps enqueueing and admitting while another process is stopped at "${stopAt}"`, () =>
      Effect.gen(function* () {
        const state = yield* temp
        const log = path.join(state, "log")
        const limits = { max_running: 2, max_running_per_session: 1 }
        const stopped = spawn({
          state,
          log,
          id: "sh_0_stopped",
          sessionID: "ses_stopped",
          holdMs: -1,
          maxRunning: limits.max_running,
          stopAt,
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => stopped.kill("SIGKILL")))
        yield* waitFor(() => processStopped(stopped.pid))
        yield* withQueue(state, (queue) =>
          Effect.gen(function* () {
            const started = Date.now()
            const first = yield* enqueue(queue, "sh_1_first", "ses_first", { limits })
            const second = yield* enqueue(queue, "sh_2_second", "ses_second", { limits })
            expect(Date.now() - started).toBeLessThan(1_000)
            yield* Deferred.await(first.admitted).pipe(Effect.timeout(2_000))
            if (stopAt !== "claimed" && stopAt !== "run-claimed") {
              yield* Deferred.await(second.admitted).pipe(Effect.timeout(2_000))
              return
            }
            yield* settle
            expect(yield* second.isAdmitted).toBe(false)
            stopped.kill("SIGKILL")
            yield* Effect.promise(() => stopped.exited)
            yield* Deferred.await(second.admitted).pipe(Effect.timeout(2_000))
          }),
        )
      }),
    )
  }

  posixIt("bounds mixed per-Session running caps by slot indices while a claimant is stopped", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const stopped = spawn({
        state,
        log,
        id: "sh_stopped",
        sessionID: "ses_shared",
        holdMs: -1,
        maxRunning: 4,
        maxRunningPerSession: 2,
        stopAt: "session-claimed",
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          stopped.kill("SIGKILL")
          await stopped.exited
        }),
      )
      yield* waitFor(() => processStopped(stopped.pid))
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const entries = yield* Effect.forEach(
            Array.from({ length: 3 }, (_, index) => index),
            (index) =>
              enqueue(queue, `sh_other_${index}`, "ses_shared", {
                limits: { max_running: 4, max_running_per_session: 4 },
              }),
          )
          yield* Effect.forEach(entries, (entry) => Deferred.await(entry.admitted))
          const prefix = `session-${Hash.sha256("ses_shared").slice(0, 32)}-`
          const slots = path.join(state, "shell-queue", "slots")
          expect((yield* Effect.scoped(ProcessLock.claim(path.join(slots, `${prefix}0`))).pipe(Effect.flip))._tag).toBe(
            "ProcessLockHeldError",
          )
          const bounded = yield* enqueue(queue, "sh_bounded", "ses_shared", {
            limits: { max_running: 4, max_running_per_session: 1 },
          })
          process.kill(stopped.pid, "SIGCONT")
          yield* waitFor(() =>
            fs
              .readFile(log, "utf8")
              .then((text) => text.includes("start sh_stopped"))
              .catch(() => false),
          )
          expect(
            (yield* Effect.promise(() => fs.readdir(slots))).filter((name) => name.startsWith(prefix)).toSorted(),
          ).toEqual([0, 1, 2, 3].map((index) => `${prefix}${index}`))
          expect(yield* bounded.isAdmitted).toBe(false)
          stopped.kill("SIGKILL")
          yield* Effect.promise(() => stopped.exited)
          yield* Deferred.await(bounded.admitted).pipe(Effect.timeout(2_000))
          expect((yield* Effect.scoped(ProcessLock.claim(path.join(slots, `${prefix}0`))).pipe(Effect.flip))._tag).toBe(
            "ProcessLockHeldError",
          )
        }),
      )
    }),
  )

  posixIt("bounds mixed waiting caps by slot indices while a claimant is stopped", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const holder = yield* enqueue(queue, "sh_holder", "ses_holder", { limits: { max_running: 1 } })
          yield* Deferred.await(holder.admitted)
          const stopped = spawn({
            state,
            log,
            id: "sh_stopped",
            sessionID: "ses_shared",
            holdMs: -1,
            maxRunning: 1,
            maxQueuedPerSession: 2,
            stopAt: "wait-claimed",
          })
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              stopped.kill("SIGKILL")
              await stopped.exited
            }),
          )
          yield* waitFor(() => processStopped(stopped.pid))
          const options = { limits: { max_running: 1, max_queued_per_session: 4 } }
          const entries = yield* Effect.forEach([1, 2, 3], (index) =>
            enqueue(queue, `sh_other_${index}`, "ses_shared", options),
          )
          expect(yield* enqueue(queue, "sh_full", "ses_shared", options).pipe(Effect.flip)).toBeInstanceOf(
            ShellQueue.FullError,
          )
          expect(
            yield* enqueue(queue, "sh_small", "ses_shared", {
              limits: { max_running: 1, max_queued_per_session: 1 },
            }).pipe(Effect.flip),
          ).toBeInstanceOf(ShellQueue.FullError)
          const prefix = `wait-${Hash.sha256("ses_shared").slice(0, 32)}-`
          const slots = path.join(state, "shell-queue", "slots")
          expect((yield* Effect.scoped(ProcessLock.claim(path.join(slots, `${prefix}0`))).pipe(Effect.flip))._tag).toBe(
            "ProcessLockHeldError",
          )
          process.kill(stopped.pid, "SIGCONT")
          yield* waitFor(() =>
            fs
              .access(`${log}.sh_stopped.queued`)
              .then(() => true)
              .catch(() => false),
          )
          expect(
            (yield* Effect.promise(() => fs.readdir(slots))).filter((name) => name.startsWith(prefix)).toSorted(),
          ).toEqual([0, 1, 2, 3].map((index) => `${prefix}${index}`))
          expect(yield* Effect.forEach(entries, (entry) => entry.isAdmitted)).toEqual([false, false, false])
          yield* Effect.forEach(entries, (entry) => entry.release, { discard: true })
          yield* holder.release
        }),
      )
    }),
  )

  posixIt("allows only run-0 to bypass unmet resources after an idle snapshot race", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const sampled = yield* Deferred.make<void>()
      const stopped = spawn({
        state,
        log,
        id: "sh_stopped",
        sessionID: "ses_stopped",
        holdMs: -1,
        maxRunning: 4,
        stopAt: "run-claimed",
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          stopped.kill("SIGKILL")
          await stopped.exited
        }),
      )
      yield* waitFor(() => processStopped(stopped.pid))
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const entries = yield* Effect.forEach([0, 1, 2], (index) =>
              enqueue(queue, `sh_low_${index}`, `ses_${index}`, { limits: { max_running: 4 } }),
            )
            yield* Deferred.await(sampled).pipe(Effect.timeout(2_000))
            expect(yield* Effect.forEach(entries, (entry) => entry.isAdmitted)).toEqual([false, false, false])
            process.kill(stopped.pid, "SIGCONT")
            yield* waitFor(() =>
              fs
                .readFile(log, "utf8")
                .then((text) => text.includes("start sh_stopped"))
                .catch(() => false),
            )
            expect(yield* Effect.forEach(entries, (entry) => entry.isAdmitted)).toEqual([false, false, false])
            stopped.kill("SIGKILL")
            yield* Effect.promise(() => stopped.exited)
            yield* Deferred.await(entries[0].admitted).pipe(Effect.timeout(2_000))
            expect(yield* Effect.forEach(entries, (entry) => entry.isAdmitted)).toEqual([true, false, false])
            yield* Effect.forEach(entries, (entry) => entry.release, { discard: true })
          }),
        { sample: Deferred.succeed(sampled, undefined).pipe(Effect.as({ availableMb: 0, load: 99 })) },
      )
    }),
  )

  posixIt("revalidates a stopped snapshot reader's lane before claiming or starting", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      const stopped = spawn({
        state,
        log,
        id: "sh_stopped",
        sessionID: "ses_a",
        holdMs: -1,
        maxRunning: 2,
        maxRunningPerSession: 2,
        stopAt: "snapshot",
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => stopped.kill("SIGKILL")))
      yield* waitFor(() => processStopped(stopped.pid))
      const remote = spawn({
        state,
        log,
        id: "sh_remote",
        sessionID: "ses_a",
        holdMs: -1,
        maxRunning: 2,
        maxRunningPerSession: 2,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => remote.kill("SIGKILL")))
      yield* waitFor(() =>
        fs
          .readFile(log, "utf8")
          .then((text) => text.includes("start sh_remote"))
          .catch(() => false),
      )
      const sample = { current: { availableMb: 0, load: 100 } }
      yield* withQueue(
        state,
        (queue) =>
          Effect.gen(function* () {
            const next = yield* enqueue(queue, "sh_next", "ses_b", { limits: { max_running: 2 } })
            process.kill(stopped.pid, "SIGCONT")
            yield* settle
            expect(yield* Effect.promise(() => fs.readFile(log, "utf8"))).not.toContain("start sh_stopped")
            sample.current = { availableMb: 1_000_000, load: 0 }
            yield* Deferred.await(next.admitted).pipe(Effect.timeout(2_000))
            yield* settle
            expect(yield* Effect.promise(() => fs.readFile(log, "utf8"))).not.toContain("start sh_stopped")
            yield* next.release
            yield* waitFor(() =>
              fs
                .readFile(log, "utf8")
                .then((text) => text.includes("start sh_stopped"))
                .catch(() => false),
            )
          }),
        { sample: Effect.sync(() => sample.current) },
      )
    }),
  )

  posixIt(
    "never exceeds the global or per-Session cap while several processes admit many entries",
    () =>
      Effect.gen(function* () {
        const state = yield* temp
        const log = path.join(state, "log")
        const limits = { maxRunning: 2, maxRunningPerSession: 1 }
        const workers = Array.from({ length: 4 }, (_, worker) =>
          spawn({
            state,
            log,
            ...limits,
            entries: Array.from({ length: 8 }, (_, index) => ({
              id: `sh_w${worker}_${index}`,
              sessionID: `ses_${(worker + index) % 3}`,
              holdMs: 20 + ((worker * 7 + index * 13) % 40),
            })),
          }),
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => workers.forEach((child) => child.kill("SIGKILL"))))
        const peak = { total: 0, session: 0, samples: 0 }
        const done = { current: false }
        const sampler = yield* Effect.promise(async () => {
          while (!done.current) {
            const events = (await fs.readFile(log, "utf8").catch(() => ""))
              .split("\n")
              .slice(0, -1)
              .map((line) => line.split(" "))
            const ended = new Set(events.filter(([kind]) => kind === "end").map(([, id]) => id))
            const admitted = events.filter(([kind, id]) => kind === "start" && !ended.has(id))
            const perSession = Object.values(
              admitted.reduce<Record<string, number>>(
                (counts, [, , , sessionID]) => ({ ...counts, [sessionID!]: (counts[sessionID!] ?? 0) + 1 }),
                {},
              ),
            )
            peak.total = Math.max(peak.total, admitted.length)
            peak.session = Math.max(peak.session, ...perSession, 0)
            peak.samples++
            await Bun.sleep(2)
          }
        }).pipe(Effect.forkScoped)
        const codes = yield* Effect.promise(() => Promise.all(workers.map((child) => child.exited)))
        done.current = true
        yield* Fiber.join(sampler)
        expect(codes).toEqual([0, 0, 0, 0])
        expect(peak.samples).toBeGreaterThan(50)
        const events = (yield* Effect.promise(() => fs.readFile(log, "utf8")))
          .trim()
          .split("\n")
          .map((line) => line.split(" "))
          .map(([kind, id, time, sessionID]) => ({ kind, id, time: Number(time), sessionID }))
        expect(events.filter((event) => event.kind === "start")).toHaveLength(32)
        const overlap = events.reduce(
          (current, event) => {
            const delta = event.kind === "start" ? 1 : -1
            const sessions = {
              ...current.sessions,
              [event.sessionID!]: (current.sessions[event.sessionID!] ?? 0) + delta,
            }
            return {
              total: current.total + delta,
              sessions,
              maxTotal: Math.max(current.maxTotal, current.total + delta),
              maxSession: Math.max(current.maxSession, ...Object.values(sessions)),
            }
          },
          { total: 0, sessions: {} as Record<string, number>, maxTotal: 0, maxSession: 0 },
        )
        expect(overlap.maxTotal).toBeLessThanOrEqual(2)
        expect(overlap.maxSession).toBeLessThanOrEqual(1)
        expect(peak.total).toBeLessThanOrEqual(2)
        expect(peak.session).toBeLessThanOrEqual(1)
      }),
    60_000,
  )

  posixIt("rejects excess waiting entries across real processes without exceeding the waiting cap", () =>
    Effect.gen(function* () {
      const state = yield* temp
      const log = path.join(state, "log")
      yield* withQueue(state, (queue) =>
        Effect.gen(function* () {
          const holder = yield* enqueue(queue, "sh_holder", "ses_holder", { limits: { max_running: 1 } })
          yield* Deferred.await(holder.admitted)
          const workers = Array.from({ length: 4 }, (_, worker) =>
            spawn({
              state,
              log,
              maxRunning: 1,
              maxQueuedPerSession: 3,
              entries: Array.from({ length: 8 }, (_, index) => ({
                id: `sh_w${worker}_${index}`,
                sessionID: "ses_shared",
                holdMs: 30,
              })),
            }),
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => workers.forEach((child) => child.kill("SIGKILL"))))
          const done = { current: false }
          const peak = { waiting: 0, samples: 0 }
          const sampler = yield* Effect.promise(async () => {
            while (!done.current) {
              const names = await fs.readdir(path.join(state, "shell-queue", "entries"))
              const entries = await Promise.all(
                names
                  .filter((name) => name.endsWith(".json"))
                  .map((name) =>
                    fs
                      .readFile(path.join(state, "shell-queue", "entries", name), "utf8")
                      .then((raw) => JSON.parse(raw) as { sessionID: string; admitted?: number })
                      .catch(() => undefined),
                  ),
              )
              peak.waiting = Math.max(
                peak.waiting,
                entries.filter((entry) => entry?.sessionID === "ses_shared" && entry.admitted === undefined).length,
              )
              peak.samples++
              await Bun.sleep(2)
            }
          }).pipe(Effect.forkScoped)
          yield* waitFor(() =>
            fs.readdir(state).then((names) => names.filter((name) => /\.(queued|rejected)$/.test(name)).length === 32),
          )
          const markers = yield* Effect.promise(() => fs.readdir(state))
          expect(markers.filter((name) => name.endsWith(".queued"))).toHaveLength(3)
          expect(markers.filter((name) => name.endsWith(".rejected"))).toHaveLength(29)
          yield* holder.release
          expect(yield* Effect.promise(() => Promise.all(workers.map((child) => child.exited)))).toEqual([0, 0, 0, 0])
          done.current = true
          yield* Fiber.join(sampler)
          expect(peak.waiting).toBe(3)
          expect(peak.samples).toBeGreaterThan(20)
        }),
      )
    }),
  )

  it.live("reads reclaimable memory and normalized load from the host", () =>
    Effect.gen(function* () {
      const appProcess = yield* AppProcess.Service
      const sample = yield* ShellQueue.sample(appProcess)
      expect(sample.availableMb).toBeGreaterThan(0)
      expect(sample.availableMb).toBeLessThanOrEqual(os.totalmem() / 1024 / 1024)
      expect(Number.isFinite(sample.load)).toBe(true)
      expect(sample.load).toBeGreaterThanOrEqual(0)
    }).pipe(Effect.provide(AppNodeBuilder.build(AppProcess.node))),
  )
})

describe("vmStatAvailableMb", () => {
  it.effect("counts free, inactive, and speculative pages without adding purgeable pages again", () =>
    Effect.sync(() => {
      const text = [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages free:                                     5250.",
        "Pages active:                                 398519.",
        "Pages inactive:                               393968.",
        "Pages speculative:                              2792.",
        "Pages throttled:                                   0.",
        "Pages wired down:                             301818.",
        "Pages purgeable:                                1781.",
      ].join("\n")
      expect(ShellQueue.vmStatAvailableMb(text)).toBe(((5250 + 393968 + 2792) * 16384) / 1024 / 1024)
      expect(ShellQueue.vmStatAvailableMb("Pages free: 1.")).toBeUndefined()
    }),
  )
})

function spawn(input: {
  state: string
  log: string
  maxRunning: number
  maxRunningPerSession?: number
  maxQueuedPerSession?: number
  backstopMs?: number
  stopAt?: ShellQueue.Trace
  enqueueGate?: string
  evaluated?: string
  id?: string
  sessionID?: string
  holdMs?: number
  entries?: { id: string; sessionID: string; holdMs: number }[]
}) {
  const options = {
    state: input.state,
    log: input.log,
    backstopMs: input.backstopMs ?? 100,
    maxRunning: input.maxRunning,
    maxRunningPerSession: input.maxRunningPerSession ?? 1,
    maxQueuedPerSession: input.maxQueuedPerSession ?? 16,
    stopAt: input.stopAt,
    enqueueGate: input.enqueueGate,
    evaluated: input.evaluated,
    entries: input.entries ?? [{ id: input.id ?? "", sessionID: input.sessionID ?? "", holdMs: input.holdMs ?? 0 }],
  }
  return Bun.spawn([process.execPath, worker, JSON.stringify(options)], { stdout: "ignore", stderr: "inherit" })
}

const processStopped = (pid: number) =>
  Bun.$`ps -o stat= -p ${pid}`
    .quiet()
    .nothrow()
    .text()
    .then((stat) => stat.trim().startsWith("T"))

const logTime = (log: string, event: string) =>
  fs
    .readFile(log, "utf8")
    .then((text) => {
      const line = text.split("\n").find((item) => item.startsWith(`${event} `))
      return line === undefined ? undefined : Number(line.split(" ")[2])
    })
    .catch(() => undefined)

function waitFor(check: () => Promise<boolean>) {
  return Effect.promise(async () => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (await check()) return
      await Bun.sleep(20)
    }
    throw new Error("condition was not reached")
  })
}

function waitForEffect(check: Effect.Effect<boolean>) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (yield* check) return
      yield* Effect.sleep(20)
    }
    return yield* Effect.die(new Error("condition was not reached"))
  })
}
