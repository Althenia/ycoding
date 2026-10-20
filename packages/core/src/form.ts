export * as Form from "./form"

import { Form } from "@ycoding-ai/schema/form"
import { Cache, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect"
import { Config } from "./config"
import { Database } from "./database/database"
import { Decision } from "./decision"
import { DecisionChoice } from "./decision-choice"
import { makeLocationNode } from "./effect/app-node"
import { EventRuntime } from "./event"
import { SessionAutonomy } from "./session/autonomy"
import { SessionMessage } from "./session/message"
import { SessionReviewFold } from "./session/review-fold"
import { SessionSchema } from "./session/schema"

const RETENTION = Duration.minutes(10)

export const ID = Form.ID
export type ID = typeof ID.Type

export const Info = Form.Info
export type Info = typeof Info.Type

export const Field = Form.Field
export type Field = Form.Field

export const Fields = Form.Fields
export type Fields = Form.Fields

export const When = Form.When
export type When = Form.When

export const State = Form.State
export type State = typeof State.Type
export type TerminalState = Exclude<State, { readonly status: "pending" }>
export type AskResult = TerminalState & { readonly automatic?: true; readonly via?: "auto-answer" | "yolo"; readonly confidence?: number }

export const Answer = Form.Answer
export type Answer = typeof Answer.Type

export const Reply = Form.Reply
export type Reply = typeof Reply.Type

export const Event = Form.Event

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Form.NotFoundError", {
  id: ID,
}) {
  override get message() {
    return `Form not found: ${this.id}`
  }
}

export class AlreadySettledError extends Schema.TaggedErrorClass<AlreadySettledError>()("Form.AlreadySettledError", {
  id: ID,
}) {
  override get message() {
    return `Form already settled: ${this.id}`
  }
}

export class AlreadyExistsError extends Schema.TaggedErrorClass<AlreadyExistsError>()("Form.AlreadyExistsError", {
  id: ID,
}) {
  override get message() {
    return `Form already exists: ${this.id}`
  }
}

export class InvalidAnswerError extends Schema.TaggedErrorClass<InvalidAnswerError>()("Form.InvalidAnswerError", {
  id: ID,
  message: Schema.String,
}) {}

export class InvalidFormError extends Schema.TaggedErrorClass<InvalidFormError>()("Form.InvalidFormError", {
  message: Schema.String,
}) {}

export type CreateInput = Omit<Form.Info, "id"> & { readonly id?: ID }

export interface ReplyInput {
  readonly id: ID
  readonly answer: Answer
}

export interface ListInput {
  readonly sessionID?: Form.Info["sessionID"]
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, AlreadyExistsError | InvalidFormError>
  readonly ask: (
    input: CreateInput,
  ) => Effect.Effect<AskResult, AlreadyExistsError | InvalidFormError | SessionReviewFold.FullError>
  readonly deferPending: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly state: (id: ID) => Effect.Effect<State, NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, AlreadySettledError | InvalidAnswerError | NotFoundError>
  readonly cancel: (id: ID) => Effect.Effect<void, AlreadySettledError | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Form") {}

interface Entry {
  readonly form: Info
  readonly state: State
  readonly deferred: Deferred.Deferred<TerminalState>
  readonly waiting: boolean
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const autonomy = yield* SessionAutonomy.Service
    const decision = yield* Decision.Service
    const settle = Semaphore.makeUnsafe(1)
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => settle.withPermit(Effect.uninterruptible(effect))
    const forms = yield* Cache.makeWith<ID, Entry>(
      () => Effect.die(new Error("Form cache must be used via set/getSuccess, never get")),
      {
        capacity: Number.MAX_SAFE_INTEGER,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.state.status === "pending" ? Duration.infinity : RETENTION,
      },
    )

    const find = Effect.fn("Form.find")(function* (id: ID) {
      return yield* Cache.getSuccess(forms, id).pipe(
        Effect.flatMap((entry) =>
          Option.match(entry, {
            onNone: () => Effect.fail(new NotFoundError({ id })),
            onSome: Effect.succeed,
          }),
        ),
      )
    })

    const complete = Effect.fn("Form.complete")(function* (
      entry: Entry,
      state: Exclude<TerminalState, { readonly status: "timed_out" }>,
    ) {
      const id = entry.form.id
      const sessionID = entry.form.sessionID
      yield* state.status === "answered"
        ? events.publish(Event.Replied, { id, sessionID, answer: state.answer })
        : state.status === "cancelled"
          ? events.publish(Event.Cancelled, { id, sessionID })
          : events.publish(Event.Deferred, { id, sessionID, itemID: state.itemID })
      yield* Cache.set(forms, id, { form: entry.form, deferred: entry.deferred, waiting: entry.waiting, state })
      yield* Deferred.succeed(entry.deferred, state)
    })

