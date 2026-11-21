import { redactText, redactURL } from "./redact.js"

const maxTargets = 64
const maxCalls = 512
const maxConsentMs = 120_000
const maxLeaseMs = 15 * 60_000
const pauseHandoffs = new Set(["captcha", "sensitive"])
const label = /^[^\u0000-\u001f\u007f]{0,256}$/u
const secret = /^[A-Za-z0-9_-]{43}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class ChromeFault extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

export function pageURL(raw) {
  if (typeof raw !== "string" || raw.length > 2048 || /[\s\\]/u.test(raw)) return undefined
  try {
    const url = new URL(raw)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined
    return url
  } catch {
    return undefined
  }
}

export function validAddress(address) {
  return typeof address === "string" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(address) &&
    Number(new URL(address).port) <= 65_535
}

export function storedLink(raw) {
  const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  const profileID = secret.test(saved.profileID ?? "") ? saved.profileID : undefined
  const credential = profileID && secret.test(saved.credential ?? "") ? saved.credential : undefined
  const forget = secret.test(saved.forget?.profileID ?? "") && secret.test(saved.forget?.credential ?? "") ?
    { profileID: saved.forget.profileID, credential: saved.forget.credential } : undefined
  const link = Object.fromEntries(Object.entries({ address: validAddress(saved.address) ? saved.address : undefined, profileID, credential, forget })
    .filter(([, value]) => value !== undefined))
  const discarded = (raw !== undefined && saved !== raw) || Object.entries(saved).some(([key, value]) => value !== undefined && !(key in link))
  return { link, discarded }
}

function scriptRun(input) {
  if (!["script", "code"].includes(input.mode) || typeof input.source !== "string" || input.source.length < 1 || input.source.length > 65_536 ||
    !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 60_000) return undefined
  return { mode: input.mode, source: input.source, timeoutMs: input.timeoutMs }
}

function candidateTab(tab) {
  return tab && Number.isSafeInteger(tab.id) && Number.isSafeInteger(tab.windowId) && !tab.pinned &&
    !tab.incognito && !tab.discarded && !tab.pendingUrl && !!pageURL(tab.url)
}

function sameTab(tab, target) {
  return candidateTab(tab) && tab.id === target.id && tab.windowId === target.windowId &&
    tab.groupId === target.groupId && tab.url === target.url && tab.index === target.index
}

export function chromeAction(value) {
  if (!value || value.platform !== "chrome" || (value.destructive !== undefined && value.destructive !== true)) return undefined
  const keys = value.type === "click" ? ["elementID"] : value.type === "fill" ? ["elementID", "text"] :
    value.type === "scroll" ? ["deltaY"] : value.type === "navigate" ? ["url"] : undefined
  if (!keys || Object.keys(value).some((key) => !keys.includes(key) && !["platform", "type", "destructive"].includes(key))) return undefined
  if (keys.includes("elementID") && !uuid.test(value.elementID ?? "")) return undefined
  if (value.type === "fill" && (typeof value.text !== "string" || value.text.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.text))) return undefined
  if (value.type === "scroll" && (!Number.isSafeInteger(value.deltaY) || Math.abs(value.deltaY) > 10_000)) return undefined
  if (value.type === "navigate" && !pageURL(value.url)) return undefined
  const { platform, type, destructive, elementID, text, deltaY, url } = value
  return JSON.stringify([platform, type, destructive ?? null, elementID ?? null, text ?? null, deltaY ?? null, url ?? null])
}

