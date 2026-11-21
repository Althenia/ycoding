import { Interaction } from "@ycoding-ai/schema/interaction"
import type { SessionID } from "@ycoding-ai/schema/session-id"
import { Schema } from "effect"
import { previewFrame } from "../../../../extensions/interaction-chrome/page.js"
import { redactText, redactURL } from "../../../../extensions/interaction-chrome/redact.js"
import { ComputerPolicy } from "../computer/policy"
import type { CaptureInput, ConsentProof, InteractionDriver, InteractionDriverKey, InventoryRequest, Lease, NativeInteraction } from "./driver"

type StopState = Extract<Interaction.Status, { state: "stopped" }>
export type AdmittedCapture = {
  readonly label: string
  readonly frame: Interaction.Frame
  readonly title?: string
  readonly url?: string
}
const publicTargetLabels = {
  "chrome-tab": "Selected Chrome tab",
  "chrome-owned": "Background Chrome tab",
  "chrome-isolated": "Temporary isolated Chrome",
  "macos-window": "Selected macOS window",
} satisfies Record<Interaction.Target["kind"], string>

type Candidate = {
  request: InventoryRequest
  targets: ReadonlyMap<Interaction.ID, Interaction.Target>
  inventoryBusy: boolean
  proof?: ConsentProof
}
type Entry = {
  sessionID: SessionID
  driver: InteractionDriver
  driverKey: InteractionDriverKey
  generation: Interaction.Generation
  status: Exclude<Interaction.Status, { state: "unavailable" }>
  controller: AbortController
  expiry: ReturnType<typeof setTimeout>
  candidate?: Candidate
  sessionLabel: string
  target?: Interaction.Target
  lease?: Lease
  revision?: number
  lastRevision?: number
  busy: boolean
  previewing: boolean
  capturing: boolean
  calls: Set<Interaction.ID>
}

const strict = { onExcessProperty: "error" } as const
const decodeObservation = Schema.decodeUnknownOption(Interaction.Observation, strict)
const decodeAction = Schema.decodeUnknownOption(Interaction.Action, strict)
const decodeResult = Schema.decodeUnknownOption(Interaction.ActionResult, strict)
const decodeTarget = Schema.decodeUnknownOption(Interaction.Target, strict)
const decodeFrame = Schema.decodeUnknownOption(Interaction.Frame, strict)
const decodeID = Schema.decodeUnknownOption(Interaction.ID)
const decodeRequest = Schema.decodeUnknownOption(Interaction.Request, strict)
const decodePauseReason = Schema.decodeUnknownOption(Interaction.PauseReason)
const decodeCapture = Schema.decodeUnknownOption(Interaction.Capture, strict)
const decodeScript = Schema.decodeUnknownOption(Interaction.ScriptRequest, strict)
const decodeScriptResult = Schema.decodeUnknownOption(Interaction.ScriptResult, strict)
const unsupportedActionConsent = { outcome: "refused", reason: "unsupported" } as const

export class InteractionError extends Error {
  constructor(readonly code: "stale" | "busy" | "unavailable" | "paused" | "uncertain") {
    super(`Interaction ${code}`)
  }
}

function allowsTarget(platform: Interaction.Platform, target: Interaction.Target) {
  if (target.kind !== "macos-window") return platform === "chrome" && URL.canParse(target.origin) &&
    new URL(target.origin).origin === target.origin && new URL(target.origin + target.pathname).pathname === target.pathname
  if (platform !== "macos") return false
  if (ComputerPolicy.isPrivateInteractionBundle(target.bundleID)) return false
  const bundle = target.bundleID.toLowerCase()
  if (/^(?:com\.google\.chrome|org\.chromium\.chromium|app\.ycoding\.computer-use)(?:\.|$)/.test(bundle)) return false
  return !ComputerPolicy.forbiddenBundleIDs.some((id) => id === bundle) &&
    !ComputerPolicy.elevatedBundleIDs.some((id) => id.toLowerCase() === bundle)
}

