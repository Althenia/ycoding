export * as SessionReview from "./review"

import { Session } from "../session"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { ModelIncident } from "../model-incident/index"
import { EventRuntime } from "../event"
import { Form } from "../form"
import { Question } from "../question"
import { PermissionSession } from "../permission/session"
import { SessionEvent } from "./event"
import { SessionExecution } from "./execution"
import { SessionMessage } from "./message"
import { SessionOrchestration } from "./orchestration"
import { SessionPending } from "./pending"
import { SessionReviewFold } from "./review-fold"
import { SessionTable } from "./sql"

export const ID = SessionReview.ID
export type ID = typeof ID.Type

export const FullError = SessionReviewFold.FullError
export const NotFoundError = SessionReviewFold.NotFoundError
export const ConflictError = SessionReviewFold.ConflictError
export const InvalidDecisionError = SessionReviewFold.InvalidDecisionError

export const fingerprint = SessionReviewFold.fingerprint
export const promptID = SessionReviewFold.promptID
export const pendingFingerprint = SessionReviewFold.pendingFingerprint

export interface DecideInput {
  readonly sessionID: Session.ID
  readonly itemID: ID
  readonly decision: SessionReview.Decision
}

export interface DelegatedDecideInput extends DecideInput {
  readonly explicitDecision?: true
  readonly fingerprint: string
  readonly source: Form.DotsClientReplySource
  readonly validate: () => Effect.Effect<boolean>
}

export type DecideError =
  | InstanceType<typeof NotFoundError>
  | InstanceType<typeof ConflictError>
  | InstanceType<typeof InvalidDecisionError>
  | Session.NotFoundError

export interface Interface {
  readonly decideDelegated: (input: DelegatedDecideInput) => Effect.Effect<void, DecideError>
  readonly pendingSnapshots: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<{ readonly item: SessionReview.Item; readonly fingerprint: string }>, Session.NotFoundError>
  readonly open: (
    input: SessionReviewFold.OpenInput,
  ) => Effect.Effect<SessionReview.Item, InstanceType<typeof FullError>>
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<SessionReview.Item>, Session.NotFoundError>
  readonly decide: (input: DecideInput) => Effect.Effect<void, DecideError>
  readonly withdraw: (sessionID: Session.ID, reason: "reverted" | "task_closed") => Effect.Effect<void>
  readonly withdrawAfter: (sessionID: Session.ID, messageID: SessionMessage.ID) => Effect.Effect<void>
  readonly consume: (
    sessionID: Session.ID,
    kind: "guardrail" | "permission",
    fingerprint: string,
  ) => Effect.Effect<boolean>
  readonly hasOpen: (sessionID: Session.ID) => Effect.Effect<boolean>
  readonly reconcile: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionReview") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventRuntime.Service
    const sessions = yield* Session.Service
    const orchestration = yield* SessionOrchestration.Service
    const permissions = yield* PermissionSession.Service
    const execution = yield* SessionExecution.Service
    const locks = KeyedMutex.makeUnsafe<ID>()

