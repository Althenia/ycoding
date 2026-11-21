import { spawn } from "node:child_process"
import { open } from "node:fs/promises"
import path from "node:path"
import { Interaction } from "@ycoding-ai/schema/interaction"
import type { SessionID } from "@ycoding-ai/schema/session-id"
import { Schema } from "effect"
import type { ConsentProof, InteractionDriver, InventoryRequest, Lease, NativeInteraction } from "./driver"

export const macOSInteractionApplication = "YCoding Interaction.app"
export const macOSInteractionBundleID = "app.ycoding.interaction"
export const macOSInteractionExecutable = "ycoding-interaction"

const maxLine = 1_048_576
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const nativeRevision = /^[0-9a-f]{64}$/
const nativeControlID = /^0(?:\.\d+){0,16}$/
const decodeFrame = Schema.decodeUnknownOption(Interaction.Frame)
const decodePauseReason = Schema.decodeUnknownOption(Interaction.PauseReason)
const matchCode = /^[A-Za-z0-9-]{4,32}$/

type Target = Extract<Interaction.Target, { kind: "macos-window" }>
type MacWindow = { pid: number; bundleID: string; started: string; windowID: number }
type WindowOffer = { target: Target; window: MacWindow }
type Claim = WindowOffer & {
  link: ReturnType<typeof connect>
  lease: Lease
  revision?: { number: number; stamp: string; controls: Map<Interaction.ID, string> }
  paused?: Interaction.PauseReason
  confirmation?: { proof: ConsentProof; revision: number; action: string; receipt: string; expiresAt: number }
  last: number
}
type Wire = Record<string, unknown>
type Operation = "hello" | "inventory" | "choose" | "attach" | "authorize" | "confirmIsolated" | "bindIsolated" | "confirmChromeProfile" |
  "observe" | "perform" | "preview" | "resume" | "detach"
type Pending = { resolve: (reply: Wire) => void; fail: (error: NativeFailure) => void; stop: () => void; operation: Operation }

export interface IsolatedConsentRequest {
  readonly candidateID: Interaction.ID
  readonly sessionID: SessionID
  readonly url: string
  readonly expiresAt: number
}

export interface ChromeProfileConsent {
  readonly profileLabel: string
  readonly matchCode: string
}

export interface IsolatedStop {
  readonly candidateID: Interaction.ID
  readonly signal: AbortSignal
  bind(leaseID: Interaction.ID, signal: AbortSignal): Promise<boolean>
  close(): void
}

class NativeFailure extends Error {
  constructor(readonly code: string, readonly reason?: Interaction.PauseReason) {
    super(`macOS interaction ${code}`)
  }
}

function object(value: unknown): value is Wire {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function label(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 256)
}

function exactWindow(value: unknown): value is MacWindow {
  return object(value) && Number.isInteger(value.pid) && typeof value.pid === "number" && value.pid > 1 && value.pid <= 2_147_483_647 &&
    Number.isInteger(value.windowID) && typeof value.windowID === "number" && value.windowID > 0 && value.windowID <= 4_294_967_295 &&
    typeof value.started === "string" && /^\d{1,18}:\d{1,6}$/.test(value.started) &&
    typeof value.bundleID === "string" && value.bundleID.length <= 256 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.bundleID)
}