export function makeAuthority(options: {
  readonly currentlyUsable?: (sessionID: SessionID) => Promise<boolean>
  readonly callTimeoutMs?: number
  readonly changed?: (sessionID: SessionID, generation: Interaction.Generation) => void
  readonly sessionLabel?: (sessionID: SessionID) => Promise<string>
} = {}) {
  const entries = new Map<SessionID, Entry>()
  const drivers = new Map<InteractionDriverKey, InteractionDriver>()
  const listeners = new Map<InteractionDriverKey, Parameters<NativeInteraction["onPending"]>[0]>()
  const targets = new Map<string, Entry>()
  const callTimeoutMs = options.callTimeoutMs ?? 10_000
  const candidateTtlMs = 60_000
  const grantTtlMs = 15 * 60_000
  const maxSessions = 128
  const maxCallsPerGrant = 512
  let closed = false
  let admission: CaptureAdmission | undefined

  const live = (entry: Entry) => entries.get(entry.sessionID) === entry && !entry.controller.signal.aborted &&
    drivers.get(entry.driverKey) === entry.driver

  function notify(entry: Entry, request: InventoryRequest) {
    queueMicrotask(() => {
      if (!live(entry) || entry.candidate?.request !== request) return
      try {
        listeners.get(entry.driverKey)?.(request, entry.controller.signal)
      } catch {
        retire(entry, "disconnected")
      }
    })
  }

  function retire(entry: Entry, reason: Interaction.StopReason) {
    if (entry.status.state === "stopped") return false
    entry.status = { state: "stopped", platform: entry.driver.platform, generation: entry.generation, reason,
      cleanup: entry.target ? "pending" : "complete" }
    entry.revision = undefined
    entry.candidate = undefined
    clearTimeout(entry.expiry)
    entry.controller.abort()
    options.changed?.(entry.sessionID, entry.generation)
    if (entry.lease) detach(entry, entry.lease, reason)
    return true
  }

  function targetKey(entry: Entry, target: Interaction.Target) {
    return `${entry.driverKey}:${target.id}`
  }

  function finish(entry: Entry, cleanup: StopState["cleanup"]) {
    if (entry.status.state === "stopped" && entry.status.cleanup !== cleanup) {
      entry.status = { ...entry.status, cleanup }
      if (entries.get(entry.sessionID) === entry) options.changed?.(entry.sessionID, entry.generation)
    }
    if (cleanup === "complete" && entry.target && targets.get(targetKey(entry, entry.target)) === entry)
      targets.delete(targetKey(entry, entry.target))
  }

  function detach(entry: Entry, lease: Lease, reason: Interaction.StopReason) {
    const pending = Promise.resolve().then(() => entry.driver.detach(lease, reason))
    void bounded(AbortSignal.timeout(callTimeoutMs), () => pending).then(
      () => finish(entry, "complete"),
      () => finish(entry, "failed"),
    )
    void pending.then(() => finish(entry, "complete"), () => undefined)
  }

  function active(sessionID: SessionID, generation: Interaction.Generation, states: readonly Interaction.Status["state"][] = ["active"]) {
    const entry = entries.get(sessionID)
    return entry?.generation === generation && states.includes(entry.status.state) && entry.target && entry.lease && live(entry)
      ? { entry, lease: entry.lease, target: entry.target, pathname: entry.target.kind === "macos-window" ? undefined : entry.target.pathname }
      : undefined
  }

  function paused(sessionID: SessionID, generation: Interaction.Generation) {
    const status = active(sessionID, generation, ["paused"])?.entry.status
    return status?.state === "paused" ? status : undefined
  }

  function pause(entry: Entry, reason: Interaction.PauseReason) {
    const status = entry.status
    if (!entry.lease || !live(entry) || (status.state !== "active" && status.state !== "paused")) return false
    if (status.state === "paused" && status.reason === reason) return true
    entry.status = { state: "paused", platform: status.platform, generation: status.generation, label: status.label, reason }
    entry.revision = undefined
    options.changed?.(entry.sessionID, entry.generation)
    return true
  }

  function unpause(entry: Entry) {
    const status = entry.status
    if (!live(entry) || status.state !== "paused") return false
    entry.status = { state: "active", platform: status.platform, generation: status.generation, label: status.label }
    options.changed?.(entry.sessionID, entry.generation)
    return true
  }

  async function capture(entry: Entry, leaseID: Interaction.ID, input: CaptureInput) {
    const captured = admission
    const status = entry.status
    if (!captured || entry.capturing || !active(entry.sessionID, entry.generation, ["active", "paused"]) ||
      (status.state !== "active" && status.state !== "paused")) return false
    const decoded = decodeFrame(input?.frame)
    const frame = decoded._tag === "Some" ? previewFrame(decoded.value.mimeType, decoded.value.base64) : undefined
    if (!frame || decoded._tag === "None" || frame.width !== decoded.value.width || frame.height !== decoded.value.height) return false
    const safe = (field: { title: string } | { url: string }) => decodeCapture({ generation: entry.generation, frame, ...field })._tag === "Some"
    const title = typeof input.title === "string" ? boundedLabel(redactText(input.title)) : ""
    const url = typeof input.url === "string" ? redactURL(input.url) : undefined
    const admitted: AdmittedCapture = { label: status.label, frame,
      ...(title && safe({ title }) ? { title } : {}),
      ...(typeof url === "string" && safe({ url }) ? { url } : {}),
    }
    entry.capturing = true
    try {
      const usable = await (options.currentlyUsable?.(entry.sessionID) ?? Promise.resolve(true)).catch(() => false)
      if (!usable) {
        retire(entry, "permission")
        return false
      }
      if (entry.lease?.id !== leaseID || !active(entry.sessionID, entry.generation, ["active", "paused"])) return false
      return await captured(entry.sessionID, entry.generation, admitted).then(() => true, () => false)
    } finally {
      entry.capturing = false
    }
  }

  async function resume(sessionID: SessionID, generation: Interaction.Generation, signal?: AbortSignal) {
    const current = active(sessionID, generation, ["paused"])
    if (!current) return false
    const { entry, lease } = current
    const scoped = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(callTimeoutMs), ...(signal ? [signal] : [])])
    const resumed = await bounded(scoped, () => entry.driver.resume(lease, scoped)).catch(() => false)
    if (!resumed) return false
    unpause(entry)
    return live(entry) && entry.status.state === "active"
  }

  async function request(sessionID: SessionID, input: Interaction.Request): Promise<Interaction.Status> {
    const checked = decodeRequest(input)
    if (checked._tag === "None") return { state: "unavailable" }
    if (typeof checked.value.url === "string" && !URL.canParse(checked.value.url)) return { state: "unavailable" }
    const selection = typeof checked.value.url === "string" ? { ...checked.value, url: new URL(checked.value.url).href } : checked.value
    const platform = selection.platform
    const prior = entries.get(sessionID)
    if (prior && (prior.status.state !== "stopped" || prior.status.cleanup === "pending")) return prior.status
    const driverKey = selection.mode === "isolated" ? "chrome-isolated" : platform
    const driver = drivers.get(driverKey)
    if (!driver || closed) return { state: "unavailable" }
    if (!prior && entries.size >= maxSessions) {
      const terminal = Array.from(entries.values()).find((entry) => entry.status.state === "stopped" && entry.status.cleanup !== "pending")
      if (!terminal) return { state: "unavailable" }
      entries.delete(terminal.sessionID)
    }
    const generation = Interaction.Generation.create()
    const expiresAt = Date.now() + candidateTtlMs
    const expiry = setTimeout(() => retire(entry, "expired"), candidateTtlMs)
    expiry.unref()
    const entry: Entry = {
      sessionID, generation, driver, driverKey, status: { state: "pending", generation, platform }, expiry, sessionLabel: "",
      controller: new AbortController(), busy: false, previewing: false, capturing: false, calls: new Set(),
    }
    entries.set(sessionID, entry)
    options.changed?.(sessionID, generation)
    const sessionLabel = await Promise.resolve().then(() => options.sessionLabel?.(sessionID) ?? "").then(boundedLabel, () => undefined)
    if (sessionLabel === undefined) {
      retire(entry, "permission")
      return entry.status
    }
    if (!live(entry) || entry.status.state !== "pending") return entry.status
    entry.sessionLabel = sessionLabel
    const candidate: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID, sessionLabel, purpose: "attach", selection, expiresAt }
    entry.candidate = { request: candidate, targets: new Map(), inventoryBusy: false }
    notify(entry, candidate)
    return entry.status
  }

  function status(sessionID: SessionID): Interaction.Status {
    return entries.get(sessionID)?.status ?? { state: "unavailable" }
  }

  function stop(sessionID: SessionID, generation: Interaction.Generation) {
    const entry = entries.get(sessionID)
    return entry?.generation === generation && retire(entry, "stopped")
  }

  function revoke(sessionID: SessionID) {
    const entry = entries.get(sessionID)
    if (entry) retire(entry, "permission")
  }

  function register(driver: InteractionDriver, key: InteractionDriverKey = driver.platform): NativeInteraction {
    if (closed) throw new InteractionError("unavailable")
    if (key !== driver.platform && (key !== "chrome-isolated" || driver.platform !== "chrome")) throw new InteractionError("unavailable")
    if (drivers.has(key)) throw new InteractionError("busy")
    drivers.set(key, driver)
    const owned = () => Array.from(entries.values()).filter((entry) => entry.driverKey === key && entry.driver === driver && live(entry))
    const resolve = (candidateID: Interaction.ID) => {
      const entry = owned().find((item) => item.candidate?.request.candidateID === candidateID)
      const candidate = entry?.candidate
      if (!entry || !candidate || candidate.request.expiresAt <= Date.now() || candidate.proof) return undefined
      return { entry, candidate }
    }
    return {
      pending: () => owned().flatMap((entry) => {
        const candidate = entry.candidate
        return candidate && candidate.request.expiresAt > Date.now() && !candidate.proof ? [candidate.request] : []
      }),
      onPending: (listener) => {
        if (drivers.get(key) !== driver || listeners.has(key)) throw new InteractionError("unavailable")
        listeners.set(key, listener)
        return () => {
          if (listeners.get(key) === listener) listeners.delete(key)
        }
      },
      inventory: async (candidateID) => {
        const current = resolve(candidateID)
        if (!current || current.candidate.inventoryBusy) return []
        current.candidate.inventoryBusy = true
        try {
          const signal = AbortSignal.any([current.entry.controller.signal, AbortSignal.timeout(callTimeoutMs)])
          const inventory = await bounded(signal, () => driver.inventory(current.candidate.request))
          if (!resolve(candidateID) || !Array.isArray(inventory) || inventory.length > 100) return []
          const offer = new Map<Interaction.ID, Interaction.Target>()
          for (const input of inventory) {
            const decoded = decodeTarget(input)
            if (decoded._tag === "None" || !allowsTarget(driver.platform, decoded.value)) continue
            const request = current.candidate.request
            const target = decoded.value
            if (request.purpose === "confirm") {
              const pinned = current.entry.target
              if (!pinned || request.targetID !== target.id || pinned.kind !== target.kind) continue
              if (target.kind === "macos-window" ? pinned.kind !== "macos-window" || target.bundleID !== pinned.bundleID :
                pinned.kind === "macos-window" || target.origin !== pinned.origin || target.pathname !== pinned.pathname) continue
            }
            if (request.purpose === "attach" && !matchesTarget(request.selection, target)) continue
            if (offer.has(decoded.value.id)) return []
            offer.set(decoded.value.id, decoded.value)
          }
          current.candidate.targets = offer
          return Array.from(offer.values())
        } catch {
          return []
        } finally {
          current.candidate.inventoryBusy = false
        }
      },
      approve: async (proof) => {
        const current = resolve(proof.candidateID)
        if (!current || current.candidate.request.sessionID !== proof.sessionID || current.candidate.inventoryBusy ||
            typeof proof.authorization !== "string" || proof.authorization.length === 0 || proof.authorization.length > 256) return false
        const target = current.candidate.targets.get(proof.targetID)
        if (!target) return false
        const { candidate, entry } = current
        const usable = await (options.currentlyUsable?.(entry.sessionID) ?? Promise.resolve(true)).catch(() => false)
        if (!usable || resolve(proof.candidateID)?.candidate !== candidate) return false
        if (candidate.request.purpose === "confirm") {
          if (entry.revision !== candidate.request.revision || entry.target?.id !== proof.targetID || entry.busy) return false
          candidate.proof = { ...proof }
          return true
        }
        const key = targetKey(entry, target)
        if (targets.has(key) || targets.size >= maxSessions) return false
        targets.set(key, entry)
        entry.candidate = undefined
        entry.target = target
        const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(callTimeoutMs)])
        const attach = Promise.resolve().then(() => {
          signal.throwIfAborted()
          return driver.attach(target, proof, signal)
        }).then((lease) => {
          if (decodeID(lease?.id)._tag === "None") {
            retire(entry, "target_lost")
            finish(entry, "failed")
            return false
          }
          if (signal.aborted || !live(entry)) {
            detach(entry, lease, entry.status.state === "stopped" ? entry.status.reason : "target_lost")
            return false
          }
          entry.lease = lease
          entry.status = { state: "active", platform: driver.platform, generation: entry.generation, label: publicTargetLabels[target.kind] }
          options.changed?.(entry.sessionID, entry.generation)
          clearTimeout(entry.expiry)
          entry.expiry = setTimeout(() => retire(entry, "expired"), grantTtlMs)
          entry.expiry.unref()
          return true
        }, () => {
          retire(entry, "target_lost")
          finish(entry, "complete")
          return false
        })
        return bounded(signal, () => attach).catch((error: unknown) => {
          retire(entry, "target_lost")
          if (error instanceof DOMException && error.name === "TimeoutError") finish(entry, "failed")
          return false
        })
      },
      reject: (candidateID) => {
        const current = resolve(candidateID)
        if (!current) return false
        if (current.candidate.request.purpose === "attach") return retire(current.entry, "rejected")
        current.entry.candidate = undefined
        return true
      },
      stop: (leaseID, reason = "stopped") => {
        const entry = owned().find((item) => item.lease?.id === leaseID)
        return entry !== undefined && retire(entry, reason)
      },
      pause: (leaseID, reason) => {
        const entry = owned().find((item) => item.lease?.id === leaseID)
        const checked = decodePauseReason(reason)
        return entry !== undefined && checked._tag === "Some" && pause(entry, checked.value)
      },
      resume: (leaseID) => {
        const entry = owned().find((item) => item.lease?.id === leaseID)
        return entry !== undefined && unpause(entry)
      },
      capture: async (leaseID, input) => {
        const entry = owned().find((item) => item.lease?.id === leaseID)
        return entry !== undefined && capture(entry, leaseID, input)
      },
      disconnect: () => {
        if (drivers.get(key) !== driver) return
        for (const entry of owned()) retire(entry, "disconnected")
        drivers.delete(key)
        listeners.delete(key)
        for (const [targetID, entry] of targets) if (entry.driverKey === key && entry.driver === driver) targets.delete(targetID)
      },
    }
  }

  function shutdown() {
    closed = true
    for (const entry of entries.values()) retire(entry, "shutdown")
    drivers.clear()
    listeners.clear()
  }

  async function observe(sessionID: SessionID, generation: Interaction.Generation, signal?: AbortSignal, expectedPathname?: Interaction.Pathname) {
    if (paused(sessionID, generation)) throw new InteractionError("paused")
    const current = active(sessionID, generation)
    if (!current || (expectedPathname !== undefined && current.pathname !== expectedPathname)) throw new InteractionError("stale")
    const { entry, lease } = current
    if (entry.busy) throw new InteractionError("busy")
    entry.busy = true
    entry.revision = undefined
    entry.candidate = undefined
    try {
      const scoped = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(callTimeoutMs), ...(signal ? [signal] : [])])
      const observed = decodeObservation(await bounded(scoped, () => entry.driver.observe(lease, scoped)))
      if (!live(entry)) throw new InteractionError("stale")
      if (observed._tag === "None" || observed.value.revision <= (entry.lastRevision ?? 0) ||
        observed.value.pathname !== current.pathname) {
        retire(entry, "target_lost")
        throw new InteractionError("unavailable")
      }
      entry.revision = observed.value.revision
      entry.lastRevision = observed.value.revision
      return observed.value
    } catch (error) {
      if (error instanceof InteractionError) throw error
      if (live(entry) && entry.status.state === "paused") throw new InteractionError("paused")
      retire(entry, "target_lost")
      throw new InteractionError("unavailable")
    } finally {
      entry.busy = false
    }
  }

  function confirmation(sessionID: SessionID, generation: Interaction.Generation, revision: number, action: Interaction.Action, expectedPathname?: Interaction.Pathname) {
    const current = active(sessionID, generation)
    if (!current || current.entry.revision !== revision || (expectedPathname !== undefined && current.pathname !== expectedPathname))
      throw new InteractionError("stale")
    const { entry, target } = current
    if (entry.busy || entry.candidate && entry.candidate.request.expiresAt > Date.now()) throw new InteractionError("busy")
    const checked = validAction(target, action)
    if (!checked) throw new InteractionError("unavailable")
    if (target.kind === "chrome-isolated") return unsupportedActionConsent
    if (checked.type === "scroll" || checked.type === "navigate") throw new InteractionError("unavailable")
    entry.candidate = {
      request: { candidateID: Interaction.ID.create(), sessionID, sessionLabel: entry.sessionLabel, purpose: "confirm", targetID: target.id, revision,
        action: checked, expiresAt: Date.now() + candidateTtlMs },
      targets: new Map(), inventoryBusy: false,
    }
    notify(entry, entry.candidate.request)
    return undefined
  }

  async function perform(sessionID: SessionID, generation: Interaction.Generation, revision: number, callID: Interaction.ID, action: Interaction.Action,
    signal?: AbortSignal, expectedPathname?: Interaction.Pathname,
  ): Promise<Interaction.ActionResult> {
    const hold = paused(sessionID, generation)
    if (hold) return { outcome: "paused", reason: hold.reason }
    const current = active(sessionID, generation)
    if (!current) return { outcome: "refused", reason: "stale" }
    const { entry, lease, target } = current
    if (entry.busy) return { outcome: "refused", reason: "busy" }
    if (entry.revision !== revision || entry.calls.has(callID) || signal?.aborted || (expectedPathname !== undefined && current.pathname !== expectedPathname))
      return { outcome: "refused", reason: "stale" }
    const checked = validAction(target, action)
    if (!checked || decodeID(callID)._tag === "None") return { outcome: "refused", reason: "policy" }
    if (target.kind === "chrome-isolated" && checked.destructive) return unsupportedActionConsent
    const cand = entry.candidate
    const consent = cand?.request.purpose === "confirm" && cand.request.expiresAt > Date.now() &&
      cand.request.revision === revision && JSON.stringify(cand.request.action) === JSON.stringify(checked) ? cand.proof : undefined
    if (checked.destructive && !consent) return { outcome: "refused", reason: "confirmation_required" }
    if (entry.calls.size >= maxCallsPerGrant) {
      retire(entry, "expired")
      return { outcome: "refused", reason: "stale" }
    }
    entry.busy = true
    entry.calls.add(callID)
    entry.candidate = undefined
    entry.revision = undefined
    try {
      const scoped = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(callTimeoutMs), ...(signal ? [signal] : [])])
      const result = decodeResult(await bounded(scoped, () => entry.driver.perform(lease, revision, {
        callID, action: checked, ...(consent ? { consent } : {}),
      }, scoped)))
      if (!live(entry)) return { outcome: "uncertain" }
      if (result._tag === "None" || result.value.outcome === "uncertain") {
        retire(entry, "uncertain")
        return { outcome: "uncertain" }
      }
      if (result.value.outcome === "refused" && result.value.reason === "confirmation_required") entry.revision = revision
      if (result.value.outcome === "refused" && result.value.reason === "target_lost") retire(entry, "target_lost")
      if (result.value.outcome === "refused" && result.value.reason === "permission") retire(entry, "permission")
      if (result.value.outcome === "paused") pause(entry, result.value.reason)
      if (result.value.outcome === "applied") options.changed?.(entry.sessionID, entry.generation)
      return result.value
    } catch {
      retire(entry, "uncertain")
      return { outcome: "uncertain" }
    } finally {
      entry.busy = false
    }
  }

  async function run(sessionID: SessionID, generation: Interaction.Generation, revision: number, request: Interaction.ScriptRequest,
    signal?: AbortSignal, expectedPathname?: Interaction.Pathname,
  ): Promise<Interaction.ScriptResult> {
    const hold = paused(sessionID, generation)
    if (hold) return { outcome: "paused", reason: hold.reason }
    const current = active(sessionID, generation)
    if (!current || (expectedPathname !== undefined && current.pathname !== expectedPathname)) return { outcome: "refused", reason: "stale" }
    const { entry, lease, target } = current
    const execute = entry.driver.run?.bind(entry.driver)
    if (target.kind === "macos-window" || !execute) return { outcome: "refused", reason: "unsupported" }
    if (entry.busy) return { outcome: "refused", reason: "busy" }
    if (entry.revision !== revision || signal?.aborted) return { outcome: "refused", reason: "stale" }
    const checked = decodeScript(request)
    if (checked._tag === "None") return { outcome: "refused", reason: "policy" }
    if (entry.calls.size >= maxCallsPerGrant) {
      retire(entry, "expired")
      return { outcome: "refused", reason: "stale" }
    }
    const script = { mode: checked.value.mode, source: checked.value.source, timeoutMs: checked.value.timeoutMs ?? Interaction.defaultScriptTimeoutMs }
    entry.busy = true
    entry.calls.add(Interaction.ID.create())
    entry.candidate = undefined
    entry.revision = undefined
    const scoped = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(script.timeoutMs + callTimeoutMs), ...(signal ? [signal] : [])])
    try {
      const result = decodeScriptResult(await settled(scoped, callTimeoutMs, () => execute(lease, script, scoped)))
      if (result._tag === "None") throw new Error("Unreadable script result")
      const value = result.value
      if (value.outcome === "paused") pause(entry, value.reason)
      if (value.outcome === "refused" && value.reason === "target_lost") retire(entry, "target_lost")
      if (value.outcome === "refused" && value.reason === "permission") retire(entry, "permission")
      if (value.outcome !== "refused" && value.outcome !== "paused" && live(entry)) options.changed?.(entry.sessionID, entry.generation)
      return value
    } catch {
      retire(entry, "uncertain")
      throw new InteractionError("uncertain")
    } finally {
      entry.busy = false
    }
  }

  async function preview(sessionID: SessionID, generation: Interaction.Generation, signal?: AbortSignal,
    expectedPathname?: Interaction.Pathname,
  ): Promise<Interaction.Preview> {
    const unavailable = { state: "unavailable", generation } as const
    const current = active(sessionID, generation, ["active", "paused"])
    if (!current || current.entry.previewing || current.entry.busy ||
      (expectedPathname !== undefined && current.pathname !== expectedPathname)) return unavailable
    const { entry, lease } = current
    const dispatched = entry.calls.size
    const revision = entry.lastRevision
    entry.previewing = true
    const scoped = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(callTimeoutMs), ...(signal ? [signal] : [])])
    try {
      const frame = decodeFrame(await bounded(scoped, () => entry.driver.preview(lease, scoped)))
      if (scoped.aborted || !live(entry) || entry.busy || dispatched !== entry.calls.size || revision !== entry.lastRevision ||
        frame._tag === "None") return unavailable
      const image = previewFrame(frame.value.mimeType, frame.value.base64)
      return image?.width === frame.value.width && image.height === frame.value.height
        ? { state: "ready", generation, frame: image } : unavailable
    } catch {
      return unavailable
    } finally {
      entry.previewing = false
    }
  }

  function admitCaptures(admit: CaptureAdmission) {
    admission = admit
    return () => {
      if (admission === admit) admission = undefined
    }
  }

  return { request, status, stop, resume, revoke, register, observe, confirmation, perform, run, preview, shutdown, admitCaptures,
    target: (sessionID: SessionID, generation: Interaction.Generation) => active(sessionID, generation)?.target }
}

