import { expect, mock } from "bun:test"
import { Effect, Redacted } from "effect"
import { EventEmitter } from "node:events"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  create,
  decodeStrict,
  encodeStrict,
  FrameSchema,
  health_get_ResultSchema,
  event_unsubscribe_ResultSchema,
  PublicEventSchema,
  PublicEvent_catalog_updatedSchema,
} from "@ycoding-ai/protocol/v5"
import { defaultBudgets } from "@ycoding-ai/protocol/v5/connection"
import { ScriptedPeer } from "../../../client/test/fixture/v5-peer"
import { fakePacket } from "./user-app-packet"
import { InstallationVersion } from "../../src/version"
import type { UserApp, UserAppSelection } from "../../src/server-process"

const scenario = process.argv[2]
if (!scenario) throw new Error("A synthetic scenario is required")
const { Service: originalService } = await import("@ycoding-ai/client/effect/service")
const root = path.resolve(import.meta.dirname, "../..")
const packet = await fakePacket()
const poison = "synthetic-secret https://synthetic.invalid/private command=/synthetic/private"
const peer = new ScriptedPeer()
const socketClosed = Promise.withResolvers<void>()
const processClosed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
const parentClosed = Promise.withResolvers<void>()
const parentJoined = Promise.withResolvers<void>()
const acquired = Promise.withResolvers<void>()
const privateClosing = Promise.withResolvers<void>()
const opening = new AbortController()
const runEffect = Effect.void
const captures: {
  ensure: unknown[]
  stop: number
  private: { cwd?: string; command?: readonly string[] }[]
  socket: { url: string; options: unknown }[]
  socketClose: number
  run: unknown[]
} = {
  ensure: [],
  stop: 0,
  private: [],
  socket: [],
  socketClose: 0,
  run: [],
}
const selectedDirectory = path.join(packet.directory, "selected-location")
await mkdir(selectedDirectory)
const registration = {
  id: "source-1",
  version: InstallationVersion,
  url: "http://127.0.0.1:19371",
  pid: 421,
  password: "synthetic-managed-password",
}
const registrationFile = path.join(packet.directory, "state", "service-local.json")
await mkdir(path.dirname(registrationFile))
await writeFile(registrationFile, JSON.stringify(registration))

function failure(error: unknown, code: string) {
  expect(error).toMatchObject({ name: "UserAppError", code })
  expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain("synthetic-secret")
  expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(packet.directory)
  expect(error).not.toHaveProperty("cause")
  expect(error).not.toHaveProperty("stack")
}

class FakeWebSocket extends EventEmitter {
  readyState = 0
  binaryType = "arraybuffer"
  constructor(url: string, options: unknown) {
    super()
    captures.socket.push({ url, options })
    peer.socket.addEventListener("message", (event) => {
      if (!(event instanceof MessageEvent) || !(event.data instanceof ArrayBuffer))
        throw new Error("Invalid synthetic binary event")
      this.emit("message", new Uint8Array(event.data), true)
    })
    queueMicrotask(() => {
      if (scenario === "socket-opening-cancel") {
        acquired.resolve()
        return
      }
      if (scenario === "socket-auth") {
        this.emit("unexpected-response", {}, { statusCode: 401, resume() {} })
        this.readyState = 3
        this.emit("error", new Error(poison))
        this.emit("close", 1006)
        return
      }
      this.readyState = 1
      peer.socket.readyState = 1
      this.emit("open")
    })
  }
  send(bytes: Uint8Array) {
    peer.receive(bytes)
  }
  close() {
    captures.socketClose++
    if (scenario === "socket-close-failure") this.emit("error", new Error(poison))
    if (scenario === "deferred-socket" || scenario === "deferred-private" || scenario === "close-subscription") {
      void socketClosed.promise.then(() => {
        this.readyState = 3
        this.emit("close", 1000)
      })
      return
    }
    this.readyState = 3
    this.emit("close", 1000)
  }
  terminate() {
    if (scenario === "socket-opening-cancel" && this.readyState === 0) {
      this.readyState = 2
      this.emit("error", new Error(poison))
    }
    this.close()
  }
}

