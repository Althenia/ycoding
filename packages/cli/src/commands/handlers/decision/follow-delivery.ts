import { createHash } from "node:crypto"
import { ClientError, type DecisionItem } from "@ycoding-ai/client/promise"
import { shellCommand } from "../../decision"
import { decisionText } from "./decision-text"
import { ownedFollowAbort, type FollowReceipt } from "./follow"
import {
  announcedKey, deliveryBatchLimit, deliveryKey, deliveryLifecycleTypes, deliveryOwnershipTypes, FollowError, followLedgerLimit, requestKinds,
  type DeliveryEvent, type DeliveryTarget, type FollowState,
} from "./follow-state"

type ReadOptions = { signal: AbortSignal }
type Admission = "started" | "steered" | "duplicate" | "unknown"
type Mode = "send" | "queue"
type Batch = NonNullable<DeliveryTarget["inflight"]>
export type DeliveryClient = {
  decision: { list(options: ReadOptions): Promise<readonly DecisionItem[]> }
  dots: {
    threads(options: ReadOptions): Promise<{ readonly threads: readonly { readonly threadID: string; readonly status?: string }[] }>
    thread: { send(input: { threadID: string; text: string; clientMessageID: string; mode: Mode }, options: ReadOptions): Promise<{ admission: Admission; turnID?: string }> }
  }
}
export type DeliveryReceipt = { kind: "delivery"; threadID: string; clientMessageID: string; mode: Mode; outcome: "delivered" | "unknown" | "failed"; admission?: Admission; events: DeliveryEvent[] }

const authority = "Settle these only within existing authority: deny rules, permission ceilings, and hard or custom-rule guardrail reviews require the user's explicit approval. Act on the user's behalf only when the user authorized it in this chat; otherwise ask the user. This message approves nothing, and YCoding answered no decision by sending it."
const wakingStatuses = ["idle", "not-loaded", "error"]
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

