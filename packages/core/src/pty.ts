export * as Pty from "./pty"

import { makeLocationNode } from "./effect/app-node"
import type { Disp, Proc } from "#pty"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Pty } from "@ycoding-ai/schema/pty"
import { Config } from "./config"
import { EventV2 } from "./event"
import { Location } from "./location"
import { PtyID } from "./pty/schema"
import { ShellSelect } from "./shell/select"
import { lazy } from "./util/lazy"

// Exited sessions stay observable (status, exit code, retained output) until removed explicitly.
// Cap retention so abandoned terminals do not accumulate unbounded buffers.
const EXITED_LIMIT = 25
const pty = lazy(() => import("#pty"))

type Subscriber = {
  readonly onData: (chunk: OutputChunk) => void
  readonly onEnd: (event: EndEvent) => void
  active: boolean
  detached: boolean
  pending: OutputChunk[]
  end?: EndEvent
}

type Segment = { startOffset: number; endOffset: number; data: Uint8Array }

type Active = {
  info: Info
  process: Proc
  retained: Segment[]
  retainedBytes: number
  timer: ReturnType<typeof setTimeout>
  terminationReason?: "timeout"
  subscribers: Map<object, Subscriber>
  listeners: Disp[]
}

export const Info = Pty.Info
export type Info = Types.DeepMutable<typeof Info.Type>

export const CreateInput = Pty.CreateInput

export type CreateInput = Types.DeepMutable<typeof CreateInput.Type>

export const UpdateInput = Pty.UpdateInput

export type UpdateInput = Types.DeepMutable<typeof UpdateInput.Type>

export const Event = Pty.Event
export const MAX_RETAINED_BYTES = Pty.MAX_RETAINED_BYTES
export const MAX_INPUT_BYTES = Pty.MAX_INPUT_BYTES
export const MAX_ACTIVE = Pty.MAX_ACTIVE
export const MAX_ATTACHMENTS = Pty.MAX_ATTACHMENTS

export type OutputChunk = {
  readonly generation: number
  readonly startOffset: number
  readonly endOffset: number
  readonly data: Uint8Array
}

export type EndEvent = {
  readonly generation: number
  readonly reason: "exit" | "timeout" | "terminated" | "service_shutdown"
  readonly exitCode?: number
}

export type AttachInput = {
  readonly sessionID: Pty.Info["sessionID"]
  readonly generation?: number
  readonly offset?: number
  readonly access: "inspect" | "control"
  readonly fence?: number
  // Callbacks fire synchronously from the native PTY data path; keep them non-blocking.
  readonly onData: (chunk: OutputChunk) => void
  // Fired once when the session stops producing output: process exit (exitCode set), removal, or service teardown.
  readonly onEnd: (event: EndEvent) => void
}

