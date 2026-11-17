export * as SessionDecisions from "./decisions"

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Session } from "@ycoding-ai/schema/session"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventTable, isReviewType } from "../event/sql"
import { LocationServiceMap } from "../location-service-map"
import { Permission } from "../permission"
import { Question } from "../question"
import { Form } from "../form"
import { SessionGuardrail } from "./guardrail"
import { SessionReviewFold } from "./review-fold"
import { SessionTable } from "./sql"

export interface Decide {
  readonly label: string
  readonly argv: readonly string[]
  readonly template?: true
  readonly hint?: string
}

export interface Item {
  readonly kind: "permission" | "guardrail" | "question" | "form" | "review"
  readonly sessionID: string
  readonly sessionTitle: string
  readonly directory: string
  readonly id: string
  readonly summary: string
  readonly options?: readonly Question.Info[] | Form.Fields | SessionReview.Payload
  readonly decide: readonly Decide[]
}

export interface Interface {
  readonly list: () => Effect.Effect<readonly Item[]>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionDecisions") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const database = yield* Database.Service
  const locations = yield* LocationServiceMap.Service
  return Service.of({ list: Effect.fn("SessionDecisions.list")(function* () {
    const loaded = yield* locations.loaded()
    const pending: { item: Omit<Item, "sessionTitle" | "directory">; directory: string }[] = []
    const add = (item: Omit<Item, "sessionTitle" | "directory">, directory: string) => {
      pending.push({ item, directory })
    }
    for (const entry of loaded) {
      if (entry.built.includes(Permission.node.name)) {
        const context = yield* locations.contextEffect(entry.ref, [Permission.node]).pipe(Effect.orDie)
        const service = Context.get(context, Permission.Service)
        for (const request of yield* service.list()) add({
          kind: "permission", sessionID: request.sessionID, id: request.id,
          summary: `${request.action}: ${request.resources.join(", ")}`,
          decide: replies().map((reply) => command(reply, "session.permission.reply", request.sessionID, "requestID", request.id, { reply })),
        }, entry.ref.directory)
      }
      if (entry.built.includes(SessionGuardrail.node.name)) {
        const context = yield* locations.contextEffect(entry.ref, [SessionGuardrail.node]).pipe(Effect.orDie)
        const service = Context.get(context, SessionGuardrail.Service)
        for (const request of yield* service.list()) add({
          kind: "guardrail", sessionID: request.sessionID, id: request.id,
          summary: `${request.action}: ${request.resources.join(", ")} — ${request.reason}`,
          decide: replies(request.hardReview).map((reply) => command(reply, "session.guardrail.request.reply", request.sessionID, "requestID", request.id, { reply })),
        }, entry.ref.directory)
      }
      if (entry.built.includes(Question.node.name)) {
        const context = yield* locations.contextEffect(entry.ref, [Question.node]).pipe(Effect.orDie)
        const service = Context.get(context, Question.Service)
        for (const request of yield* service.list()) add({
          kind: "question", sessionID: request.sessionID, id: request.id,
          summary: request.questions.map((question) => question.question).join("; "), options: request.questions,
          decide: [
            ...questionAnswers(request.questions).map((answer) => command(answer.label, "session.question.reply", request.sessionID, "requestID", request.id, { answers: answer.value }, answer.template)),
            command("Reject", "session.question.reject", request.sessionID, "requestID", request.id),
          ],
        }, entry.ref.directory)
      }
      if (entry.built.includes(Form.node.name)) {
        const context = yield* locations.contextEffect(entry.ref, [Form.node]).pipe(Effect.orDie)
        const service = Context.get(context, Form.Service)
        for (const request of yield* service.list()) add({
          kind: "form", sessionID: request.sessionID, id: request.id, summary: request.title, options: request.fields,
          decide: [
            ...formAnswers(request.fields).map((answer) => command(answer.label, "session.form.reply", request.sessionID, "formID", request.id, { answer: answer.value }, answer.template, request.sessionID === "global" ? entry.ref.directory : undefined)),
            command("Cancel", "session.form.cancel", request.sessionID, "formID", request.id, undefined, undefined, request.sessionID === "global" ? entry.ref.directory : undefined),
          ],
        }, entry.ref.directory)
      }
    }
    const reviews = yield* database.db.select({
      id: EventTable.id, aggregate: EventTable.aggregate_id, type: EventTable.type, created: EventTable.created, revision: EventTable.seq,
      itemID: sql<unknown>`json_extract(${EventTable.data}, '$.itemID')`,
      data: sql<unknown>`CASE WHEN ${EventTable.type} = ${SessionReviewFold.deferredType} THEN NULL ELSE ${EventTable.data} END`.mapWith(EventTable.data),
    }).from(EventTable)
      .innerJoin(SessionTable, eq(SessionTable.id, EventTable.aggregate_id))
      .where(and(
        isReviewType(EventTable.type),
        inArray(EventTable.type, [SessionReviewFold.deferredType, SessionReviewFold.decidedType, SessionReviewFold.withdrawnType]),
        isNull(SessionTable.time_archived),
      ))
      .orderBy(asc(EventTable.seq))
      .all().pipe(Effect.orDie)
    const deferred = reviews.filter((row) => row.type === SessionReviewFold.deferredType)
    const aggregates = new Set(deferred.map((row) => row.aggregate))
    const closers = reviews.filter((row) => row.type !== SessionReviewFold.deferredType && aggregates.has(row.aggregate))
    const latest = new Map(deferred.flatMap((row) => typeof row.itemID === "string" ? [[row.itemID, row.revision] as const] : []))
    const closed = new Set(closers.flatMap((row) => {
      const itemID = SessionReviewFold.closedItem(row)
      const last = itemID === undefined ? undefined : latest.get(itemID)
      return itemID !== undefined && last !== undefined && row.revision > last ? [itemID] : []
    }))
    const candidates = deferred.filter((row) => typeof row.itemID === "string" && !closed.has(row.itemID))
    const payloads = candidates.length === 0 ? [] : yield* database.db.select({ id: EventTable.id, data: EventTable.data }).from(EventTable)
      .where(inArray(EventTable.id, candidates.map((row) => row.id))).all().pipe(Effect.orDie)
    const data = new Map(payloads.map((row) => [row.id, row.data]))
    const open = new Set(candidates.map((row) => row.itemID))
    const folded = SessionReviewFold.foldRows([
      ...candidates.map((row) => ({ ...row, data: data.get(row.id) })),
      ...closers.filter((row) => open.has(row.itemID)),
    ].toSorted((left, right) => left.revision - right.revision)).filter(SessionReviewFold.isOpen)
    for (const item of folded) {
      const payload = item.payload
      const choices: { label: string; value: unknown; template?: true }[] =
        payload.type === "permission" || payload.type === "guardrail"
          ? replies(payload.type === "guardrail" && payload.hardReview).map((reply) => ({ label: reply, value: { kind: payload.type, reply } }))
          : payload.type === "recovery"
            ? (["continue", "stop"] as const).map((choice) => ({ label: choice, value: { kind: "recovery", choice } }))
            : payload.type === "subagent_question"
              ? [{ label: "Reply (replace answer values)", template: true, value: { kind: "subagent_question", text: "<answer:text>" } }, { label: "Dismiss", value: { kind: "subagent_question", dismissed: true } }]
              : [
                  ...(payload.type === "question" ? questionAnswers(payload.questions) : formAnswers(payload.fields)).map((answer) => ({ label: answer.label, template: answer.template, value: { kind: "question" as const, answers: answer.value } })),
                  { label: "Dismiss", value: { kind: "question", dismissed: true } },
                ]
      add({ kind: "review", sessionID: item.sessionID, id: item.itemID, summary: reviewSummary(payload), options: payload,
        decide: choices.map((choice) => command(choice.label, "session.review.decide", item.sessionID, "itemID", item.itemID, { decision: choice.value }, choice.template)),
      }, "")
    }
    const ids = [...new Set(pending.map((entry) => entry.item.sessionID).filter(Schema.is(Session.ID)))]
    const sessions = ids.length === 0 ? [] : yield* database.db.select({ id: SessionTable.id, title: SessionTable.title, directory: SessionTable.directory })
      .from(SessionTable).where(and(inArray(SessionTable.id, ids), isNull(SessionTable.time_archived))).all().pipe(Effect.orDie)
    const owners = new Map<string, typeof sessions[number]>(sessions.map((session) => [session.id, session]))
    return pending.flatMap(({ item, directory }): Item[] => {
      const owner = owners.get(item.sessionID)
      if (!owner && item.sessionID !== "global") return []
      return [{ ...item, sessionTitle: owner?.title ?? "Global", directory: owner?.directory ?? directory }]
    })
  }, Effect.scoped) })
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, LocationServiceMap.node] })