    const deliver = Effect.fnUntraced(function* (
      rootID: Session.ID,
      item: SessionReviewFold.Folded,
      decision: SessionReview.Decision,
      source?: Form.DotsClientReplySource,
      admit?: (text: string) => Effect.Effect<void, DecideError>,
    ) {
      const owner = item.sessionID
      const actor = source ? "The authenticated Dots client" : "The user"
      const prompt = (text: string) =>
        admit ? admit(text) : source ? sessions.synthetic({
          id: promptID(item.itemID), sessionID: owner, text, delivery: "steer",
          description: "Dots deferred decision", metadata: { review: { itemID: item.itemID, kind: item.kind }, dotsSource: source },
        }).pipe(Effect.mapError((error) => new InvalidDecisionError({ itemID: item.itemID, message: error.message })), Effect.asVoid) :
        sessions
          .prompt({
            id: promptID(item.itemID),
            sessionID: owner,
            text,
            delivery: "steer",
            origin: "review",
            metadata: { review: { itemID: item.itemID, kind: item.kind } },
          })
          .pipe(
            Effect.catchTag("Session.PromptConflictError", () => Effect.die(new Error("Review prompt conflict"))),
            Effect.catchTag("Session.AttachmentError", (error) => new InvalidDecisionError({ itemID: item.itemID, message: error.message })),
            Effect.asVoid,
          )
      if ("dismissed" in decision) {
        const text = `${actor} dismissed deferred question ${item.itemID} without answering; proceed on your own judgment.`
        if (item.kind === "subagent_question") return yield* answerChild(item, text, undefined, decision, source)
        return yield* prompt(text)
      }
      if (decision.kind === "subagent_question") return yield* answerChild(item, decision.text, decision.data, decision, source)
      if (decision.kind === "question") {
        if (item.payload.type === "question" && Array.isArray(decision.answers)) {
          const answers = decision.answers
          const formatted = item.payload.questions
            .map((question, index) => `"${question.question}"="${(answers[index] ?? []).join(", ")}"`)
            .join(", ")
          return yield* prompt(
            source ? `${actor} answered deferred questions ${item.itemID}: ${formatted}. Continue with the work that depended on it.`
              : `Decision on deferred questions ${item.itemID} (asked while the user slept): ${formatted}. Continue with the work that depended on it.`,
          )
        }
        if (item.payload.type === "form" && !Array.isArray(decision.answers)) {
          if (item.payload.questionTool) {
            const formatted = item.payload.fields
              .map((field) => {
                const value = (decision.answers as Record<string, unknown>)[field.key]
                const answer = Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value)
                return `"${field.description ?? field.title ?? field.key}"="${answer}"`
              })
              .join(", ")
            return yield* prompt(
              source ? `${actor} answered deferred questions ${item.itemID}: ${formatted}. Continue with the work that depended on it.`
                : `Decision on deferred questions ${item.itemID} (asked while the user slept): ${formatted}. Continue with the work that depended on it.`,
            )
          }
          return yield* prompt(
            `${actor} answered deferred form ${item.itemID} "${item.payload.title}": ${JSON.stringify(decision.answers)}. Continue with the work that depended on it.`,
          )
        }
        return yield* Effect.die(new Error("Review decision does not match its item payload"))
      }
      if (decision.kind === "guardrail" && item.payload.type === "guardrail") {
        if (decision.reply === "reject")
          return yield* prompt(
            `${actor} rejected deferred guardrail item ${item.itemID} (${item.payload.action}). Do not retry it; choose another approach or report the blocker to ${source ? "the Dots client" : "the user"}.`,
          )
        if (decision.reply === "always" && item.payload.directories.length > 0)
          yield* events.publish(SessionEvent.GuardrailApproved, {
            sessionID: rootID,
            directories: [...item.payload.directories],
          })
        const once = `${actor} approved deferred guardrail item ${item.itemID} once: ${item.payload.action} on ${item.payload.resources.join(", ")}. Re-issue exactly that action now if it is still needed; the approval covers one identical request from this Session.`
        return yield* prompt(
          decision.reply === "always" && item.payload.directories.length > 0
            ? `${once} Directories ${item.payload.directories.join(", ")} are approved for this Session family.`
            : once,
        )
      }
      if (decision.kind === "permission" && item.payload.type === "permission") {
        if (decision.reply === "reject")
          return yield* prompt(
            `${actor} rejected deferred permission item ${item.itemID} (${item.payload.action}). Do not retry it; choose another approach or report the blocker to ${source ? "the Dots client" : "the user"}.`,
          )
        if (decision.reply === "always" && item.payload.save && item.payload.save.length > 0) {
          yield* permissions.remember({ sessionID: owner, action: item.payload.action, resources: item.payload.save })
        }
        return yield* prompt(
          `${actor} approved deferred permission item ${item.itemID} ${decision.reply === "always" ? "always" : "once"}: ${item.payload.action} on ${item.payload.resources.join(", ")}. Re-issue exactly that action now if it is still needed; the approval covers one identical request from this Session.`,
        )
      }
      return yield* Effect.die(new Error("Review decision does not match its item"))
    })

    const answerChild = Effect.fnUntraced(function* (
      item: SessionReviewFold.Folded,
      text: string,
      data: Schema.Json | undefined,
      decision: SessionReview.Decision,
      source?: Form.DotsClientReplySource,
      dots?: SessionOrchestration.DotsSettlement,
    ) {
      if (!("questionID" in item.origin)) return yield* Effect.die(new Error("Subagent review item has no question"))
      const row = yield* db
        .select({ parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, item.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row?.parentID) return yield* Effect.die(new Error("Subagent review item has no parent Session"))
      yield* orchestration
        .answer({
          parentID: row.parentID,
          childID: item.sessionID,
          questionID: item.origin.questionID,
          text,
          ...(data === undefined ? {} : { data }),
          origin: source ? "dots-review" : "review",
          reviewDecision: { itemID: item.itemID, decision },
          ...(dots === undefined ? {} : { dots }),
        })
        .pipe(
          Effect.mapError((error) => new ConflictError({ itemID: item.itemID, message: error.message })),
        )
    })

    const decide = Effect.fn("SessionReview.decide")((input: DecideInput, dots?: DelegatedDecideInput) =>
      locks.withLock(input.itemID)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const family = yield* SessionReviewFold.familyFold(db, input.sessionID)
            if (!family) return yield* new Session.NotFoundError({ sessionID: input.sessionID })
            const item = family.folded.find((candidate) => candidate.itemID === input.itemID)
            if (!item) return yield* new NotFoundError({ itemID: input.itemID })
            if (dots && (!dots.explicitDecision || pendingFingerprint(item) !== dots.fingerprint || !(yield* dots.validate())))
              return yield* new ConflictError({ itemID: input.itemID, message: "Dots review authorization changed" })
            const owner = family.sessions.find((session) => session.id === item.sessionID)
            if (owner?.archived)
              return yield* new ConflictError({ itemID: input.itemID, message: "Review item belongs to an archived Session" })
            if (item.withdrawn !== undefined)
              return yield* new ConflictError({ itemID: input.itemID, message: "Review item was withdrawn" })
            if (item.decision !== undefined && !continuesStoppedRecovery(item.decision, input.decision))
              return yield* new ConflictError({ itemID: input.itemID, message: "Review item already decided" })
            const invalid = validate(item, input.decision)
            if (invalid) return yield* new InvalidDecisionError({ itemID: input.itemID, message: invalid })
            if (dots && "reply" in input.decision && input.decision.reply !== "once" && input.decision.reply !== "reject")
              return yield* new InvalidDecisionError({ itemID: input.itemID, message: "Dots decisions permit once or reject only" })
            const settlement = dots ? { explicitDecision: dots.explicitDecision, source: dots.source, fingerprint: dots.fingerprint, validate: dots.validate, target: { kind: "review" as const, itemID: item.itemID, fingerprint: dots.fingerprint } } : undefined
            if (item.kind === "subagent_question" && dots) {
              const decision = input.decision
              if (decision.kind !== "subagent_question") return yield* new InvalidDecisionError({ itemID: input.itemID, message: "Expected child question decision" })
              return yield* answerChild(item, "dismissed" in decision ? "The authenticated Dots client dismissed this question without an answer. Continue independent work; leave dependent work blocked." : decision.text,
                "data" in decision ? decision.data : undefined, decision, dots.source, settlement)
            }
            if (item.kind === "subagent_question") return yield* deliver(family.rootID, item, input.decision)
            if (input.decision.kind === "recovery" && "choice" in input.decision)
              return yield* orchestration
                .resolveRecovery({ childID: item.sessionID, itemID: item.itemID, choice: input.decision.choice, ...(settlement === undefined ? {} : { dots: settlement }) })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError((error) => new ConflictError({ itemID: item.itemID, message: error.message })),
                )
            const rejected =
              item.payload.type === "guardrail" && input.decision.kind === "guardrail" && input.decision.reply === "reject"
                ? item.payload
                : undefined
            const time = yield* Clock.currentTimeMillis
            const options = rejected ? {
              commit: () => ModelIncident.recordRejection(db, {
                sessionID: item.sessionID,
                requestID: rejected.requestID,
                ...("messageID" in item.origin ? { messageID: item.origin.messageID } : {}),
                ruleIDs: rejected.ruleIDs,
                hardReview: rejected.hardReview,
                decidedBy: "client",
                time,
              }),
            } : undefined
            if (dots) {
              return yield* deliver(family.rootID, item, input.decision, dots.source, (text) => Effect.gen(function* () {
                const committed = yield* events.publishBatch([
                  { definition: SessionEvent.InputAdmitted, data: { sessionID: item.sessionID, inputID: promptID(item.itemID),
                    input: SessionPending.Message.make({ type: "synthetic", delivery: "steer", data: {
                      text, description: "Dots deferred decision", metadata: { review: { itemID: item.itemID, kind: item.kind }, dotsSource: dots.source },
                    } }) } },
                  { definition: SessionEvent.Review.Decided, data: { sessionID: item.sessionID, itemID: item.itemID, decision: input.decision, source: dots.source }, options },
                  { definition: SessionEvent.DotsDecisionSettled, data: { sessionID: item.sessionID, source: dots.source, target: { kind: "review", itemID: item.itemID, fingerprint: dots.fingerprint } } },
                ], { when: Effect.gen(function* () {
                  const current = yield* SessionReviewFold.familyFold(db, input.sessionID)
                  const latest = current?.folded.find((candidate) => candidate.itemID === input.itemID)
                  return latest !== undefined && pendingFingerprint(latest) === dots.fingerprint &&
                    !current?.sessions.find((owner) => owner.id === latest.sessionID)?.archived &&
                    (yield* SessionPending.lookup(db, item.sessionID, promptID(item.itemID))) === undefined && (yield* dots.validate())
                }) })
                if (committed.length === 0) return yield* new ConflictError({ itemID: input.itemID, message: "Dots review changed before settlement" })
                if (!(yield* sessions.get(item.sessionID)).revert) yield* execution.wake(item.sessionID)
              }))
            }
            yield* events.publish(
              SessionEvent.Review.Decided,
              {
                sessionID: item.sessionID,
                itemID: item.itemID,
                decision: input.decision,
              },
              options,
            )
            return yield* deliver(family.rootID, item, input.decision)
          }),
        ),
      ),
    )

    const reconcile: Interface["reconcile"] = Effect.gen(function* () {
      const aggregates = yield* SessionReviewFold.decidedAggregates(db)
      for (const sessionID of aggregates) {
        const family = yield* SessionReviewFold.familyFold(db, sessionID)
        if (!family) continue
        for (const item of family.folded) {
          if (item.sessionID !== sessionID || item.decision === undefined || item.withdrawn !== undefined || item.kind === "recovery")
            continue
          if (item.kind === "subagent_question") {
            if ("questionID" in item.origin && (yield* SessionReviewFold.ownsQuestion(db, item.sessionID, item.origin.questionID)))
              yield* deliver(family.rootID, item, item.decision, item.source).pipe(Effect.ignore)
            continue
          }
          const admitted = yield* SessionPending.lookup(db, item.sessionID, promptID(item.itemID)).pipe(
            Effect.catchDefect(() => Effect.succeed(undefined)),
          )
          if (admitted === undefined) yield* deliver(family.rootID, item, item.decision, item.source).pipe(Effect.ignore)
        }
      }
    })

    yield* reconcile.pipe(Effect.catchCause(() => Effect.void), Effect.forkScoped)

    return Service.of({
      open: (input) => SessionReviewFold.open(db, events, input),
      list: Effect.fn("SessionReview.list")(function* (sessionID) {
        const family = yield* SessionReviewFold.familyFold(db, sessionID)
        if (!family) return yield* new Session.NotFoundError({ sessionID })
        const archived = new Set(family.sessions.filter((session) => session.archived).map((session) => session.id))
        return yield* Effect.forEach(
          family.folded.filter((item) => SessionReviewFold.isOpen(item) && !archived.has(item.sessionID)),
          (item) => SessionReviewFold.toItem(db, family.rootID, family.sessions, item),
        )
      }),
      decide,
      decideDelegated: (input) => decide(input, input),
      pendingSnapshots: Effect.fn("SessionReview.pendingSnapshots")(function* (sessionID) {
        const family = yield* SessionReviewFold.familyFold(db, sessionID)
        if (!family) return yield* new Session.NotFoundError({ sessionID })
        const archived = new Set(family.sessions.filter((session) => session.archived).map((session) => session.id))
        return yield* Effect.forEach(family.folded.filter((item) => (SessionReviewFold.isOpen(item) || SessionReviewFold.isStoppedRecovery(item)) && !archived.has(item.sessionID)), (item) =>
          SessionReviewFold.toItem(db, family.rootID, family.sessions, item).pipe(Effect.map((value) => ({ item: value, fingerprint: pendingFingerprint(item) }))))
      }),
      withdraw: (sessionID, reason) => SessionReviewFold.withdrawSession(db, events, sessionID, reason),
      withdrawAfter: (sessionID, messageID) => SessionReviewFold.withdrawAfter(db, events, sessionID, messageID),
      consume: (sessionID, kind, expected) => SessionReviewFold.consume(db, events, sessionID, kind, expected),
      hasOpen: (sessionID) => SessionReviewFold.openCount(db, sessionID).pipe(Effect.map((count) => count > 0)),
      reconcile,
    })
  }),
)

