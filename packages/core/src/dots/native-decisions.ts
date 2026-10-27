export * as NativeDecisions from "./native-decisions"

import { Effect, Semaphore } from "effect"
import { Form } from "../form"
import type { SessionReview as Review } from "@ycoding-ai/schema/session-review"
import { Session } from "../session"
import { Permission } from "../permission"
import { Question } from "../question"
import { SessionGuardrail } from "../session/guardrail"
import { SessionOrchestration } from "../session/orchestration"
import { SessionReview } from "../session/review"
import type { Answers } from "./native"
import { Projection } from "./native-projection"
export type { InputQuestion } from "./native-projection"

type Validate = () => Effect.Effect<boolean>
export interface Request {
  readonly id: string
  readonly sessionID: Session.ID
  readonly fingerprint: string
  readonly turnID: string
  readonly waitKind: "approval" | "user-input"
  readonly stage?: number
  readonly questions: readonly Projection.InputQuestion[]
  readonly resolve: (answers: Answers, source: Form.NativeReplySource, validate: Validate) => Effect.Effect<void, unknown>
}
export interface Interface {
  readonly pending: (sessionID: Session.ID) => Effect.Effect<readonly Request[], unknown>
  readonly settle: (request: Request, answers: Answers, source: Form.NativeReplySource, validate: Validate) => Effect.Effect<void, unknown>
}
export interface Options {
  readonly permission: Permission.Interface
  readonly guardrail: SessionGuardrail.Interface
  readonly forms: Form.Interface
  readonly questions: Question.Interface
  readonly reviews: SessionReview.Interface
  readonly orchestration: SessionOrchestration.Interface
  readonly sessions: Pick<Session.Interface, "get">
}
const invalid = () => new globalThis.Error("The answer does not match the pending native request")
const single = (answers: Answers): string | undefined => {
  const keys = Object.keys(answers)
  const value = answers.answer?.answers
  return keys.length === 1 && keys[0] === "answer" && Array.isArray(value) && value.length === 1 && typeof value[0] === "string" ? value[0] : undefined
}
const question = (header: string, text: string, options: Projection.InputQuestion["options"] = null): readonly Projection.InputQuestion[] => [{
  id: "answer", header, question: text, isOther: options === null, isSecret: false, options,
}]
const approval = (text: string) => question("Approval", text, [
  { label: "Allow once", description: "Allow this exact pending operation once" },
  { label: "Reject", description: "Reject this pending operation" },
])
const reply = (answers: Answers) => {
  const text = single(answers)
  return text === "Allow once" ? "once" as const : text === "Reject" ? "reject" as const : undefined
}
export function make(options: Options): Interface {
  const drafts = new Map<string, Request>()
  const lock = Semaphore.makeUnsafe(1)
  function projected<A>(base: Pick<Request, "id" | "sessionID" | "fingerprint" | "turnID">, stage: Projection.Stage<A>, fresh: () => Effect.Effect<boolean, unknown>,
    finish: (value: A, source: Form.NativeReplySource, validate: Validate) => Effect.Effect<void, unknown>,
    cancel: (source: Form.NativeReplySource, validate: Validate) => Effect.Effect<void, unknown>): Request {
    const key = JSON.stringify([base.id, base.fingerprint])
    const existing = drafts.get(key)
    if (existing) return existing
    const makeRequest = (current: Projection.Stage<A>, stage: number): Request => {
      const request: Request = { ...base, waitKind: "user-input", stage, questions: current.questions, resolve: (answers, source, validate) => Effect.gen(function* () {
        if (drafts.get(key) !== request || !(yield* fresh()) || !(yield* validate())) return yield* Effect.fail(invalid())
        const result = yield* Effect.try({ try: () => current.read(answers), catch: invalid })
        if (result.type === "next") drafts.set(key, makeRequest(result.stage, stage + 1))
        else {
          if (result.type === "cancel") yield* cancel(source, validate)
          else yield* finish(result.value, source, validate)
          drafts.delete(key)
        }
      }) }
      return request
    }
    const request = makeRequest(stage, 0)
    drafts.set(key, request)
    return request
  }
  const pending = Effect.fn("NativeDecisions.pending")(function* (sessionID: Session.ID) {
    const requests: Request[] = []
    for (const item of yield* options.permission.snapshots(sessionID)) {
      const current = item.request
      requests.push({ id: current.id, sessionID, fingerprint: item.fingerprint, turnID: current.source?.messageID ?? sessionID, waitKind: "approval",
        questions: approval(`${current.action}: ${current.resources.join(", ")}`),
        resolve: (answers, source, validate) => Effect.gen(function* () {
          const decision = reply(answers)
          if (!decision) return yield* Effect.fail(invalid())
          yield* options.permission.replyDelegated({ requestID: current.id, reply: decision, fingerprint: item.fingerprint, source, explicitDecision: true, validate })
        }),
      })
    }
    for (const item of yield* options.guardrail.requestSnapshots(sessionID)) {
      const current = item.request
      requests.push({ id: current.id, sessionID, fingerprint: item.fingerprint, turnID: current.source?.messageID ?? sessionID, waitKind: "approval",
        questions: approval(`${current.action}: ${current.resources.join(", ")}; rules: ${current.ruleIDs.join(", ")}`),
        resolve: (answers, source, validate) => Effect.gen(function* () {
          const decision = reply(answers)
          if (!decision) return yield* Effect.fail(invalid())
          yield* options.guardrail.replyDelegated({ sessionID, requestID: current.id, reply: decision, fingerprint: item.fingerprint, source, explicitDecision: true, validate })
        }),
      })
    }
    for (const item of yield* options.forms.snapshots(sessionID)) {
      if (item.state.status !== "pending") continue
      requests.push(projected({ id: item.form.id, sessionID, fingerprint: item.fingerprint, turnID: sessionID },
        Projection.form(item.form.title, item.form.fields),
        () => options.forms.snapshots(sessionID).pipe(Effect.map((items) => items.some((current) => current.form.id === item.form.id && current.fingerprint === item.fingerprint && current.state.status === "pending"))),
        (answer, source, validate) => options.forms.replyDelegated({ id: item.form.id, fingerprint: item.fingerprint, source, explicitDecision: true, validate, answer }),
        (source, validate) => options.forms.cancelDelegated({ id: item.form.id, fingerprint: item.fingerprint, source, explicitDecision: true, validate })))
    }
    for (const item of yield* options.questions.list()) {
      if (item.sessionID !== sessionID) continue
      const fingerprint = Question.fingerprint(item)
      requests.push(projected({ id: item.id, sessionID, fingerprint, turnID: item.tool?.messageID ?? sessionID }, Projection.questions(item.questions),
        () => options.questions.list().pipe(Effect.map((items) => items.some((current) => current.id === item.id && Question.fingerprint(current) === fingerprint))),
        (answers, source, validate) => options.questions.replyDelegated({ requestID: item.id, fingerprint, source, explicitDecision: true, validate, answers }),
        (source, validate) => options.questions.rejectDelegated({ requestID: item.id, fingerprint, source, explicitDecision: true, validate })))
    }
    for (const item of yield* options.reviews.pendingSnapshots(sessionID)) {
      if (item.item.sessionID !== sessionID) continue
      const payload = item.item.payload
      const finish = (decision: Review.Decision, source: Form.NativeReplySource, validate: Validate) => Effect.gen(function* () {
          const gate = () => Effect.gen(function* () {
            if (!(yield* validate())) return false
            if ("reply" in decision && decision.reply === "once" && (payload.type === "permission" || payload.type === "guardrail")) {
              for (const resource of payload.resources)
                if ((yield* options.permission.evaluateEffective({ sessionID, action: payload.action, resource })) === "deny") return false
              if (payload.type === "guardrail") {
                const current = yield* options.guardrail.evaluate({ sessionID, action: payload.action, resources: payload.resources })
                if (current.decision === "deny") return false
              }
            }
            return true
          }).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)))
          yield* options.reviews.decideDelegated({ sessionID, itemID: item.item.itemID, decision, fingerprint: item.fingerprint, source, explicitDecision: true, validate: gate })
      })
      const base = { id: item.item.itemID, sessionID, fingerprint: item.fingerprint, turnID: sessionID }
      if (payload.type === "permission" || payload.type === "guardrail" || payload.type === "recovery") {
        requests.push({ ...base, waitKind: payload.type === "recovery" ? "user-input" : "approval", questions: payload.type === "recovery" ? question("Recovery", "Continue or stop the interrupted operation?", [{ label: "Continue", description: "Continue" }, { label: "Stop", description: "Stop" }]) : approval(`${payload.action}: ${payload.resources.join(", ")}`),
          resolve: (answers, source, validate) => {
            if (payload.type === "recovery") {
              const text = single(answers)
              return text === "Continue" || text === "Stop" ? finish({ kind: "recovery", choice: text === "Continue" ? "continue" : "stop" }, source, validate) : Effect.fail(invalid())
            }
            const decision = reply(answers)
            return decision ? finish({ kind: payload.type, reply: decision }, source, validate) : Effect.fail(invalid())
          },
        })
      } else {
        const stage = payload.type === "form" ? Projection.map(Projection.form(payload.title, payload.fields), (answers): Review.Decision => ({ kind: "question", answers }))
          : payload.type === "question" ? Projection.map(Projection.questions(payload.questions), (answers): Review.Decision => ({ kind: "question", answers }))
          : Projection.map(Projection.child(payload.text), (answer): Review.Decision => ({ kind: "subagent_question", text: answer.text ?? "", ...(answer.data === undefined ? {} : { data: answer.data }) }))
        requests.push(projected(base, stage,
          () => options.reviews.pendingSnapshots(sessionID).pipe(Effect.map((items) => items.some((current) => current.item.itemID === item.item.itemID && current.fingerprint === item.fingerprint))),
          finish, (source, validate) => payload.type === "subagent_question" ? Effect.void : finish({ kind: "question", dismissed: true }, source, validate)))
      }
    }
    const session = yield* options.sessions.get(sessionID)
    if (session.parentID) for (const item of yield* options.orchestration.questionSnapshots(session.parentID)) {
      const task = item.task
      if (task.sessionID !== sessionID || !task.question || task.question.deferred) continue
      const questionID = task.question.id
      requests.push(projected({ id: questionID, sessionID, fingerprint: item.fingerprint, turnID: sessionID }, Projection.child(task.question.text),
        () => options.orchestration.questionSnapshots(task.parentID).pipe(Effect.map((items) => items.some((current) => current.task.question?.id === questionID && current.fingerprint === item.fingerprint))),
        (value, source, validate) => options.orchestration.answer({ parentID: task.parentID, childID: task.sessionID, questionID, ...value,
          dots: { source, explicitDecision: true, fingerprint: item.fingerprint, validate },
        }).pipe(Effect.asVoid), () => Effect.void))
    }
    return requests
  })
  return { pending, settle: (request, answers, source, validate) => lock.withPermit(request.resolve(answers, source, validate)) }
}
