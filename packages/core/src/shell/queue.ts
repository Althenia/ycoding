export * as ShellQueue from "./queue"

import { randomUUID } from "crypto"
import { watch } from "fs"
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Context, Deferred, Effect, Exit, Layer, Option, Queue, Schema, Scope, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { Shell } from "@ycoding-ai/schema/shell"
import type { ConfigShell } from "../config/shell"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"
import { AppProcess } from "../process"
import { Hash } from "../util/hash"
import { ProcessLock } from "../util/process-lock"
import { ShellMemory } from "./memory"

// While this process has waiting entries it re-evaluates at least this often, covering changes
// that produce no file event: resource levels, crashed owners, stalled owners, and missed events.
const BACKSTOP_MS = 2_000
// While this process owns entries it refreshes its heartbeat on this interval, from a fiber
// that never waits on an evaluation.
const HEARTBEAT_MS = 1_000
// An owner whose heartbeat is older than this many of its own recorded intervals is stalled or dead.
const STALE_HEARTBEATS = 5
// An entry file that still cannot be decoded after this long was torn by a writer that died.
const TORN_MS = HEARTBEAT_MS * STALE_HEARTBEATS
const SAMPLE_TIMEOUT_MS = 1_000
const MIB = 1024 * 1024

export type Sample = { readonly availableMb: number; readonly load: number }

export interface Request {
  readonly id: Shell.ID
  readonly sessionID: string
  readonly command: string
  readonly cwd: string
  readonly admission?: Admission
  readonly memoryLimitMb?: number
  readonly residentMb?: () => number
  readonly limits: Required<ConfigShell.Queue>
}

export interface Admission {
  readonly family: string
  readonly acquire: Effect.Effect<FamilyReservation | undefined>
  readonly subscribe: (wake: () => void) => () => void
}

export interface FamilyReservation {
  readonly release: Effect.Effect<void>
  readonly commit: Effect.Effect<void>
}

export class FullError extends Schema.TaggedErrorClass<FullError>()("ShellQueue.FullError", {
  limit: Schema.Number,
}) {
  override get message() {
    return `The shell queue already holds ${this.limit} waiting commands for this Session. Wait for a queued command to start before queueing another.`
  }
}

export class EntryLostError extends Schema.TaggedErrorClass<EntryLostError>()("ShellQueue.EntryLostError", {
  id: Schema.String,
}) {
  override get message() {
    return `The shell queue entry ${this.id} was removed before it was admitted`
  }
}

export interface Ticket {
  readonly position: number
  // Waits until the entry is admitted, reporting each position change while it waits.
  readonly admitted: (onPosition: (position: number) => Effect.Effect<void>) => Effect.Effect<void, EntryLostError>
}

export interface Interface {
  readonly recordPeak: (input: ShellMemory.Peak) => Effect.Effect<void>
  // Adds an entry to the machine-wide queue. The entry and every slot it holds are released when
  // the enclosing scope closes.
  readonly enqueue: (request: Request) => Effect.Effect<Ticket, FullError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ShellQueue") {}

const entryFields = {
  id: Schema.String,
  owner: Schema.String,
  sessionID: Schema.String,
  enqueued: Schema.Finite,
  reserveMb: Schema.Finite,
  maxRunning: Schema.Finite,
  maxRunningPerSession: Schema.Finite,
  maxLoad: Schema.Finite,
  capacityBlocked: Schema.String.pipe(Schema.optional),
  retiring: Schema.Boolean.pipe(Schema.optional),
}
const Entry = Schema.Union([
  Schema.Struct({ ...entryFields, admitted: Schema.Undefined.pipe(Schema.optional) }),
  Schema.Struct({
    ...entryFields,
    admitted: Schema.Finite,
    slots: Schema.Struct({ run: Schema.Finite, session: Schema.Finite }),
  }),
])
type Entry = typeof Entry.Type

const Owner = Schema.Struct({
  heartbeatMs: Schema.Finite,
  residentMb: Schema.Record(Schema.String, Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))).pipe(Schema.optional),
})

type Waiter = {
  readonly request: Request
  readonly entry: Entry
  readonly admitted: Deferred.Deferred<void, EntryLostError>
  readonly admission: Scope.Scope
  readonly waiting: Scope.Closeable
  position: number
  backfilled: boolean
  onPosition: (position: number) => Effect.Effect<void>
}

type Claim = { readonly id: string; readonly parent: Scope.Scope; readonly scope: Scope.Closeable }
type Exhausted = {
  run: number
  readonly sessions: Map<string, number>
  readonly families: Set<string>
  readonly memory: Map<string, Waiter>
}

type Snapshot = {
  readonly started: number
  readonly revision: number
  readonly admissionEpoch: string
  readonly known: ReadonlySet<string>
  readonly present: ReadonlySet<string>
  readonly entries: readonly Entry[]
  readonly running: readonly Entry[]
  readonly waiting: readonly Entry[]
  readonly stalled: ReadonlySet<string>
  readonly residentMb: ReadonlyMap<string, Readonly<Record<string, number>>>
}

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Entry))
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(Entry))
const decodeOwner = Schema.decodeUnknownOption(Schema.fromJsonString(Owner))
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(Owner))

