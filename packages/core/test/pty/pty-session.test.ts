import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Queue, Schema } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { Pty } from "@ycoding-ai/core/pty"
import { SessionV2 } from "@ycoding-ai/core/session"
import { PtyID } from "@ycoding-ai/core/pty/schema"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

type PtyEvent = { type: "created" | "exited" | "deleted"; id: PtyID }

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp") })),
)
const configLayer = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, configLayer],
    [Location.node, locationLayer],
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live
const sessionID = SessionV2.ID.make("ses_pty_test")

const subscribePtyEvents = Effect.fn("PtySessionTest.subscribePtyEvents")(function* () {
  const source = yield* EventV2.Service
  const events = yield* Queue.unbounded<PtyEvent>()
  const unsubscribe = yield* source.listen((event) => {
    if (event.type === Pty.Event.Created.type && Schema.is(Pty.Event.Created.data)(event.data))
      Queue.offerUnsafe(events, { type: "created", id: event.data.info.id })
    if (event.type === Pty.Event.Exited.type && Schema.is(Pty.Event.Exited.data)(event.data))
      Queue.offerUnsafe(events, { type: "exited", id: event.data.id })
    if (event.type === Pty.Event.Deleted.type && Schema.is(Pty.Event.Deleted.data)(event.data))
      Queue.offerUnsafe(events, { type: "deleted", id: event.data.id })
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe)
  return events
})

const createPty = Effect.fn("PtySessionTest.createPty")(function* (
  command: string,
  args: string[] = [],
  maxRetainedBytes?: number,
  maxRuntimeSeconds?: number,
) {
  const pty = yield* Pty.Service
  return yield* Effect.acquireRelease(
    pty.create({
      sessionID,
      command,
      args,
      cwd: "/tmp",
      env: { TERM: "xterm-256color", YCODING_TERMINAL: "1" },
      maxRetainedBytes,
      maxRuntimeSeconds,
    }),
    (info) => pty.remove(info.id, sessionID).pipe(Effect.ignore),
  )
})

const waitForEvents = (events: Queue.Queue<PtyEvent>, id: PtyID, count: number) =>
  Effect.gen(function* () {
    const picked: Array<PtyEvent["type"]> = []
    while (picked.length < count) {
      const evt = yield* Queue.take(events)
      if (evt.id === id) picked.push(evt.type)
    }
    return picked
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timeout waiting for pty events")),
    }),
  )

const attachCollecting = Effect.fn("PtySessionTest.attachCollecting")(function* (id: PtyID, offset?: number) {
  const pty = yield* Pty.Service
  const output = yield* Queue.unbounded<string>()
  const ended = yield* Deferred.make<Pty.EndEvent>()
  const attachment = yield* pty.attach(id, {
    sessionID,
    offset,
    access: "inspect",
    onData: (chunk) => Queue.offerUnsafe(output, new TextDecoder().decode(chunk.data)),
    onEnd: (event) => Deferred.doneUnsafe(ended, Effect.succeed(event)),
  })
  attachment.activate()
  return { attachment, output, ended }
})

const waitForOutput = (output: Queue.Queue<string>, text: string) =>
  Effect.gen(function* () {
    let received = ""
    while (!received.includes(text)) received += yield* Queue.take(output)
    return received
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error(`timeout waiting for output containing ${JSON.stringify(text)}`)),
    }),
  )