const socketModulePath = path.join(root, "src/user-app-socket.ts")
const socketIOModulePath = path.join(root, "src/user-app-node-socket.ts")
let realConstructorReached = 0
const forbiddenSocket = () => {
  realConstructorReached++
  throw new Error("The real socket constructor is forbidden in this fixture")
}
mock.module(socketIOModulePath, () => ({ openNodeSocket: forbiddenSocket }))
const { openNodeSocket }: typeof import("../../src/user-app-node-socket") = await import(socketIOModulePath)
expect(openNodeSocket).toBe(forbiddenSocket)
const { userAppSocket }: typeof import("../../src/user-app-socket") = await import(socketModulePath)
const syntheticSocket = (url: string, headers: Readonly<Record<string, string>>) =>
  userAppSocket(url, headers, (url, options) => new FakeWebSocket(url, options))
mock.module(socketModulePath, () => ({ userAppSocket: syntheticSocket }))
expect(await import(socketModulePath)).toMatchObject({ userAppSocket: syntheticSocket })
mock.module(path.join(root, "src/paths.ts"), () => ({
  FrontendPaths: {
    Path: { bin: path.join(packet.directory, "extracted") },
    resolvePaths: () => ({ state: path.dirname(registrationFile), bin: path.join(packet.directory, "extracted") }),
  },
}))
mock.module(path.join(root, "src/env.ts"), () => ({
  Env: { password: Effect.succeed(Redacted.make("synthetic-main-password")) },
}))
mock.module("@ycoding-ai/client/effect/service", () => ({
  Service: {
    Info: originalService.Info,
    headers: (endpoint: { auth?: { username: string; password: string } }) =>
      endpoint.auth
        ? {
            authorization:
              "Basic " + Buffer.from(endpoint.auth.username + ":" + endpoint.auth.password).toString("base64"),
          }
        : undefined,
    stop: () => {
      captures.stop++
      return Effect.void
    },
    ensure: (options: unknown) =>
      Effect.gen(function* () {
        captures.ensure.push(options)
        if (scenario === "managed-version") return yield* Effect.fail(new Error(poison))
        if (scenario === "managed-failed") return yield* Effect.fail(new Error(poison))
        if (scenario === "managed-wait-cancel") {
          acquired.resolve()
          return yield* Effect.never
        }
        if (scenario === "managed-race")
          yield* Effect.promise(() =>
            writeFile(registrationFile, JSON.stringify({ ...registration, id: "replacement-source" })),
          )
        return { url: registration.url, auth: { type: "basic", username: "ycoding", password: registration.password } }
      }),
  },
}))
mock.module(path.join(root, "src/native-process.ts"), () => ({
  NativeProcess: {
    run: (options: unknown) => {
      captures.run.push(options)
      return runEffect
    },
    start: (options: { cwd?: string; command?: readonly string[] }) =>
      Effect.gen(function* () {
        captures.private.push(options)
        if (scenario === "private-start") return yield* Effect.fail(new Error(poison))
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.promise(async () => {
            privateClosing.resolve()
            await parentClosed.promise
            await processClosed.promise
            await parentJoined.promise
            if (scenario === "private-close-failure" || scenario === "forced-termination") throw new Error(poison)
          }),
        )
        return {
          pid: 421,
          closed: processClosed.promise,
          retire: () => privateClosing.resolve(),
          stdout: (async function* () {
            yield Buffer.from(
              scenario === "private-ready"
                ? "synthetic-secret malformed\n"
                : JSON.stringify({ url: registration.url }) + "\n",
            )
          })(),
          stderr: (async function* () {})(),
        }
      }),
  },
}))

