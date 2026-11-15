import { createHash } from "node:crypto"
import { ClientError, type DecisionItem } from "@ycoding-ai/client/promise"
import { shellCommand } from "../../decision"
import { dotsFailureText, dotsRejection, type DotsRejection } from "../dots/rejection"
import { decisionText, line } from "./decision-text"
import { ownedFollowAbort, type FollowReceipt } from "./follow"
import {
  announcedKey, deliveryBatchLimit, deliveryKey, deliveryLifecycleTypes, deliveryOwnershipTypes, dotDeliveryTarget, FollowError, followLedgerLimit, requestKinds,
  type DeliveryEvent, type DeliveryTarget, type FollowState,
} from "./follow-state"

type ReadOptions = { signal: AbortSignal }
type Admission = "started" | "steered" | "duplicate" | "unknown"
type Batch = NonNullable<DeliveryTarget["inflight"]>
type Listing = { readonly rootThreadID?: string; readonly threads: readonly { readonly threadID: string }[] }
export type DeliveryClient = {
  decision: { list(options: ReadOptions): Promise<readonly DecisionItem[]> }
  dots: {
    threads(options: ReadOptions): Promise<Listing>
    resume(options: ReadOptions): Promise<unknown>
    thread: { send(input: { threadID: string; text: string; clientMessageID: string; mode: "send" }, options: ReadOptions): Promise<{ admission: Admission; turnID?: string }> }
  }
}
export type DeliveryReceipt = { kind: "delivery"; target: string; threadID: string; clientMessageID: string; mode: "send"; outcome: "delivered" | "unknown" | "failed"
  admission?: Admission; rejection?: DotsRejection; events: DeliveryEvent[] }

const blockLimit = 1500
const failureLimit = 10
const lifecyclePhrases: Record<string, string> = {
  "session.execution.started": "execution started",
  "session.execution.succeeded": "execution succeeded",
  "session.execution.failed": "execution failed",
  "session.execution.interrupted": "execution interrupted",
  "session.work.completed": "accepted a work-completion receipt",
}
const transport = (error: unknown) => error instanceof ClientError && error.reason === "Transport"
const baseKey = (kind: string, sessionID: string, id: string) => `${kind}\0${sessionID}\0${id}`
const indent = (text: string) => text.split("\n").map((value) => `   ${value}`).join("\n")

function resolveTarget(listing: Listing, target: string) {
  if (target === dotDeliveryTarget) return listing.rootThreadID
  return listing.threads.some((thread) => thread.threadID === target) ? target : undefined
}

function deliverable(receipt: FollowReceipt, root: string): DeliveryEvent | undefined {
  if (receipt.kind === "reconciliation" && receipt.id !== undefined && receipt.reason !== undefined && receipt.evidence !== undefined)
    return { sessionID: receipt.sessionID, id: receipt.id, type: "watch.reconciliation", reason: receipt.reason, evidence: receipt.evidence }
  if (receipt.id === undefined) return undefined
  if ((receipt.kind === "durable" || receipt.kind === "interruption") && receipt.type !== undefined && deliveryLifecycleTypes.includes(receipt.type) && receipt.seq !== undefined && !receipt.compaction &&
    (receipt.type === "session.execution.failed" || receipt.type === "session.execution.interrupted" && receipt.sessionID === root && receipt.unrecovered && !receipt.rootActive))
    return { sessionID: receipt.sessionID, id: receipt.id, type: receipt.type, seq: receipt.seq }
  if (!["pending", "request-observed", "project-escalation"].includes(receipt.kind) || receipt.requestKind === undefined || !requestKinds.includes(receipt.requestKind)) return undefined
  return { sessionID: receipt.sessionID, id: receipt.id, requestKind: receipt.requestKind,
    ...(receipt.parentID === undefined ? {} : { parentID: receipt.parentID }), ...(receipt.fingerprint === undefined ? {} : { fingerprint: receipt.fingerprint }),
    ...(receipt.revision === undefined ? {} : { revision: receipt.revision }), ...(receipt.kind === "project-escalation" ? { escalated: true as const } : {}) }
}