type CaptureAdmission = (sessionID: SessionID, generation: Interaction.Generation, capture: AdmittedCapture) => Promise<void>

function boundedLabel(text: string) {
  return Array.from(text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 128).join("")
}

function matchesTarget(selection: Interaction.Request, target: Interaction.Target) {
  if (selection.platform === "macos") return target.kind === "macos-window"
  if (typeof selection.url !== "string") return target.kind === "chrome-tab"
  if (target.kind !== "chrome-owned" && target.kind !== "chrome-isolated") return false
  return (selection.mode === "owned" ? target.kind === "chrome-owned" : target.kind === "chrome-isolated") &&
    selection.url === target.url && new URL(target.url).origin === target.origin && new URL(target.url).pathname === target.pathname
}

function validAction(target: Interaction.Target, input: Interaction.Action) {
  const decoded = decodeAction(input)
  if (decoded._tag === "None") return undefined
  const action = decoded.value
  if (action.platform !== (target.kind === "macos-window" ? "macos" : "chrome")) return undefined
  if (action.type === "navigate") {
    if (target.kind === "macos-window" || !URL.canParse(action.url)) return undefined
    const destination = new URL(action.url)
    if (destination.origin !== target.origin || destination.pathname !== target.pathname ||
      (target.kind !== "chrome-tab" && destination.href !== new URL(target.url).href)) return undefined
  }
  return action
}

function settled<T>(signal: AbortSignal, graceMs: number, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let grace: ReturnType<typeof setTimeout> | undefined
    const abort = () => { grace = setTimeout(() => reject(signal.reason), graceMs) }
    const settle = () => {
      clearTimeout(grace)
      signal.removeEventListener("abort", abort)
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(run).then(
      (value) => { settle(); resolve(value) },
      (error: unknown) => { settle(); reject(error) },
    )
  })
}

function bounded<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return run()
    }).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}
