export * as Form from "./form"

import { Form } from "@ycoding-ai/schema/form"
import { Cache, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Semaphore } from "effect"
import { Config } from "./config"
import { ConfigQuestionTimeout } from "./config/question-timeout"
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
  ) => Effect.Effect<TerminalState, AlreadyExistsError | InvalidFormError | SessionReviewFold.FullError>
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
  readonly created: number
  readonly waiting: boolean
  readonly timer?: Fiber.Fiber<void>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const autonomy = yield* SessionAutonomy.Service
    const decision = yield* Decision.Service
    const lifetime = yield* Scope.Scope
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

    const complete = Effect.fn("Form.complete")(function* (entry: Entry, state: TerminalState) {
      const id = entry.form.id
      const sessionID = entry.form.sessionID
      yield* state.status === "answered"
        ? events.publish(Event.Replied, { id, sessionID, answer: state.answer })
        : state.status === "cancelled"
          ? events.publish(Event.Cancelled, { id, sessionID })
          : state.status === "deferred"
            ? events.publish(Event.Deferred, { id, sessionID, itemID: state.itemID })
            : events.publish(Event.TimedOut, { id, sessionID })
      yield* Cache.set(forms, id, { form: entry.form, deferred: entry.deferred, created: entry.created, waiting: entry.waiting, state })
      yield* Deferred.succeed(entry.deferred, state)
      if (entry.timer && state.status !== "timed_out") yield* Fiber.interrupt(entry.timer)
    })

    const armTimeout = Effect.fn("Form.armTimeout")(function* (id: ID) {
      const seconds = ConfigQuestionTimeout.seconds(Config.latest(yield* config.entries(), "question_timeout_seconds"))
      if (seconds === 0) return
      yield* exclusive(Effect.gen(function* () {
        const entry = yield* find(id).pipe(Effect.orDie)
        if (entry.state.status !== "pending" || entry.timer) return
        const remaining = Math.max(0, seconds * 1000 - ((yield* Clock.currentTimeMillis) - entry.created))
        const timer = yield* Effect.sleep(Duration.millis(remaining)).pipe(
          Effect.andThen(expire(id, seconds)),
          Effect.interruptible,
          Effect.forkIn(lifetime),
        )
        yield* Cache.set(forms, id, { ...entry, timer })
      }))
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
            created: yield* Clock.currentTimeMillis,
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
      outcome: { readonly reason: "disabled" | "free_text" | "refused" | "low_confidence" | "error" | "timeout" | "sleep_entry"; readonly choice?: string; readonly confidence?: number },
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

    const create = Effect.fn("Form.create")((input: CreateInput) =>
      Effect.uninterruptible(Effect.gen(function* () {
        const form = yield* createPending(input)
        yield* armTimeout(form.id)
        return form
      })),
    )

    const ask = Effect.fn("Form.ask")((input: CreateInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const sessionID = Schema.is(SessionSchema.ID)(input.sessionID) ? input.sessionID : undefined
          const autoAnswer = sessionID
            ? yield* autonomy
                .canAutoAnswer(sessionID)
                .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            : false
          const asleep = sessionID
            ? yield* autonomy
                .isAsleep(sessionID)
                .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            : false
          if (asleep && sessionID) {
            const form: Info = {
              id: input.id ?? ID.create(),
              sessionID: input.sessionID,
              title: input.title,
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
              fields: input.fields,
            }
            if (!autoAnswer) {
              const item = yield* openReview(form, sessionID, { reason: "disabled" })
              return { status: "deferred", itemID: item.itemID } as TerminalState
            }
            const outcome = yield* restore(decisionAnswer(decision, sessionID, form))
            if (outcome.type === "defer") {
              const item = yield* openReview(form, sessionID, outcome)
              return { status: "deferred", itemID: item.itemID } as TerminalState
            }
            const stillEnabled = yield* autonomy
              .canAutoAnswer(sessionID)
              .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            if (!stillEnabled) {
              const item = yield* openReview(form, sessionID, { reason: "disabled" })
              return { status: "deferred", itemID: item.itemID } as TerminalState
            }
            const created = yield* createPending({ ...input, id: form.id }, true)
            yield* reply({ id: created.id, answer: outcome.answer }).pipe(Effect.orDie)
            return { status: "answered", answer: outcome.answer } as TerminalState
          }
          const form = yield* createPending(input, true)
          const entry = yield* find(form.id).pipe(Effect.orDie)
          return yield* restore(Effect.gen(function* () {
            const answer = autoAnswer ? automaticAnswer(form) : undefined
            if (answer) {
              yield* reply({ id: form.id, answer }).pipe(
                Effect.catchTag("Form.AlreadySettledError", () => Effect.void),
                Effect.orDie,
              )
            }
            if (!answer) yield* armTimeout(form.id)
            return yield* Deferred.await(entry.deferred)
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

    const expire = Effect.fn("Form.expire")((id: ID, seconds: number) =>
      exclusive(
        Effect.gen(function* () {
          const entry = yield* find(id)
          if (entry.state.status !== "pending") return
          yield* complete(entry, { status: "timed_out", seconds })
        }).pipe(Effect.orDie),
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

type SleepOutcome =
  | { readonly type: "answer"; readonly answer: Answer }
  | {
      readonly type: "defer"
      readonly reason: "free_text" | "refused" | "low_confidence" | "error" | "timeout"
      readonly choice?: string
      readonly confidence?: number
    }

function decisionAnswer(
  decision: Decision.Interface,
  sessionID: SessionSchema.ID,
  form: Info,
): Effect.Effect<SleepOutcome> {
  return Effect.gen(function* () {
    const answer: Record<string, Form.Value> = {}
    for (const field of form.fields) {
      if (field.type === "external") {
        answer[field.key] = true
        continue
      }
      if (!isActive(field, answer)) continue
      const outcome = yield* decisionValue(decision, sessionID, form, field)
      if (outcome.type === "defer") return outcome
      if (outcome.value === undefined) {
        if (field.required) return { type: "defer", reason: "error" } as SleepOutcome
        continue
      }
      answer[field.key] = outcome.value
    }
    return validateAnswer(form, answer)
      ? ({ type: "defer", reason: "error" } as SleepOutcome)
      : ({ type: "answer", answer } as SleepOutcome)
  })
}

type FieldOutcome =
  | { readonly type: "value"; readonly value: Form.Value | undefined }
  | Extract<SleepOutcome, { readonly type: "defer" }>

function decisionValue(
  decision: Decision.Interface,
  sessionID: SessionSchema.ID,
  form: Info,
  field: InputField,
): Effect.Effect<FieldOutcome> {
  if (field.type !== "string" && field.type !== "multiselect")
    return Effect.succeed<FieldOutcome>({ type: "value", value: automaticValue(field) })
  const options = field.options
  if (!options || options.length === 0) {
    if (field.required)
      return Effect.succeed<FieldOutcome>({ type: "defer", reason: "free_text" })
    return Effect.succeed<FieldOutcome>({ type: "value", value: automaticValue(field) })
  }
  return DecisionChoice.chooseDetailed(decision, {
    sessionID,
    name: field.key,
    instructions:
      "The user is asleep and cannot answer this form. Choose the option that best serves the form's stated purpose with the evidence given. Refuse when the evidence does not support a choice; refusal defers the form to the user's review box.",
    state: {
      form: form.title,
      field: field.key,
      title: field.title ?? null,
      description: field.description ?? null,
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
    Effect.map((outcome): FieldOutcome => {
      if (outcome.type === "unsettled")
        return {
          type: "defer",
          reason: outcome.reason,
          ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
          ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        }
      const value: Form.Value = field.type === "multiselect" ? [outcome.value] : outcome.value
      return validateField(field, value)
        ? { type: "defer", reason: "error", choice: outcome.value, confidence: outcome.confidence }
        : { type: "value", value }
    }),
  )
}

function automaticAnswer(form: Info): Answer | undefined {
  const answer: Record<string, Form.Value> = {}
  for (const field of form.fields) {
    if (field.type === "external") {
      answer[field.key] = true
      continue
    }
    if (!isActive(field, answer)) continue
    const value = automaticValue(field)
    if (value === undefined) {
      if (field.required) return
      continue
    }
    answer[field.key] = value
  }
  return validateAnswer(form, answer) ? undefined : answer
}

function automaticValue(field: InputField): Form.Value | undefined {
  if (field.type === "boolean") return field.default ?? false
  if (field.type === "number" || field.type === "integer") {
    if (field.default !== undefined) return field.default
    const bounded = field.minimum ?? (field.maximum !== undefined && field.maximum < 0 ? field.maximum : 0)
    const value = field.type === "integer" ? Math.ceil(bounded) : bounded
    return validateField(field, value) ? undefined : value
  }
  if (field.type === "multiselect") {
    if (field.default !== undefined) return validateField(field, field.default) ? undefined : field.default
    if (!field.required && (field.minItems ?? 0) === 0) return
    const count = Math.max(field.minItems ?? 1, 1)
    const value = field.options.slice(0, count).map((option) => option.value)
    return validateField(field, value) ? undefined : value
  }
  if (field.default !== undefined) return validateField(field, field.default) ? undefined : field.default
  const option = field.options?.[0]?.value
  if (option !== undefined) return validateField(field, option) ? undefined : option
  if (!field.required) return
  const candidates = [
    field.placeholder,
    field.format === "email"
      ? "user@example.com"
      : field.format === "uri"
        ? "https://example.com"
        : field.format === "date"
          ? "1970-01-01"
          : field.format === "date-time"
            ? "1970-01-01T00:00:00.000Z"
            : "Continue",
  ].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    const minimum = field.minLength ?? 0
    const maximum = field.maxLength ?? Number.MAX_SAFE_INTEGER
    const value = candidate.padEnd(minimum, "x").slice(0, maximum)
    if (!validateField(field, value)) return value
  }
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