export type Watch = (
  directory: string,
  onChange: () => void,
  onError: (error: unknown) => void,
) => { readonly close: () => void }

// `snapshot` follows each read of the queue and `claimed` follows a successful slot claim, before
// the entry is marked admitted.
export type Trace =
  | "pass"
  | "snapshot"
  | "claimed"
  | "admission-written"
  | "run-claimed"
  | "session-claimed"
  | "wait-claimed"
  | "entry-invalidated"
  | "entry-released"
  | "restore"
  | "watch-open"
  | "watch-close"
  | "wait-backstop"
  | "wait-idle"

export interface Options {
  readonly sample?: Effect.Effect<Sample>
  readonly backstopMs?: number
  readonly heartbeatMs?: number
  readonly watch?: Watch
  readonly trace?: (event: Trace) => void
  readonly now?: () => number
  readonly parallelism?: number
}

const watchDirectory: Watch = (directory, onChange, onError) => {
  const watcher = watch(directory, { persistent: false }, onChange)
  watcher.on("error", onError)
  return { close: () => watcher.close() }
}

// Resolves undefined when the path no longer exists; any other filesystem error aborts the
// evaluation without deleting anything.
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.die(error),
    ),
  )

const laneOf = (sessionID: string) => Hash.sha256(sessionID).slice(0, 32)

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const appProcess = yield* AppProcess.Service
      const layerScope = yield* Scope.Scope
      const sampler = (options?.sample ?? sample(appProcess)).pipe(
        Effect.timeoutOption(SAMPLE_TIMEOUT_MS),
        Effect.map(Option.getOrUndefined),
      )
      const backstopMs = options?.backstopMs ?? BACKSTOP_MS
      const heartbeatMs = options?.heartbeatMs ?? HEARTBEAT_MS
      const now = options?.now ?? Date.now
      const parallelism = options?.parallelism ?? os.availableParallelism()
      const trace = options?.trace ?? (() => {})
      const runFork = Effect.runForkWith(yield* Effect.context())
      const dir = path.join(global.state, "shell-queue")
      const memory = ShellMemory.make(dir)
      const entriesDir = path.join(dir, "entries")
      const ownersDir = path.join(dir, "owners")
      const slotsDir = path.join(dir, "slots")
      const lanesDir = path.join(dir, "lanes")
      const admissionFile = path.join(dir, "admission")
      const token = randomUUID()
      const ownerFile = path.join(ownersDir, `${token}.lock`)
      const entryFile = (id: string) => path.join(entriesDir, `${id}.json`)
      const waiters = new Map<string, Waiter>()
      // Every entry this process owns, waiting or admitted, until its scope closes.
      const owned = new Map<string, Entry>()
      const residents = new Map<string, () => number>()
      const published = new Set<string>()
      // Every slot this process holds, by file.
      const claims = new Map<string, Claim>()
      const registration: {
        scope?: Scope.Closeable
        owner?: { readonly dev: number; readonly ino: number }
        entries?: { readonly dev: number; readonly ino: number }
      } = {}
      const registering = yield* Semaphore.make(1)
      const evaluating = yield* Semaphore.make(1)
      const writing = yield* Semaphore.make(1)
      const missingOwners = new Map<string, number>()
      const ownerHeartbeats = new Map<
        string,
        {
          readonly mtimeMs: number
          readonly heartbeatMs: number
          readonly residentMb: Readonly<Record<string, number>>
        }
      >()
      const changes = { revision: 0 }
      const admissionEpoch = attempt(() => readFile(admissionFile, "utf8")).pipe(
        Effect.map((value) => value ?? "initial"),
      )

      const present = (file: string) => attempt(() => stat(file)).pipe(Effect.map((info) => info !== undefined))

      const writeEntry = (id: string) =>
        writing.withPermits(1)(
          Effect.gen(function* () {
            const entry = owned.get(id)
            if (!entry) return
            const temporary = `${entryFile(id)}.${randomUUID()}.tmp`
            yield* Effect.promise(() => writeFile(temporary, encodeEntry(entry)))
            yield* Effect.promise(() => rename(temporary, entryFile(id))).pipe(
              Effect.onError(() => Effect.promise(() => unlink(temporary).catch(() => undefined))),
            )
            if (owned.has(id)) published.add(id)
            if (!owned.has(id)) yield* Effect.promise(() => unlink(entryFile(id)).catch(() => undefined))
          }).pipe(Effect.uninterruptible),
        )

      const hold = Effect.fnUntraced(function* (file: string, id: string, parent: Scope.Scope) {
        const scope = yield* Scope.fork(parent)
        return yield* ProcessLock.claim(file).pipe(
          Scope.provide(scope),
          Effect.andThen(Effect.sync(() => claims.set(file, { id, parent, scope }))),
          Effect.andThen(
            Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                if (claims.get(file)?.scope === scope) claims.delete(file)
              }),
            ),
          ),
          Effect.andThen(Effect.sync(() => claims.get(file)?.scope === scope)),
          Effect.catch((error) =>
            Scope.close(scope, Exit.void).pipe(
              Effect.andThen(
                error._tag === "ProcessLockSystemError"
                  ? Effect.logWarning("could not claim a shell queue slot", { file, error })
                  : Effect.void,
              ),
              Effect.as(false),
            ),
          ),
        )
      })

      const claimSlot = Effect.fnUntraced(function* (input: {
        readonly prefix: string
        readonly size: number
        readonly id: string
        readonly parent: Scope.Scope
      }) {
        for (let index = 0; index < input.size; index++) {
          const file = path.join(slotsDir, `${input.prefix}-${index}`)
          if (!(yield* hold(file, input.id, input.parent))) continue
          trace(
            input.prefix === "run"
              ? "run-claimed"
              : input.prefix.startsWith("session-")
                ? "session-claimed"
                : "wait-claimed",
          )
          return index
        }
      })

      const residentMb = (id: string) => {
        const value = residents.get(id)?.() ?? 0
        return Number.isFinite(value) ? Math.max(0, value) : 0
      }

      const heartbeat = Effect.promise(() =>
        writeFile(
          ownerFile,
          encodeOwner({
            heartbeatMs,
            residentMb: Object.fromEntries(
              [...owned.values()].flatMap((entry) =>
                entry.admitted === undefined ? [] : [[entry.id, residentMb(entry.id)]],
              ),
            ),
          }),
        ).then(
          () => true,
          () => false,
        ),
      ).pipe(Effect.flatMap((written) => (written ? Effect.void : Effect.sync(wake))))

      // The owner file's OS lock is held for this process's lifetime and released by the OS when it
      // exits, so a taken lock marks a dead owner; its modification time is the owner's heartbeat
      // and its content records the heartbeat interval. When the owner file or the entries
      // directory disappears, registration recreates them and restores this process's entries and
      // slots.
      const register = registering.withPermits(1)(
        Effect.gen(function* () {
          const known = [...published]
          const owner = yield* attempt(() => stat(ownerFile))
          const entries = yield* attempt(() => stat(entriesDir))
          const registered =
            registration.scope &&
            owner &&
            entries &&
            owner.dev === registration.owner?.dev &&
            owner.ino === registration.owner.ino &&
            entries.dev === registration.entries?.dev &&
            entries.ino === registration.entries.ino
          const names = registered ? new Set((yield* attempt(() => readdir(entriesDir))) ?? []) : new Set<string>()
          if (registered && known.every((id) => !owned.has(id) || names.has(`${id}.json`))) return
          const restoring = registration.scope !== undefined || owned.size > 0 || claims.size > 0
          if (restoring && !registered) closeWatcher()
          if (!registered && registration.scope) yield* Scope.close(registration.scope, Exit.void)
          if (!registered) registration.scope = undefined
          yield* Effect.forEach(
            [entriesDir, ownersDir, slotsDir, lanesDir],
            (directory) => Effect.promise(() => mkdir(directory, { recursive: true })),
            { discard: true },
          )
          if (!registered) {
            yield* Effect.promise(() => writeFile(ownerFile, encodeOwner({ heartbeatMs })))
            const scope = yield* Scope.fork(layerScope)
            yield* ProcessLock.claim(ownerFile).pipe(Scope.provide(scope), Effect.orDie)
            registration.scope = scope
          }
          registration.owner = yield* Effect.promise(() => stat(ownerFile))
          registration.entries = yield* Effect.promise(() => stat(entriesDir))
          if (!restoring) return
          trace("restore")
          yield* Effect.logWarning("shell queue files were removed; restoring this process's entries and slots", {
            directory: dir,
          })
          yield* Effect.forEach(
            [...owned.values()],
            (entry) =>
              Effect.gen(function* () {
                if (yield* present(entryFile(entry.id))) return
                yield* writeEntry(entry.id)
              }),
            { discard: true },
          )
          yield* Effect.forEach(
            [...claims],
            ([file, claim]) =>
              Effect.gen(function* () {
                if (yield* present(file)) return
                yield* Scope.close(claim.scope, Exit.void)
                if (!owned.has(claim.id)) return
                if (!(yield* hold(file, claim.id, claim.parent)))
                  yield* Effect.logWarning("another process took a shell queue slot while it was restored", { file })
              }),
            { discard: true },
          )
        }),
      )

      const ownerState = Effect.fnUntraced(function* (owner: string, now: number) {
        const file = path.join(ownersDir, `${owner}.lock`)
        const info = yield* attempt(() => stat(file))
        if (!info) {
          const since = missingOwners.get(owner) ?? now
          missingOwners.set(owner, since)
          const previous = ownerHeartbeats.get(owner)
          return now - (previous?.mtimeMs ?? since) < (previous?.heartbeatMs ?? HEARTBEAT_MS) * STALE_HEARTBEATS
            ? ("stalled" as const)
            : ("dead" as const)
        }
        missingOwners.delete(owner)
        const recorded = Option.getOrUndefined(decodeOwner((yield* attempt(() => readFile(file, "utf8"))) ?? ""))
        const interval = recorded?.heartbeatMs ?? HEARTBEAT_MS
        ownerHeartbeats.set(owner, {
          mtimeMs: info.mtimeMs,
          heartbeatMs: interval,
          residentMb: recorded?.residentMb ?? {},
        })
        if (now - info.mtimeMs <= interval * STALE_HEARTBEATS) return "live" as const
        return yield* Effect.scoped(ProcessLock.claim(file)).pipe(
          Effect.as("dead" as const),
          Effect.catchTag("ProcessLockHeldError", () => Effect.succeed("stalled" as const)),
          Effect.catchTag("ProcessLockSystemError", (error) =>
            Effect.logWarning("could not check a shell queue owner", { file, error }).pipe(
              Effect.as("stalled" as const),
            ),
          ),
        )
      })

      const pruneAbandoned = Effect.fnUntraced(function* (now: number, entryNames: readonly string[]) {
        const sources = [
          {
            directory: entriesDir,
            names: entryNames.filter((name) => /\.json\.[0-9a-f-]{36}\.tmp$/.test(name)),
            locked: false,
          },
          {
            directory: dir,
            names: ((yield* attempt(() => readdir(dir))) ?? []).filter((name) =>
              /^admission\.[0-9a-f-]{36}\.tmp$/.test(name),
            ),
            locked: false,
          },
          {
            directory: slotsDir,
            names: ((yield* attempt(() => readdir(slotsDir))) ?? []).filter((name) =>
              /^bypass-[0-9a-f]{64}$/.test(name),
            ),
            locked: true,
          },
        ]
        yield* Effect.forEach(
          sources.flatMap((source) =>
            source.names.map((name) => ({ file: path.join(source.directory, name), locked: source.locked })),
          ),
          (candidate) =>
            Effect.gen(function* () {
              const info = yield* attempt(() => stat(candidate.file))
              if (!info || now - info.mtimeMs <= TORN_MS) return
              if (!candidate.locked) return yield* attempt(() => unlink(candidate.file))
              yield* Effect.scoped(ProcessLock.claim(candidate.file)).pipe(
                Effect.catchTag("ProcessLockHeldError", () => Effect.void),
                Effect.catchTag("ProcessLockSystemError", (error) =>
                  Effect.logWarning("could not reclaim an abandoned shell queue claim", { error }),
                ),
              )
            }),
          { concurrency: 8, discard: true },
        )
      })

      // Reads the queue, removing entries of dead owners and orphaned entries of this process, and
      // reports which owners are stalled. Owner locks are probed only once a heartbeat is stale.
      const survey = Effect.gen(function* () {
        const now = Date.now()
        const entryNames = (yield* attempt(() => readdir(entriesDir))) ?? []
        yield* pruneAbandoned(now, entryNames)
        const names = entryNames.filter((name) => name.endsWith(".json"))
        const read = yield* Effect.forEach(
          names,
          (name) =>
            Effect.gen(function* () {
              const file = path.join(entriesDir, name)
              const raw = yield* attempt(() => readFile(file, "utf8"))
              const entry = raw === undefined ? undefined : Option.getOrUndefined(decodeEntry(raw))
              const torn =
                raw !== undefined &&
                entry === undefined &&
                now - ((yield* attempt(() => stat(file)))?.mtimeMs ?? now) > TORN_MS
              return { file, entry, torn }
            }),
          { concurrency: 16 },
        )
        const foreign = [
          ...new Set(read.flatMap((item) => (item.entry && item.entry.owner !== token ? [item.entry.owner] : []))),
        ]
        const owners = new Set(foreign)
        for (const observed of [missingOwners, ownerHeartbeats]) {
          observed.forEach((_, owner) => {
            if (!owners.has(owner)) observed.delete(owner)
          })
        }
        const states = new Map(
          yield* Effect.forEach(
            foreign,
            (owner) => ownerState(owner, now).pipe(Effect.map((state) => [owner, state] as const)),
            { concurrency: 8 },
          ),
        )
        const stale = read.filter(
          (item) =>
            item.torn ||
            (item.entry !== undefined &&
              (item.entry.owner === token
                ? !owned.has(item.entry.id) && !published.has(item.entry.id) && !item.entry.retiring
                : states.get(item.entry.owner) === "dead")),
        )
        yield* Effect.forEach(stale, (item) => Effect.promise(() => unlink(item.file).catch(() => undefined)), {
          discard: true,
        })
        return {
          present: new Set(names.map((name) => name.slice(0, -".json".length))),
          entries: read.flatMap((item) =>
            item.entry && !item.entry.retiring && !stale.includes(item) ? [item.entry] : [],
          ),
          stalled: new Set(foreign.filter((owner) => states.get(owner) === "stalled")),
          residentMb: new Map(
            [...ownerHeartbeats].map(([owner, value]) => [owner, states.get(owner) === "live" ? value.residentMb : {}]),
          ),
        }
      })

      // Lanes are read after entries, and an admission writes its lane before marking its entry, so a
      // snapshot that shows an entry admitted also shows its lane's admission time.
      const snapshot = Effect.gen(function* () {
        const started = Date.now()
        const revision = changes.revision
        const known = new Set(waiters.keys())
        const current = yield* survey
        const unordered = current.entries.filter((entry) => entry.admitted === undefined)
        const lanes = Object.fromEntries(
          (yield* Effect.forEach(
            [...new Set(unordered.map((entry) => entry.sessionID))],
            (sessionID) =>
              attempt(() => readFile(path.join(lanesDir, laneOf(sessionID)), "utf8")).pipe(
                Effect.map((raw) => [sessionID, raw ? Number(raw) : Number.NaN] as const),
              ),
            { concurrency: 16 },
          )).filter((lane) => Number.isFinite(lane[1])),
        )
        trace("snapshot")
        return {
          started,
          revision,
          admissionEpoch: yield* admissionEpoch,
          known,
          present: current.present,
          entries: current.entries,
          running: current.entries.filter((entry) => entry.admitted !== undefined),
          waiting: order(unordered, lanes),
          stalled: current.stalled,
          residentMb: current.residentMb,
        } satisfies Snapshot
      })

      // Fails waiters whose entry was removed and reports position changes. Only waiters registered
      // before the snapshot was read can be judged lost by it.
      const settle = Effect.fnUntraced(function* (current: Snapshot) {
        const lost = [...waiters.values()].filter(
          (waiter) => current.known.has(waiter.entry.id) && !current.present.has(waiter.entry.id),
        )
        yield* Effect.forEach(
          lost,
          (waiter) => {
            waiters.delete(waiter.entry.id)
            return Deferred.fail(waiter.admitted, new EntryLostError({ id: waiter.entry.id }))
          },
          { discard: true },
        )
        const positions = new Map(current.waiting.map((entry, index) => [entry.id, index + 1]))
        yield* Effect.forEach(
          [...waiters.values()],
          (waiter) => {
            const position = positions.get(waiter.entry.id)
            if (position === undefined || position === waiter.position) return Effect.void
            waiter.position = position
            return waiter.onPosition(position)
          },
          { discard: true },
        )
      })

      const resourceStatus = (entry: Entry, current: Snapshot) =>
        sampler.pipe(
          Effect.map((value) => {
            if (value === undefined) return "unavailable" as const
            const unmaterializedMb = current.running.reduce(
              (total, running) =>
                total +
                Math.max(
                  0,
                  running.reserveMb -
                    (running.owner === token
                      ? residentMb(running.id)
                      : (current.residentMb.get(running.owner)?.[running.id] ?? 0)),
                ),
              0,
            )
            const time = now()
            const recentLoad = current.running.reduce(
              (total, running) =>
                total + (running.admitted === undefined ? 0 : Math.exp(-Math.max(0, time - running.admitted) / 60_000)),
              0,
            )
            if (!(value.load + recentLoad / parallelism < entry.maxLoad)) return "cpu" as const
            return value.availableMb - unmaterializedMb >= entry.reserveMb ? ("met" as const) : ("memory" as const)
          }),
        )

      const candidate = (current: Snapshot, exhausted: Exhausted) =>
        current.waiting.find((entry) => {
          if (exhausted.memory.has(entry.sessionID)) return false
          const family = waiters.get(entry.id)?.request.admission?.family
          if (family !== undefined && exhausted.families.has(family)) return false
          if (current.stalled.has(entry.owner)) return false
          if (entry.owner !== token && entry.capacityBlocked !== undefined)
            return entry.capacityBlocked !== current.admissionEpoch
          if (
            entry.maxRunning <= exhausted.run ||
            entry.maxRunningPerSession <= (exhausted.sessions.get(entry.sessionID) ?? 0)
          )
            return false
          if (entry.capacityBlocked !== undefined) return true
          return (
            Array.from({ length: entry.maxRunning }, (_, index) => index).some(
              (index) => !current.running.some((item) => item.admitted !== undefined && item.slots.run === index),
            ) &&
            Array.from({ length: entry.maxRunningPerSession }, (_, index) => index).some(
              (index) =>
                !current.running.some(
                  (item) =>
                    item.sessionID === entry.sessionID && item.admitted !== undefined && item.slots.session === index,
                ),
            )
          )
        })

      const capacityBlocked = Effect.fnUntraced(function* (waiter: Waiter, observation: string | undefined) {
        const entry = owned.get(waiter.entry.id)
        if (
          waiters.get(waiter.entry.id) !== waiter ||
          !entry ||
          entry.admitted !== undefined ||
          entry.capacityBlocked === observation
        )
          return
        owned.set(entry.id, { ...entry, capacityBlocked: observation })
        yield* writeEntry(entry.id)
      })

      const admit = Effect.fnUntraced(function* (waiter: Waiter, current: Snapshot, exhausted: Exhausted) {
        const entry = {
          ...waiter.entry,
          reserveMb: yield* memory.requirement({
            ...waiter.request,
            reserveMb: waiter.request.limits.memory_reserve_mb,
          }),
        }
        if (waiters.get(entry.id) !== waiter) return "stop" as const
        const admission = yield* Scope.fork(waiter.admission)
        const slot = (prefix: string, size: number) => claimSlot({ prefix, size, id: entry.id, parent: admission })
        const idle = current.running.length === 0
        const family: { current?: FamilyReservation } = {}
        const claimed = yield* Effect.gen(function* () {
          if (!idle) {
            const resources = yield* resourceStatus(entry, current)
            if (resources !== "met") return resources
          }
          if (changes.revision !== current.revision || candidate(current, exhausted)?.id !== entry.id)
            return "changed" as const
          if (waiter.request.admission) {
            family.current = yield* Effect.acquireRelease(
              waiter.request.admission.acquire,
              (reservation) => reservation?.release ?? Effect.void,
            ).pipe(Scope.provide(admission))
            if (!family.current) return "family" as const
          }
          const lane = laneOf(entry.sessionID)
          const exempt = idle ? yield* slot("run", 1) : undefined
          if (exempt !== undefined) {
            const session = yield* slot(`session-${lane}`, entry.maxRunningPerSession)
            return session === undefined ? ("session" as const) : { run: exempt, session }
          }
          if (idle) {
            const resources = yield* resourceStatus(entry, current)
            if (resources !== "met") return resources
          }
          const session = yield* slot(`session-${lane}`, entry.maxRunningPerSession)
          if (session === undefined) return "session" as const
          const run = yield* slot("run", entry.maxRunning)
          return run === undefined ? ("run" as const) : { run, session }
        })
        if (typeof claimed === "string") {
          yield* Scope.close(admission, Exit.void)
          if (claimed !== "changed")
            yield* capacityBlocked(
              waiter,
              claimed === "memory" || claimed === "cpu" || claimed === "unavailable"
                ? undefined
                : yield* admissionEpoch,
            )
          if (claimed === "memory" && !idle) return "memory" as const
          return claimed === "run" || claimed === "session" || claimed === "family" ? claimed : ("stop" as const)
        }
        trace("claimed")
        const latest = yield* snapshot
        if (candidate(latest, exhausted)?.id !== entry.id || waiters.get(entry.id) !== waiter) {
          yield* Scope.close(admission, Exit.void)
          return "stop" as const
        }
        const bypassing = latest.waiting
          .slice(
            0,
            latest.waiting.findIndex((item) => item.id === entry.id),
          )
          .some(
            (item) =>
              item.owner !== token && !latest.stalled.has(item.owner) && item.capacityBlocked === latest.admissionEpoch,
          )
        const bypass = bypassing ? yield* Scope.fork(admission) : undefined
        if (
          bypass &&
          (!(yield* hold(path.join(slotsDir, `bypass-${Hash.sha256(latest.admissionEpoch)}`), entry.id, bypass)) ||
            (yield* admissionEpoch) !== latest.admissionEpoch)
        ) {
          yield* Scope.close(admission, Exit.void)
          return "stop" as const
        }
        const temporary = `${admissionFile}.${token}.tmp`
        yield* Effect.promise(() =>
          writeFile(temporary, randomUUID()).then(() => rename(temporary, admissionFile)),
        ).pipe(
          Effect.onError(() =>
            Scope.close(admission, Exit.void).pipe(
              Effect.andThen(Effect.promise(() => unlink(temporary).catch(() => undefined))),
            ),
          ),
        )
        if (bypass) yield* Scope.close(bypass, Exit.void)
        trace("admission-written")
        const admitted = now()
        const started = { ...entry, admitted, slots: claimed }
        if (waiters.get(entry.id) !== waiter || !owned.has(entry.id)) {
          yield* Scope.close(admission, Exit.void)
          return "stop" as const
        }
        owned.set(entry.id, started)
        yield* Effect.gen(function* () {
          const lane = path.join(lanesDir, laneOf(entry.sessionID))
          const temporary = `${lane}.${token}.tmp`
          yield* Effect.promise(() => writeFile(temporary, String(admitted)))
          yield* Effect.promise(() => rename(temporary, lane))
          yield* writeEntry(entry.id)
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              if (waiters.get(entry.id) === waiter && owned.has(entry.id)) owned.set(entry.id, entry)
              yield* Scope.close(admission, Exit.void)
            }),
          ),
        )
        if (waiters.get(entry.id) !== waiter) {
          return "stop" as const
        }
        waiters.delete(entry.id)
        yield* Scope.close(waiter.waiting, Exit.void)
        if (family.current) yield* family.current.commit
        yield* Deferred.succeed(waiter.admitted, undefined)
        yield* pruneLanes(new Set(current.entries.map((item) => laneOf(item.sessionID))), current.started)
        return "admitted" as const
      })

      // Removes lane files of Sessions without entries, sparing any written after the snapshot.
      const pruneLanes = Effect.fnUntraced(function* (live: ReadonlySet<string>, before: number) {
        const names = (yield* attempt(() => readdir(lanesDir))) ?? []
        yield* Effect.forEach(
          names.filter((name) => !live.has(name.split(".")[0] ?? name)),
          (name) =>
            Effect.gen(function* () {
              const file = path.join(lanesDir, name)
              const info = yield* attempt(() => stat(file))
              if (info && info.mtimeMs < before) yield* Effect.promise(() => unlink(file).catch(() => undefined))
            }),
          { concurrency: 8, discard: true },
        )
      })

      // Every queue change wakes one evaluation: changes that arrive during a pass leave exactly one
      // pending signal, so they coalesce into a single follow-up pass.
      const signal = yield* Queue.sliding<void>(1)
      const wake = () => {
        changes.revision++
        Queue.offerUnsafe(signal, undefined)
      }
      const activity = yield* Queue.sliding<void>(1)

      // Entries are watched only while this process has waiting entries; owners, slots, and lanes
      // live outside the watched directory, so their changes never wake an evaluation.
      const watcher: { current?: { readonly close: () => void }; warned: boolean } = { warned: false }
      const warnWatch = (error: unknown) => {
        if (watcher.warned) return
        watcher.warned = true
        runFork(
          Effect.logWarning("shell queue cannot watch for changes; it re-evaluates on its backstop timer", {
            directory: entriesDir,
            error,
          }),
        )
      }
      const closeWatcher = () => {
        if (!watcher.current) return
        watcher.current.close()
        watcher.current = undefined
        trace("watch-close")
      }
      const syncWatcher = () => {
        Queue.offerUnsafe(activity, undefined)
        if (waiters.size === 0) return closeWatcher()
        if (watcher.current) return
        const opened = Effect.runSync(
          Effect.try({
            try: () =>
              (options?.watch ?? watchDirectory)(entriesDir, wake, (error) => {
                warnWatch(error)
                closeWatcher()
              }),
            catch: (error) => error,
          }).pipe(Effect.match({ onFailure: (error) => ({ error }), onSuccess: (handle) => ({ handle }) })),
        )
        if ("error" in opened) return warnWatch(opened.error)
        watcher.current = opened.handle
        trace("watch-open")
      }
      yield* Effect.addFinalizer(() => Effect.sync(closeWatcher))

      // Admits this process's entries while each is next in order and its slots can be claimed,
      // reading a fresh snapshot before every admission. Passes of one process never overlap.
      const pass = Effect.gen(function* () {
        if (waiters.size === 0) return
        trace("pass")
        yield* register
        const state = {
          current: yield* snapshot,
          exhausted: {
            run: 0,
            sessions: new Map<string, number>(),
            families: new Set<string>(),
            memory: new Map<string, Waiter>(),
          },
        }
        yield* settle(state.current)
        while (true) {
          if (changes.revision !== state.current.revision) return
          const head = candidate(state.current, state.exhausted)
          const waiter = head?.owner === token ? waiters.get(head.id) : undefined
          if (!waiter) return
          const result = yield* admit(waiter, state.current, state.exhausted)
          if (result === "stop") return
          if (result === "memory") {
            if (waiter.backfilled) return
            state.exhausted.memory.set(waiter.entry.sessionID, waiter)
          }
          if (result === "family" && waiter.request.admission)
            state.exhausted.families.add(waiter.request.admission.family)
          if (result === "run") state.exhausted.run = Math.max(state.exhausted.run, waiter.entry.maxRunning)
          if (result === "session")
            state.exhausted.sessions.set(
              waiter.entry.sessionID,
              Math.max(state.exhausted.sessions.get(waiter.entry.sessionID) ?? 0, waiter.entry.maxRunningPerSession),
            )
          if (result === "admitted") {
            state.exhausted.memory.forEach((blocked) => {
              blocked.backfilled = true
            })
            state.current = yield* snapshot
            state.exhausted = {
              run: 0,
              sessions: new Map<string, number>(),
              families: new Set<string>(),
              memory: new Map<string, Waiter>(),
            }
            yield* settle(state.current)
          }
        }
      }).pipe(
        Effect.ensuring(Effect.sync(syncWatcher)),
        Effect.catchCause((cause) => Effect.logWarning("shell queue evaluation failed", { cause })),
        evaluating.withPermits(1),
      )

      // Running commands retain the heartbeat and recovery even when no entry waits.
      yield* Effect.gen(function* () {
        while (true) {
          if (owned.size === 0) {
            yield* Queue.take(activity)
            continue
          }
          yield* register.pipe(
            Effect.andThen(heartbeat),
            Effect.catchCause((cause) => Effect.logWarning("shell queue heartbeat failed", { cause })),
          )
          yield* Queue.take(activity).pipe(Effect.timeoutOption(heartbeatMs))
        }
      }).pipe(Effect.forkScoped)

      // The backstop timer exists only while this process has waiting entries.
      yield* Effect.gen(function* () {
        while (true) {
          if (waiters.size === 0) {
            trace("wait-idle")
            yield* Queue.take(signal)
          } else {
            trace("wait-backstop")
            yield* Queue.take(signal).pipe(Effect.timeoutOption(backstopMs))
          }
          yield* pass
        }
      }).pipe(Effect.forkScoped)

      const enqueue = Effect.fn("ShellQueue.enqueue")(function* (request: Request) {
        const scope = yield* Scope.Scope
        yield* register
        yield* heartbeat
        const entry: Entry = {
          id: request.id,
          owner: token,
          sessionID: request.sessionID,
          enqueued: now(),
          reserveMb: request.memoryLimitMb ?? request.limits.memory_reserve_mb,
          maxRunning: request.limits.max_running,
          maxRunningPerSession: request.limits.max_running_per_session,
          maxLoad: request.limits.max_load,
        }
        const waiting = yield* Scope.fork(scope)
        const limit = request.limits.max_queued_per_session
        if (
          (yield* claimSlot({
            prefix: `wait-${laneOf(request.sessionID)}`,
            size: limit,
            id: entry.id,
            parent: waiting,
          })) === undefined
        ) {
          yield* Scope.close(waiting, Exit.void)
          return yield* new FullError({ limit })
        }
        const admission = yield* Scope.fork(scope)
        if (request.residentMb) residents.set(entry.id, request.residentMb)
        owned.set(entry.id, entry)
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            waiters.delete(entry.id)
            owned.delete(entry.id)
            residents.delete(entry.id)
            yield* writing.withPermits(1)(
              Effect.gen(function* () {
                const temporary = `${entryFile(entry.id)}.${randomUUID()}.tmp`
                const written = yield* attempt(() =>
                  writeFile(temporary, encodeEntry({ ...entry, retiring: true })).then(() => true),
                )
                if (written) yield* attempt(() => rename(temporary, entryFile(entry.id)))
              }),
            )
            trace("entry-invalidated")
            yield* Scope.close(admission, Exit.void)
            trace("entry-released")
            yield* Effect.promise(() => unlink(entryFile(entry.id)).catch(() => undefined))
            syncWatcher()
            wake()
          }).pipe(Effect.ensuring(Effect.sync(() => published.delete(entry.id)))),
        )
        yield* writeEntry(entry.id)
        const current = yield* snapshot
        const position = Math.max(1, current.waiting.findIndex((item) => item.id === entry.id) + 1)
        const waiter: Waiter = {
          request,
          entry,
          admitted: yield* Deferred.make<void, EntryLostError>(),
          admission,
          waiting,
          backfilled: false,
          position,
          onPosition: () => Effect.void,
        }
        waiters.set(entry.id, waiter)
        if (request.admission) {
          const unsubscribe = request.admission.subscribe(wake)
          yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe))
        }
        syncWatcher()
        wake()
        return {
          position,
          admitted: (onPosition) =>
            Effect.gen(function* () {
              waiter.onPosition = onPosition
              if (waiter.position !== position && waiters.has(entry.id)) yield* onPosition(waiter.position)
              yield* Deferred.await(waiter.admitted)
            }),
        } satisfies Ticket
      })

      return Service.of({
        enqueue,
        recordPeak: (input) =>
          memory.record(input).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Shell memory peak could not be recorded", { cause })),
            Effect.andThen(Effect.sync(wake)),
          ),
      })
    }),
  )

