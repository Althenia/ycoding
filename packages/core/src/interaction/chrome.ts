import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { Schema } from "effect"
import { previewFrame } from "../../../../extensions/interaction-chrome/page.js"
import type { ConsentProof, InteractionDriver, InventoryRequest, NativeInteraction } from "./driver"

export const chromeConnectPath = "/api/interaction/chrome/connect"
export const chromeExtensionID = "gdhiogddidamidlaagllklagfnghpjmn"
const maxFrame = 262_144
const maxRequests = 2048
const deadlineMs = 8_000
const decodeID = Schema.decodeUnknownSync(Interaction.ID)
const decodeTargets = Schema.decodeUnknownSync(Schema.Array(Interaction.Target).check(Schema.isMaxLength(65)))
const decodeObservation = Schema.decodeUnknownSync(Interaction.Observation)
const decodeFrame = Schema.decodeUnknownOption(Interaction.Frame)
const decodeResult = Schema.decodeUnknownSync(Interaction.ActionResult)
const decodeRefusal = Schema.decodeUnknownSync(Interaction.Refusal)
const decodeProof = Schema.decodeUnknownSync(Schema.Struct({
  candidateID: Interaction.ID,
  sessionID: SessionID,
  targetID: Interaction.ID,
  authorization: Schema.String.check(Schema.isLengthBetween(1, 256)),
}))

interface Peer {
  readonly url: string
  readonly origin: string | undefined
  readonly peerAddress: string | undefined
  readonly send: (text: string) => boolean
  readonly close: () => void
}

class ChromeTransportError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "ChromeTransportError"
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChromeTransportError("invalid")
  return Object.fromEntries(Object.entries(value))
}