    const createPending = Effect.fn("Form.createPending")((input: CreateInput, waiting = false) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const id = input.id ?? ID.create()
          const existing = yield* Cache.getSuccess(forms, id)
          if (Option.isSome(existing)) return yield* new AlreadyExistsError({ id })
          const invalid = validateFields(input.fields)
          if (invalid) return yield* new InvalidFormError({ message: invalid })
          const form: Info = {
            id,
            sessionID: input.sessionID,
            title: input.title,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            fields: input.fields,
          }
          const entry: Entry = {
            form,
            state: { status: "pending" },
            deferred: yield* Deferred.make<TerminalState>(),
            waiting,
          }
          yield* Cache.set(forms, id, entry)
          yield* events.publish(Event.Created, { form }).pipe(Effect.onError(() => Cache.invalidate(forms, id)))
          return form
        }),
      ),
    )

    const reviewLimit = Effect.fnUntraced(function* () {
      return Config.latest(yield* config.entries(), "guardrails")?.max_pending_reviews ?? 16
    })

    const openReview = Effect.fnUntraced(function* (
      form: Info,
      sessionID: SessionSchema.ID,
      outcome: { readonly reason: "disabled" | "free_text" | "error" | "sleep_entry" | DecisionChoice.UnsettledReason; readonly choice?: string; readonly confidence?: number },
      conversion = false,
    ) {
      const tool = form.metadata?.tool
      const origin = tool && typeof tool === "object" && !Array.isArray(tool) &&
        typeof (tool as Record<string, unknown>).messageID === "string" && typeof (tool as Record<string, unknown>).callID === "string"
        ? { messageID: SessionMessage.ID.make((tool as Record<string, string>).messageID), callID: (tool as Record<string, string>).callID }
        : { requestID: form.id }
      return yield* SessionReviewFold.open(database.db, events, {
        sessionID,
        kind: "question",
        reason: outcome.reason,
        ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        origin,
        payload: {
          type: "form",
          title: form.title,
          fields: form.fields,
          ...(form.metadata?.kind === "question" ? { questionTool: true as const } : {}),
        },
        limit: yield* reviewLimit(),
        conversion,
      })
    })

    const deferPending = Effect.fn("Form.deferPending")(function* (sessionID: SessionSchema.ID) {
      const entries = Array.from(yield* Cache.values(forms)).filter(
        (entry) => entry.state.status === "pending" && entry.waiting && entry.form.sessionID === sessionID,
      )
      yield* Effect.forEach(entries, (entry) =>
        exclusive(Effect.gen(function* () {
          const current = yield* find(entry.form.id).pipe(Effect.orDie)
          if (current.state.status !== "pending") return
          const item = yield* openReview(current.form, sessionID, { reason: "sleep_entry" }, true).pipe(Effect.orDie)
          yield* complete(current, { status: "deferred", itemID: item.itemID })
        })), { discard: true })
    })

    const create = Effect.fn("Form.create")((input: CreateInput) => createPending(input))

    const ask = Effect.fn("Form.ask")((input: CreateInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const sessionID = Schema.is(SessionSchema.ID)(input.sessionID) ? input.sessionID : undefined
          const snapshot = sessionID
            ? yield* autonomy
                .snapshot(sessionID)
                .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
            : undefined
          const autoAnswer = snapshot ? SessionAutonomy.canAutoAnswer(snapshot.state) : false
          const asleep = sessionID
            ? yield* autonomy
                .isAsleep(sessionID)
                .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            : false
          const yolo = sessionID ? yield* DecisionChoice.yoloEnabled(autonomy, sessionID) : false
          const auto = autoAnswer || yolo
          if (asleep && sessionID) {
            const form: Info = {
              id: input.id ?? ID.create(),
              sessionID: input.sessionID,
              title: input.title,
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
              fields: input.fields,
            }
            if (!auto || !snapshot) {
              const item = yield* openReview(form, sessionID, { reason: "disabled" })
              return { status: "deferred", itemID: item.itemID } as TerminalState
            }
            const outcome = yield* restore(decisionAnswer(decision, sessionID, form, { autoAnswer, yolo }))
            if (outcome.type === "defer") {
              const item = yield* openReview(form, sessionID, outcome)
              return { status: "deferred", itemID: item.itemID } as TerminalState
            }
            const unchanged = yield* DecisionChoice.autonomyUnchanged(autonomy, sessionID, snapshot.sequence)
            if (!unchanged) {
              const item = yield* openReview(form, sessionID, { reason: "disabled" })
              return { status: "deferred", itemID: item.itemID } as TerminalState
            }
            const created = yield* createPending({ ...input, id: form.id }, true)
            const entry = yield* find(created.id).pipe(Effect.orDie)
            const automatic = yield* reply({ id: created.id, answer: outcome.answer }).pipe(
              Effect.as(true),
              Effect.catchTag("Form.AlreadySettledError", () => Effect.succeed(false)),
              Effect.orDie,
            )
            const result = yield* Deferred.await(entry.deferred)
            return automatic ? { ...result, automatic: true as const, via: outcome.via, ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }) } : result
          }
          const form = yield* createPending(input, true)
          const entry = yield* find(form.id).pipe(Effect.orDie)
          return yield* restore(Effect.gen(function* () {
            const outcome = auto && sessionID && snapshot
              ? yield* decisionAnswer(decision, sessionID, form, { autoAnswer, yolo })
              : undefined
            const unchanged = outcome?.type === "answer" && sessionID && snapshot
              ? yield* DecisionChoice.autonomyUnchanged(autonomy, sessionID, snapshot.sequence)
              : false
            const automatic = outcome?.type === "answer" && unchanged
              ? yield* reply({ id: form.id, answer: outcome.answer }).pipe(
                  Effect.as(true),
                  Effect.catchTag("Form.AlreadySettledError", () => Effect.succeed(false)),
                  Effect.orDie,
                )
              : false
            const result = yield* Deferred.await(entry.deferred)
            return automatic && outcome?.type === "answer"
              ? { ...result, automatic: true as const, via: outcome.via, ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }) }
              : result
          })).pipe(
            Effect.onInterrupt(() => Effect.ignore(cancel(form.id))),
          )
        }),
      ),
    )

    const get = Effect.fn("Form.get")(function* (id: ID) {
      return (yield* find(id)).form
    })

    const list = Effect.fn("Form.list")(function* (input?: ListInput) {
      const entries = yield* Cache.values(forms)
      return Array.from(entries)
        .filter((entry) => entry.state.status === "pending")
        .filter((entry) => input?.sessionID === undefined || entry.form.sessionID === input.sessionID)
        .map((entry) => entry.form)
    })

    const state = Effect.fn("Form.state")(function* (id: ID) {
      return (yield* find(id)).state
    })

    const reply = Effect.fn("Form.reply")((input: ReplyInput) =>
      exclusive(
        Effect.gen(function* () {
          const entry = yield* find(input.id)
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id: input.id })
          const invalid = validateAnswer(entry.form, input.answer)
          if (invalid) return yield* new InvalidAnswerError({ id: input.id, message: invalid })
          yield* complete(entry, { status: "answered", answer: input.answer })
        }),
      ),
    )

    const cancel = Effect.fn("Form.cancel")((id: ID) =>
      exclusive(
        Effect.gen(function* () {
          const entry = yield* find(id)
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id })
          yield* complete(entry, { status: "cancelled" })
        }),
      ),
    )

    yield* Effect.addFinalizer(() =>
      Cache.values(forms).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            Array.from(entries).filter((entry) => entry.state.status === "pending"),
            (entry) => cancel(entry.form.id).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      ),
    )

    return Service.of({ create, ask, deferPending, get, list, state, reply, cancel })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node],
})

