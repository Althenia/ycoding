import { FollowError, followID, followLedgerLimit, requestKinds, type FollowRequest, type FollowState } from "./follow-state"
import { ClientError } from "@ycoding-ai/client/promise"

export type FollowEvent = { type: string; id?: string; created?: number; sourceEpoch?: string; aggregateID?: string; seq?: number;
  durable?: { aggregateID: string; seq: number }; data?: unknown }
type ReadOptions = { signal: AbortSignal }
export type FollowClient = {
  event: { subscribe(options: ReadOptions): AsyncIterable<FollowEvent> }
  decision: { list(options: ReadOptions): Promise<readonly FollowRequest[]> }
  session: {
    get(input: { sessionID: string }, options: ReadOptions): Promise<{ id: string; parentID?: string }>
    active(options: ReadOptions): Promise<Record<string, unknown>>
    list(input: { parentID: string; limit: number; cursor?: string }, options: ReadOptions): Promise<{ data: readonly { id: string; parentID?: string }[]; cursor: { next?: string | null } }>
    snapshot(input: { sessionID: string; limit: number }, options: ReadOptions): Promise<{ sourceEpoch: string; watermark: { seq?: number } }>
    log(input: { sessionID: string; after?: number; follow: boolean }, options: ReadOptions): AsyncIterable<FollowEvent>
  }
}
export type FollowReceipt = {
  kind: "ready" | "pending" | "request-observed" | "reply-observed" | "request-ended-observed" | "no-longer-pending" | "durable" | "heartbeat" | "closed"
  sessionID: string
  id?: string
  requestKind?: string
  type?: string
  seq?: number
  rootActive?: boolean
  resolution?: "unknown" | "reply-observed" | "cancelled" | "timed_out" | "rejected"
}
type Entry = { id: string; epoch: string; after?: number; baselineAfter?: number; controller: AbortController; task?: Promise<void>; restart: boolean; failures: number; backoff: number }
const transport = (error: unknown) => error instanceof ClientError && error.reason === "Transport"
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

export function ownedFollowAbort(error: unknown, signal: AbortSignal): boolean {
  for (let depth = 0; signal.aborted && depth < 8; depth++) {
    if (error === signal.reason) return true
    if (typeof error !== "object" || error === null) break
    error = Reflect.get(error, "cause")
  }
  return false
}