export function makeChromeTransport(options: {
  readonly origin: string
  readonly register: (driver: InteractionDriver) => NativeInteraction
}) {
  const origin = new URL(options.origin)
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash) throw new ChromeTransportError("not_loopback")
  let enrollment: { digest: Buffer; expiresAt: number } | undefined
  let current: ReturnType<typeof attachPeer> | undefined
  const peers = new Set<ReturnType<typeof attachPeer>>()
  let closed = false

  function admit(peer: Pick<Peer, "url" | "origin" | "peerAddress">) {
    return !closed && (peer.peerAddress === "127.0.0.1" || peer.peerAddress === "::ffff:127.0.0.1") &&
      peer.origin === `chrome-extension://${chromeExtensionID}` &&
      (peer.url === chromeConnectPath || peer.url === `${origin.origin}${chromeConnectPath}`)
  }

  function attachPeer(peer: Peer) {
    let native: NativeInteraction | undefined
    let ended = false
    let requests = 0
    let unsubscribe: (() => void) | undefined
    const offered = new Map<Interaction.ID, InventoryRequest>()
    const answering = new Set<Interaction.ID>()
    const waiting = new Map<Interaction.ID, (error: unknown, value?: unknown) => void>()
    const leases = new Map<Interaction.ID, {
      input: { leaseID: Interaction.ID; sessionID: ConsentProof["sessionID"]; epoch: number; revision: number; pathname: Interaction.Pathname }
      awaitingObservation: boolean
    }>()
    const revoked = new Set<Interaction.ID>()
    const timer = setTimeout(() => disconnect(), deadlineMs)
    timer.unref()

    function send(frame: unknown) {
      if (ended) return false
      const text = JSON.stringify(frame)
      if (Buffer.byteLength(text) <= maxFrame && peer.send(text)) return true
      disconnect()
      return false
    }

    function disconnect() {
      if (ended) return
      ended = true
      clearTimeout(timer)
      peers.delete(channel)
      if (current === channel) current = undefined
      unsubscribe?.()
      native?.disconnect()
      for (const settle of waiting.values()) settle(new ChromeTransportError("disconnected"))
      offered.clear()
      leases.clear()
      peer.close()
    }

    function tellPending(request: InventoryRequest) {
      if (!native || ended || offered.has(request.candidateID)) return
      for (const previous of offered.values()) {
        if (answering.has(previous.candidateID) || previous.expiresAt > Date.now()) continue
        offered.delete(previous.candidateID)
      }
      if (offered.size >= 8) return
      offered.set(request.candidateID, request)
      if (send({ type: "pending", input: request })) void native.inventory(request.candidateID).catch(disconnect)
    }

    function invoke(op: string, input: unknown, signal = AbortSignal.timeout(deadlineMs)) {
      if (!native || ended || waiting.size >= 16 || requests >= maxRequests || signal.aborted)
        return Promise.reject(new ChromeTransportError("unavailable"))
      requests++
      const id = Interaction.ID.create()
      const deadline = Date.now() + deadlineMs
      return new Promise<unknown>((resolve, reject) => {
        const settle = (error: unknown, value?: unknown) => {
          waiting.delete(id)
          clearTimeout(expiry)
          signal.removeEventListener("abort", abort)
          if (error) reject(error)
          else resolve(value)
        }
        const abort = () => settle(new ChromeTransportError("uncertain"))
        const expiry = setTimeout(abort, deadlineMs)
        expiry.unref()
        waiting.set(id, settle)
        signal.addEventListener("abort", abort, { once: true })
        if (!send({ type: "request", id, op, input, deadline })) settle(new ChromeTransportError("disconnected"))
      })
    }

    const driver: InteractionDriver = {
      platform: "chrome",
      async inventory(request) { return decodeTargets(await invoke("inventory", request)) },
      async attach(target, proof, signal) {
        if (target.kind === "macos-window" || target.kind === "chrome-isolated") throw new ChromeTransportError("invalid")
        const cancel = () => { send({ type: "cancel", input: { candidateID: proof.candidateID, sessionID: proof.sessionID } }) }
        signal.addEventListener("abort", cancel, { once: true })
        try {
          const frame = record(await invoke("attach", { target, proof }, signal))
          const leaseID = decodeID(frame.leaseID)
          const epoch = frame.epoch
          if (frame.sessionID !== proof.sessionID || frame.targetID !== proof.targetID || frame.pathname !== target.pathname ||
            typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 || frame.revision !== 1 || revoked.has(leaseID))
            throw new ChromeTransportError("invalid")
          leases.set(leaseID, { input: { leaseID, epoch, sessionID: proof.sessionID, revision: 1, pathname: target.pathname }, awaitingObservation: false })
          return { id: leaseID }
        } catch (cause) {
          cancel()
          if (!(cause instanceof ChromeTransportError) || ["invalid", "uncertain"].includes(cause.code)) disconnect()
          throw cause
        } finally {
          signal.removeEventListener("abort", cancel)
        }
      },
      async observe(lease, signal) {
        const live = leases.get(lease.id)
        if (!live) throw new ChromeTransportError("target_lost")
        const observed = decodeObservation(await invoke("observe", live.input, signal))
        if (observed.revision <= live.input.revision || observed.pathname !== live.input.pathname) throw new ChromeTransportError("stale")
        live.input.revision = observed.revision
        live.awaitingObservation = false
        return observed
      },
      async perform(lease, revision, command, signal) {
        const live = leases.get(lease.id)
        if (!live || live.awaitingObservation || revision !== live.input.revision || signal.aborted) return { outcome: "refused", reason: "stale" }
        if (command.action.type === "navigate") live.awaitingObservation = true
        try {
          return decodeResult(await invoke("perform", { ...live.input, revision, ...command }, signal))
        } catch (cause) {
          if (!(cause instanceof ChromeTransportError) || ["disconnected", "uncertain"].includes(cause.code))
            return { outcome: "uncertain" }
          if (cause.code === "consent") return { outcome: "refused", reason: "confirmation_required" }
          if (cause.code === "ownership" || cause.code === "stopped") return { outcome: "refused", reason: "target_lost" }
          if (cause.code === "invalid" || cause.code === "unavailable") return { outcome: "refused", reason: "unsupported" }
          return { outcome: "refused", reason: decodeRefusal(cause.code) }
        }
      },
      async preview(lease, signal) {
        const live = leases.get(lease.id)
        if (!live) return undefined
        const result = record(await invoke("preview", live.input, signal))
        if (result.status !== "ready") return undefined
        const frame = decodeFrame(result.frame)
        if (frame._tag === "None") return undefined
        const image = previewFrame(frame.value.mimeType, frame.value.base64)
        return image?.width === frame.value.width && image.height === frame.value.height ? image : undefined
      },
      async detach(lease, reason) {
        const live = leases.get(lease.id)
        if (!live) return
        leases.delete(lease.id)
        await invoke("detach", { ...live.input, reason })
      },
    }

    async function receive(raw: string) {
      if (ended) return
      try {
        if (typeof raw !== "string" || Buffer.byteLength(raw) > maxFrame) throw new ChromeTransportError("invalid")
        const frame = record(JSON.parse(raw))
        if (!native) {
          const expected = enrollment
          if (frame.type !== "authenticate" || frame.version !== 1 || frame.extensionID !== chromeExtensionID ||
            typeof frame.code !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(frame.code) || !expected ||
            expected.expiresAt <= Date.now() || !timingSafeEqual(expected.digest, createHash("sha256").update(frame.code).digest()))
            throw new ChromeTransportError("authentication")
          enrollment = undefined
          current?.disconnect()
          native = options.register(driver)
          current = channel
          clearTimeout(timer)
          if (send({ type: "authenticated", version: 1 })) {
            unsubscribe = native.onPending(tellPending)
            for (const request of native.pending()) tellPending(request)
          }
          return
        }
        if (current !== channel) throw new ChromeTransportError("disconnected")
        if (frame.type === "result" || frame.type === "error") {
          const id = decodeID(frame.id)
          waiting.get(id)?.(frame.type === "error" ?
            new ChromeTransportError(typeof frame.code === "string" && frame.code.length < 32 ? frame.code : "invalid") : undefined, frame.result)
          return
        }
        if (frame.type === "approved") {
          const proof = decodeProof(frame.proof)
          const request = offered.get(proof.candidateID)
          if (!request || request.sessionID !== proof.sessionID || answering.has(proof.candidateID) || request.expiresAt <= Date.now()) return
          answering.add(proof.candidateID)
          if (!await native.approve(proof)) {
            send({ type: "cancel", input: { candidateID: proof.candidateID, sessionID: proof.sessionID } })
          }
          offered.delete(proof.candidateID)
          answering.delete(proof.candidateID)
          return
        }
        if (frame.type === "rejected") {
          const candidateID = decodeID(frame.candidateID)
          if (offered.delete(candidateID)) native.reject(candidateID)
          return
        }
        if (frame.type === "revoked") {
          const id = decodeID(frame.leaseID)
          const lease = leases.get(id)
          if (revoked.size >= maxRequests) throw new ChromeTransportError("invalid")
          if (lease && frame.epoch !== lease.input.epoch) return
          revoked.add(id)
          if (!lease) return
          native.stop(id, frame.reason === "stopped" ? "stopped" : "target_lost")
          return
        }
        throw new ChromeTransportError("invalid")
      } catch {
        disconnect()
      }
    }

    const channel = { receive, disconnect }
    return channel
  }

  return {
    enroll() {
      if (closed) throw new ChromeTransportError("unavailable")
      const code = randomBytes(32).toString("base64url")
      const expiresAt = Date.now() + 60_000
      const issued = { digest: createHash("sha256").update(code).digest(), expiresAt }
      enrollment = issued
      return { code, expiresAt, revoke() { if (enrollment === issued) enrollment = undefined } }
    },
    admit,
    connect(peer: Peer) {
      if (!admit(peer) || peers.size >= 4) throw new ChromeTransportError("authentication")
      const channel = attachPeer(peer)
      peers.add(channel)
      return channel
    },
    close() {
      closed = true
      enrollment = undefined
      for (const peer of peers) peer.disconnect()
    },
  }
}