interface AutoMode {
  readonly autoAnswer: boolean
  readonly yolo: boolean
}

type SleepOutcome =
  | { readonly type: "answer"; readonly answer: Answer; readonly via: "auto-answer" | "yolo"; readonly confidence?: number }
  | {
      readonly type: "defer"
      readonly reason: "disabled" | "free_text" | "error" | DecisionChoice.UnsettledReason
      readonly choice?: string
      readonly confidence?: number
    }

function decisionAnswer(
  decision: Decision.Interface,
  sessionID: SessionSchema.ID,
  form: Info,
  mode: AutoMode,
): Effect.Effect<SleepOutcome> {
  return Effect.gen(function* () {
    let consultations = 0
    const consulted: Decision.Interface = {
      evaluate: (input, context) => {
        consultations++
        return decision.evaluate(input, context)
      },
    }
    const answer: Record<string, Form.Value> = {}
    let confidence: number | undefined
    for (const field of form.fields) {
      if (field.type === "external") return { type: "defer", reason: "error" } as SleepOutcome
      if (!isActive(field, answer)) continue
      const outcome = yield* decisionValue(consulted, sessionID, form, field, mode)
      if (outcome.type === "defer") return outcome
      if (outcome.confidence !== undefined) confidence = Math.min(confidence ?? 1, outcome.confidence)
      if (outcome.value === undefined) continue
      answer[field.key] = outcome.value
    }
    if (Object.keys(answer).length === 0)
      return {
        type: "defer",
        reason: consultations > 0 ? "low_confidence" : form.fields.some(isTextField) ? "free_text" : "disabled",
      } as SleepOutcome
    return validateAnswer(form, answer)
      ? ({ type: "defer", reason: "error" } as SleepOutcome)
      : ({
          type: "answer",
          answer,
          via: consultations > 0 ? "yolo" : "auto-answer",
          ...(confidence === undefined ? {} : { confidence }),
        } as SleepOutcome)
  })
}