globalThis.fetch = Object.assign(
  async (_input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (scenario === "opening-cancel") {
      acquired.resolve()
      return new Promise<Response>((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error(poison)), { once: true }),
      )
    }
    if (scenario === "external-auth") return new Response("synthetic-secret", { status: 401 })
    return Response.json({
      healthy: scenario !== "health-contract",
      version: scenario === "external-version" ? InstallationVersion + "-other" : InstallationVersion,
      pid: scenario === "private-pid" ? 999 : 421,
      sourceEpoch: scenario === "health-epoch" ? "different-source" : "source-1",
    })
  },
  {
    preconnect: (..._args: unknown[]) => {
      throw new Error("Synthetic preconnect is unavailable")
    },
  },
)

if (scenario === "wire-contract")
  peer.transform = (bytes) => {
    const frame = decodeStrict(FrameSchema, bytes)
    if (frame.body.case === "ready") frame.body.value.contractDigest = new Uint8Array(32)
    return encodeStrict(FrameSchema, frame)
  }

peer.onRequest = (dispatch) => {
  if (scenario === "sent" || scenario === "deferred-socket" || scenario === "deferred-private") return
  if (scenario === "domain") return peer.reject(dispatch)
  if (dispatch.operation.diagnosticName === "event.unsubscribe") {
    peer.result(dispatch, {
      typeName: event_unsubscribe_ResultSchema.typeName,
      payload: encodeStrict(event_unsubscribe_ResultSchema, create(event_unsubscribe_ResultSchema, { data: {} })),
    })
    return
  }
  if (dispatch.operation.diagnosticName === "event.subscribe") {
    peer.subscribe(dispatch)
    return
  }
  peer.result(dispatch, {
    typeName: health_get_ResultSchema.typeName,
    payload: encodeStrict(
      health_get_ResultSchema,
      create(health_get_ResultSchema, {
        data: {
          healthy: true,
          version: { encoding: { case: "utf8", value: InstallationVersion } },
          pid: 421n,
          sourceEpoch: { encoding: { case: "utf8", value: "source-1" } },
        },
      }),
    ),
  })
}

