import { Effect, Option } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import {
  YCoding,
  type DecisionItem,
  type EventSubscribeOutput,
  type SessionLogOutput,
  type SessionOrchestrationSummary,
  type SessionOrchestrationTask,
  type SessionTodoInfo,
} from "@ycoding-ai/client/promise"
import { DecisionCommand, shellCommand, watchTimeout } from "../../decision"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"

type Client = ReturnType<typeof YCoding.make>
type LogEvent = Exclude<SessionLogOutput, { type: "log.synced" }>
type Terminal = Extract<LogEvent, { type: "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted" }>
type Status = "succeeded" | "failed" | "interrupted" | "rejected" | "unknown"
type Ref = { readonly id: string; readonly seq: number }
type Receipt = Ref & { readonly inputID: string; readonly assistantMessageID: string }

type Options = {
  readonly sessionID: string
  readonly input?: string
  readonly after?: number
  readonly family: boolean
  readonly timeout: number
  readonly server?: string
  readonly standalone: boolean
  readonly json: boolean
}

type Execution = {
  start?: { readonly seq: number; readonly id: string }
  startedAt?: number
  inputIDs: string[]
  toolCalls: number
  latest?: string
}

type Settled = {
  readonly status: Status
  readonly inputIDs: string[]
  readonly startedAt?: string
  readonly settledAt?: string
  readonly startEvent?: Ref
  readonly endEvent?: Ref
  readonly error?: { readonly type: string; readonly message: string }
  readonly reason?: string
  readonly response?: string
  readonly truncated?: true
}

type Oversized = { readonly kind: DecisionItem["kind"]; readonly id: string; readonly sessionID: string }

type TaskRef = {
  readonly sessionID: string
  readonly parentID: string
  readonly state: SessionOrchestrationTask["state"]
  readonly revision: number
  readonly description: string
  readonly questionID?: string
  readonly recoveryItemID?: string
}

type Work = {
  readonly state: "running" | "needs-decision" | "lost" | "background" | "unconfirmed" | "completed" | "incomplete" | "idle"
  readonly receipt?: Receipt & { readonly current: boolean }
  readonly todos: { readonly sessionID: string; readonly open: number; readonly items: SessionTodoInfo[] }
  readonly decisions: DecisionItem[]
  readonly oversized?: Oversized[]
  readonly omitted?: number
  readonly tasks: TaskRef[]
  readonly omittedTasks?: number
  readonly children: SessionOrchestrationSummary
  readonly omittedParents?: number
  readonly running: string[]
  readonly lost: string[]
  readonly pending: number
}

type Outcome =
  | { readonly outcome: "decision"; readonly decisions: DecisionItem[]; readonly oversized: Oversized[]; readonly omitted: number }
  | { readonly outcome: "settled"; readonly execution: Settled; readonly work?: Work }
  | { readonly outcome: "timeout"; readonly state: "running" | "unconfirmed" | "idle"; readonly work?: Work }

const responseLimit = 4_000
const latestLimit = 500
const decisionLimit = 20
const decisionBytes = 256 * 1024
const resubscribeLimit = 10
const snapshotLimit = 200
const todoLimit = 10
const taskPageLimit = 10
const taskParentLimit = 20
const assessmentReserveMs = 5_000
const activeTaskStates: readonly string[] = ["starting", "running", "waiting", "cancelling"]
const exitCodes = { settled: 0, decision: 2, timeout: 3 } as const

class InputBeforeCursor extends Error {}

const iso = (millis: number) => new Date(millis).toISOString()
const line = (value: string) => value.replaceAll(/[\u0000-\u001f\u007f]/g, " ")
const block = (value: string) => value.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")

function bounded(value: string, limit: number) {
  return value.length > limit ? { text: value.slice(0, limit), truncated: true as const } : { text: value }
}