export type Attachment = {
  // Retained output from the requested cursor to the current end.
  readonly replay: {
    readonly generation: number
    readonly startOffset: number
    readonly endOffset: number
    readonly gap: boolean
    readonly data: Uint8Array
  }
  // Returns false when this is an inspect-only attachment or its writer fence became stale.
  readonly write: (data: string) => boolean
  // Starts live delivery after the caller has applied replay and cursor metadata.
  readonly activate: () => void
  readonly detach: () => void
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export class ExitedError extends Schema.TaggedErrorClass<ExitedError>()("Pty.ExitedError", {
  ptyID: PtyID,
}) {}

export class OwnershipError extends Schema.TaggedErrorClass<OwnershipError>()("Pty.OwnershipError", {
  ptyID: PtyID,
}) {}

export class FenceError extends Schema.TaggedErrorClass<FenceError>()("Pty.FenceError", {
  ptyID: PtyID,
}) {}

export class ResourceLimitError extends Schema.TaggedErrorClass<ResourceLimitError>()("Pty.ResourceLimitError", {
  resource: Schema.Literals(["active", "attachments", "input"]),
}) {}

export interface Interface {
  readonly list: (sessionID: Pty.Info["sessionID"]) => Effect.Effect<Info[]>
  readonly get: (id: PtyID, sessionID: Pty.Info["sessionID"]) => Effect.Effect<Info, NotFoundError | OwnershipError>
  readonly create: (input: CreateInput) => Effect.Effect<Info, ResourceLimitError>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info, NotFoundError | OwnershipError | FenceError>
  readonly control: (id: PtyID, input: Pty.ControlInput) => Effect.Effect<Info, NotFoundError | OwnershipError | FenceError>
  readonly remove: (id: PtyID, sessionID: Pty.Info["sessionID"]) => Effect.Effect<void, NotFoundError | OwnershipError>
  readonly write: (
    id: PtyID,
    input: { readonly sessionID: Pty.Info["sessionID"]; readonly generation: number; readonly expectedFence: number; readonly actor: Pty.Actor; readonly data: string },
  ) => Effect.Effect<void, NotFoundError | OwnershipError | FenceError | ResourceLimitError>
  readonly attach: (
    id: PtyID,
    input: AttachInput,
  ) => Effect.Effect<Attachment, NotFoundError | OwnershipError | ExitedError | FenceError | ResourceLimitError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Pty") {}

export const layer = (options?: ShellSelect.Options) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const sessions = new Map<PtyID, Active>()
    const exitOrder: PtyID[] = []

    function notifyEnd(session: Active, event: EndEvent) {
      for (const subscriber of session.subscribers.values()) {
        if (!subscriber.active) {
          subscriber.end = event
          continue
        }
        try {
          subscriber.onEnd(event)
        } catch {}
      }
      session.subscribers.clear()
    }

    function teardown(session: Active) {
      clearTimeout(session.timer)
      for (const listener of session.listeners) listener.dispose()
      session.listeners.length = 0
      if (session.info.status === "running") {
        try {
          session.process.kill()
        } catch {}
      }
      notifyEnd(session, { generation: session.info.generation, reason: "service_shutdown" })
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const session of sessions.values()) teardown(session)
        sessions.clear()
        exitOrder.length = 0
      }),
    )

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return yield* new NotFoundError({ ptyID: id })
      return session
    })

    const requireOwned = Effect.fn("Pty.requireOwned")(function* (id: PtyID, sessionID: Pty.Info["sessionID"]) {
      const session = yield* requireSession(id)
      if (session.info.sessionID !== sessionID) return yield* new OwnershipError({ ptyID: id })
      return session
    })

    function validFence(session: Active, input: { generation: number; expectedFence: number; actor: Pty.Actor }) {
      return (
        session.info.generation === input.generation &&
        session.info.control.fence === input.expectedFence &&
        session.info.control.owner === input.actor
      )
    }

    const removeSession = Effect.fnUntraced(function* (id: PtyID, reason: EndEvent["reason"] = "terminated") {
      const session = sessions.get(id)
      if (!session) return
      sessions.delete(id)
      const index = exitOrder.indexOf(id)
      if (index !== -1) exitOrder.splice(index, 1)
      yield* Effect.logInfo("removing session", { id })
      clearTimeout(session.timer)
      for (const listener of session.listeners) listener.dispose()
      session.listeners.length = 0
      if (session.info.status === "running") {
        try {
          session.process.kill()
        } catch {}
      }
      notifyEnd(session, { generation: session.info.generation, reason })
      yield* events.publish(Event.Deleted, { id: session.info.id })
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID, sessionID: Pty.Info["sessionID"]) {
      yield* requireOwned(id, sessionID)
      yield* removeSession(id)
    })

    const list = Effect.fn("Pty.list")(function* (sessionID: Pty.Info["sessionID"]) {
      return Array.from(sessions.values()).filter((session) => session.info.sessionID === sessionID).map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID, sessionID: Pty.Info["sessionID"]) {
      return (yield* requireOwned(id, sessionID)).info
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      if (Array.from(sessions.values()).filter((session) => session.info.status === "running").length >= Pty.MAX_ACTIVE)
        return yield* new ResourceLimitError({ resource: "active" })
      const id = PtyID.ascending()
      const command = input.command || ShellSelect.preferred(Config.latest(yield* config.entries(), "shell"), options)
      const args = ShellSelect.login(command) ? [...(input.args ?? []), "-l"] : [...(input.args ?? [])]
      const cwd = input.cwd || location.directory
      const env = {
        ...process.env,
        ...input.env,
        TERM: "xterm-256color",
        YCODING_TERMINAL: "1",
      } as Record<string, string>
      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      yield* Effect.logInfo("creating session", { id, cmd: command, args, cwd })
      const { spawn } = yield* Effect.promise(() => pty())
      const size = input.size ?? { rows: 24, cols: 80 }
      const proc = yield* Effect.sync(() => spawn(command, args, { name: "xterm-256color", cwd, env, ...size }))
      const maxRuntimeSeconds = input.maxRuntimeSeconds ?? Pty.DEFAULT_RUNTIME_SECONDS
      const maxRetainedBytes = input.maxRetainedBytes ?? Pty.MAX_RETAINED_BYTES
      const info: Info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        sessionID: input.sessionID,
        status: "running",
        pid: proc.pid,
        generation: 1,
        size,
        control: { owner: "agent", fence: 1 },
        output: { startOffset: 0, endOffset: 0, truncated: false },
        limits: {
          maxRuntimeSeconds,
          maxRetainedBytes,
          maxInputBytes: Pty.MAX_INPUT_BYTES,
        },
      }
      const session: Active = {
        info,
        process: proc,
        retained: [],
        retainedBytes: 0,
        timer: setTimeout(() => {
          if (info.status !== "running") return
          session.terminationReason = "timeout"
          try {
            proc.kill()
          } catch {}
        }, maxRuntimeSeconds * 1000),
        subscribers: new Map(),
        listeners: [],
      }
      sessions.set(id, session)
      session.listeners.push(
        proc.onData((chunk) => {
          const data = new TextEncoder().encode(chunk)
          const output: OutputChunk = {
            generation: session.info.generation,
            startOffset: session.info.output.endOffset,
            endOffset: session.info.output.endOffset + data.byteLength,
            data,
          }
          session.info.output.endOffset = output.endOffset
          for (const [token, subscriber] of session.subscribers.entries()) {
            if (!subscriber.active) {
              subscriber.pending.push(output)
              continue
            }
            try {
              subscriber.onData(output)
            } catch {
              session.subscribers.delete(token)
            }
          }
          session.retained.push(output)
          session.retainedBytes += data.byteLength
          while (session.retainedBytes > session.info.limits.maxRetainedBytes) {
            const first = session.retained[0]
            if (!first) break
            const excess = session.retainedBytes - session.info.limits.maxRetainedBytes
            if (first.data.byteLength <= excess) {
              session.retained.shift()
              session.retainedBytes -= first.data.byteLength
              continue
            }
            session.retained[0] = {
              ...first,
              startOffset: first.startOffset + excess,
              data: first.data.subarray(excess),
            }
            session.retainedBytes -= excess
          }
          session.info.output.startOffset = session.retained[0]?.startOffset ?? session.info.output.endOffset
          session.info.output.truncated = session.info.output.startOffset > 0
        }),
        proc.onExit(({ exitCode }) => {
          if (session.info.status === "exited") return
          session.info.status = "exited"
          session.info.exitCode = exitCode
          session.info.exitReason = session.terminationReason ?? "exit"
          clearTimeout(session.timer)
          notifyEnd(session, { generation: session.info.generation, reason: session.info.exitReason, exitCode })
          exitOrder.push(id)
          runFork(
            Effect.gen(function* () {
              yield* Effect.logInfo("session exited", { id, exitCode })
              yield* events.publish(Event.Exited, {
                id,
                exitCode,
                reason: session.info.exitReason === "timeout" ? "timeout" : "exit",
              })
              while (exitOrder.length > EXITED_LIMIT) {
                const oldest = exitOrder[0]
                if (!oldest) break
                yield* removeSession(oldest)
              }
            }),
          )
        }),
      )
      yield* events.publish(Event.Created, { info })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireOwned(id, input.sessionID)
      if (!validFence(session, input)) return yield* new FenceError({ ptyID: id })
      if (input.title) session.info.title = input.title
      if (input.size && session.info.status === "running") {
        session.process.resize(input.size.cols, input.size.rows)
        session.info.size = { ...input.size }
      }
      yield* events.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const control = Effect.fn("Pty.control")(function* (id: PtyID, input: Pty.ControlInput) {
      const session = yield* requireOwned(id, input.sessionID)
      if (session.info.generation !== input.generation || session.info.control.fence !== input.expectedFence)
        return yield* new FenceError({ ptyID: id })
      const next = input.action === "take" ? "user" : input.action === "agent" ? "agent" : "paused"
      const allowed =
        (input.action === "take" && session.info.control.owner !== "user") ||
        (input.action === "pause" && session.info.control.owner === "user") ||
        (input.action === "agent" && session.info.control.owner === "paused")
      if (!allowed) return yield* new FenceError({ ptyID: id })
      session.info.control = { owner: next, fence: session.info.control.fence + 1 }
      yield* events.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const write = Effect.fn("Pty.write")(function* (
      id: PtyID,
      input: { sessionID: Pty.Info["sessionID"]; generation: number; expectedFence: number; actor: Pty.Actor; data: string },
    ) {
      const session = yield* requireOwned(id, input.sessionID)
      if (!validFence(session, input)) return yield* new FenceError({ ptyID: id })
      if (new TextEncoder().encode(input.data).byteLength > Pty.MAX_INPUT_BYTES)
        return yield* new ResourceLimitError({ resource: "input" })
      if (session.info.status === "running") session.process.write(input.data)
      return yield* Effect.void
    })

    const attach = Effect.fn("Pty.attach")(function* (id: PtyID, input: AttachInput) {
      const session = yield* requireOwned(id, input.sessionID)
      if (session.info.status !== "running") return yield* new ExitedError({ ptyID: id })
      if (session.subscribers.size >= Pty.MAX_ATTACHMENTS)
        return yield* new ResourceLimitError({ resource: "attachments" })
      if (
        input.access === "control" &&
        (input.generation !== session.info.generation ||
          input.fence !== session.info.control.fence ||
          session.info.control.owner !== "user")
      )
        return yield* new FenceError({ ptyID: id })
      yield* Effect.logInfo("client attached to session", { id, directory: location.directory })
      const token = {}
      const subscriber: Subscriber = {
        onData: input.onData,
        onEnd: input.onEnd,
        active: false,
        detached: false,
        pending: [],
      }
      session.subscribers.set(token, subscriber)
      const startOffset = session.info.output.startOffset
      const endOffset = session.info.output.endOffset
      const from = input.offset ?? 0
      const gap =
        (input.generation !== undefined && input.generation !== session.info.generation) ||
        !Number.isSafeInteger(from) ||
        from < startOffset ||
        from > endOffset
      const replay = gap
        ? new Uint8Array()
        : concat(
            session.retained.flatMap((segment) => {
              if (segment.endOffset <= from) return []
              return [segment.data.subarray(Math.max(0, from - segment.startOffset))]
            }),
          )
      return {
        replay: {
          generation: session.info.generation,
          startOffset: gap ? startOffset : from,
          endOffset,
          gap,
          data: replay,
        },
        write: (data: string) => {
          if (
            input.access !== "control" ||
            session.info.status !== "running" ||
            input.generation !== session.info.generation ||
            input.fence !== session.info.control.fence ||
            session.info.control.owner !== "user" ||
            new TextEncoder().encode(data).byteLength > Pty.MAX_INPUT_BYTES
          )
            return false
          session.process.write(data)
          return true
        },
        activate: () => {
          if (subscriber.active || subscriber.detached) return
          subscriber.active = true
          try {
            for (const chunk of subscriber.pending) subscriber.onData(chunk)
            subscriber.pending.length = 0
            if (subscriber.end) subscriber.onEnd(subscriber.end)
          } catch {
            session.subscribers.delete(token)
          }
        },
        detach: () => {
          subscriber.detached = true
          subscriber.pending.length = 0
          subscriber.end = undefined
          session.subscribers.delete(token)
        },
      }
    })

    return Service.of({ list, get, create, update, control, remove, write, attach })
  }),
)

export function configured(options?: ShellSelect.Options) {
  return makeLocationNode({ service: Service, layer: layer(options), deps: [EventV2.node, Location.node, Config.node] })
}

export const node = configured()

function concat(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}