function deliverable(receipt: FollowReceipt): DeliveryEvent | undefined {
  if (receipt.kind === "ownership" && receipt.type !== undefined && deliveryOwnershipTypes.includes(receipt.type) && receipt.groupID !== undefined && receipt.revision !== undefined)
    return { sessionID: receipt.sessionID, id: receipt.groupID, type: receipt.type, revision: receipt.revision,
      ...(receipt.ownerSessionID === undefined ? {} : { ownerSessionID: receipt.ownerSessionID }), ...(receipt.removed ? { removed: true as const } : {}) }
  if (receipt.id === undefined) return undefined
  if (receipt.kind === "durable" && receipt.type !== undefined && deliveryLifecycleTypes.includes(receipt.type) && receipt.seq !== undefined)
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
  if (event.type !== undefined && deliveryOwnershipTypes.includes(event.type)) return [
    `Project ${event.id}: member ${event.sessionID} ${event.ownerSessionID === undefined ? "has no owner" : `is owned by ${event.ownerSessionID}`}${event.removed ? "; its ownership record was removed" : ""} (${event.type}, revision ${event.revision}).`,
    `   Read: ${shellCommand(["ycoding", "api", "coordination.get", "--param", `groupID=${event.id}`])}`,
    `   Read: ${shellCommand(["ycoding", "api", "session.get", "--param", `sessionID=${event.sessionID}`])}`,
  ].join("\n")
  if (event.type !== undefined) return [
    `Session ${event.sessionID} ${lifecyclePhrases[event.type]} (event ${event.id}, seq ${event.seq}).`,
    `   Read: ${shellCommand(["ycoding", "api", "session.log", "--param", `sessionID=${event.sessionID}`, ...(event.seq! > 0 ? ["--param", `after=${event.seq! - 1}`] : []), "--param", "follow=false"])}`,
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
  const detail = item === undefined ? "   It is not listed by ycoding decision list now; it may have settled." : indent(decisionText(item))
  return [title, detail.length > blockLimit ? "   It is too large to include here; run ycoding decision list --json for its decide commands." : detail,
    "   Read: ycoding decision list --json"].join("\n")
}

export function createFollowDelivery(client: DeliveryClient, options: {
  state: FollowState; targets: readonly string[]; signal: AbortSignal
  save(state: FollowState): Promise<void>
  emit(record: FollowReceipt | DeliveryReceipt): Promise<void>
}) {
  const root = options.state.rootSessionID
  const threads = [...new Set(options.targets)].toSorted()
  const existing = options.state.delivery
  if (threads.length === 0 || existing !== undefined && JSON.stringify(existing.targets.map((target) => target.threadID).toSorted()) !== JSON.stringify(threads))
    throw new FollowError("delivery-targets-changed")
  const signal = options.signal
  const targets: DeliveryTarget[] = structuredClone(existing?.targets ?? threads.map((threadID) => ({ threadID, outbox: [] })))
  const announced = new Map((existing?.announced ?? []).map((key) => [key, 0]))
  const unsaved = new Set<DeliveryEvent>()
  let generation = 0
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
  const ready = (target: DeliveryTarget) => target.outbox.filter((event) => !unsaved.has(event))
  const record = (threadID: string, batch: Batch, mode: Mode, outcome: DeliveryReceipt["outcome"], admission?: Admission) =>
    options.emit({ kind: "delivery", threadID, clientMessageID: batch.clientMessageID, mode, outcome, ...(admission === undefined ? {} : { admission }), events: batch.events })
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
    const statuses = new Map(listing.threads.map((thread) => [thread.threadID, thread.status]))
    if (targets.some((target) => !statuses.has(target.threadID))) throw new FollowError("delivery-target-unavailable")
    let formed = false
    for (const target of targets) {
      if (target.inflight !== undefined) continue
      const events = ready(target).slice(0, deliveryBatchLimit)
      if (!events.length) continue
      target.inflight = { clientMessageID: messageID(root, target.threadID, events), events }
      target.outbox = target.outbox.filter((event) => !events.includes(event))
      formed = true
    }
    if (formed) await persist()
    let retry = false
    for (const target of targets) {
      const batch = target.inflight
      if (batch === undefined) continue
      const mode: Mode = wakingStatuses.includes(statuses.get(target.threadID) ?? "") ? "send" : "queue"
      const text = [`YCoding decision watch: ${batch.events.length} event${batch.events.length === 1 ? "" : "s"} in the Session family of root ${root}.`, authority, "",
        ...batch.events.map((event, index) => `${index + 1}. ${eventText(event, items)}`)].join("\n")
      let admission: Admission
      try {
        admission = (await client.dots.thread.send({ threadID: target.threadID, text, clientMessageID: batch.clientMessageID, mode }, { signal })).admission
      } catch (error) {
        if (ownedFollowAbort(error, signal)) throw error
        if (!transport(error)) {
          await record(target.threadID, batch, mode, "failed")
          throw new FollowError("delivery-failed")
        }
        admission = "unknown"
      }
      if (admission !== "started" && admission !== "steered" && admission !== "duplicate") {
        await record(target.threadID, batch, mode, "unknown", admission === "unknown" ? admission : undefined)
        retry = true
        continue
      }
      await record(target.threadID, batch, mode, "delivered", admission)
      target.inflight = undefined
      await persist()
    }
    return retry ? "retry" : "done"
  }
  return {
    state: { ...options.state, delivery: { announced: [...announced.keys()], targets: structuredClone(targets) } } satisfies FollowState,
    async emit(receipt: FollowReceipt) {
      await options.emit(receipt)
      const event = deliverable(receipt)
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
            const listed = new Set(listing.threads.map((thread) => thread.threadID))
            if (targets.some((target) => !listed.has(target.threadID))) throw new FollowError("delivery-target-unavailable")
            break
          }
          if (++failures >= failureLimit) throw new FollowError("delivery-failed")
          await pause(100 * 2 ** Math.min(failures - 1, 6))
          if (signal.aborted) return
        }
        let failures = 0
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