function message(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

function eventSessionID(event: EventSubscribeOutput) {
  const data: unknown = event.data
  if (typeof data !== "object" || data === null) return undefined
  if ("sessionID" in data && typeof data.sessionID === "string") return data.sessionID
  if ("rootSessionID" in data && typeof data.rootSessionID === "string") return data.rootSessionID
  if ("form" in data && typeof data.form === "object" && data.form !== null && "sessionID" in data.form && typeof data.form.sessionID === "string")
    return data.form.sessionID
  return undefined
}

function quiet(event: EventSubscribeOutput) {
  return event.type.endsWith(".delta") || event.type === "session.tool.progress"
}

export function resumeCommand(options: Options, after: number | undefined, withInput = true) {
  return ["ycoding", "decision", "watch", options.sessionID, ...(options.family ? ["--family"] : []),
    ...(!withInput || options.input === undefined ? [] : ["--input", options.input]), ...(after === undefined ? [] : ["--after", String(after)]),
    ...(options.server === undefined ? [] : ["--server", options.server]), ...(options.standalone ? ["--standalone"] : []),
    ...(options.timeout === watchTimeout ? [] : ["--timeout", String(options.timeout)]), ...(options.json ? ["--json"] : [])]
}

function decisionText(item: DecisionItem) {
  const lines = [`${item.kind} ${item.id} in "${line(item.sessionTitle)}" (${item.sessionID}): ${line(item.summary)}`]
  for (const choice of item.decide) {
    lines.push(`  ${line(choice.label)}${choice.template ? " [template]" : ""}: ${shellCommand(choice.argv)}`)
    if (choice.hint) lines.push(`    ${line(choice.hint)}`)
  }
  return lines.join("\n")
}

export function selectDecisions(items: readonly DecisionItem[], json: boolean) {
  const seen = new Set<string>()
  const unique = items.filter((item) => {
    const key = `${item.kind}\0${item.sessionID}\0${item.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const decisions: DecisionItem[] = []
  const oversized: Oversized[] = []
  let used = 0
  for (const item of unique.slice(0, decisionLimit)) {
    const size = Buffer.byteLength(json ? JSON.stringify(item) : decisionText(item))
    if (used + size > decisionBytes) {
      oversized.push({ kind: item.kind, id: item.id, sessionID: item.sessionID })
      continue
    }
    used += size
    decisions.push(item)
  }
  return { decisions, oversized, omitted: Math.max(0, unique.length - decisionLimit) }
}

export async function watchSession(client: Client, options: Options, cancel: AbortSignal) {
  const deadline = Date.now() + options.timeout * 1_000
  const expiry = new AbortController()
  const timer = setTimeout(() => expiry.abort(), options.timeout * 1_000)
  try {
    return await watchUntil(client, options, cancel, AbortSignal.any([cancel, expiry.signal]), deadline)
  } finally {
    clearTimeout(timer)
  }
}

async function watchUntil(client: Client, options: Options, cancel: AbortSignal, signal: AbortSignal, deadline: number) {
  const target = await client.session.get({ sessionID: options.sessionID }, { signal })
  if (options.family && target.parentID !== undefined) throw new Error("--family requires a root Session")
  let cursor = options.after
  if (cursor === undefined && options.input === undefined)
    cursor = (await client.session.snapshot({ sessionID: target.id, limit: 1 }, { signal })).watermark.seq
  let family = new Set([target.id])
  let execution: Execution | undefined
  let input: "not-seen" | "admitted" | "promoted" = "not-seen"
  let own: { readonly seq: number; readonly execution: Execution } | undefined
  let check: { readonly start: { readonly seq: number; readonly id: string }; readonly result: Settled; readonly unproven: Settled } | undefined
  let settled: Settled | undefined
  let located = false
  let promotionChecked = false
  let receipt: Receipt | undefined
  let superseded = false
  let ended = false

  const descendants = async () => {
    const found = new Set([target.id])
    const queue = [target.id]
    while (queue.length) {
      const parentID = queue.shift()!
      let page: string | undefined
      do {
        const result = await client.session.list({ parentID, limit: 200, ...(page === undefined ? {} : { cursor: page }) }, { signal })
        for (const child of result.data) if (!found.has(child.id)) { found.add(child.id); queue.push(child.id) }
        page = result.cursor.next ?? undefined
      } while (page !== undefined)
    }
    return found
  }

  const response = async (settled: Settled) => {
    const from = options.input ?? settled.inputIDs[0]
    if (from === undefined) return undefined
    const messages = (await client.session.snapshot({ sessionID: target.id, limit: snapshotLimit }, { signal })).messages
    const start = messages.findIndex((item) => item.type === "user" && item.id === from) + 1
    if (start === 0) return undefined
    const end = messages.findIndex((item, index) => index >= start && item.type === "user" && !settled.inputIDs.includes(item.id))
    const text = messages.slice(start, end < 0 ? undefined : end).flatMap((item) => item.type !== "assistant" ? [] : [
      item.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim(),
    ]).filter(Boolean).at(-1)
    return text === undefined ? undefined : bounded(text, responseLimit)
  }

  const unknown = (): Settled => ({ status: "unknown", inputIDs: [options.input!] })

  const result = (event: Terminal, current: Execution | undefined, attributed: boolean): Settled => {
    const details = {
      inputIDs: attributed ? current?.inputIDs ?? [] : [],
      ...(attributed && current?.startedAt !== undefined ? { startedAt: iso(current.startedAt) } : {}),
      settledAt: iso(event.created),
      ...(attributed && current?.start !== undefined ? { startEvent: { id: current.start.id, seq: current.start.seq } } : {}),
      endEvent: { id: event.id, seq: event.durable.seq },
    }
    if (event.type === "session.execution.succeeded") return { status: "succeeded", ...details }
    if (event.type === "session.execution.interrupted") return { status: "interrupted", ...details, reason: event.data.reason }
    return { status: event.data.error.type === "interrupted" ? "interrupted" : "failed", ...details, error: event.data.error }
  }

  const terminal = (event: Terminal) => {
    const current = execution
    execution = undefined
    if (options.input === undefined) {
      if (current?.start) check = { start: current.start, result: result(event, current, true), unproven: result(event, current, false) }
      else settled = result(event, current, false)
      return
    }
    if (own === undefined) return
    if (!own.execution.start) {
      settled = unknown()
      return
    }
    const outcome = result(event, own.execution, true)
    check = { start: own.execution.start, result: outcome, unproven: unknown() }
  }

  const track = (event: LogEvent) => {
    if (event.type === "session.work.completed") {
      receipt = { id: event.id, seq: event.durable.seq, inputID: event.data.inputID, assistantMessageID: event.data.assistantMessageID }
      superseded = false
      return
    }
    if (event.type === "session.input.admitted" || event.type === "session.execution.started") superseded ||= receipt !== undefined
    if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") ended = true
  }

  const apply = (event: LogEvent) => {
    track(event)
    switch (event.type) {
      case "session.deleted":
        throw new Error(`Session was deleted: ${target.id}`)
      case "session.input.admitted":
        if (event.data.inputID === options.input && input === "not-seen") input = "admitted"
        return
      case "session.execution.started":
        if (own !== undefined) {
          settled = unknown()
          return
        }
        execution = { start: { seq: event.durable.seq, id: event.id }, startedAt: event.created, inputIDs: [], toolCalls: 0 }
        return
      case "session.input.promoted":
      case "session.input.consumed": {
        const ids = event.type === "session.input.promoted" ? [event.data.inputID] : event.data.inputIDs
        execution ??= { inputIDs: [], toolCalls: 0 }
        for (const id of ids) if (!execution.inputIDs.includes(id)) {
          execution.inputIDs.push(id)
          if (id === options.input && own === undefined) {
            own = { seq: event.durable.seq, execution }
            input = "promoted"
          }
        }
        return
      }
      case "session.tool.called":
        if (execution) execution.toolCalls++
        return
      case "session.text.ended":
        if (execution) execution.latest = event.data.text
        return
      case "session.dots.instruction.rejected":
        if (event.data.inputID === options.input && own === undefined)
          settled = { status: "rejected", inputIDs: [event.data.inputID], settledAt: iso(event.created), endEvent: { id: event.id, seq: event.durable.seq }, reason: event.data.reason }
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        terminal(event)
        return
    }
  }

  const retained = async (start: { readonly seq: number; readonly id: string }) => {
    const reading = new AbortController()
    try {
      for await (const item of client.session.log({ sessionID: target.id, follow: false, ...(start.seq > 0 ? { after: start.seq - 1 } : {}) },
        { signal: AbortSignal.any([signal, reading.signal]) })) {
        if (item.type === "log.synced") return false
        return item.durable.seq === start.seq && item.id === start.id
      }
      return false
    } finally {
      reading.abort()
    }
  }

  const read = async () => {
    for await (const item of client.session.log({ sessionID: target.id, follow: false, ...(cursor === undefined ? {} : { after: cursor }) }, { signal })) {
      if (item.type === "log.synced") {
        if (item.seq !== undefined) cursor = Math.max(cursor ?? item.seq, item.seq)
        continue
      }
      if (item.durable.aggregateID !== target.id || (cursor !== undefined && item.durable.seq <= cursor)) continue
      apply(item)
      cursor = item.durable.seq
      if (settled || check || (own && !own.execution.start && !located)) return
    }
  }

  const locate = async (current: { readonly seq: number; readonly execution: Execution }) => {
    located = true
    let found: Execution | undefined
    const reading = new AbortController()
    try {
      for await (const item of client.session.log({ sessionID: target.id, follow: false }, { signal: AbortSignal.any([signal, reading.signal]) })) {
        if (item.type === "log.synced" || item.durable.seq >= current.seq) break
        if (item.type === "session.execution.started") found = { start: { seq: item.durable.seq, id: item.id }, startedAt: item.created, inputIDs: [], toolCalls: 0 }
        else if (item.type === "session.execution.succeeded" || item.type === "session.execution.failed" || item.type === "session.execution.interrupted") found = undefined
        else if (found && (item.type === "session.input.promoted" || item.type === "session.input.consumed"))
          for (const id of item.type === "session.input.promoted" ? [item.data.inputID] : item.data.inputIDs) if (!found.inputIDs.includes(id)) found.inputIDs.push(id)
      }
    } finally {
      reading.abort()
    }
    if (!found?.start) return
    current.execution.start = found.start
    current.execution.startedAt = found.startedAt
    current.execution.inputIDs.unshift(...found.inputIDs.filter((id) => !current.execution.inputIDs.includes(id)))
  }

  const correlate = async () => {
    for (;;) {
      await read()
      if (settled) return
      if (own && !own.execution.start && !located) {
        await locate(own)
        continue
      }
      if (!check) return
      const pending = check
      check = undefined
      if (await retained(pending.start)) {
        settled = pending.result
        return
      }
      settled = pending.unproven
      return
    }
  }

  const promotedBeforeCursor = async () => {
    if (promotionChecked || options.input === undefined || options.after === undefined || input === "promoted") return false
    promotionChecked = true
    const messages = (await client.session.snapshot({ sessionID: target.id, limit: snapshotLimit }, { signal })).messages
    if (!messages.some((item) => item.type === "user" && item.id === options.input)) return false
    await correlate()
    return !settled && own === undefined
  }

  const untilDeadline = (error: unknown) => {
    if (cancel.aborted || !signal.aborted) throw error
    return undefined
  }

  const tail = async (from: number | undefined) => {
    let reopened = false
    for await (const item of client.session.log({ sessionID: target.id, follow: false, ...(from === undefined ? {} : { after: from }) }, { signal })) {
      if (item.type === "log.synced" || item.durable.aggregateID !== target.id || (from !== undefined && item.durable.seq <= from)) continue
      track(item)
      if (item.type === "session.execution.started") reopened = true
      if (item.type === "session.execution.succeeded" || item.type === "session.execution.failed" || item.type === "session.execution.interrupted") reopened = false
    }
    return reopened
  }

  const assess = async (settlement: { readonly settled: boolean; readonly reopened: boolean }) => {
    const [active, outstanding, todos, pending, items, scope] = await Promise.all([
      client.session.active({ signal }),
      client.session.outstanding(undefined, { signal }),
      client.session.todo.list({ sessionID: target.id }, { signal }),
      client.session.pending.list({ sessionID: target.id }, { signal }),
      client.decision.list({ signal }),
      options.family ? descendants() : Promise.resolve(new Set([target.id])),
    ])
    const scoped = (ids: readonly string[]) => [...new Set(ids)].filter((id) => scope.has(id)).toSorted()
    const running = scoped(outstanding.running)
    const lost = scoped(outstanding.lost)
    const parents = [target.id, ...scoped([...outstanding.data, ...outstanding.lost]).filter((id) => id !== target.id)]
    const pages = await Promise.all(parents.slice(0, taskParentLimit).map((parentID) => client.session.subagent.list({ parentID, limit: taskPageLimit }, { signal })))
    const tasks = pages.flatMap((page) => page.data)
      .filter((task) => activeTaskStates.includes(task.state) || task.question !== undefined || task.stoppedRecovery !== undefined || (task.state === "lost" && lost.includes(task.parentID)))
      .map((task): TaskRef => ({
        sessionID: task.sessionID, parentID: task.parentID, state: task.state, revision: task.revision, description: bounded(task.description, latestLimit).text,
        ...(task.question === undefined ? {} : { questionID: task.question.id }),
        ...(task.stoppedRecovery === undefined ? {} : { recoveryItemID: task.stoppedRecovery.itemID }),
      }))
    const children = pages.reduce((sum, page) => ({ total: sum.total + page.summary.total, active: sum.active + page.summary.active,
      running: sum.running + page.summary.running, waiting: sum.waiting + page.summary.waiting }), { total: 0, active: 0, running: 0, waiting: 0 })
    const omittedTasks = children.active - tasks.filter((task) => activeTaskStates.includes(task.state)).length
    const omittedParents = parents.length - Math.min(parents.length, taskParentLimit)
    const open = todos.filter((item) => item.status === "pending" || item.status === "in_progress")
    const selected = selectDecisions(items.filter((item) => scope.has(item.sessionID)), options.json)
    const current = receipt !== undefined && !superseded
    const executing = active[target.id] !== undefined || settlement.reopened
    const blocked = selected.decisions.length + selected.oversized.length + selected.omitted > 0 || children.waiting > 0 ||
      tasks.some((task) => task.state === "waiting" || task.questionID !== undefined || task.recoveryItemID !== undefined)
    const state: Work["state"] = blocked ? "needs-decision"
      : executing ? "running"
      : lost.length ? "lost"
      : running.length || pending.length || children.active > 0 ? "background"
      : !settlement.settled && execution !== undefined ? "unconfirmed"
      : current ? "completed"
      : settlement.settled || receipt !== undefined || ended || open.length ? "incomplete"
      : "idle"
    const work: Work = {
      state,
      ...(receipt === undefined ? {} : { receipt: { ...receipt, current } }),
      todos: { sessionID: target.id, open: open.length, items: open.slice(0, todoLimit).map((item) => ({ ...item, content: bounded(item.content, latestLimit).text })) },
      decisions: selected.decisions,
      ...(selected.oversized.length ? { oversized: selected.oversized } : {}),
      ...(selected.omitted ? { omitted: selected.omitted } : {}),
      tasks,
      ...(omittedTasks > 0 ? { omittedTasks } : {}),
      children,
      ...(omittedParents > 0 ? { omittedParents } : {}),
      running,
      lost,
      pending: pending.length,
    }
    return { work, executing }
  }

  const report = async (execution: Settled): Promise<Outcome> => {
    const text = execution.status === "unknown" || execution.status === "rejected" ? undefined
      : await response(execution).catch(untilDeadline)
    const assessed = await tail(cursor).then((reopened) => assess({ settled: true, reopened })).catch(untilDeadline)
    return {
      outcome: "settled",
      execution: text === undefined ? execution : { ...execution, response: text.text, ...(text.truncated ? { truncated: text.truncated } : {}) },
      ...(assessed === undefined ? {} : { work: assessed.work }),
    }
  }

  const timedOut = async (): Promise<Outcome> => {
    const assessed = await assess({ settled: false, reopened: false }).catch(untilDeadline)
    const state = assessed?.executing ? "running" as const : execution === undefined ? "idle" as const : "unconfirmed" as const
    return { outcome: "timeout", state, ...(assessed === undefined ? {} : { work: assessed.work }) }
  }

  const evaluate = async (): Promise<Outcome | undefined> => {
    await correlate()
    if (settled) return report(settled)
    if (await promotedBeforeCursor())
      throw new InputBeforeCursor(`Input ${options.input} ran at or before --after ${options.after}; rerun without --after`)
    if (settled) return report(settled)
    if (options.family) family = await descendants()
    const selected = selectDecisions((await client.decision.list({ signal })).filter((item) => family.has(item.sessionID)), options.json)
    if (selected.decisions.length + selected.oversized.length > 0) return { outcome: "decision", ...selected }
    return undefined
  }

  const relevant = (event: EventSubscribeOutput) => {
    if (quiet(event)) return false
    if (options.family && event.type === "session.created") return true
    const sessionID = eventSessionID(event)
    return sessionID !== undefined && family.has(sessionID)
  }

  const anchor = () => {
    if (settled || options.input === undefined || own === undefined) return cursor
    const seq = (own.execution.start?.seq ?? own.seq) - 1
    if (seq < 0) return undefined
    return cursor === undefined ? seq : Math.min(seq, cursor)
  }

  const next = async (iterator: AsyncIterator<EventSubscribeOutput>) => {
    const remaining = deadline - Math.min(assessmentReserveMs, options.timeout * 200) - Date.now()
    if (remaining <= 0) return "timeout" as const
    const pending = iterator.next()
    pending.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remaining) })
    try {
      return await Promise.race([pending, expired])
    } finally {
      clearTimeout(timer)
    }
  }

  const finish = (outcome: Outcome) => ({
    outcome, target, after: outcome.outcome === "settled" ? cursor : anchor(), execution,
    input: options.input === undefined ? undefined : input,
  })

  try {
    for (let subscriptions = 0; ; subscriptions++) {
      if (subscriptions > resubscribeLimit) throw new Error("The server event stream keeps closing")
      const stream = new AbortController()
      const iterator = client.event.subscribe({ signal: AbortSignal.any([signal, stream.signal]) })[Symbol.asyncIterator]()
      try {
        const connected = await next(iterator)
        if (connected === "timeout") return finish(await timedOut())
        if (connected.done || connected.value.type !== "server.connected") throw new Error("The server event stream is unavailable")
        const initial = await evaluate()
        if (initial) return finish(initial)
        for (;;) {
          const result = await next(iterator).catch(() => ({ done: true as const, value: undefined }))
          if (result === "timeout") return finish(await timedOut())
          if (result.done) break
          if (!relevant(result.value)) continue
          const outcome = await evaluate()
          if (outcome) return finish(outcome)
        }
      } finally {
        stream.abort()
        await iterator.return?.().catch(() => undefined)
      }
    }
  } catch (error) {
    if (cancel.aborted || error instanceof InputBeforeCursor) throw error
    if (signal.aborted) return finish({ outcome: "timeout", state: execution === undefined ? "idle" : "unconfirmed" })
    throw new Error(`${message(error)}; resume with: ${shellCommand(resumeCommand(options, anchor()))}`)
  }
}

function render(options: Options, result: Awaited<ReturnType<typeof watchSession>>) {
  const json = options.json
  const { outcome, target, after, execution, input } = result
  const session = `Session "${line(target.title)}" (${target.id})`
  const resume = resumeCommand(options, after)
  if (outcome.outcome === "decision") {
    if (json) return { outcome: "decision", sessionID: target.id, ...(after === undefined ? {} : { after }), decisions: outcome.decisions,
      ...(outcome.oversized.length ? { oversized: outcome.oversized } : {}), ...(outcome.omitted ? { omitted: outcome.omitted } : {}), resume }
    const lines = [`Pending decision in ${session}. A listed item can settle by its own mode or appear twice while it moves to the review box; each decide command rechecks it.`,
      ...decisionLines(outcome.decisions, outcome.oversized, outcome.omitted), `Resume after deciding: ${shellCommand(resume)}`]
    return lines.join("\n")
  }
  if (outcome.outcome === "settled") {
    const settled = outcome.execution
    const next = resumeCommand(options, after, false)
    if (json) return { outcome: "settled", sessionID: target.id, ...(after === undefined ? {} : { after }), execution: settled,
      ...(outcome.work === undefined ? {} : { work: outcome.work }), resume: next }
    const lines = [settled.status === "rejected" ? `Input rejected in ${session}.`
      : settled.status === "unknown" ? `The execution that ran input ${settled.inputIDs.join(", ")} in ${session} has ended, but its retained history no longer proves the result. Read message.list; do not treat it as succeeded.`
      : `Execution ${settled.status} in ${session}.`]
    if (settled.status !== "unknown" && settled.inputIDs.length) lines.push(`Inputs: ${settled.inputIDs.join(", ")}`)
    if (settled.startedAt) lines.push(`Started: ${settled.startedAt}`)
    if (settled.settledAt) lines.push(`Settled: ${settled.settledAt}`)
    if (settled.error) lines.push(`Error: ${line(settled.error.type)}: ${line(settled.error.message)}`)
    if (settled.reason) lines.push(`Reason: ${settled.reason}`)
    lines.push(...(outcome.work === undefined ? [unassessed] : workLines(outcome.work, options.family)))
    if (settled.response !== undefined) lines.push("Response:", block(settled.response))
    if (settled.truncated) lines.push(`[Response truncated to ${responseLimit} characters.]`)
    lines.push(`Watch the next transition: ${shellCommand(next)}`)
    return lines.join("\n")
  }
  const latest = execution?.latest === undefined ? undefined : bounded(execution.latest, latestLimit).text
  const progress = {
    state: outcome.state,
    ...(execution?.startedAt === undefined ? {} : { startedAt: iso(execution.startedAt) }),
    ...(execution === undefined ? {} : { toolCalls: execution.toolCalls }),
    ...(input === undefined ? {} : { input }),
    ...(latest === undefined ? {} : { latest }),
  }
  if (json) return { outcome: "timeout", sessionID: target.id, ...(after === undefined ? {} : { after }), progress,
    ...(outcome.work === undefined ? {} : { work: outcome.work }), resume }
  const since = `${progress.startedAt ? ` since ${progress.startedAt}` : ""}${progress.toolCalls === undefined ? "" : `; ${progress.toolCalls} tool calls`}`
  const state = progress.state === "idle" ? "idle" : progress.state === "running" ? `running${since}`
    : `unconfirmed; retained history shows an open execution${since}, but the connected service does not report it active`
  return [
    `No pending decision or settlement in ${session} within ${options.timeout}s.`,
    `State: ${state}${options.input === undefined ? "" : `; input ${options.input} ${input}`}`,
    ...(latest === undefined ? [] : [`Latest: ${line(latest)}`]),
    ...(outcome.work === undefined ? [unassessed] : workLines(outcome.work, options.family)),
    `Resume: ${shellCommand(resume)}`,
  ].join("\n")
}

const unassessed = "Work not assessed: the Session state could not be read before the deadline."

function decisionLines(decisions: readonly DecisionItem[], oversized: readonly Oversized[], omitted: number) {
  return [
    ...decisions.map(decisionText),
    ...oversized.map((item) => `${item.kind} ${item.id} in ${item.sessionID} is too large to print here; run ycoding decision list --json for its decide commands.`),
    ...(omitted ? [`${omitted} more decisions omitted; run ycoding decision list.`] : []),
  ]
}

function workLines(work: Work, family: boolean) {
  const open = `${work.todos.open} open todo${work.todos.open === 1 ? "" : "s"}`
  const hiddenWaiting = work.children.waiting - work.tasks.filter((task) => task.state === "waiting").length
  const childDecision = !family && (work.children.waiting > 0 || work.tasks.some((task) => task.questionID !== undefined || task.recoveryItemID !== undefined))
  const summary = {
    "needs-decision": `Work needs a decision before it can continue.${childDecision ? " Add --family to list child Session decisions." : ""}`,
    running: "Work running: the Session is executing.",
    lost: "Work lost: the service restarted while work was active and did not resume it. Resume or cancel it explicitly.",
    background: "Work continues in the background without a decision.",
    unconfirmed: "Work unconfirmed: retained history shows an open execution that the connected service does not report as active; it may run in another service process or have ended without a terminal event.",
    completed: "Work completed: an accepted completion receipt is current.",
    incomplete: `Work incomplete: ${[work.receipt?.current ? undefined : work.receipt ? "the completion receipt was superseded" : "no accepted completion receipt",
      work.todos.open ? open : undefined].filter(Boolean).join("; ")}.`,
    idle: "Work idle: nothing is running and no settlement was observed.",
  }[work.state]
  const lines = [summary]
  if (work.receipt) lines.push(`Receipt: ${work.receipt.id} (seq ${work.receipt.seq}) accepted input ${work.receipt.inputID} with message ${work.receipt.assistantMessageID}.${work.receipt.current ? "" : " A later input or execution superseded it."}`)
  if (work.todos.open) lines.push(`Open todos in ${work.todos.sessionID} (${work.todos.open}):`, ...work.todos.items.map((item) => `  [${item.status}] ${line(item.content)}`),
    ...(work.todos.open > work.todos.items.length ? [`  ${work.todos.open - work.todos.items.length} more not listed; run ycoding api server.session.session.todo.list --param sessionID=${work.todos.sessionID}`] : []))
  if (work.children.total) lines.push(`Child tasks: ${work.children.active} of ${work.children.total} active.`)
  lines.push(...work.tasks.map((task) => `  ${task.sessionID} ${task.state} revision ${task.revision} (parent ${task.parentID}): ${line(task.description)}${task.questionID ? `; question ${task.questionID}` : ""}${task.recoveryItemID ? `; recovery review ${task.recoveryItemID}` : ""}`))
  const subagents = family
    ? `ycoding api session.subagent.list --param parentID=<parent-session-id> for each parent Session in the family, starting with ${work.todos.sessionID}, and follow cursor.next`
    : `ycoding api session.subagent.list --param parentID=${work.todos.sessionID} and follow cursor.next`
  if (work.omittedTasks) lines.push(`  ${work.omittedTasks} more active child task${work.omittedTasks === 1 ? "" : "s"} not listed${hiddenWaiting > 0 ? ` (${hiddenWaiting} waiting on a decision)` : ""}; run ${subagents}.`)
  if (work.omittedParents) lines.push(`  Child tasks of ${work.omittedParents} more family Session${work.omittedParents === 1 ? " were" : "s were"} not read; run ${subagents}.`)
  if (work.running.length) lines.push(`Running: ${work.running.join(", ")}`)
  if (work.lost.length) lines.push(`Lost: ${work.lost.join(", ")}`)
  if (work.pending) lines.push(`Pending inputs: ${work.pending}`)
  lines.push(...decisionLines(work.decisions, work.oversized ?? [], work.omitted ?? 0))
  return lines
}

export default Runtime.handler(DecisionCommand.commands.watch, Effect.fn("cli.decision.watch")(function* (input) {
  const options: Options = {
    sessionID: input.session,
    family: input.family,
    timeout: input.timeout,
    standalone: input.standalone,
    json: input.json,
    ...Option.match(input.server, { onNone: () => ({}), onSome: (value) => ({ server: value }) }),
    ...Option.match(input.input, { onNone: () => ({}), onSome: (value) => ({ input: value }) }),
    ...Option.match(input.after, { onNone: () => ({}), onSome: (value) => ({ after: value }) }),
  }
  if (!options.sessionID.trim()) return yield* Effect.fail(new Error("A Session ID is required"))
  if (options.input !== undefined && !options.input.trim()) return yield* Effect.fail(new Error("--input requires an input ID"))
  if (options.after !== undefined && options.after < 0) return yield* Effect.fail(new Error("--after must be a nonnegative sequence"))
  if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 3_600) return yield* Effect.fail(new Error("--timeout must be between 1 and 3600 seconds"))
  const connection = yield* ServerConnection.resolve({ server: options.server, standalone: options.standalone, mismatch: "ignore" })
  const client = YCoding.make({ baseUrl: connection.endpoint.url, headers: Service.headers(connection.endpoint) })
  const result = yield* Effect.tryPromise({ try: (signal) => watchSession(client, options, signal), catch: (error) => new Error(message(error)) })
  const output = render(options, result)
  yield* Effect.sync(() => {
    process.stdout.write(`${typeof output === "string" ? output : JSON.stringify(output)}\n`)
    process.exitCode = exitCodes[result.outcome.outcome]
  })
}, Effect.catch((error) => Effect.sync(() => {
  process.stderr.write(`ycoding: ${error.message}\n`)
  process.exitCode = 1
}))))