function isTextField(field: Form.Field) {
  return field.type === "number" || field.type === "integer" || (field.type === "string" && (field.options?.length ?? 0) === 0)
}

type FieldOutcome =
  | { readonly type: "value"; readonly value: Form.Value | undefined; readonly confidence?: number }
  | Extract<SleepOutcome, { readonly type: "defer" }>

const fieldInstructions =
  "The user cannot answer this form right now. Answer only this field from the evidence given and the form's stated purpose. Refuse when the evidence does not support an answer; refusal asks the user instead. Never invent facts, names, addresses, or identifiers the evidence does not supply."

const RECOMMENDED = / \(Recommended\)$/

function mustAnswer(form: Info, field: InputField) {
  return field.required === true || form.metadata?.kind === "question"
}

function fieldState(form: Info, field: InputField) {
  return {
    form: form.title,
    field: field.key,
    title: field.title ?? null,
    description: field.description ?? null,
    required: mustAnswer(form, field),
  }
}

function modelDefer(outcome: {
  readonly reason: DecisionChoice.UnsettledReason
  readonly choice?: string
  readonly confidence?: number
}): FieldOutcome {
  return {
    type: "defer",
    reason: outcome.reason,
    ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
    ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
  }
}

function decisionValue(
  decision: Decision.Interface,
  sessionID: SessionSchema.ID,
  form: Info,
  field: InputField,
  mode: AutoMode,
): Effect.Effect<FieldOutcome> {
  const required = mustAnswer(form, field)
  const unanswered: FieldOutcome = required
    ? { type: "defer", reason: isTextField(field) ? "free_text" : "disabled" }
    : { type: "value", value: undefined }
  const call = {
    sessionID,
    name: field.key,
    purpose: "answer" as const,
    authority: "yolo" as const,
    invocationKey: `${form.id}:${field.key}`,
  }
  if (mode.autoAnswer && field.default !== undefined && !validateField(field, field.default))
    return Effect.succeed<FieldOutcome>({ type: "value", value: field.default })
  if (field.type === "boolean") {
    if (!mode.yolo) return Effect.succeed(unanswered)
    return DecisionChoice.answerBoolean(decision, {
      ...call,
      instructions: `${fieldInstructions} Answer yes (true) or no (false) for this field; false is a real answer, distinct from refusing.`,
      state: fieldState(form, field),
    }).pipe(
      Effect.map((outcome): FieldOutcome =>
        outcome.type === "unsettled" ? modelDefer(outcome) : { type: "value", value: outcome.value, confidence: outcome.confidence },
      ),
    )
  }
  if (field.type === "number" || field.type === "integer") {
    if (!required || !mode.yolo) return Effect.succeed(unanswered)
    return DecisionChoice.answerText(decision, {
      ...call,
      instructions: `${fieldInstructions} Respond with only the numeric value for this ${field.type} field, with no units or words.`,
      state: {
        ...fieldState(form, field),
        minimum: field.minimum ?? null,
        maximum: field.maximum ?? null,
      },
      maxLength: 64,
    }).pipe(
      Effect.map((outcome): FieldOutcome => {
        if (outcome.type === "unsettled") return modelDefer(outcome)
        const value = Number(outcome.value.trim())
        return !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value)) || validateField(field, value)
          ? { type: "defer", reason: "error", confidence: outcome.confidence }
          : { type: "value", value, confidence: outcome.confidence }
      }),
    )
  }
  if (field.type === "multiselect") {
    const marked = field.options.filter((option) => RECOMMENDED.test(option.label)).map((option) => option.value)
    if (mode.autoAnswer && marked.length > 0 && !validateField(field, marked))
      return Effect.succeed<FieldOutcome>({ type: "value", value: marked })
    if (!mode.yolo || field.options.length === 0) return Effect.succeed(unanswered)
    return DecisionChoice.grade(decision, {
      ...call,
      instructions: `${fieldInstructions} Grade every option independently for whether it should be selected.`,
      state: {
        ...fieldState(form, field),
        options: field.options.map((option) => ({ value: option.value, label: option.label, description: option.description ?? null })),
      },
      choices: field.options.map((option) => ({ value: option.value, description: option.description ?? option.label })),
    }).pipe(
      Effect.map((outcome): FieldOutcome => {
        if (outcome.type === "unsettled") return { type: "defer", reason: outcome.reason }
        const selected = outcome.grades.filter(
          (grade) => typeof grade.choice === "string" && grade.confidence >= DecisionChoice.ConfidenceThreshold,
        )
        if (selected.length === 0) return required || (field.minItems ?? 0) > 0 ? { type: "defer", reason: "low_confidence" } : { type: "value", value: undefined }
        const value = selected.map((grade) => String(grade.choice))
        return validateField(field, value)
          ? { type: "defer", reason: "error" }
          : { type: "value", value, confidence: Math.min(...selected.map((grade) => grade.confidence)) }
      }),
    )
  }
  const options = field.options
  if (!options || options.length === 0) {
    if (!required || !mode.yolo) return Effect.succeed(unanswered)
    return DecisionChoice.answerText(decision, {
      ...call,
      instructions: fieldInstructions,
      state: fieldState(form, field),
      maxLength: Math.min(field.maxLength ?? 8192, 8192),
    }).pipe(
      Effect.map((outcome): FieldOutcome =>
        outcome.type === "unsettled"
          ? modelDefer(outcome)
          : validateField(field, outcome.value)
            ? { type: "defer", reason: "error", confidence: outcome.confidence }
            : { type: "value", value: outcome.value, confidence: outcome.confidence },
      ),
    )
  }
  const marked = options.filter((option) => RECOMMENDED.test(option.label))
  if (mode.autoAnswer && marked.length === 1 && marked[0] && !validateField(field, marked[0].value))
    return Effect.succeed<FieldOutcome>({ type: "value", value: marked[0].value })
  if (!mode.yolo) return Effect.succeed(unanswered)
  return DecisionChoice.chooseDetailed(decision, {
    ...call,
    instructions: fieldInstructions,
    state: {
      ...fieldState(form, field),
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description ?? null,
      })),
    },
    choices: options.map((option) => ({
      value: option.value,
      description: option.description ?? option.label,
    })),
  }).pipe(
    Effect.flatMap((outcome): Effect.Effect<FieldOutcome> => {
      if (outcome.type === "judgment")
        return Effect.succeed<FieldOutcome>(
          validateField(field, outcome.value)
            ? { type: "defer", reason: "error", choice: outcome.value, confidence: outcome.confidence }
            : { type: "value", value: outcome.value, confidence: outcome.confidence },
        )
      if (field.custom !== true) return Effect.succeed(modelDefer(outcome))
      return DecisionChoice.answerText(decision, {
        ...call,
        invocationKey: `${call.invocationKey}:custom`,
        instructions: `${fieldInstructions} No listed option was settled; give a custom answer only when the evidence clearly supports one.`,
        state: fieldState(form, field),
        maxLength: Math.min(field.maxLength ?? 8192, 8192),
      }).pipe(
        Effect.map((text): FieldOutcome =>
          text.type === "text" && !validateField(field, text.value)
            ? { type: "value", value: text.value, confidence: text.confidence }
            : modelDefer(outcome),
        ),
      )
    }),
  )
}