describe("pty", () => {
  it.live("returns typed not found errors for missing sessions", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const id = PtyID.make("pty_missing")

      for (const result of [
        yield* pty.get(id, sessionID).pipe(Effect.asVoid, Effect.exit),
        yield* pty
          .update(id, { sessionID, generation: 1, expectedFence: 1, actor: "agent", title: "missing" })
          .pipe(Effect.asVoid, Effect.exit),
        yield* pty.remove(id, sessionID).pipe(Effect.exit),
        yield* pty
          .write(id, { sessionID, generation: 1, expectedFence: 1, actor: "agent", data: "input" })
          .pipe(Effect.exit),
        yield* pty
          .attach(id, { sessionID, access: "inspect", onData: () => {}, onEnd: () => {} })
          .pipe(Effect.asVoid, Effect.exit),
      ]) {
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.NotFoundError", ptyID: id })
      }
    }),
  )

  ptyTest("retains exited sessions until removed", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const events = yield* subscribePtyEvents()
      const info = yield* createPty("/usr/bin/env", ["sh", "-c", "exit 3"])

      expect(yield* waitForEvents(events, info.id, 2)).toEqual(["created", "exited"])
      const exited = yield* pty.get(info.id, sessionID)
      expect(exited.status).toBe("exited")
      expect(exited.exitCode).toBe(3)

      yield* pty.remove(info.id, sessionID)
      expect(yield* waitForEvents(events, info.id, 1)).toEqual(["deleted"])
      const missing = yield* pty.get(info.id, sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }),
  )

  ptyTest("replays buffered output and streams live output to attachments", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      yield* pty.write(info.id, {
        sessionID,
        generation: info.generation,
        expectedFence: info.control.fence,
        actor: "agent",
        data: "AAA\n",
      })

      const first = yield* attachCollecting(info.id)
      expect(yield* waitForOutput(first.output, "AAA")).toContain("AAA")

      expect(first.attachment.write("BBB\n")).toBe(false)
      yield* pty.write(info.id, {
        sessionID,
        generation: info.generation,
        expectedFence: info.control.fence,
        actor: "agent",
        data: "BBB\n",
      })
      yield* waitForOutput(first.output, "BBB")

      // A later attachment replays everything already buffered.
      const replayed = yield* attachCollecting(info.id)
      expect(new TextDecoder().decode(replayed.attachment.replay.data)).toContain("AAA")
      expect(new TextDecoder().decode(replayed.attachment.replay.data)).toContain("BBB")
      expect(replayed.attachment.replay.endOffset).toBeGreaterThan(0)
      expect(replayed.attachment.replay.gap).toBe(false)

      // Tail attachments skip the buffer and only see subsequent output.
      const tail = yield* attachCollecting(info.id, replayed.attachment.replay.endOffset)
      expect(tail.attachment.replay.data).toHaveLength(0)
      expect(tail.attachment.replay.endOffset).toBe(replayed.attachment.replay.endOffset)
    }),
  )

  ptyTest("stops delivering output after detach", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      const attached = yield* attachCollecting(info.id, -1)

      attached.attachment.detach()
      yield* pty.write(info.id, {
        sessionID,
        generation: info.generation,
        expectedFence: info.control.fence,
        actor: "agent",
        data: "AAA\n",
      })

      const verify = yield* attachCollecting(info.id)
      yield* waitForOutput(verify.output, "AAA")
      const leaked = yield* Queue.poll(attached.output)
      expect(leaked._tag).toBe("None")
    }),
  )

  ptyTest("isolates output between sessions", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const a = yield* createPty("cat")
      const b = yield* createPty("cat")
      const attachedA = yield* attachCollecting(a.id)
      const attachedB = yield* attachCollecting(b.id)

      yield* pty.write(a.id, {
        sessionID,
        generation: a.generation,
        expectedFence: a.control.fence,
        actor: "agent",
        data: "AAA\n",
      })
      yield* waitForOutput(attachedA.output, "AAA")

      const leaked = yield* Queue.poll(attachedB.output)
      expect(leaked._tag).toBe("None")
    }),
  )

  ptyTest("notifies attachments with the exit code and rejects attach after exit", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const events = yield* subscribePtyEvents()
      const info = yield* createPty("cat")
      const attached = yield* attachCollecting(info.id)

      yield* pty.write(info.id, {
        sessionID,
        generation: info.generation,
        expectedFence: info.control.fence,
        actor: "agent",
        data: "\u0004",
      })
      expect(yield* Deferred.await(attached.ended).pipe(Effect.timeout("5 seconds"))).toEqual({
        generation: info.generation,
        reason: "exit",
        exitCode: 0,
      })
      yield* waitForEvents(events, info.id, 2)

      const result = yield* pty
        .attach(info.id, { sessionID, access: "inspect", onData: () => {}, onEnd: () => {} })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject({ _tag: "Pty.ExitedError", ptyID: info.id })
    }),
  )

  ptyTest("enforces Session ownership and exclusive fenced control", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      const other = SessionV2.ID.make("ses_pty_other")
      const initialFence = info.control.fence

      const crossSession = yield* pty.get(info.id, other).pipe(Effect.exit)
      expect(Exit.isFailure(crossSession)).toBe(true)
      if (Exit.isFailure(crossSession))
        expect(Cause.squash(crossSession.cause)).toMatchObject({ _tag: "Pty.OwnershipError", ptyID: info.id })

      const controlled = yield* pty.control(info.id, {
        sessionID,
        generation: info.generation,
        expectedFence: initialFence,
        action: "take",
      })
      expect(controlled.control).toEqual({ owner: "user", fence: initialFence + 1 })

      const staleAgentWrite = yield* pty
        .write(info.id, {
          sessionID,
          generation: info.generation,
          expectedFence: initialFence,
          actor: "agent",
          data: "forbidden",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(staleAgentWrite)).toBe(true)

      const user = yield* pty.attach(info.id, {
        sessionID,
        access: "control",
        generation: info.generation,
        fence: controlled.control.fence,
        offset: controlled.output.endOffset,
        onData: () => {},
        onEnd: () => {},
      })
      expect(user.write("allowed\n")).toBe(true)
      const paused = yield* pty.control(info.id, {
        sessionID,
        generation: info.generation,
        expectedFence: controlled.control.fence,
        action: "pause",
      })
      expect(paused.control.owner).toBe("paused")
      expect(user.write("stale\n")).toBe(false)
    }),
  )

  ptyTest("reports an output gap instead of replaying an evicted prefix", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat", [], 1024)
      const live = yield* attachCollecting(info.id, info.output.endOffset)
      for (let index = 0; index < 10; index++)
        yield* pty.write(info.id, {
          sessionID,
          generation: info.generation,
          expectedFence: info.control.fence,
          actor: "agent",
          data: `${"x".repeat(400)}\n`,
        })
      yield* waitForOutput(live.output, "xxxx")
      while ((yield* pty.get(info.id, sessionID)).output.startOffset === 0) yield* Effect.sleep("10 millis")
      live.attachment.detach()
      const attached = yield* attachCollecting(info.id, 0)
      expect(attached.attachment.replay.gap).toBe(true)
      expect(attached.attachment.replay.data).toHaveLength(0)
      expect(attached.attachment.replay.startOffset).toBeGreaterThan(0)
    }),
  )

  ptyTest("enforces active terminal, input, and lifetime bounds", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const first = yield* createPty("cat", [], undefined, 1)
      const attached = yield* attachCollecting(first.id, first.output.endOffset)
      const oversized = yield* pty
        .write(first.id, {
          sessionID,
          generation: first.generation,
          expectedFence: first.control.fence,
          actor: "agent",
          data: "x".repeat(Pty.MAX_INPUT_BYTES + 1),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(oversized)).toBe(true)
      if (Exit.isFailure(oversized))
        expect(Cause.squash(oversized.cause)).toMatchObject({ _tag: "Pty.ResourceLimitError", resource: "input" })

      for (let index = 1; index < Pty.MAX_ACTIVE; index++) yield* createPty("cat")
      const excess = yield* pty.create({ sessionID, command: "cat", cwd: "/tmp" }).pipe(Effect.exit)
      expect(Exit.isFailure(excess)).toBe(true)
      if (Exit.isFailure(excess))
        expect(Cause.squash(excess.cause)).toMatchObject({ _tag: "Pty.ResourceLimitError", resource: "active" })

      expect(yield* Deferred.await(attached.ended).pipe(Effect.timeout("3 seconds"))).toMatchObject({
        generation: first.generation,
        reason: "timeout",
      })
    }),
  )
})

const configuredShell = process.platform === "win32" ? undefined : Bun.which("bash")
const configuredIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [
      Config.node,
      Layer.mock(Config.Service)({
        entries: () =>
          Effect.succeed(
            configuredShell
              ? [new Config.Document({ type: "document", info: new Config.Info({ shell: configuredShell }) })]
              : [],
          ),
      }),
    ],
    [Location.node, locationLayer],
  ]),
)
const configuredTest = process.platform === "win32" ? configuredIt.live.skip : configuredIt.live

describe("pty create defaults", () => {
  configuredTest("defaults command, login args, and cwd from config and location", () =>
    Effect.gen(function* () {
      if (!configuredShell) return
      const pty = yield* Pty.Service
      const info = yield* Effect.acquireRelease(pty.create({ sessionID, title: "configured" }), (created) =>
        pty.remove(created.id, sessionID).pipe(Effect.ignore),
      )
      expect(info.command).toBe(configuredShell)
      expect(info.args).toEqual(["-l"])
      expect(info.cwd).toBe("/tmp")
      expect(info.title).toBe("configured")
    }),
  )
})