function command(label: string, operation: string, sessionID: string, key: string, id: string, body?: unknown, template?: true, directory?: string): Decide {
  return { label, argv: ["ycoding", "api", operation, "--param", `sessionID=${sessionID}`, "--param", `${key}=${id}`,
    ...(directory === undefined ? [] : ["--header", `x-ycoding-directory:${directory}`]),
    ...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
  ], ...(template ? { template, hint: "Replace each entire quoted placeholder, including its quotes, with a JSON value matching options. Replace <answer:fields> with the complete answer object, including only active fields." } : {}) }
}

function replies(hard = false): ("once" | "always" | "reject")[] {
  return hard ? ["once", "reject"] : ["once", "always", "reject"]
}

function questionAnswers(questions: readonly Question.Info[]) {
  const single = questions.length === 1 ? questions[0] : undefined
  const finite = single?.options.map((option) => ({ label: option.label, value: [[option.label]], template: undefined })) ?? []
  return single && single.options.length > 0 && single.custom === false && !single.multiple ? finite : [
    ...finite,
    { label: "Reply (replace answer values)", value: questions.map((_, index) => [`<answer:${index}>`]), template: true as const },
  ]
}

function formAnswers(fields: Form.Fields): { label: string; value: Form.Answer | string; template?: true }[] {
  if (fields.some((field) => field.type !== "external" && field.when !== undefined)) return [
    { label: "Reply (replace answer values)", value: "<answer:fields>", template: true },
  ]
  const field = fields.length === 1 ? fields[0] : undefined
  const finite = field && (field.type === "string" || field.type === "multiselect") && field.options && (field.type !== "multiselect" || (field.minItems ?? 0) <= 1)
    ? field.options.map((option) => ({ label: option.label, value: { [field.key]: field.type === "multiselect" ? [option.value] : option.value } })) : []
  return field?.type === "string" && finite.length > 0 && field.custom === false ? finite : [
    ...finite,
    { label: "Reply (replace answer values)", value: Object.fromEntries(fields.map((field) => [field.key, `<answer:${field.key}>`])), template: true },
  ]
}

function reviewSummary(payload: SessionReview.Payload) {
  if (payload.type === "permission") return `${payload.action}: ${payload.resources.join(", ")}`
  if (payload.type === "guardrail") return `${payload.action}: ${payload.resources.join(", ")} — ${payload.reason}`
  if (payload.type === "question") return payload.questions.map((question) => question.question).join("; ")
  if (payload.type === "form") return payload.title
  if (payload.type === "subagent_question") return payload.text
  return `Recovery: ${payload.tools.map((tool) => tool.name).join(", ")}`
}