export function validateAnswer(form: Pick<Info, "fields">, answer: Answer) {
  const fields = new Map(form.fields.map((field) => [field.key, field] as const))
  for (const key of Object.keys(answer)) {
    if (!fields.has(key)) return `Unknown form field: ${key}`
  }
  for (const field of form.fields) {
    const value = answer[field.key]
    if (field.type === "external") {
      if (value !== true) return `External form field must be acknowledged: ${field.key}`
      continue
    }
    const active = isActive(field, answer)
    if (value === undefined) {
      if (field.required && active) return `Missing required form field: ${field.key}`
      continue
    }
    if (!active) return `Form field is not active: ${field.key}`
    const invalid = validateField(field, value)
    if (invalid) return invalid
  }
}

type InputField = Exclude<Form.Field, Form.ExternalField>

function isActive(field: InputField, answer: Answer) {
  if (!field.when) return true
  return field.when.every((when) => matches(when, answer[when.key]))
}

// An unanswered referenced field makes the condition false for both ops. Combined with inactive
// fields being unanswerable, this cascades: hiding a field falsifies every condition referencing it.
function matches(when: Form.When, value: Form.Value | undefined) {
  if (value === undefined) return false
  const hit = Array.isArray(value) ? value.some((item) => item === when.value) : value === when.value
  return when.op === "eq" ? hit : !hit
}