function connect(executable: string, onClose: () => void) {
  const generation = Interaction.Generation.create()
  const child = spawn(executable, [], {
    env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    stdio: ["pipe", "pipe", "ignore"],
  })
  const pending = new Map<number, Pending>()
  let next = 0
  let closed = false
  let stopped: string | undefined
  let tail = Buffer.alloc(0)
  let onStop: ((id?: string) => void) | undefined
  let onPause: ((id: string, reason: Interaction.PauseReason) => void) | undefined
  let onResume: ((id: string) => void) | undefined

  function close() {
    if (closed) return
    closed = true
    child.stdin.destroy()
    child.stdout.destroy()
    child.kill()
    for (const waiter of pending.values()) {
      waiter.stop()
      waiter.fail(new NativeFailure(waiter.operation === "perform" ? "uncertain" : "unavailable"))
    }
    pending.clear()
    onClose()
    onStop?.(stopped)
  }

  function consume(line: Buffer) {
    try {
      const reply: unknown = JSON.parse(line.toString("utf8"))
      if (!object(reply) || typeof reply.generation !== "string" || reply.generation.toLowerCase() !== generation) return close()
      if (reply.state === "stopped" && reply.id === undefined && typeof reply.lease === "string" && uuid.test(reply.lease)) {
        stopped = reply.lease.toLowerCase()
        onStop?.(stopped)
        return
      }
      if (reply.state === "resumed" && reply.id === undefined && typeof reply.lease === "string" && uuid.test(reply.lease)) {
        onResume?.(reply.lease.toLowerCase())
        return
      }
      const waiter = typeof reply.id === "number" ? pending.get(reply.id) : undefined
      if (!waiter || typeof reply.id !== "number") return close()
      pending.delete(reply.id)
      waiter.stop()
      if (reply.state === "ok") return waiter.resolve(reply)
      if (reply.state === "paused") {
        const reason = decodePauseReason(reply.reason)
        if (reason._tag === "None" || typeof reply.lease !== "string" || !uuid.test(reply.lease)) {
          waiter.fail(new NativeFailure(waiter.operation === "perform" ? "uncertain" : "unavailable"))
          return close()
        }
        onPause?.(reply.lease.toLowerCase(), reason.value)
        return waiter.fail(new NativeFailure("paused", reason.value))
      }
      if (reply.state === "uncertain") return waiter.fail(new NativeFailure("uncertain"))
      if (reply.state === "refused" && typeof reply.code === "string" && /^[A-Za-z]{1,40}$/.test(reply.code)) {
        return waiter.fail(new NativeFailure(reply.code))
      }
      waiter.fail(new NativeFailure(waiter.operation === "perform" ? "uncertain" : "unavailable"))
      close()
    } catch { close() }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    let start = 0
    while (!closed && start < chunk.length) {
      const end = chunk.indexOf(10, start)
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end)
      if (tail.length + piece.length > maxLine) return close()
      tail = Buffer.concat([tail, piece])
      if (end === -1) return
      consume(tail)
      tail = Buffer.alloc(0)
      start = end + 1
    }
  })
  child.stdout.once("end", close)
  child.stdout.once("error", close)
  child.stdin.once("error", close)
  child.once("error", close)
  child.once("exit", close)

  function request(operation: Operation, body: Wire, signal: AbortSignal) {
    if (signal.aborted || closed) return Promise.reject(new NativeFailure("stopped"))
    if (next === 4_294_967_295 || pending.size >= 4) return Promise.reject(new NativeFailure("busy"))
    const id = ++next
    const payload = Buffer.from(`${JSON.stringify({ ...body, id, generation, operation })}\n`)
    if (payload.length > maxLine) return Promise.reject(new NativeFailure("invalidRequest"))
    return new Promise<Wire>((resolve, fail) => {
      pending.set(id, { resolve, fail, operation, stop: () => signal.removeEventListener("abort", close) })
      signal.addEventListener("abort", close, { once: true })
      child.stdin.write(payload, (error) => { if (error) close() })
      if (signal.aborted) close()
    })
  }

  return { close, request, pid: child.pid, alive: () => !closed && !stopped,
    onPause: (listener: (id: string, reason: Interaction.PauseReason) => void) => { onPause = listener },
    onResume: (listener: (id: string) => void) => { onResume = listener },
    onStop: (listener: (id?: string) => void) => {
    onStop = listener
    if (closed || stopped) listener(stopped)
  } }
}

function wireAction(action: Interaction.MacOSAction, revision: NonNullable<Claim["revision"]>): Wire {
  if (action.type === "scroll") return { action: "scroll", deltaY: action.deltaY }
  const controlID = revision.controls.get(action.elementID)
  if (!controlID) throw new NativeFailure("staleRevision")
  return action.type === "press" ? { action: "press", controlID, destructive: action.destructive }
    : { action: "replaceText", controlID, text: action.text, destructive: action.destructive }
}