function continuesStoppedRecovery(current: SessionReview.Decision, next: SessionReview.Decision) {
  return (
    current.kind === "recovery" &&
    "choice" in current &&
    current.choice === "stop" &&
    next.kind === "recovery" &&
    "choice" in next &&
    next.choice === "continue"
  )
}

function validate(item: SessionReviewFold.Folded, decision: SessionReview.Decision): string | undefined {
  if (decision.kind !== item.kind) return "Decision kind does not match the review item"
  if ("dismissed" in decision) return
  if (decision.kind === "question") {
    if (item.payload.type === "question") {
      if (!Array.isArray(decision.answers)) return "Question answers must be one list per question"
      return Question.validateAnswers(item.payload.questions, decision.answers)
    }
    if (item.payload.type === "form") {
      if (!Schema.is(Form.Answer)(decision.answers)) return "Form answers must be keyed by field"
      return Form.validateAnswer(item.payload, decision.answers)
    }
    return "Decision does not match the review item"
  }
  if (decision.kind === "guardrail" && item.payload.type === "guardrail" && decision.reply === "always" && item.payload.hardReview)
    return "Hard guardrail reviews cannot be approved always"
  return
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventRuntime.node, Session.node, SessionOrchestration.node, PermissionSession.node, SessionExecution.node],
})