function messageID(root: string, threadID: string, events: readonly DeliveryEvent[]) {
  const hash = createHash("sha256").update(JSON.stringify([root, threadID, events.map(deliveryKey)])).digest("hex")
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${"89ab"[Number.parseInt(hash.charAt(16), 16) & 3]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function eventText(event: DeliveryEvent, items: readonly DecisionItem[]) {
  if (event.type === "watch.reconciliation") return `Session ${event.sessionID}: ${event.reason}; ${event.evidence}.\n   Inspect/resume: ${shellCommand(["ycoding", "decision", "watch", event.sessionID, "--family"])}`
  if (event.snapshot) return [
    `Project ${event.id} ownership when this watch started (current state, not a change; revision ${event.revision}): ${(event.members ?? []).map((member) =>
      `member ${member.sessionID} ${member.ownerSessionID === undefined ? "has no owner" : `is owned by ${member.ownerSessionID}`}`).join("; ")}.`,
    `   Read: ${shellCommand(["ycoding", "api", "coordination.get", "--param", `groupID=${event.id}`])}`,
  ].join("\n")
  if (event.type !== undefined && deliveryOwnershipTypes.includes(event.type)) return [
    `Project ${event.id}: member ${event.sessionID} ${event.ownerSessionID === undefined ? "has no owner" : `is owned by ${event.ownerSessionID}`}${event.removed ? "; its ownership record was removed" : ""} (${event.type}, revision ${event.revision}).`,
    `   Read: ${shellCommand(["ycoding", "api", "coordination.get", "--param", `groupID=${event.id}`])}`,
  ].join("\n")
  if (event.type !== undefined) return [
    `Session ${event.sessionID} ${lifecyclePhrases[event.type]} (event ${event.id}, seq ${event.seq}).`,
    `   Read: ${shellCommand(["ycoding", "api", "session.snapshot", "--param", `sessionID=${event.sessionID}`, "--param", "limit=50"])}`,
  ].join("\n")
  const title = `${event.requestKind} ${event.id} pending in ${event.sessionID}${event.parentID === undefined ? "" : ` (parent ${event.parentID})`}${event.escalated ? ", escalated to the user by its Project" : ""}.`
  if (event.requestKind === "child-question") return [title,
    ...(event.parentID === undefined ? [] : [
      `   Answer [template]: ${shellCommand(["ycoding", "api", "session.subagent.answer", "--param", `parentID=${event.parentID}`, "--param", `childID=${event.sessionID}`,
        "--param", `questionID=${event.id}`, "--data", JSON.stringify({ text: "<answer:text>" })])}`,
      "      Replace <answer:text> with the answer text.",
      `   Read: ${shellCommand(["ycoding", "api", "session.subagent.list", "--param", `parentID=${event.parentID}`])}`,
    ]),
  ].join("\n")
  const item = items.find((candidate) => candidate.kind === event.requestKind && candidate.sessionID === event.sessionID && candidate.id === event.id)
  const detail = item === undefined ? "   It is not listed by ycoding decision list now; it may have settled." : indent([line(item.summary), ...decisionText(item).split("\n").slice(1)].join("\n"))
  return [title, detail.length > blockLimit ? "   It is too large to include here; run ycoding decision list --json for its decide commands." : detail,
    ...(item === undefined ? ["   Read: ycoding decision list --json"] : [])].join("\n")
}

export function createFollowDelivery(client: DeliveryClient, options: {
  state: FollowState; targets: readonly string[]; signal: AbortSignal
  ready: Promise<void>
  save(state: FollowState): Promise<void>
  emit(record: FollowReceipt | DeliveryReceipt): Promise<void>
}) {
  const root = options.state.rootSessionID
  const requested = [...new Set(options.targets)].toSorted()
  const existing = options.state.delivery
  if (requested.length === 0 || existing?.targets.some((target) => !requested.includes(target.target) && (target.inflight !== undefined || target.outbox.length > 0)))
    throw new FollowError("delivery-targets-changed")
  const signal = options.signal
  const targets: DeliveryTarget[] = structuredClone(existing?.targets.filter((target) => requested.includes(target.target)) ?? [])
  for (const target of requested) if (!targets.some((saved) => saved.target === target)) targets.push({ target, outbox: [] })
  const announced = new Map((existing?.announced ?? []).map((key) => [key, 0]))
  const unsaved = new Set<DeliveryEvent>()
  let generation = 0
  let started = false
  let resumedMissingRoot = false
  let last = options.state
  let chain = Promise.resolve()
  let notify: (() => void) | undefined
  const wake = () => { notify?.(); notify = undefined }
  const snapshot = (): FollowState => ({ ...last, delivery: { announced: [...announced.keys()], targets: structuredClone(targets) } })
  const persist = () => {
    const next = chain.then(async () => {
      const saving = [...unsaved]
      await options.save(snapshot())
      for (const event of saving) unsaved.delete(event)
      wake()
    })
    chain = next.catch(() => {})
    return next
  }
  const ready = (target: DeliveryTarget) => target.outbox.filter((event) => !unsaved.has(event) && (started || !event.snapshot))
  const record = (target: DeliveryTarget, batch: Batch, outcome: DeliveryReceipt["outcome"], detail: { admission?: Admission; rejection?: DotsRejection } = {}) =>
    options.emit({ kind: "delivery", target: target.target, threadID: batch.threadID, clientMessageID: batch.clientMessageID, mode: "send", outcome,
      ...(detail.admission === undefined ? {} : { admission: detail.admission }), ...(detail.rejection === undefined ? {} : { rejection: detail.rejection }), events: batch.events })
  const resolveAll = (listing: Listing) => new Map(targets.map((target) => {
    const threadID = resolveTarget(listing, target.target)
    if (threadID === undefined) throw new FollowError("delivery-target-unavailable")
    return [target, threadID] as const
  }))
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
  const read = async <T>(operation: () => Promise<T>): Promise<T | "retry"> => {
    try { return await operation() } catch (error) {
      if (ownedFollowAbort(error, signal)) throw error
      if (transport(error)) return "retry"
      throw new FollowError("delivery-failed")
    }
  }
  const prune = (items: readonly DecisionItem[], before: number) => {
    const live = new Set([...last.pending, ...items].map((item) => baseKey(item.kind, item.sessionID, item.id)))
    for (const [key, added] of announced) if (added <= before && !live.has(key.replace(/^project-escalation:/, ""))) announced.delete(key)
  }
  const pass = async (): Promise<"done" | "retry"> => {
    const listing = await read(() => client.dots.threads({ signal }))
    if (listing === "retry") return "retry"
    const before = generation
    const items = await read(() => client.decision.list({ signal }))
    if (items === "retry") return "retry"
    prune(items, before)
    const resolved = resolveAll(listing)
    let formed = false
    for (const target of targets) {
      const threadID = resolved.get(target)!
      if (target.inflight !== undefined) {
        if (target.inflight.threadID === threadID) continue
        const events = target.inflight.events
        target.inflight = { threadID, clientMessageID: messageID(root, threadID, events), events }
        formed = true
        continue
      }
      const events = ready(target).slice(0, deliveryBatchLimit)
      if (!events.length) continue
      target.inflight = { threadID, clientMessageID: messageID(root, threadID, events), events }
      target.outbox = target.outbox.filter((event) => !events.includes(event))
      formed = true
    }
    if (formed) await persist()
    let retry = false
    for (const target of targets) {
      const batch = target.inflight
      if (batch === undefined) continue
      const text = [`YCoding watch (${root}):`,
        ...batch.events.map((event, index) => `${index + 1}. ${eventText(event, items)}`)].join("\n")
      let admission: Admission
      try {
        admission = (await client.dots.thread.send({ threadID: batch.threadID, text, clientMessageID: batch.clientMessageID, mode: "send" }, { signal })).admission
      } catch (error) {
        if (ownedFollowAbort(error, signal)) throw error
        if (!transport(error)) {
          const rejection = dotsRejection(error)
          const reason = dotsFailureText(error)
          await record(target, batch, "failed", rejection === undefined ? {} : { rejection })
          if (target.target === dotDeliveryTarget && !resumedMissingRoot && rejection?.message?.includes("thread not found")) {
            resumedMissingRoot = true
            try {
              await client.dots.resume({ signal })
              const listing = await client.dots.threads({ signal })
              if (listing.rootThreadID !== undefined && listing.rootThreadID !== batch.threadID) return "retry"
            } catch (resumeError) {
              if (ownedFollowAbort(resumeError, signal)) throw resumeError
            }
          }
          throw new FollowError("delivery-failed", reason === undefined ? undefined : `${batch.threadID}: ${reason}`)
        }
        admission = "unknown"
      }
      if (admission !== "started" && admission !== "steered" && admission !== "duplicate") {
        await record(target, batch, "unknown", admission === "unknown" ? { admission } : {})
        retry = true
        continue
      }
      await record(target, batch, "delivered", { admission })
      if (target.target === dotDeliveryTarget) resumedMissingRoot = false
      target.inflight = undefined
      await persist()
    }
    return retry ? "retry" : "done"
  }
  return {
    state: { ...options.state, delivery: { announced: [...announced.keys()], targets: structuredClone(targets) } } satisfies FollowState,
    async emit(receipt: FollowReceipt) {
      await options.emit(receipt)
      if (receipt.kind === "ready" && !started) {
        started = true
        wake()
        return
      }
      const event = deliverable(receipt, root)
      if (event?.requestKind !== undefined) {
        const key = announcedKey(event)
        if (announced.has(key)) return
        if (announced.size >= followLedgerLimit) throw new FollowError("budget-exhausted")
        announced.set(key, ++generation)
      }
      if (event !== undefined) {
        for (const target of targets) {
          if (target.outbox.length >= followLedgerLimit) throw new FollowError("budget-exhausted")
          const copy = { ...event }
          target.outbox.push(copy)
          unsaved.add(copy)
        }
        return
      }
      if (!["reply-observed", "request-ended-observed"].includes(receipt.kind) || receipt.requestKind === undefined || receipt.id === undefined) return
      const ended = baseKey(receipt.requestKind, receipt.sessionID, receipt.id)
      announced.delete(ended)
      announced.delete(`project-escalation:${ended}`)
      for (const target of targets) target.outbox = target.outbox.filter((item) =>
        item.requestKind === undefined || baseKey(item.requestKind, item.sessionID, item.id) !== ended)
    },
    save(state: FollowState) {
      last = state
      return persist()
    },
    async run() {
      try {
        for (let failures = 0; ;) {
          const listing = await read(() => client.dots.threads({ signal }))
          if (listing !== "retry") {
            resolveAll(listing)
            break
          }
          if (++failures >= failureLimit) throw new FollowError("delivery-failed")
          await pause(100 * 2 ** Math.min(failures - 1, 6))
          if (signal.aborted) return
        }
        let failures = 0
        await new Promise<void>((resolve, reject) => {
          const done = () => { signal.removeEventListener("abort", done); resolve() }
          options.ready.then(done, (error: unknown) => { signal.removeEventListener("abort", done); reject(error) })
          if (signal.aborted) done()
          else signal.addEventListener("abort", done, { once: true })
        })
        while (!signal.aborted) {
          if (!targets.some((target) => target.inflight !== undefined || ready(target).length > 0)) {
            await new Promise<void>((resolve) => {
              const done = () => { signal.removeEventListener("abort", done); notify = undefined; resolve() }
              notify = done
              if (signal.aborted) done()
              else signal.addEventListener("abort", done, { once: true })
            })
            continue
          }
          if (await pass() === "done") { failures = 0; continue }
          if (++failures >= failureLimit) throw new FollowError("delivery-failed")
          await pause(100 * 2 ** Math.min(failures - 1, 6))
        }
      } catch (error) {
        if (ownedFollowAbort(error, signal)) return
        throw error instanceof FollowError ? error : new FollowError("delivery-failed")
      }
    },
  }
}