try {
  const packetModulePath = path.join(root, "src/user-app-packet.ts")
  const packetModule: typeof import("../../src/user-app-packet") | undefined = await import(packetModulePath).catch(
    () => undefined,
  )
  if (packetModule && scenario !== "unbound")
    mock.module(packetModulePath, () => ({
      ...packetModule,
      loadUserAppPacket: () => packetModule.readPacket(packet.url),
    }))
  const apiModule: typeof import("../../src/server-process") = await import(
    pathToFileURL(path.join(root, "src/server-process.ts")).href
  )
  if (scenario === "run") {
    const effect = apiModule.run({ mode: "stdio" })
    expect(effect).toBe(runEffect)
    expect(await Effect.runPromise(effect)).toBeUndefined()
    expect(captures.run).toEqual([{ mode: "stdio" }])
  } else {
    expect(apiModule.openUserApp).toBeFunction()
    if (scenario === "managed-version") {
      registration.version += "-other"
      await writeFile(registrationFile, JSON.stringify(registration))
    }
    if (scenario === "pre-cancel") opening.abort(new Error(poison))
    const selection: UserAppSelection =
      scenario.startsWith("private") ||
      scenario === "deferred-private" ||
      scenario === "forced-termination" ||
      scenario === "signal-detach-failure"
        ? { mode: "private" }
        : scenario.startsWith("managed")
          ? { mode: "managed" }
          : {
              mode: "external",
              url:
                scenario === "external-url" ? "http://synthetic:synthetic-secret@synthetic.invalid" : registration.url,
            }
    const options = {
      location: { directory: scenario === "location-relative" ? "relative" : selectedDirectory },
      signal: opening.signal,
    }
    if (scenario === "signal-invalid") Object.defineProperty(options, "signal", { value: {} })
    if (scenario === "signal-getter")
      Object.defineProperty(options, "signal", {
        get() {
          throw new Error(poison)
        },
      })
    if (scenario === "signal-detach-failure")
      Object.defineProperty(opening.signal, "removeEventListener", {
        value() {
          throw new Error(poison)
        },
      })
    const promise: Promise<UserApp> =
      scenario === "location-missing"
        ? Reflect.apply(apiModule.openUserApp, undefined, [selection, { signal: opening.signal }])
        : apiModule.openUserApp(selection, options)
    if (scenario === "opening-cancel" || scenario === "socket-opening-cancel" || scenario === "managed-wait-cancel") {
      await Promise.race([
        acquired.promise,
        promise.then(() => {
          throw new Error("Opening completed before the cancellation gate")
        }),
      ])
      opening.abort(new Error(poison))
    }
    const expectedErrors: Record<string, string> = {
      "managed-race": "identity",
      "managed-version": "version",
      "managed-failed": "unavailable",
      "managed-wait-cancel": "cancelled",
      "external-url": "configuration",
      "external-auth": "authentication",
      "external-version": "version",
      "health-contract": "contract",
      "private-start": "unavailable",
      "private-ready": "unavailable",
      "private-pid": "identity",
      "health-epoch": "identity",
      "wire-contract": "contract",
      "opening-cancel": "cancelled",
      "socket-opening-cancel": "cancelled",
      "pre-cancel": "cancelled",
      unbound: "artifact",
      "location-relative": "configuration",
      "location-missing": "configuration",
      "signal-invalid": "configuration",
      "signal-getter": "unavailable",
      "signal-detach-failure": "shutdown",
      "socket-auth": "authentication",
    }
    if (expectedErrors[scenario]) {
      parentClosed.resolve()
      processClosed.resolve({ code: 0, signal: null })
      parentJoined.resolve()
      failure(await promise.catch((error: unknown) => error), expectedErrors[scenario])
      if (scenario === "signal-detach-failure") {
        expect(captures.socketClose).toBe(1)
        await privateClosing.promise
      }
    } else {
      const outcome = await Promise.race([
        promise.then((handle) => ({ handle })),
        privateClosing.promise.then(() => ({ retired: true })),
      ])
      if (!("handle" in outcome)) {
        parentClosed.resolve()
        processClosed.resolve({ code: 0, signal: null })
        parentJoined.resolve()
        const error = await promise.catch((error: unknown) => error)
        failure(error, "unavailable")
        throw new Error("Private ownership retired before publication")
      }
      const handle = outcome.handle
      expect(Object.keys(handle).sort()).toEqual(["api", "close"])
      expect(handle.api).not.toHaveProperty("transport")
      opening.abort(new Error(poison))
      if (scenario === "socket-headers") {
        expect(captures.socket[0]).toEqual({
          url: "ws://127.0.0.1:19371/ws/v5/local",
          options: {
            headers: { Authorization: "Basic " + Buffer.from("ycoding:synthetic-main-password").toString("base64") },
            maxPayload: defaultBudgets.serverFrameBytes,
            perMessageDeflate: false,
            followRedirects: false,
          },
        })
      }
      if (scenario === "unsent" || scenario === "sent") {
        const controller = new AbortController()
        const arrival = peer.nextRequest()
        if (scenario === "unsent") controller.abort()
        const request = handle.api.health.get({ signal: controller.signal }).catch((error: unknown) => error)
        if (scenario === "sent") {
          await arrival
          controller.abort()
        }
        expect(await request).toMatchObject({ status: scenario === "sent" ? "unknown" : "unsent" })
        expect(peer.requests).toHaveLength(scenario === "sent" ? 1 : 0)
      } else if (scenario === "domain")
        expect(await handle.api.health.get().catch((error: unknown) => error)).toMatchObject({
          _tag: "InvalidRequestError",
          message: "Scripted rejection",
        })
      else if (scenario === "event-return" || scenario === "event-signal") {
        const controller = new AbortController()
        const iterator = handle.api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
        expect((await iterator.next()).value).toMatchObject({ type: "server.connected", sourceEpoch: "source-1" })
        if (scenario === "event-signal") {
          controller.abort()
          await iterator.next().catch((error: unknown) => error)
        } else await iterator.return?.()
        expect(peer.requests.map((item) => item.operation.diagnosticName)).toContain("event.unsubscribe")
      } else if (scenario !== "deferred-socket" && scenario !== "deferred-private" && scenario !== "resync")
        expect(await handle.api.health.get()).toMatchObject({ healthy: true })
      if (scenario === "resync") {
        const arrival = peer.nextRequest()
        const iterator = handle.api.event.subscribe()[Symbol.asyncIterator]()
        await iterator.next()
        await arrival
        peer.events(
          "subscription-1",
          [
            {
              typeName: PublicEventSchema.typeName,
              payload: encodeStrict(
                PublicEventSchema,
                create(PublicEventSchema, {
                  kind: {
                    case: "catalogUpdated",
                    value: create(PublicEvent_catalog_updatedSchema, {
                      id: { encoding: { case: "utf8", value: "synthetic-stale-event" } },
                      created: 0,
                      type: 1,
                      data: {},
                    }),
                  },
                }),
              ),
            },
          ],
          "source-2",
        )
        expect(await iterator.next().catch((error: unknown) => error)).toMatchObject({ status: "resync" })
      }
      let pending: Promise<unknown> | undefined
      let subscription: AsyncIterator<unknown> | undefined
      if (scenario === "close-subscription") {
        subscription = handle.api.event.subscribe()[Symbol.asyncIterator]()
        await subscription.next()
      }
      if (scenario === "deferred-socket" || scenario === "deferred-private") {
        const arrival = peer.nextRequest()
        pending = handle.api.health.get().catch((error: unknown) => error)
        await arrival
      }
      const first = handle.close()
      expect(handle.close()).toBe(first)
      let settled = false
      void first.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      expect(await handle.api.health.get().catch((error: unknown) => error)).toMatchObject({ status: "unsent" })
      if (pending) expect(await pending).toMatchObject({ status: "unknown" })
      if (subscription)
        expect(await subscription.next().catch((error: unknown) => error)).toMatchObject({ status: "unavailable" })
      if (scenario === "deferred-private") await privateClosing.promise
      if (scenario === "deferred-socket" || scenario === "deferred-private" || scenario === "close-subscription") {
        expect(settled).toBe(false)
        socketClosed.resolve()
      }
      if (selection.mode === "private") {
        await privateClosing.promise
        if (scenario === "deferred-private") expect(settled).toBe(false)
        parentClosed.resolve()
        processClosed.resolve({ code: scenario === "private-exit-failure" ? 9 : 0, signal: null })
        if (scenario === "deferred-private") {
          await Promise.resolve()
          expect(settled).toBe(false)
        }
        parentJoined.resolve()
      }
      if (
        ["socket-close-failure", "private-close-failure", "private-exit-failure", "forced-termination"].includes(
          scenario,
        )
      )
        failure(await first.catch((error: unknown) => error), "shutdown")
      else await first
      if (selection.mode === "private") {
        const child = captures.private[0]
        if (!child) throw new Error("No synthetic native child was acquired")
        expect(child.cwd).toBe(selectedDirectory)
        expect(child.command).toContain("--frontend-executable")
        expect(child.command).toContain(path.join(packet.directory, packet.files.frontend.file))
      }
    }
    if (selection.mode === "managed")
      for (const options of captures.ensure)
        expect(options).toMatchObject({
          existing: "preserve",
          version: InstallationVersion,
          command: [path.join(packet.directory, packet.files.frontend.file), "serve", "--service"],
        })
    if (selection.mode === "external") expect(captures.ensure).toHaveLength(0)
    expect(captures.stop).toBe(0)
  }
  expect(realConstructorReached).toBe(0)
  console.log(JSON.stringify({ scenario, passed: true }))
} finally {
  await rm(packet.directory, { recursive: true, force: true })
}