export async function followFamily(client: FollowClient, options: {
  state: FollowState; signal: AbortSignal; heartbeatSeconds: number
  save(state: FollowState): Promise<void>
  emit(receipt: FollowReceipt): Promise<void>
}) {
  const state = structuredClone(options.state)
  let committed = structuredClone(state)
  const local = new AbortController()
  const signal = AbortSignal.any([options.signal, local.signal])
  const root = state.rootSessionID
  const entries = new Map<string, Entry>()
  const saved = new Map(state.cursors.map((cursor) => [cursor.sessionID, cursor.after]))
  const seen = new Set(state.seen)
  const requestSeen = new Set(state.requestSeen)
  const terminalSeen = new Set(state.terminalSeen)
  const key = (request: FollowRequest) => `${request.kind}\0${request.sessionID}\0${request.id}`
  const pending = new Map(state.pending.map((request) => [key(request), request]))
  let scope = new Set([root])
  let baseline = state.sourceEpoch !== undefined
  let epoch = state.sourceEpoch
  let rootActive: boolean | undefined
  let failure: unknown
  let dirty = false
  let notify: (() => void) | undefined
  let output = Promise.resolve()
  let graceful = false
  let ready = false
  let queued = 0
  let globalBackoff = 0
  let reviewDirty = false
  const wake = () => { dirty = true; notify?.(); notify = undefined }
  const send = (receipt: FollowReceipt, delivered = false) => {
    if (queued >= 66) throw new FollowError("budget-exhausted")
    queued++
    const sourceEpoch = epoch
    const baselines = [...entries.values()].map(({ id, baselineAfter }) => ({ sessionID: id, ...(baselineAfter === undefined ? {} : { after: baselineAfter }) }))
    output = output.then(async () => {
      if (!delivered) await options.emit(receipt)
      const checkpoint = structuredClone(committed)
      checkpoint.sourceEpoch = sourceEpoch
      checkpoint.cursors = baselines.map((cursor) => checkpoint.cursors.find((saved) => saved.sessionID === cursor.sessionID) ?? cursor)
      const append = (ledger: string[], value: string) => {
        if (ledger.includes(value)) return
        if (ledger.length >= followLedgerLimit) throw new FollowError("budget-exhausted")
        ledger.push(value)
      }
      if (receipt.kind === "durable" && receipt.id !== undefined && receipt.seq !== undefined) {
        const cursor = checkpoint.cursors.find((cursor) => cursor.sessionID === receipt.sessionID)
        if (!cursor) throw new FollowError("invalid-native-data")
        cursor.after = receipt.seq
      }
      if (receipt.requestKind !== undefined && receipt.id !== undefined) {
        const request = { kind: receipt.requestKind, sessionID: receipt.sessionID, id: receipt.id }
        const requestKey = key(request)
        const active = new Map(checkpoint.pending.map((item) => [key(item), item]))
        if (receipt.kind === "pending" || receipt.kind === "request-observed") {
          active.set(requestKey, request)
          append(checkpoint.requestSeen, requestKey)
        } else {
          active.delete(requestKey)
          if (receipt.kind !== "no-longer-pending") append(checkpoint.terminalSeen, requestKey)
        }
        checkpoint.pending = [...active.values()]
      }
      checkpoint.seen = checkpoint.seen.filter((value) => {
        const [sessionID, , seq] = value.split("\0")
        const after = checkpoint.cursors.find((cursor) => cursor.sessionID === sessionID)?.after
        return after === undefined || Number(seq) > after
      })
      await options.save(checkpoint)
      committed = checkpoint
      for (const value of seen) if (!checkpoint.seen.includes(value)) seen.delete(value)
      if (receipt.kind === "durable" || receipt.requestKind !== undefined) {
        globalBackoff = 0
        const entry = entries.get(receipt.sessionID)
        if (entry) entry.backoff = 0
      }
    }).catch((error: unknown) => { failure = error; wake(); throw error }).finally(() => { queued-- })
    return output
  }
  const remember = (ledger: Set<string>, value: string) => {
    if (ledger.has(value)) return false
    if (ledger.size >= followLedgerLimit) throw new FollowError("budget-exhausted")
    ledger.add(value)
    return true
  }
  const stop = async (entry: Entry) => { entry.controller.abort(); await entry.task }
  const delay = (attempt: number) => pause(100 * 2 ** Math.min(attempt - 1, 4))
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (let failures = 0; ; ) {
      try { return await operation() } catch (error) {
        if (ownedFollowAbort(error, signal) || !transport(error)) throw error
        if (++failures >= 10) throw new FollowError("budget-exhausted")
        await delay(failures)
        if (signal.aborted) throw signal.reason
      }
    }
  }
  const discover = async () => {
    const found = new Set([root])
    const queue = [root]
    let pages = 0
    while (queue.length) {
      const parentID = queue.shift()!
      let cursor: string | undefined
      const visited = new Set<string>()
      do {
        if (++pages > 128) throw new FollowError("budget-exhausted")
        const page = await read(() => client.session.list({ parentID, limit: 200, ...(cursor === undefined ? {} : { cursor }) }, { signal }))
        for (const child of page.data) {
          if (child.parentID !== parentID || found.has(child.id)) continue
          if (!followID(child.id) || !child.id.startsWith("ses")) throw new FollowError("invalid-native-data")
          if (found.size >= 64) throw new FollowError("budget-exhausted")
          found.add(child.id)
          queue.push(child.id)
        }
        cursor = page.cursor.next ?? undefined
        if (cursor !== undefined && visited.has(cursor)) throw new FollowError("invalid-native-data")
        if (cursor !== undefined) visited.add(cursor)
      } while (cursor !== undefined)
    }
    return found
  }
  const pump = async (entry: Entry) => {
    const reading = AbortSignal.any([signal, entry.controller.signal])
    try {
      for await (const event of client.session.log({ sessionID: entry.id, after: entry.after, follow: true }, { signal: reading })) {
        if (reading.aborted || entries.get(entry.id) !== entry) return
        if (event.sourceEpoch !== entry.epoch) continue
        if (event.type === "log.synced") {
          if (event.aggregateID !== entry.id) throw new FollowError("invalid-native-data")
          if (event.aggregateID === entry.id && event.seq !== undefined) {
            if (!Number.isSafeInteger(event.seq) || event.seq < (entry.after ?? 0)) throw new FollowError("invalid-native-data")
            entry.after = event.seq
          }
          entry.failures = 0
          continue
        }
        if (!event.durable || event.durable.aggregateID !== entry.id || event.durable.seq <= (entry.after ?? -1)) continue
        if (!followID(event.id) || !Number.isSafeInteger(event.durable.seq) || event.durable.seq < 0) throw new FollowError("invalid-native-data")
        entry.after = event.durable.seq
        if (!/^session\.(execution\.(started|succeeded|failed|interrupted)|step\.(started|ended|failed)|input\.(admitted|promoted|consumed|rejected)|work\.completed|task\.updated|review\.(deferred|decided|withdrawn|consumed))$/.test(event.type)) continue
        if (entry.id === root && event.type === "session.execution.started") rootActive = true
        if (entry.id === root && /^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) rootActive = false
        await send({ kind: "durable", sessionID: entry.id, id: event.id, seq: event.durable.seq, type: event.type, rootActive }, seen.has(`${entry.id}\0${event.id}\0${event.durable.seq}`))
        if (/^session\.review\./.test(event.type)) { reviewDirty = true; wake() }
      }
      if (reading.aborted) return
    } catch (error) {
      if (ownedFollowAbort(error, reading)) return
      if (!transport(error) || reading.aborted || failure !== undefined) throw error
    }
    if (++entry.failures >= 10) throw new FollowError("budget-exhausted")
    entry.backoff++
    entry.restart = true
    wake()
  }
  const reconcile = async (reset: boolean, child?: string, pendingOnly = false) => {
    ready = false
    if (child !== undefined) scope.add(child)
    else if (!pendingOnly) {
      scope = await discover()
      rootActive = Object.hasOwn(await read(() => client.session.active({ signal })), root)
    }
    if (scope.size > 64) throw new FollowError("budget-exhausted")
    for (const [id, entry] of entries) if (!scope.has(id)) { entries.delete(id); await stop(entry) }
    if (reset) for (const entry of entries.values()) await stop(entry)
    const starting: Entry[] = []
    for (const id of pendingOnly ? [] : scope) {
      let entry = entries.get(id)
      if (entry && !reset && !entry.restart) continue
      if (entry) await stop(entry)
      const projection = await read(() => client.session.snapshot({ sessionID: id, limit: 1 }, { signal }))
      if (!followID(projection.sourceEpoch)) throw new FollowError("invalid-native-data")
      if (epoch !== undefined && projection.sourceEpoch !== epoch) throw new FollowError("epoch-mismatch")
      epoch = projection.sourceEpoch
      const after = entry ? entry.after : saved.has(id) ? saved.get(id) : baseline ? undefined : projection.watermark.seq
      if (after !== undefined && (projection.watermark.seq === undefined || after > projection.watermark.seq)) throw new FollowError("cursor-ahead")
      if (entry?.restart) await delay(entry.backoff)
      entry = { id, epoch, after, baselineAfter: committed.cursors.find((cursor) => cursor.sessionID === id)?.after ?? after, controller: new AbortController(), restart: false, failures: entry?.failures ?? 0, backoff: entry?.backoff ?? 0 }
      starting.push(entry)
    }
    baseline = true
    const next = new Map<string, FollowRequest>()
    for (const item of await read(() => client.decision.list({ signal }))) {
      if (!scope.has(item.sessionID)) continue
      if (!requestKinds.includes(item.kind) || !followID(item.id)) throw new FollowError("invalid-native-data")
      const request = { kind: item.kind, sessionID: item.sessionID, id: item.id }
      next.set(key(request), request)
      if (next.size > followLedgerLimit) throw new FollowError("budget-exhausted")
    }
    const receipts: FollowReceipt[] = []
    for (const [id, request] of next) if (!pending.has(id) && remember(requestSeen, id)) receipts.push({ kind: "pending", sessionID: request.sessionID, id: request.id, requestKind: request.kind })
    for (const [id, request] of pending) if (!next.has(id) && !terminalSeen.has(id)) receipts.push({ kind: "no-longer-pending", sessionID: request.sessionID, id: request.id, requestKind: request.kind, resolution: "unknown" })
    pending.clear()
    for (const [id, request] of next) pending.set(id, request)
    for (const entry of starting) {
      entries.set(entry.id, entry)
      entry.task = pump(entry).catch((error: unknown) => { failure = error; wake() })
    }
    ready = true
    for (const receipt of receipts) await send(receipt)
  }
  const pause = async (ms: number) => {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
      const timer = setTimeout(done, ms)
      signal.addEventListener("abort", done, { once: true })
    })
  }
  const aborted = () => wake()
  signal.addEventListener("abort", aborted, { once: true })
  let heartbeatPending = false
  const heartbeat = setInterval(() => {
    if (!ready || heartbeatPending) return
    heartbeatPending = true
    send({ kind: "heartbeat", sessionID: root, rootActive }).catch((error: unknown) => { failure = error; wake() }).finally(() => { heartbeatPending = false })
  }, options.heartbeatSeconds * 1000)
  try {
    const target = await read(() => client.session.get({ sessionID: root }, { signal }))
    if (target.id !== root || target.parentID !== undefined) throw new FollowError("root-required")
    let globalFailures = 0
    let reconnect = false
    while (!signal.aborted) {
      if (reconnect) await delay(globalBackoff)
      if (signal.aborted) break
      const stream = new AbortController()
      const reading = AbortSignal.any([signal, stream.signal])
      let iterator: AsyncIterator<FollowEvent> | undefined
      try {
      iterator = client.event.subscribe({ signal: reading })[Symbol.asyncIterator]()
      const current = iterator
      const readNext = () => current.next().then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }))
      let next: ReturnType<typeof readNext> | undefined
      try {
        const first = await iterator.next()
        if (signal.aborted) break
        if (first.done) {
          if (++globalFailures >= 10) throw new FollowError("budget-exhausted")
          globalBackoff++
          reconnect = true
          continue
        }
        if (first.value.type !== "server.connected") throw new FollowError("invalid-native-data")
        if (first.value.sourceEpoch !== undefined) {
          if (!followID(first.value.sourceEpoch)) throw new FollowError("invalid-native-data")
          if (epoch !== undefined && first.value.sourceEpoch !== epoch) throw new FollowError("epoch-mismatch")
          epoch = first.value.sourceEpoch
        }
        await reconcile(reconnect)
        if (first.value.sourceEpoch !== undefined && first.value.sourceEpoch !== epoch) throw new FollowError("epoch-mismatch")
        await send({ kind: "ready", sessionID: root, rootActive })
        next = readNext()
        while (!signal.aborted) {
          if (failure !== undefined) throw failure
          if (dirty) {
            dirty = false
            const pendingOnly = reviewDirty && ![...entries.values()].some((entry) => entry.restart)
            reviewDirty = false
            await reconcile(false, undefined, pendingOnly)
            continue
          }
          const changed = new Promise<{ kind: "dirty" }>((resolve) => { notify = () => resolve({ kind: "dirty" }) })
          const item = await Promise.race([next.then((result) => ({ kind: "global" as const, result })), changed])
          notify = undefined
          if (signal.aborted) break
          if (item.kind === "dirty") continue
          if (item.result.error !== undefined) throw item.result.error
          if (!item.result.result || item.result.result.done) break
          next = readNext()
          const event = item.result.result.value
          if (event.sourceEpoch !== undefined && event.sourceEpoch !== epoch) continue
          const data = record(event.data)
          const form = event.type === "form.created" ? record(data.form) : undefined
          const id = form ? form.sessionID : data.sessionID
          if (!(typeof id === "string" && scope.has(id)) && !(event.type === "session.created" && typeof data.parentID === "string" && scope.has(data.parentID))) continue
          const [requestKind, phase] = event.type.split(".")
          let usable = false
          if (["form", "question", "guardrail", "permission"].includes(requestKind!) && typeof id === "string") {
            const asked = phase === "asked" || event.type === "form.created"
            const terminal = ["replied", "cancelled", "timed_out", "rejected"].includes(phase!)
            const requestID = asked ? form ? form.id : data.id : requestKind === "form" ? data.id : data.requestID
            if (followID(requestID) && (asked || terminal)) {
              usable = true
              const request = { kind: requestKind!, sessionID: id, id: requestID }
              const requestKey = key(request)
              if (remember(asked ? requestSeen : terminalSeen, requestKey)) {
                const previouslyPending = pending.has(requestKey)
                if (asked) pending.set(requestKey, request)
                else pending.delete(requestKey)
                if (!asked || !previouslyPending) await send({ kind: asked ? "request-observed" : phase === "replied" ? "reply-observed" : "request-ended-observed",
                  sessionID: id, id: requestID, requestKind,
                  resolution: asked ? "unknown" : phase === "replied" ? "reply-observed" : phase as "cancelled" | "timed_out" | "rejected" })
              }
            }
          }
          if (event.type === "session.created" && typeof id === "string" && !scope.has(id)) {
            if (!followID(id) || !id.startsWith("ses")) throw new FollowError("invalid-native-data")
            await reconcile(false, id)
            usable = true
          }
          if (/^session\.review\./.test(event.type)) { await reconcile(false, undefined, true); usable = true }
          if (event.type === "session.status" && id === root) {
            const status = record(data.status)
            if (status.type === "idle") { rootActive = false; usable = true }
            if (["busy", "retry"].includes(String(status.type))) { rootActive = true; usable = true }
          }
          if (usable && event.sourceEpoch === epoch) globalFailures = 0
        }
      } finally {
        stream.abort()
        try {
          const pendingRead = await next
          if (pendingRead?.error !== undefined && !ownedFollowAbort(pendingRead.error, reading)) throw pendingRead.error
        } finally {
          try { await current.return?.() } catch (error) { if (!ownedFollowAbort(error, reading)) throw error }
        }
      }
      } catch (error) {
        if (ownedFollowAbort(error, signal) || !transport(error) || failure !== undefined) throw error
      } finally { stream.abort() }
      if (signal.aborted) break
      if (++globalFailures >= 10) throw new FollowError("budget-exhausted")
      globalBackoff++
      reconnect = true
    }
    graceful = true
  } catch (error) { if (!ownedFollowAbort(error, signal)) throw error; graceful = true }
  finally {
    clearInterval(heartbeat)
    signal.removeEventListener("abort", aborted)
    local.abort()
    for (const entry of entries.values()) entry.controller.abort()
    await Promise.all([...entries.values()].map(stop))
    await output
    if (graceful && ready && failure === undefined && epoch !== undefined && entries.has(root)) await send({ kind: "closed", sessionID: root, rootActive })
    if (failure !== undefined) throw failure
  }
}