// Create-time validation of `when` references: each condition must point at an earlier field,
// carry a value matching that field's type, and use a declared option when the field's options
// are closed. Rejecting these at creation surfaces authoring mistakes to the caller instead of
// silently never matching.
function validateFields(fields: ReadonlyArray<Form.Field>) {
  if (fields.length === 0) return "Form must have at least one field"
  const earlier = new Map<string, InputField>()
  const keys = new Set<string>()
  for (const field of fields) {
    if (keys.has(field.key)) return `Duplicate form field key: ${field.key}`
    keys.add(field.key)
    if (field.type === "external") continue
    for (const when of field.when ?? []) {
      const target = earlier.get(when.key)
      if (!target) return `Form field condition must reference an earlier field: ${field.key} -> ${when.key}`
      const invalid = validateWhen(when, target)
      if (invalid) return `${invalid}: ${field.key} -> ${when.key}`
    }
    earlier.set(field.key, field)
  }
}

function validateWhen(when: Form.When, target: InputField) {
  if (target.type === "boolean") {
    if (typeof when.value !== "boolean") return "Form field condition value must be a boolean"
    return
  }
  if (target.type === "number" || target.type === "integer") {
    if (typeof when.value !== "number") return "Form field condition value must be a number"
    return
  }
  // string and multiselect targets both compare against string values
  if (typeof when.value !== "string") return "Form field condition value must be a string"
  const closed = target.type === "multiselect" ? !target.custom : target.options !== undefined && !target.custom
  if (closed && !target.options?.some((option) => option.value === when.value)) {
    return "Form field condition value must be one of the field's options"
  }
}

function validateField(field: InputField, value: Form.Value): string | undefined {
  if (field.type === "string") {
    if (typeof value !== "string") return `Expected string for form field: ${field.key}`
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    if (field.minLength !== undefined && value.length < field.minLength) return `Form field is too short: ${field.key}`
    if (field.maxLength !== undefined && value.length > field.maxLength) return `Form field is too long: ${field.key}`
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(value)) return `Form field does not match pattern: ${field.key}`
      } catch {
        return `Form field has invalid pattern: ${field.key}`
      }
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return `Expected email for form field: ${field.key}`
    if (field.format === "uri" && !isUri(value)) return `Expected URI for form field: ${field.key}`
    if (field.format === "date" && !isDate(value)) return `Expected date for form field: ${field.key}`
    if (field.format === "date-time" && !isDateTime(value)) return `Expected date-time for form field: ${field.key}`
    if (field.options && !field.custom && !field.options.some((option) => option.value === value)) {
      return `Invalid option for form field: ${field.key}`
    }
    return
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `Expected number for form field: ${field.key}`
    if (field.type === "integer" && !Number.isInteger(value)) return `Expected integer for form field: ${field.key}`
    if (field.minimum !== undefined && value < field.minimum) return `Form field is too small: ${field.key}`
    if (field.maximum !== undefined && value > field.maximum) return `Form field is too large: ${field.key}`
    return
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") return `Expected boolean for form field: ${field.key}`
    return
  }
  if (field.type === "multiselect") {
    if (!isStringArray(value)) return `Expected string array for form field: ${field.key}`
    if (new Set(value).size !== value.length) return `Duplicate selections for form field: ${field.key}`
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    if (field.minItems !== undefined && value.length < field.minItems)
      return `Too few selections for form field: ${field.key}`
    if (field.maxItems !== undefined && value.length > field.maxItems)
      return `Too many selections for form field: ${field.key}`
    if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item))) {
      return `Invalid option for form field: ${field.key}`
    }
  }
}

function isStringArray(value: Form.Value): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
}

function isUri(value: string) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isDateTime(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}
