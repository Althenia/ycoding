import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { Option, Schema } from "effect"
import { previewFrame } from "../../../../extensions/interaction-chrome/page.js"
import type { ConsentProof, InteractionDriver, InventoryRequest, NativeInteraction } from "./driver"

export const chromeConnectPath = "/api/interaction/chrome/connect"
export const chromeExtensionID = "gdhiogddidamidlaagllklagfnghpjmn"
export const chromeCloseRejected = 4401
export const chromeCloseBusy = 4409
const maxFrame = 262_144
const maxRequests = 2048
const maxProfiles = 32
const deadlineMs = 8_000
const enrollmentMs = 75_000
const secret = /^[A-Za-z0-9_-]{43}$/
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const decodeID = Schema.decodeUnknownSync(Interaction.ID)
const decodeTargets = Schema.decodeUnknownSync(Schema.Array(Interaction.Target).check(Schema.isMaxLength(65)))
const decodeObservation = Schema.decodeUnknownSync(Interaction.Observation)
const decodeFrame = Schema.decodeUnknownOption(Interaction.Frame)
const decodeResult = Schema.decodeUnknownSync(Interaction.ActionResult)
const decodeScriptResult = Schema.decodeUnknownSync(Interaction.ScriptResult)
const decodeRefusal = Schema.decodeUnknownSync(Interaction.Refusal)
const decodePauseReason = Schema.decodeUnknownSync(Interaction.PauseReason)
const decodeProof = Schema.decodeUnknownSync(Schema.Struct({
  candidateID: Interaction.ID,
  sessionID: SessionID,
  targetID: Interaction.ID,
  authorization: Schema.String.check(Schema.isLengthBetween(1, 256)),
}))
const StoredProfile = Schema.Struct({
  profileID: Schema.String.check(Schema.isPattern(secret)),
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  label: Schema.String.check(Schema.isMaxLength(64)),
  created: Schema.Number,
})
type StoredProfile = typeof StoredProfile.Type
const decodeProfiles = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  profiles: Schema.Array(StoredProfile).check(Schema.isMaxLength(maxProfiles)),
})))

export interface ChromePeer {
  readonly url: string
  readonly origin: string | undefined
  readonly peerAddress: string | undefined
  readonly send: (text: string) => boolean
  readonly close: (code: number) => void
}

export interface ChromeProfileConsent {
  readonly profileLabel: string
  readonly matchCode: string
}

class ChromeTransportError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "ChromeTransportError"
  }
}