export function createChromeController(platform, { now = Date.now, revoked, paused = () => {}, resumed = () => {} }) {
  const requests = new Map()
  const leases = new Map()
  const cleanup = new Set()
  const closed = new Map()
  const challenges = new Set()
  const attaching = new Set()
  let connection = 0
  let epoch = 0

  function clearPending(request) {
    if (requests.get(request.candidateID) !== request) return
    requests.delete(request.candidateID)
    clearTimeout(request.timer)
  }

  function close(lease, reason) {
    if (!leases.delete(lease.id)) return Promise.resolve()
    clearTimeout(lease.timer)
    for (const run of lease.runs.values()) run.abort()
    cleanup.add(lease.target.tabId)
    revoked({ leaseID: lease.id, epoch: lease.epoch, reason })
    const closing = Promise.resolve().then(() => platform.detach(lease.target, reason)).finally(() => cleanup.delete(lease.target.tabId))
    closed.set(lease.id, { epoch: lease.epoch, sessionID: lease.sessionID, closing })
    if (closed.size > 16) closed.delete(closed.keys().next().value)
    return closing
  }

  function pause(lease, reason) {
    if (leases.get(lease.id) !== lease || lease.paused === reason) return
    lease.paused = reason
    lease.target.held = true
    lease.refs.clear()
    lease.awaitingObservation = true
    paused({ leaseID: lease.id, epoch: lease.epoch, reason })
  }

  function summary(lease) {
    return { sessionID: lease.sessionID, leaseID: lease.id, epoch: lease.epoch, label: lease.publicTarget.label,
      sessionLabel: lease.sessionLabel, paused: lease.paused, tabId: lease.target.tabId, windowId: lease.target.windowId }
  }

  async function capture(input, operation) {
    const lease = requireLease(input)
    if (lease.busy || lease.capturing) throw new ChromeFault("busy")
    const fence = () => { if (leases.get(lease.id) !== lease || now() >= lease.expiresAt) throw new ChromeFault("stopped") }
    lease.capturing = true
    try {
      fence()
      const shot = await platform.capture(lease.target, fence)
      fence()
      if (!shot?.frame) throw new ChromeFault("sensitive")
      return operation(lease, shot)
    } finally {
      lease.capturing = false
    }
  }

  function invalidate(tabId, reason) {
    for (const request of requests.values()) {
      if (request.approval?.selection.tabId === tabId || request.lease?.target.tabId === tabId) clearPending(request)
      for (const [id, candidate] of request.targets) if (candidate.tab?.id === tabId) request.targets.delete(id)
    }
    for (const lease of leases.values()) {
      if (lease.target.tabId === tabId) void close(lease, reason).catch(() => {})
    }
  }

  function reset(reason = "disconnected") {
    connection++
    for (const request of requests.values()) clearPending(request)
    challenges.clear()
    return Promise.allSettled([...leases.values()].map((lease) => close(lease, reason)))
  }

  function requireLease(input) {
    const lease = leases.get(input.leaseID)
    if (!lease || lease.epoch !== input.epoch || lease.sessionID !== input.sessionID) throw new ChromeFault("ownership")
    return lease
  }

  function requireRequest(input) {
    const request = requests.get(input.candidateID)
    if (!request || request.sessionID !== input.sessionID || now() >= request.expiresAt) throw new ChromeFault("consent")
    return request
  }

  async function withLease(input, operation, whilePaused = false) {
    const lease = requireLease(input)
    if (lease.paused && !whilePaused) throw new ChromeFault("paused")
    if (input.revision !== lease.revision) throw new ChromeFault("stale")
    if (lease.busy) throw new ChromeFault("busy")
    const fence = () => {
      if (leases.get(lease.id) !== lease || now() >= Math.min(lease.expiresAt, input.deadline ?? Infinity))
        throw new ChromeFault("stopped")
    }
    lease.busy = true
    try {
      fence()
      const valid = await Promise.resolve().then(() => platform.verify(lease.target, fence)).catch(() => false)
      fence()
      if (!valid) {
        void close(lease, "changed").catch(() => {})
        throw new ChromeFault("stale")
      }
      return await operation(lease, fence)
    } finally {
      lease.busy = false
    }
  }

  return {
    offer(input) {
      const expiresIn = input.expiresAt - now()
      if (!uuid.test(input.candidateID ?? "") || typeof input.sessionID !== "string" || input.sessionID.length > 256 ||
        !Number.isSafeInteger(input.expiresAt) || expiresIn <= 0 || expiresIn > maxConsentMs ||
        (input.sessionLabel !== undefined && (typeof input.sessionLabel !== "string" || !label.test(input.sessionLabel))) ||
        challenges.has(input.candidateID) || challenges.size >= maxCalls || requests.size >= 8) throw new ChromeFault("consent")
      const mode = input.mode ?? "tab"
      if (!["tab", "owned"].includes(mode) || (mode === "owned" && !pageURL(input.url)) ||
        (mode === "tab" && input.url !== undefined) || !["attach", "confirm"].includes(input.purpose) ||
        (input.purpose === "confirm" && (!uuid.test(input.targetID ?? "") || !Number.isSafeInteger(input.revision) ||
          !chromeAction(input.action)))) throw new ChromeFault("invalid")
      const request = { ...input, mode, connection, targets: new Map(), unavailableTabs: new Set() }
      request.timer = setTimeout(() => clearPending(request), expiresIn)
      request.timer.unref?.()
      challenges.add(input.candidateID)
      requests.set(input.candidateID, request)
    },

    async inventory(input) {
      const request = requireRequest(input)
      if (request.expiresAt !== input.expiresAt || request.purpose !== input.purpose) throw new ChromeFault("consent")
      if (request.inventory) return request.inventory
      request.inventory = (async () => {
        if (request.purpose === "confirm") {
          const lease = [...leases.values()].find((value) => value.publicTarget.id === request.targetID &&
            value.sessionID === request.sessionID && value.revision === request.revision)
          if (!lease) throw new ChromeFault("stale")
          request.lease = lease
          request.targets.set(lease.publicTarget.id, { target: lease.publicTarget })
          return [lease.publicTarget]
        }
        if (request.mode === "owned") {
          const url = pageURL(request.url)
          const target = { kind: "chrome-owned", id: crypto.randomUUID(), label: "New background tab", origin: url.origin,
            pathname: url.pathname, url: request.url }
          request.targets.set(target.id, { target, url: url.href, grouping: "create" })
          return [target]
        }
        const tabs = await platform.list()
        if (requireRequest(input) !== request) throw new ChromeFault("consent")
        const targets = await Promise.all(tabs.filter(candidateTab).slice(0, maxTargets).map(async (tab) => {
          const url = pageURL(tab.url)
          const target = { kind: "chrome-tab", id: crypto.randomUUID(), label: "Selected Chrome tab", origin: url.origin, pathname: url.pathname }
          const group = await platform.snapshot?.(tab, () => requireRequest(input)).catch(() => null)
          if (requireRequest(input) !== request) return undefined
          if (group === null || group?.collapsed || tab.groupId !== -1 && !group) {
            request.unavailableTabs.add(tab.id)
            return undefined
          }
          request.targets.set(target.id, { target, tab: { ...tab }, group, grouping: group ? "already" : "move" })
          return target
        }))
        return targets.filter(Boolean)
      })()
      return request.inventory
    },

    approve(input, selection) {
      const request = requireRequest(input)
      const candidate = request.targets.get(input.targetID)
      if (!candidate || request.approval || !Number.isSafeInteger(selection.windowId) || input.grouping !== candidate.grouping)
        throw new ChromeFault("consent")
      if (request.lease) {
        if (leases.get(request.lease.id) !== request.lease || request.lease.revision !== request.revision ||
          selection.tabId !== request.lease.target.tabId || selection.windowId !== request.lease.target.windowId)
          throw new ChromeFault("stale")
      }
      const original = candidate.tab
      if (original && (selection.tabId !== original.id || selection.windowId !== original.windowId)) throw new ChromeFault("consent")
      const proof = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: candidate.target.id,
        authorization: `${crypto.randomUUID()}${crypto.randomUUID()}` }
      request.approval = { proof, candidate, selection }
      return proof
    },

    async attach(input) {
      const request = requireRequest(input.proof)
      const approval = request.approval
      const candidate = approval?.candidate
      const selection = approval?.selection
      if (request.purpose !== "attach" || !candidate || request.consumed || Object.keys(approval.proof).some((key) =>
        approval.proof[key] !== input.proof[key]) || candidate.target.id !== input.target?.id ||
        candidate.target.kind !== input.target.kind || input.target.origin !== candidate.target.origin ||
        input.target.pathname !== candidate.target.pathname || input.target.url !== candidate.target.url) throw new ChromeFault("consent")
      const original = candidate.tab
      if (leases.size >= 8 || original && (attaching.has(original.id) || cleanup.has(original.id) ||
        [...leases.values()].some((lease) => lease.target.tabId === original.id)))
        throw new ChromeFault("ownership")
      const fence = () => {
        if (requests.get(request.candidateID) !== request || connection !== request.connection ||
          now() >= Math.min(request.expiresAt, input.deadline ?? Infinity))
          throw new ChromeFault("stopped")
      }
      request.consumed = true
      if (original) attaching.add(original.id)
      let attached
      try {
        const tab = original ? await platform.tab(original.id) : undefined
        fence()
        if (original && !sameTab(tab, original)) throw new ChromeFault("stale")
        attached = await platform.attach(tab, { url: candidate.url, windowId: selection.windowId,
          group: candidate.group, grouping: candidate.grouping }, fence)
        fence()
        const id = crypto.randomUUID()
        const lease = { id, epoch: ++epoch, sessionID: request.sessionID, sessionLabel: request.sessionLabel ?? "", target: attached,
          publicTarget: candidate.target, revision: 1,
          expiresAt: now() + maxLeaseMs, refs: new Set(), calls: new Set(), runs: new Map(), busy: false }
        lease.timer = setTimeout(() => void close(lease, "expired").catch(() => {}), maxLeaseMs)
        lease.timer.unref?.()
        leases.set(id, lease)
        attached.onPause = (reason) => pause(lease, reason)
        platform.maintain?.(attached, () => {
          if (leases.get(id) !== lease || now() >= lease.expiresAt) throw new ChromeFault("stopped")
        }, () => { void close(lease, "target_lost").catch(() => {}) })
        return { sessionID: request.sessionID, targetID: candidate.target.id, pathname: candidate.target.pathname,
          leaseID: id, epoch: lease.epoch, revision: lease.revision }
      } catch (cause) {
        if (attached) await platform.detach(attached, "stopped").catch(() => {})
        throw cause
      } finally {
        if (original) attaching.delete(original.id)
        clearPending(request)
      }
    },

    dismiss(input) {
      const request = requests.get(input.candidateID)
      if (!request || request.sessionID !== input.sessionID) return false
      clearPending(request)
      return true
    },

    localState(selection) {
      return {
        groupingUnavailable: [...requests.values()].some((request) => request.unavailableTabs.has(selection.tabId)),
        pending: [...requests.values()].filter((request) => !request.approval).flatMap((request) => {
          const candidate = [...request.targets.values()].find((value) => value.tab ? value.tab.id === selection.tabId &&
            value.tab.windowId === selection.windowId : !request.lease || request.lease.target.tabId === selection.tabId)
          if (!candidate) return []
          return [{ sessionID: request.sessionID, sessionLabel: request.sessionLabel ?? "", candidateID: request.candidateID, targetID: candidate.target.id,
            target: candidate.target, purpose: request.purpose, action: request.action?.type, grouping: candidate.grouping,
            url: candidate.url ?? (request.action?.type === "navigate" ? request.action.url : undefined) }]
        }),
        active: [...leases.values()].filter((lease) => lease.target.windowId === selection.windowId &&
          (lease.target.tabId === selection.tabId || lease.target.owned))
          .toSorted((first, second) => Number(second.target.tabId === selection.tabId) - Number(first.target.tabId === selection.tabId)).map(summary),
      }
    },

    lease(leaseID) {
      const lease = leases.get(leaseID)
      return lease ? summary(lease) : undefined
    },

    observe: (input) => withLease(input, async (lease, fence) => {
      const observation = await platform.observe(lease.target, fence)
      fence()
      if (observation.pathname !== lease.publicTarget.pathname) {
        void close(lease, "target_lost").catch(() => {})
        throw new ChromeFault("target_lost")
      }
      lease.refs = new Set(observation.elements.map((element) => element.id))
      lease.awaitingObservation = false
      return { ...observation, revision: ++lease.revision }
    }),

    perform: async (input) => {
      const current = requireLease(input)
      if (current.paused) return { outcome: "paused", reason: current.paused, revision: current.revision }
      return withLease(input, async (lease, fence) => {
        const action = chromeAction(input.action)
        if (!action) throw new ChromeFault("invalid")
        if (lease.awaitingObservation) throw new ChromeFault("stale")
        if (input.action.elementID !== undefined && !lease.refs.has(input.action.elementID)) throw new ChromeFault("stale")
        if (!uuid.test(input.callID ?? "") || lease.calls.has(input.callID) || lease.calls.size >= maxCalls) throw new ChromeFault("stale")
        if (input.action.destructive) {
          const request = input.consent && requireRequest(input.consent)
          if (!request || request.purpose !== "confirm" || request.lease !== lease || request.revision !== input.revision ||
            chromeAction(request.action) !== action || !request.approval ||
            Object.keys(request.approval.proof).some((key) => request.approval.proof[key] !== input.consent[key]))
            throw new ChromeFault("consent")
          clearPending(request)
        }
        lease.calls.add(input.callID)
        let dispatched = false
        try {
          const result = await platform.perform(lease.target, input.action, fence, () => {
            dispatched = true
            if (input.action.type === "navigate") lease.awaitingObservation = true
          })
          fence()
          const handoff = result.paused ?? (pauseHandoffs.has(result.refusal) ? result.refusal : undefined)
          if (handoff) {
            pause(lease, handoff)
            return { outcome: "paused", reason: handoff, revision: lease.revision }
          }
          if (result.refusal) return { outcome: "refused", reason: result.refusal, revision: lease.revision }
          lease.refs.clear()
          return { ...result, outcome: "applied", revision: lease.revision }
        } catch (cause) {
          if (!dispatched) throw cause
          void close(lease, "uncertain").catch(() => {})
          return { outcome: "uncertain", revision: lease.revision }
        }
      })
    },

    run: async (input) => {
      const current = requireLease(input)
      if (current.paused) return { outcome: "paused", reason: current.paused }
      return withLease(input, async (lease, fence) => {
        const script = scriptRun(input)
        if (!script) throw new ChromeFault("invalid")
        if (lease.awaitingObservation) throw new ChromeFault("stale")
        if (!uuid.test(input.runID ?? "") || lease.calls.has(input.runID) || lease.calls.size >= maxCalls) throw new ChromeFault("stale")
        lease.calls.add(input.runID)
        lease.refs.clear()
        lease.awaitingObservation = true
        const cancel = new AbortController()
        lease.runs.set(input.runID, cancel)
        try {
          const ran = await platform.run(lease.target, { ...script, leaseID: lease.id, signal: cancel.signal }, fence)
          if (ran.outcome === "paused") {
            pause(lease, ran.reason)
            return ran
          }
          if (ran.outcome === "refused") return ran
          if (!ran.verified) void close(lease, "target_lost").catch(() => {})
          return ran.result
        } catch {
          void close(lease, "uncertain").catch(() => {})
          throw new ChromeFault("target_lost")
        } finally {
          lease.runs.delete(input.runID)
        }
      })
    },

    cancelRun(input) {
      const run = requireLease(input).runs.get(input.runID)
      run?.abort()
      return run !== undefined
    },

    preview: (input) => withLease(input, async (lease, fence) => {
      const preview = await platform.preview(lease.target, fence)
      fence()
      return preview
    }, true),

    takeover(input) {
      pause(requireLease(input), "user_takeover")
      return true
    },

    async resume(input, local = false) {
      const lease = requireLease(input)
      if (!lease.paused) throw new ChromeFault("stale")
      if (lease.busy) throw new ChromeFault("busy")
      const fence = () => { if (leases.get(lease.id) !== lease || now() >= lease.expiresAt) throw new ChromeFault("stopped") }
      lease.busy = true
      try {
        await platform.resume(lease.target, fence)
        fence()
      } finally {
        lease.busy = false
      }
      lease.paused = undefined
      lease.target.held = false
      lease.refs.clear()
      lease.awaitingObservation = true
      if (local) resumed({ leaseID: lease.id, epoch: lease.epoch })
      return true
    },

    capture: (input) => capture(input, (lease, shot) => ({
      frame: shot.frame,
      title: shot.title === undefined ? undefined : redactText(shot.title).slice(0, 256),
      url: shot.url === undefined ? undefined : redactURL(shot.url),
    })),

    async glance(input) {
      const lease = requireLease(input)
      if (lease.busy || lease.capturing) return undefined
      return capture(input, (_lease, shot) => shot.frame)
    },

    async detach(input) {
      const prior = closed.get(input.leaseID)
      if (!leases.has(input.leaseID) && prior?.epoch === input.epoch && prior.sessionID === input.sessionID) return prior.closing
      return close(requireLease(input), "stopped")
    },

    invalidate,
    reset,
  }
}
