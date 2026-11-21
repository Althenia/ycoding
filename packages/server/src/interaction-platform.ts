import path from "node:path"
import { Global } from "@ycoding-ai/core/global"
import { makeChromeTransport } from "@ycoding-ai/core/interaction/chrome"
import { makeChromeIsolatedDriver } from "@ycoding-ai/core/interaction/chrome-isolated"
import type { InteractionDriver, InteractionDriverKey, InventoryRequest, NativeInteraction } from "@ycoding-ai/core/interaction/driver"
import type { Interaction, InteractionRuntime } from "@ycoding-ai/core/interaction/index"
import { makeMacOSInteraction } from "@ycoding-ai/core/interaction/macos"
import { Deferred, Effect, Option, Queue } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"

export type ChromeTransport = Pick<ReturnType<typeof makeChromeTransport>, "admit" | "connect">

export type InteractionPlatforms = {
  readonly macOS?: {
    readonly application: string
    readonly certificateSHA1: string
  }
}

export const mountNativeConsent = Effect.fnUntraced(function* (
  authority: InteractionRuntime.Service["Service"], driver: InteractionDriver, key: InteractionDriverKey,
  approve: (native: NativeInteraction, request: InventoryRequest, targets: readonly Interaction.Target[], signal: AbortSignal) => Promise<boolean>,
) {
  const native = authority.register(driver, key)
  const controller = new AbortController()
  const stop = native.onPending((request, lifetime) => {
    const remaining = request.expiresAt - Date.now()
    if (lifetime.aborted || remaining <= 0) return
    const signal = AbortSignal.any([lifetime, controller.signal, AbortSignal.timeout(remaining)])
    void native.inventory(request.candidateID).then(async (targets) => {
      if (!targets.length || signal.aborted) return
      if (!await approve(native, request, targets, signal) && !signal.aborted) native.reject(request.candidateID)
    }).catch(() => { if (!signal.aborted) native.reject(request.candidateID) })
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    controller.abort()
    stop()
    native.disconnect()
  }))
  return native
})

export const mountInteractionPlatforms = Effect.fnUntraced(function* (
  authority: InteractionRuntime.Service["Service"], options: InteractionPlatforms, origin?: string,
) {
  const macOS = options.macOS && makeMacOSInteraction(options.macOS)
  if (macOS) {
    yield* Effect.addFinalizer(() => Effect.sync(() => macOS.close()))
    yield* mountNativeConsent(authority, macOS.driver, "macos", async (native, request, targets, signal) => {
      const targetID = await macOS.choose(request, targets, signal)
      return targetID !== undefined && !signal.aborted && macOS.approve(native, request.candidateID, targetID, signal)
    })
    const isolated = makeChromeIsolatedDriver({
      lost: (leaseID, reason) => { isolatedNative.stop(leaseID, reason) },
      confirmIsolated: macOS.confirmIsolated,
    })
    const isolatedNative = yield* mountNativeConsent(authority, isolated.driver, "chrome-isolated", async (channel, request, targets, signal) => {
      const target = targets[0]
      if (targets.length !== 1 || target?.kind !== "chrome-isolated") return false
      const proof = await isolated.approve({ candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }, signal)
      return proof !== undefined && !signal.aborted && channel.approve(proof)
    })
  }

  if (!origin || !macOS) return undefined
  return yield* mountChromeTransport(authority, macOS, origin, path.join(Global.Path.state, "interaction-chrome-profiles.json"))
})

export const mountChromeTransport = Effect.fnUntraced(function* (
  authority: Pick<InteractionRuntime.Service["Service"], "register">,
  macOS: Pick<ReturnType<typeof makeMacOSInteraction>, "available" | "confirmChromeProfile">,
  origin: string,
  profiles: string,
) {
  const lifetime = new AbortController()
  yield* Effect.addFinalizer(() => Effect.sync(() => lifetime.abort()))
  const ready = yield* Effect.promise(() => macOS.available(AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])))
  if (!ready || lifetime.signal.aborted) return undefined
  const transport = makeChromeTransport({ origin, register: authority.register, confirm: macOS.confirmChromeProfile, profiles })
  yield* Effect.addFinalizer(() => Effect.sync(() => transport.close()))
  return { admit: transport.admit, connect: (peer) => transport.connect(peer) } satisfies ChromeTransport
})

export const connectChromeInteraction = Effect.fnUntraced(function* (transport: ChromeTransport) {
  const request = yield* HttpServerRequest.HttpServerRequest
  const peer = { url: request.url, origin: request.headers.origin, peerAddress: Option.getOrUndefined(request.remoteAddress) }
  if (request.method !== "GET" || !transport.admit(peer)) return HttpServerResponse.empty({ status: 403 })
  const upgraded = yield* request.upgrade.pipe(Effect.option)
  if (Option.isNone(upgraded)) return HttpServerResponse.empty({ status: 400 })
  const socket = upgraded.value
  const write = yield* socket.writer
  const outbox = yield* Queue.dropping<string>(32)
  const closing = yield* Deferred.make<number>()
  const connected = yield* Effect.option(Effect.try(() => transport.connect({
    ...peer,
    send: (content) => Queue.offerUnsafe(outbox, content),
    close: (code) => { Deferred.doneUnsafe(closing, Effect.succeed(code)) },
  })))
  if (Option.isNone(connected)) {
    yield* write(new Socket.CloseEvent(1008)).pipe(Effect.ignore)
    return HttpServerResponse.empty()
  }
  const channel = connected.value
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let pending = 0
  const read = socket.runRaw((input) => {
    const size = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength
    if (size > 262_144 || pending >= 16) return channel.disconnect()
    let content: string
    try { content = typeof input === "string" ? input : decoder.decode(input) }
    catch { return channel.disconnect() }
    pending++
    void channel.receive(content).finally(() => { pending-- })
  })
  const drain = Effect.forever(Queue.take(outbox).pipe(Effect.flatMap(write)))
  yield* Effect.raceFirst(Effect.raceFirst(read, drain), Deferred.await(closing).pipe(
    Effect.flatMap((code) => write(new Socket.CloseEvent(code))),
  )).pipe(Effect.ignore, Effect.ensuring(Effect.sync(channel.disconnect)))
  return HttpServerResponse.empty()
}, Effect.scoped)