function refusal(code: string): Interaction.Refusal {
  switch (code) {
    case "staleRevision": case "stopped": return "stale"
    case "sensitive": return "sensitive"
    case "captcha": return "captcha"
    case "permissionMissing": case "notAuthorized": return "permission"
    case "targetChanged": case "unavailable": return "target_lost"
    case "confirmationRequired": return "confirmation_required"
    case "busy": case "paused": return "busy"
    case "unsupported": case "unverified": return "unsupported"
    default: return "policy"
  }
}

export function makeMacOSInteraction(options: { readonly application: string; readonly certificateSHA1: string }) {
  if (process.platform !== "darwin" || !path.isAbsolute(options.application) ||
      path.basename(options.application) !== macOSInteractionApplication || !/^[a-f0-9]{40}$/i.test(options.certificateSHA1)) {
    throw new NativeFailure("unavailable")
  }
  const requirement = `identifier "${macOSInteractionBundleID}" and certificate leaf = H"${options.certificateSHA1.toLowerCase()}"`
  return makeMacOSAdapter({
    application: options.application,
    executable: path.join(options.application, "Contents", "MacOS", macOSInteractionExecutable),
    verify: (subject, signal) => new Promise<boolean>((settle) => {
      const verifier = spawn("/usr/bin/codesign", ["--verify", "--strict", "--verbose=1", "-R", `=${requirement}`, subject], {
        env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, signal, stdio: "ignore",
      })
      verifier.once("error", () => settle(false))
      verifier.once("exit", (code) => settle(code === 0))
    }),
  })
}