export function chromeMatchCode(profileID: string) {
  const digest = createHash("sha256").update(`ycoding-chrome-profile:${profileID}`).digest()
  const bits = digest.subarray(0, 5).reduce((value, byte) => value * 256n + BigInt(byte), 0n)
  const code = Array.from({ length: 8 }, (_, index) => crockford[Number((bits >> BigInt(35 - index * 5)) & 31n)]).join("")
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function chromeProfiles(file: string) {
  let queue: Promise<unknown> = Promise.resolve()
  const read = async () => Option.getOrUndefined(decodeProfiles(await readFile(file, "utf8").catch(() => "")))?.profiles ?? []
  const write = async (profiles: readonly StoredProfile[]) => {
    await mkdir(path.dirname(file), { recursive: true })
    const staged = `${file}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(staged, JSON.stringify({ version: 1, profiles }), { mode: 0o600 })
    await rename(staged, file)
  }
  const serial = <T>(work: () => Promise<T>) => {
    const next = queue.then(work)
    queue = next.catch(() => {})
    return next
  }
  return {
    get: (profileID: string) => serial(async () => (await read()).find((profile) => profile.profileID === profileID)),
    put: (profile: StoredProfile) => serial(async () => {
      const others = (await read()).filter((entry) => entry.profileID !== profile.profileID)
      await write([...others.slice(Math.max(0, others.length - maxProfiles + 1)), profile])
    }),
    remove: (profileID: string) => serial(async () => {
      const profiles = await read()
      if (profiles.some((profile) => profile.profileID === profileID))
        await write(profiles.filter((profile) => profile.profileID !== profileID))
    }),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChromeTransportError("invalid")
  return Object.fromEntries(Object.entries(value))
}

function digestOf(credential: string) {
  return createHash("sha256").update(credential).digest()
}

function profileLabel(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || value.trim() !== value ||
    /[\p{Cc}\p{Cf}]/u.test(value)) throw new ChromeTransportError("invalid")
  return value
}

export function makeChromeTransport(options: {
  readonly origin: string
  readonly register: (driver: InteractionDriver) => NativeInteraction
  readonly confirm: (input: ChromeProfileConsent, signal: AbortSignal) => Promise<boolean>
  readonly profiles: string
}) {
  const origin = new URL(options.origin)
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash) throw new ChromeTransportError("not_loopback")
  const profiles = chromeProfiles(options.profiles)
  let current: ReturnType<typeof attachPeer> | undefined
  let enrolling = false
  const peers = new Set<ReturnType<typeof attachPeer>>()
  let closed = false

  function admit(peer: Pick<ChromePeer, "url" | "origin" | "peerAddress">) {
    return !closed && (peer.peerAddress === "127.0.0.1" || peer.peerAddress === "::ffff:127.0.0.1") &&
      peer.origin === `chrome-extension://${chromeExtensionID}` &&
      (peer.url === chromeConnectPath || peer.url === `${origin.origin}${chromeConnectPath}`)
  }

  function attachPeer(peer: ChromePeer) {
    let native: NativeInteraction | undefined
    let profileID: string | undefined
    let stage: "open" | "handshake" | "ready" = "open"
    let ended = false
    let requests = 0
    let unsubscribe: (() => void) | undefined
    const lifetime = new AbortController()
    const offered = new Map<Interaction.ID, InventoryRequest>()
    const answering = new Set<Interaction.ID>()
    const waiting = new Map<Interaction.ID, (error: unknown, value?: unknown) => void>()
    const leases = new Map<Interaction.ID, {
      input: { leaseID: Interaction.ID; sessionID: ConsentProof["sessionID"]; epoch: number; revision: number; pathname: Interaction.Pathname }
      awaitingObservation: boolean
    }>()
    const revoked = new Set<Interaction.ID>()
    let timer = setTimeout(() => disconnect(), deadlineMs)
    timer.unref()

    function send(frame: unknown) {
      if (ended) return false
      const text = JSON.stringify(frame)
      if (Buffer.byteLength(text) <= maxFrame && peer.send(text)) return true
      disconnect()
      return false
    }

    function disconnect(code = 1008) {
      if (ended) return
      ended = true
      clearTimeout(timer)
      lifetime.abort()
      peers.delete(channel)
      if (current === channel) current = undefined
      unsubscribe?.()
      native?.disconnect()
      for (const settle of waiting.values()) settle(new ChromeTransportError("disconnected"))
      offered.clear()
      leases.clear()
      peer.close(code)
    }

    function tellPending(request: InventoryRequest) {
      if (!native || ended || offered.has(request.candidateID)) return
      for (const previous of offered.values()) {
        if (answering.has(previous.candidateID) || previous.expiresAt > Date.now()) continue
        offered.delete(previous.candidateID)
      }
      if (offered.size >= 8) return
      offered.set(request.candidateID, request)
      if (send({ type: "pending", input: request })) void native.inventory(request.candidateID).catch(() => disconnect())
    }

    function invoke(op: string, input: unknown, signal = AbortSignal.timeout(deadlineMs), wait = deadlineMs) {
      if (!native || ended || waiting.size >= 16 || requests >= maxRequests || signal.aborted)
        return Promise.reject(new ChromeTransportError("unavailable"))
      requests++
      const id = Interaction.ID.create()
      const deadline = Date.now() + wait
      return new Promise<unknown>((resolve, reject) => {
        const settle = (error: unknown, value?: unknown) => {
          waiting.delete(id)
          clearTimeout(expiry)
          signal.removeEventListener("abort", abort)
          if (error) reject(error)
          else resolve(value)
        }
        const abort = () => settle(new ChromeTransportError("uncertain"))
        const expiry = setTimeout(abort, wait)
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
          const result = decodeResult(await invoke("perform", { ...live.input, revision, ...command }, signal))
          if (result.outcome !== "paused") return result
          live.awaitingObservation = true
          native?.pause(lease.id, result.reason)
          return result
        } catch (cause) {
          if (!(cause instanceof ChromeTransportError) || ["disconnected", "uncertain"].includes(cause.code))
            return { outcome: "uncertain" }
          if (cause.code === "consent") return { outcome: "refused", reason: "confirmation_required" }
          if (cause.code === "ownership" || cause.code === "stopped") return { outcome: "refused", reason: "target_lost" }
          if (cause.code === "invalid" || cause.code === "unavailable" || cause.code === "paused") return { outcome: "refused", reason: "unsupported" }
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
      async run(lease, script, signal) {
        const live = leases.get(lease.id)
        if (!live || live.awaitingObservation || signal.aborted) return { outcome: "refused", reason: "stale" }
        const runID = Interaction.ID.create()
        const identity = { leaseID: live.input.leaseID, sessionID: live.input.sessionID, epoch: live.input.epoch }
        const cancel = () => { void invoke("cancelRun", { ...identity, runID }).catch(() => {}) }
        live.awaitingObservation = true
        signal.addEventListener("abort", cancel, { once: true })
        const wait = script.timeoutMs + deadlineMs
        try {
          const result = decodeScriptResult(await invoke("run", { ...live.input, runID, mode: script.mode, source: script.source,
            timeoutMs: script.timeoutMs }, AbortSignal.timeout(wait), wait))
          if (result.outcome === "paused") native?.pause(lease.id, result.reason)
          return result
        } catch (cause) {
          if (!(cause instanceof ChromeTransportError) || ["disconnected", "uncertain"].includes(cause.code)) throw cause
          if (cause.code === "ownership" || cause.code === "stopped" || cause.code === "target_lost") return { outcome: "refused", reason: "target_lost" }
          if (cause.code === "paused") return { outcome: "refused", reason: "busy" }
          if (cause.code === "invalid" || cause.code === "unavailable") return { outcome: "refused", reason: "unsupported" }
          return { outcome: "refused", reason: decodeRefusal(cause.code) }
        } finally {
          signal.removeEventListener("abort", cancel)
        }
      },
      async resume(lease, signal) {
        const live = leases.get(lease.id)
        if (!live) return false
        const resumed = await invoke("resume", live.input, signal)
        if (resumed !== true) return false
        live.awaitingObservation = true
        return true
      },
      async detach(lease, reason) {
        const live = leases.get(lease.id)
        if (!live) return
        leases.delete(lease.id)
        await invoke("detach", { ...live.input, reason })
      },
    }

    function ready(id: string, credential?: string) {
      if (ended) return
      if (current && current !== channel && current.profileID() !== id) return disconnect(chromeCloseBusy)
      current?.disconnect()
      profileID = id
      stage = "ready"
      native = options.register(driver)
      current = channel
      clearTimeout(timer)
      if (send({ type: "authenticated", version: 1, ...(credential ? { credential } : {}) })) {
        unsubscribe = native.onPending(tellPending)
        for (const request of native.pending()) tellPending(request)
      }
    }

    async function verified(frame: Record<string, unknown>) {
      if (frame.version !== 1 || frame.extensionID !== chromeExtensionID || typeof frame.profileID !== "string" ||
        !secret.test(frame.profileID) || typeof frame.credential !== "string" || !secret.test(frame.credential)) return undefined
      const stored = await profiles.get(frame.profileID).catch(() => undefined)
      return stored && timingSafeEqual(Buffer.from(stored.digest, "hex"), digestOf(frame.credential)) ? stored : undefined
    }

    async function enroll(frame: Record<string, unknown>) {
      if (frame.version !== 1 || typeof frame.profileID !== "string" || !secret.test(frame.profileID)) throw new ChromeTransportError("invalid")
      const label = profileLabel(frame.profileLabel)
      if (enrolling) return disconnect(chromeCloseBusy)
      enrolling = true
      clearTimeout(timer)
      timer = setTimeout(() => disconnect(chromeCloseRejected), enrollmentMs)
      timer.unref()
      try {
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(enrollmentMs)])
        const allowed = await options.confirm({ profileLabel: label, matchCode: chromeMatchCode(frame.profileID) }, signal).catch(() => false)
        if (!allowed || ended || signal.aborted) return disconnect(chromeCloseRejected)
        const credential = randomBytes(32).toString("base64url")
        await profiles.put({ profileID: frame.profileID, digest: digestOf(credential).toString("hex"), label, created: Date.now() })
        if (ended) {
          await profiles.remove(frame.profileID)
          return
        }
        ready(frame.profileID, credential)
      } finally {
        enrolling = false
      }
    }

    async function handshake(frame: Record<string, unknown>) {
      stage = "handshake"
      if (frame.type === "enroll") return enroll(frame)
      if (frame.type !== "authenticate" && frame.type !== "forget") throw new ChromeTransportError("authentication")
      const stored = await verified(frame)
      if (ended) return
      if (frame.type === "forget") {
        if (stored) await profiles.remove(stored.profileID)
        return disconnect(chromeCloseRejected)
      }
      if (!stored) return disconnect(chromeCloseRejected)
      ready(stored.profileID)
    }

    function lease(frame: Record<string, unknown>) {
      const id = decodeID(frame.leaseID)
      const live = leases.get(id)
      return live && frame.epoch === live.input.epoch ? id : undefined
    }

    async function receive(raw: string) {
      if (ended) return
      try {
        if (typeof raw !== "string" || Buffer.byteLength(raw) > maxFrame) throw new ChromeTransportError("invalid")
        const frame = record(JSON.parse(raw))
        if (stage === "open") return await handshake(frame)
        if (stage !== "ready" || !native || current !== channel) throw new ChromeTransportError("disconnected")
        if (frame.type === "ping") return
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
          const live = leases.get(id)
          if (revoked.size >= maxRequests) throw new ChromeTransportError("invalid")
          if (live && frame.epoch !== live.input.epoch) return
          revoked.add(id)
          if (!live) return
          native.stop(id, frame.reason === "stopped" ? "stopped" : "target_lost")
          return
        }
        if (frame.type === "paused") {
          const reason = decodePauseReason(frame.reason)
          const id = lease(frame)
          if (!id) return
          const live = leases.get(id)
          if (live) live.awaitingObservation = true
          native.pause(id, reason)
          return
        }
        if (frame.type === "resumed") {
          const id = lease(frame)
          if (id) native.resume(id)
          return
        }
        if (frame.type === "capture") {
          const id = lease(frame)
          const capture = record(frame.capture)
          const decoded = decodeFrame(capture.frame)
          if (decoded._tag === "None" || (capture.title !== undefined && typeof capture.title !== "string") ||
            (capture.url !== undefined && typeof capture.url !== "string")) throw new ChromeTransportError("invalid")
          const image = previewFrame(decoded.value.mimeType, decoded.value.base64)
          if (!id || image?.width !== decoded.value.width || image.height !== decoded.value.height) return
          await native.capture(id, { frame: image, title: capture.title, url: capture.url })
          return
        }
        throw new ChromeTransportError("invalid")
      } catch {
        disconnect()
      }
    }

    const channel = { receive, disconnect: () => disconnect(), profileID: () => profileID }
    return channel
  }

  return {
    admit,
    connect(peer: ChromePeer) {
      if (!admit(peer) || peers.size >= 4) throw new ChromeTransportError("authentication")
      const channel = attachPeer(peer)
      peers.add(channel)
      return { receive: channel.receive, disconnect: channel.disconnect }
    },
    close() {
      closed = true
      for (const peer of peers) peer.disconnect()
    },
  }
}