// Round-robin across Session lanes: each round takes the next entry of every lane, starting
// with the lane admitted least recently, so one Session's backlog cannot starve another.
function order(waiting: readonly Entry[], lanes: Record<string, number>) {
  const sorted = waiting.toSorted((a, b) => a.enqueued - b.enqueued || a.id.localeCompare(b.id))
  const sessions = [...new Set(sorted.map((entry) => entry.sessionID))]
  const bySession = new Map(
    sessions.map((sessionID) => [sessionID, sorted.filter((entry) => entry.sessionID === sessionID)]),
  )
  const ranked = sessions.toSorted(
    (a, b) => (lanes[a] ?? -1) - (lanes[b] ?? -1) || sessions.indexOf(a) - sessions.indexOf(b),
  )
  const rounds = Math.max(0, ...[...bySession.values()].map((lane) => lane.length))
  return Array.from({ length: rounds }, (_, round) =>
    ranked.flatMap((sessionID) => bySession.get(sessionID)?.[round] ?? []),
  ).flat()
}

export const sample = (appProcess: AppProcess.Interface) =>
  availableMemoryMb(appProcess).pipe(
    Effect.map((availableMb) => ({ availableMb, load: os.loadavg()[0] / os.availableParallelism() })),
  )

// Available memory counts memory the kernel can hand out without compressing or swapping. On
// macOS `os.freemem()` reports only unused pages, so `vm_stat` supplies free, inactive, and
// speculative pages; purgeable pages already sit on the active or inactive queues and are not
// added again. Linux reads MemAvailable. Other platforms use `os.freemem()`.
function availableMemoryMb(appProcess: AppProcess.Interface) {
  const fallback = Effect.sync(() => os.freemem() / MIB)
  if (process.platform === "darwin")
    return appProcess
      .run(ChildProcess.make("vm_stat", [], { stdin: "ignore", env: { LC_ALL: "C" }, extendEnv: true }), {
        maxOutputBytes: 64 * 1024,
        maxErrorBytes: 1024,
      })
      .pipe(
        Effect.flatMap(AppProcess.requireSuccess),
        Effect.map((result) => vmStatAvailableMb(result.stdout.toString("utf8"))),
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.flatMap((value) => (value === undefined ? fallback : Effect.succeed(value))),
      )
  if (process.platform === "linux")
    return Effect.promise(() => readFile("/proc/meminfo", "utf8").catch(() => "")).pipe(
      Effect.flatMap((text) => {
        const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text)
        return match ? Effect.succeed(Number(match[1]) / 1024) : fallback
      }),
    )
  return fallback
}

export function vmStatAvailableMb(text: string) {
  const pageSize = /page size of (\d+) bytes/.exec(text)
  if (!pageSize) return
  const pages = ["free", "inactive", "speculative"].flatMap((name) => {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "m").exec(text)
    return match ? [Number(match[1])] : []
  })
  if (pages.length !== 3) return
  return (pages.reduce((total, count) => total + count, 0) * Number(pageSize[1])) / MIB
}

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [Global.node, AppProcess.node] })
}

export const node = configured()