export function makeMacOSAdapter(options: {
  readonly application: string
  readonly executable: string
  readonly verify: (subject: string, signal: AbortSignal) => Promise<boolean>
}) {
  const connections = new Set<ReturnType<typeof connect>>()
  const claims = new Map<Interaction.ID, Claim>()
  const identities = new Map<string, Interaction.ID>()
  const offered = new Map<Interaction.ID, { request: InventoryRequest; offers: ReadonlyMap<Interaction.ID, WindowOffer> }>()
  const prepared = new Map<string, { claim: Claim; proof: ConsentProof }>()
  const approving = new Set<Interaction.ID>()
  const isolated = new Map<SessionID, AbortController>()
  const isolatedCandidates = new Map<Interaction.ID, number>()
  const choosing = new Map<SessionID, { candidateID: Interaction.ID; abort: AbortController }>()
  let closed = false

  async function start(signal: AbortSignal) {
    if (closed || signal.aborted) throw new NativeFailure("stopped")
    const file = await open(options.executable, "r")
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile()) throw new NativeFailure("unavailable")
      const verified = await options.verify(options.application, signal)
      const current = await open(options.executable, "r")
      try {
        const after = await current.stat({ bigint: true })
        if (!verified || closed || signal.aborted || before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || before.ctimeNs !== after.ctimeNs) throw new NativeFailure("unavailable")
        const link = connect(options.executable, () => connections.delete(link))
        connections.add(link)
        try {
          if (!link.pid || !(await options.verify(String(link.pid), signal)) || !link.alive()) throw new NativeFailure("unavailable")
          await link.request("hello", { version: 1, ownerPID: process.pid }, signal)
          return link
        } catch (error) {
          link.close()
          throw error
        }
      } finally { await current.close() }
    } finally { await file.close() }
  }

  const driver: InteractionDriver = {
    platform: "macos",
    async inventory(request) {
      if (request.expiresAt <= Date.now() || closed) return []
      for (const [id, value] of offered) if (value.request.expiresAt <= Date.now()) offered.delete(id)
      const claim = request.purpose === "confirm" ? Array.from(claims.values()).find((value) => value.target.id === request.targetID &&
        value.revision?.number === request.revision && value.link.alive()) : undefined
      const windows: WindowOffer[] = []
      if (request.purpose === "confirm") {
        if (claim) windows.push({ target: claim.target, window: claim.window })
      } else {
        if (request.selection.platform !== "macos") return []
        const signal = AbortSignal.timeout(Math.max(1, Math.min(9_000, request.expiresAt - Date.now())))
        const link = await start(signal)
        try {
          const reply = await link.request("inventory", {}, signal)
          if (!Array.isArray(reply.targets) || reply.targets.length > 64) throw new NativeFailure("unavailable")
          for (const entry of reply.targets) {
            if (!object(entry) || !exactWindow(entry.target) || typeof entry.label !== "string") continue
            const window = entry.target
            const key = `${window.pid}:${window.started}:${window.bundleID}:${window.windowID}`
            const id = identities.get(key) ?? Interaction.ID.create()
            identities.set(key, id)
            windows.push({ window, target: { id, kind: "macos-window", label: label(`${entry.label} · Window ${window.windowID}`), bundleID: window.bundleID } })
          }
        } finally { link.close() }
      }
      offered.set(request.candidateID, { request, offers: new Map(windows.map((value) => [value.target.id, value])) })
      const currentIDs = new Set([...Array.from(offered.values()).flatMap((value) => Array.from(value.offers.keys())),
        ...Array.from(claims.values(), (value) => value.target.id)])
      for (const [key, id] of identities) if (!currentIDs.has(id)) identities.delete(key)
      return windows.map((value) => value.target)
    },
    async attach(target, proof, signal) {
      const ready = prepared.get(proof.authorization)
      if (!ready || signal.aborted || !ready.claim.link.alive() || target.kind !== "macos-window" ||
          ready.claim.target.id !== target.id || ready.claim.target.bundleID !== target.bundleID ||
          ready.proof.candidateID !== proof.candidateID || ready.proof.targetID !== proof.targetID || ready.proof.sessionID !== proof.sessionID) {
        throw new NativeFailure("notAuthorized")
      }
      prepared.delete(proof.authorization)
      claims.set(ready.claim.lease.id, ready.claim)
      return ready.claim.lease
    },
    async observe(lease, signal) {
      const claim = claims.get(lease.id)
      if (!claim) throw new NativeFailure("targetChanged")
      if (claim.paused) throw new NativeFailure("paused", claim.paused)
      claim.revision = undefined
      claim.confirmation = undefined
      const reply = await claim.link.request("observe", { target: claim.window, lease: lease.id }, signal)
      const observation = reply.observation
      if (!claim.link.alive() || signal.aborted || !object(observation) || typeof observation.revision !== "string" ||
          !nativeRevision.test(observation.revision) || !Array.isArray(observation.controls) || observation.controls.length > 200) {
        throw new NativeFailure("unavailable")
      }
      const controls = new Map<Interaction.ID, string>()
      const elements = observation.controls.map((control: unknown) => {
        if (!object(control) || typeof control.id !== "string" || !nativeControlID.test(control.id) ||
            typeof control.role !== "string" || typeof control.label !== "string" || !Array.isArray(control.actions)) {
          throw new NativeFailure("unavailable")
        }
        const id = Interaction.ID.create()
        controls.set(id, control.id)
        return { id, role: label(control.role), label: label(control.label), editable: control.actions.includes("replaceText") }
      })
      const revision = ++claim.last
      claim.revision = { number: revision, stamp: observation.revision, controls }
      return { revision, elements }
    },
    async perform(lease, revision, command, signal) {
      const claim = claims.get(lease.id)
      if (claim?.paused) return { outcome: "paused", reason: claim.paused }
      const current = claim?.revision
      if (!claim || !current || current.number !== revision || signal.aborted || !claim.link.alive()) return { outcome: "refused", reason: "stale" }
      if (command.action.platform !== "macos") return { outcome: "refused", reason: "policy" }
      const confirmation = claim.confirmation
      const consent = command.consent
      if ((command.action.type === "press" || command.action.destructive) && (!confirmation || !consent ||
          consent.authorization !== confirmation.proof.authorization || consent.candidateID !== confirmation.proof.candidateID ||
          consent.sessionID !== confirmation.proof.sessionID || consent.targetID !== confirmation.proof.targetID ||
          confirmation.revision !== revision || confirmation.expiresAt <= Date.now() || confirmation.action !== JSON.stringify(command.action))) {
        return { outcome: "refused", reason: "confirmation_required" }
      }
      try {
        const fields = wireAction(command.action, current)
        claim.revision = undefined
        claim.confirmation = undefined
        await claim.link.request("perform", { ...fields, target: claim.window, lease: lease.id,
          revision: current.stamp, authorization: confirmation?.receipt }, signal)
        return signal.aborted || !claim.link.alive() ? { outcome: "uncertain" } : { outcome: "applied" }
      } catch (error) {
        const code = error instanceof NativeFailure ? error.code : "uncertain"
        if (error instanceof NativeFailure && error.reason) return claim.paused ? { outcome: "paused", reason: claim.paused } : { outcome: "refused", reason: "stale" }
        if (code === "confirmationRequired" && claim.link.alive() && !signal.aborted) claim.revision = current
        return code === "uncertain" ? { outcome: "uncertain" } : { outcome: "refused", reason: refusal(code) }
      }
    },
    async preview(lease, signal) {
      const claim = claims.get(lease.id)
      if (!claim || claim.paused || !claim.link.alive() || signal.aborted) return undefined
      const reply = await claim.link.request("preview", { target: claim.window, lease: lease.id }, signal).catch(() => undefined)
      if (signal.aborted || claims.get(lease.id) !== claim || !claim.link.alive() || typeof reply?.lease !== "string" ||
          reply.lease.toLowerCase() !== lease.id || !object(reply.preview)) return undefined
      const frame = decodeFrame({ mimeType: "image/jpeg", base64: reply.preview.image, width: reply.preview.width, height: reply.preview.height })
      return frame._tag === "Some" ? frame.value : undefined
    },
    async resume(lease, signal) {
      const claim = claims.get(lease.id)
      if (!claim || !claim.link.alive() || signal.aborted) return false
      const reply = await claim.link.request("resume", { lease: lease.id }, signal).catch(() => undefined)
      if (!reply || signal.aborted || claims.get(lease.id) !== claim || !claim.link.alive() ||
          typeof reply.lease !== "string" || reply.lease.toLowerCase() !== lease.id) return false
      claim.paused = undefined
      return true
    },
    async detach(lease) {
      const claim = claims.get(lease.id)
      if (!claim) return
      claims.delete(lease.id)
      claim.revision = undefined
      claim.confirmation = undefined
      try {
        if (claim.link.alive()) await claim.link.request("detach", { lease: lease.id }, AbortSignal.timeout(1_500))
      } finally { claim.link.close() }
    },
  }

  async function approve(native: NativeInteraction, candidateID: Interaction.ID, targetID: Interaction.ID, signal?: AbortSignal) {
    const entry = offered.get(candidateID)
    const selection = entry?.offers.get(targetID)
    const request = entry?.request
    if (!selection || !request || closed || signal?.aborted || request.expiresAt <= Date.now() || approving.has(candidateID) ||
        !native.pending().some((pending) => pending.candidateID === candidateID && pending.sessionID === request.sessionID)) return false
    const remaining = request.expiresAt - Date.now()
    if (remaining <= 0) return false
    const scoped = AbortSignal.any([AbortSignal.timeout(Math.min(60_000, remaining)), ...(signal ? [signal] : [])])
    const proof = { candidateID, sessionID: request.sessionID, targetID, authorization: crypto.randomUUID() }
    approving.add(candidateID)
    try {
      if (request.purpose === "confirm") {
        const current = Array.from(claims.values()).find((value) => value.target.id === targetID)
        const revision = current?.revision
        if (!current || !revision || revision.number !== request.revision || request.action.platform !== "macos" || !current.link.alive()) return false
        const reply = await current.link.request("authorize", { ...wireAction(request.action, revision), target: current.window,
          lease: current.lease.id, revision: revision.stamp }, scoped)
        if (scoped.aborted || !current.link.alive() || current.revision !== revision || typeof reply.authorization !== "string" || !uuid.test(reply.authorization)) return false
        current.confirmation = { proof, action: JSON.stringify(request.action), revision: revision.number, receipt: reply.authorization, expiresAt: request.expiresAt }
        const approved = await native.approve(proof)
        if (!approved && current.confirmation?.proof === proof) current.confirmation = undefined
        return approved
      }
      const link = await start(scoped)
      try {
        const reply = await link.request("attach", { target: selection.window }, scoped)
        if (!link.alive() || scoped.aborted || typeof reply.lease !== "string" || !uuid.test(reply.lease)) return false
        const lease = { id: Interaction.ID.make(reply.lease.toLowerCase()) }
        const claim: Claim = { ...selection, link, lease, last: 0 }
        link.onStop((stopped) => {
          if (claims.get(lease.id) !== claim) return
          claims.delete(lease.id)
          native.stop(lease.id, stopped === lease.id ? "stopped" : "target_lost")
          link.close()
        })
        link.onPause((id, reason) => {
          if (id !== lease.id || claims.get(lease.id) !== claim) return
          claim.paused = reason
          claim.revision = undefined
          claim.confirmation = undefined
          native.pause(lease.id, reason)
        })
        link.onResume((id) => {
          if (id !== lease.id || claims.get(lease.id) !== claim || !claim.paused) return
          claim.paused = undefined
          native.resume(lease.id)
        })
        prepared.set(proof.authorization, { claim, proof })
        const accepted = await native.approve(proof)
        return accepted && claims.get(lease.id) === claim && link.alive()
      } finally {
        prepared.delete(proof.authorization)
        if (!Array.from(claims.values()).some((claim) => claim.link === link)) link.close()
      }
    } catch { return false } finally {
      approving.delete(candidateID)
      if (offered.get(candidateID) === entry) offered.delete(candidateID)
    }
  }

  async function choose(request: InventoryRequest, targets: readonly Interaction.Target[], signal: AbortSignal): Promise<Interaction.ID | undefined> {
    const entry = offered.get(request.candidateID)
    const remaining = request.expiresAt - Date.now()
    if (closed || signal.aborted || !entry || entry.request.sessionID !== request.sessionID || entry.request.purpose !== request.purpose ||
        entry.request.expiresAt !== request.expiresAt || remaining <= 0 || remaining > 60_000 || !targets.length || targets.length > 64) return undefined
    const selected = targets.flatMap((target) => {
      const offer = entry.offers.get(target.id)
      return target.kind === "macos-window" && offer && target.bundleID === offer.target.bundleID ? [{ id: target.id, target: offer.window }] : []
    })
    if (selected.length !== targets.length || new Set(selected.map((window) => window.id)).size !== selected.length) return undefined
    if (request.purpose === "confirm") return selected.length === 1 && selected[0].id === request.targetID ? selected[0].id : undefined
    if (request.selection.platform !== "macos") return undefined
    const previous = choosing.get(request.sessionID)
    if (previous?.candidateID === request.candidateID) return undefined
    previous?.abort.abort()
    const owner = { candidateID: request.candidateID, abort: new AbortController() }
    choosing.set(request.sessionID, owner)
    const scoped = AbortSignal.any([signal, owner.abort.signal, AbortSignal.timeout(remaining)])
    try {
      const link = await start(scoped)
      try {
        const reply = await link.request("choose", { choices: { candidateID: request.candidateID, sessionID: request.sessionID,
          expiresAt: request.expiresAt, windows: selected } }, scoped)
        if (closed || scoped.aborted || Date.now() >= request.expiresAt || choosing.get(request.sessionID) !== owner ||
            offered.get(request.candidateID) !== entry || typeof reply.selected !== "string") return undefined
        const id = reply.selected.toLowerCase()
        return selected.find((target) => target.id === id)?.id
      } finally { link.close() }
    } catch { return undefined } finally {
      if (choosing.get(request.sessionID) === owner) choosing.delete(request.sessionID)
    }
  }

  async function confirmIsolated(input: IsolatedConsentRequest, signal: AbortSignal): Promise<IsolatedStop | undefined> {
    const request = { candidateID: input.candidateID, sessionID: input.sessionID, url: input.url, expiresAt: input.expiresAt }
    const now = Date.now()
    const remaining = request.expiresAt - now
    if (closed || signal.aborted || !Number.isSafeInteger(request.expiresAt) || remaining <= 0 || remaining > 60_000 ||
        !uuid.test(request.candidateID) || !/^ses[A-Za-z0-9_-]{0,125}$/.test(request.sessionID) ||
        request.url.length > 2048 || !/^https?:\/\/[\x21-\x7e]+$/.test(request.url) || request.url.includes("\\") || !URL.canParse(request.url)) return undefined
    const url = new URL(request.url)
    if (url.href !== request.url || url.username || url.password) return undefined
    for (const [candidateID, expiry] of isolatedCandidates) if (expiry <= now) isolatedCandidates.delete(candidateID)
    if (isolatedCandidates.has(request.candidateID)) return undefined
    isolatedCandidates.set(request.candidateID, request.expiresAt)
    isolated.get(request.sessionID)?.abort("target_lost")
    const owner = new AbortController()
    isolated.set(request.sessionID, owner)
    const pending = AbortSignal.any([signal, AbortSignal.timeout(remaining)])
    const expire = () => owner.abort("target_lost")
    pending.addEventListener("abort", expire, { once: true })
    owner.signal.addEventListener("abort", () => {
      pending.removeEventListener("abort", expire)
      if (isolated.get(request.sessionID) === owner) isolated.delete(request.sessionID)
    }, { once: true })
    let retained = false
    try {
      const link = await start(owner.signal)
      if (owner.signal.aborted) { link.close(); return undefined }
      let binding: Interaction.ID | undefined
      owner.signal.addEventListener("abort", link.close, { once: true })
      link.onStop((id) => owner.abort(id !== undefined && (id === request.candidateID || id === binding) ? "stopped" : "target_lost"))
      const reply = await link.request("confirmIsolated", { isolated: request }, owner.signal)
      if (owner.signal.aborted || !link.alive() || Date.now() >= request.expiresAt || reply.consent !== "approved" ||
          typeof reply.candidateID !== "string" || reply.candidateID.toLowerCase() !== request.candidateID) return undefined
      retained = true
      return {
        candidateID: request.candidateID,
        signal: owner.signal,
        async bind(leaseID, attaching) {
          if (binding !== undefined || owner.signal.aborted) return false
          if (Date.now() >= request.expiresAt || attaching.aborted || !uuid.test(leaseID)) { expire(); return false }
          binding = leaseID
          const scoped = AbortSignal.any([owner.signal, attaching])
          try {
            const result = await link.request("bindIsolated", { candidateID: request.candidateID, lease: leaseID }, scoped)
            if (!scoped.aborted && link.alive() && Date.now() < request.expiresAt &&
                typeof result.candidateID === "string" && result.candidateID.toLowerCase() === request.candidateID &&
                typeof result.lease === "string" && result.lease.toLowerCase() === leaseID) {
              pending.removeEventListener("abort", expire)
              return true
            }
          } catch {
            expire()
            return false
          }
          expire()
          return false
        },
        close: () => owner.abort("stopped"),
      }
    } catch { return undefined } finally {
      if (!retained) expire()
    }
  }

  async function available(signal: AbortSignal) {
    try {
      const link = await start(AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
      link.close()
      return true
    } catch { return false }
  }

  async function confirmChromeProfile(input: ChromeProfileConsent, signal: AbortSignal) {
    const profile = { profileLabel: input.profileLabel, matchCode: input.matchCode, expiresAt: Date.now() + 60_000 }
    if (closed || signal.aborted || !profile.profileLabel || profile.profileLabel.length > 128 || label(profile.profileLabel) !== profile.profileLabel ||
        profile.profileLabel.trim() !== profile.profileLabel || !matchCode.test(profile.matchCode)) return false
    const scoped = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
    try {
      const link = await start(scoped)
      try {
        const reply = await link.request("confirmChromeProfile", { profile }, scoped)
        return !scoped.aborted && link.alive() && Date.now() < profile.expiresAt && reply.consent === "approved"
      } finally { link.close() }
    } catch { return false }
  }

  return { driver, choose, approve, confirmIsolated, confirmChromeProfile, available, close() {
    closed = true
    for (const owner of isolated.values()) owner.abort("target_lost")
    for (const owner of choosing.values()) owner.abort.abort()
    for (const link of connections) link.close()
    choosing.clear()
    isolated.clear()
    isolatedCandidates.clear()
    prepared.clear()
    offered.clear()
    identities.clear()
  } }
}
