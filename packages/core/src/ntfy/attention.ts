export * as NtfyAttention from "./attention"

import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { and, count, eq, inArray } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { EventV2 } from "../event"
import { Form } from "../form"
import { LocationServiceMap } from "../location-service-map"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { SessionAutonomy } from "../session/autonomy"
import { SessionTaskTable } from "../session/sql"
import { SessionEvent } from "../session/event"
import { SessionGenerate } from "../session/generate"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { Shell } from "../shell"
import { NtfyMessage } from "./message"

const CHECKPOINT = Effect.sleep("500 millis")
export const resource = "https://ntfy.sh/*"

export const RequestKind = ["permission", "question", "guardrail", "form"] as const
export type RequestKind = (typeof RequestKind)[number]

export type GoalStatus = "active" | "completed" | "stopped" | "exhausted"

export type AttentionEvent =
  | { readonly type: "asked"; readonly kind: RequestKind; readonly sessionID: string; readonly requestID: string }
  | { readonly type: "resolved"; readonly kind: RequestKind; readonly sessionID: string; readonly requestID: string }
  | { readonly type: "started"; readonly sessionID: string; readonly at?: number }
  | { readonly type: "settled"; readonly outcome: "succeeded" | "failed"; readonly sessionID: string }
  | {
      readonly type: "interrupted"
      readonly sessionID: string
      readonly reason: "user" | "shutdown" | "superseded"
    }

export type Context = {
  readonly parentID?: string
  readonly goalStatus?: GoalStatus
}

export type Decision =
  | { readonly notify: false; readonly clear?: string }
  | { readonly notify: true; readonly message: string; readonly episode: string }

const requestMessage: Record<RequestKind, string> = {
  permission: "Permission needs input",
  question: "Question needs input",
  guardrail: "Guardrail approval needed",
  form: "Input needs response",
}

const requestEpisode = (kind: RequestKind, sessionID: string, requestID: string) =>
  `request:${kind}:${sessionID}:${requestID}`

const terminalEpisode = (sessionID: string) => `terminal:${sessionID}`

export function decide(event: AttentionEvent, context: Context = {}): Decision {
  if (event.type === "resolved")
    return { notify: false, clear: requestEpisode(event.kind, event.sessionID, event.requestID) }
  if (event.type === "asked")
    return {
      notify: true,
      message: requestMessage[event.kind],
      episode: requestEpisode(event.kind, event.sessionID, event.requestID),
    }
  if (event.type === "started") return { notify: false, clear: terminalEpisode(event.sessionID) }
  if (context.parentID) return { notify: false }
  if (event.type === "interrupted") {
    if (event.reason !== "shutdown") return { notify: false }
    return { notify: true, message: "Session interrupted", episode: terminalEpisode(event.sessionID) }
  }
  if (event.outcome === "failed")
    return { notify: true, message: "Session failed", episode: terminalEpisode(event.sessionID) }
  if (context.goalStatus === "exhausted")
    return { notify: true, message: "Goal exhausted", episode: terminalEpisode(event.sessionID) }
  if (context.goalStatus === "stopped")
    return { notify: true, message: "Goal stopped", episode: terminalEpisode(event.sessionID) }
  if (context.goalStatus === "completed")
    return { notify: true, message: "Session done", episode: terminalEpisode(event.sessionID) }
  return { notify: false }
}

export type Settings = { readonly enabled?: boolean; readonly topic?: string }

export function topic(settings: Settings | undefined) {
  if (settings?.enabled !== true) return undefined
  const value = settings.topic?.trim()
  return value ? value : undefined
}

export function post(http: HttpClient.HttpClient, topic: string, message: string) {
  return http
    .execute(
      HttpClientRequest.post(`https://ntfy.sh/${encodeURIComponent(topic)}`).pipe(
        HttpClientRequest.bodyText(message, "text/plain"),
      ),
    )
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid)
}

export interface Dependencies {
  readonly send: (sessionID: string, topic: string, message: string) => Effect.Effect<void, unknown, Scope.Scope>
  readonly settings: (sessionID: string) => Effect.Effect<Settings | undefined, never, Scope.Scope>
  readonly authorize: (sessionID: string) => Effect.Effect<"allow" | "ask" | "deny", never, Scope.Scope>
  readonly generate: (sessionID: string, prompt: string) => Effect.Effect<string, unknown, Scope.Scope>
  readonly session: (sessionID: string) => Effect.Effect<{ readonly parentID?: string } | undefined>
  readonly goal: (sessionID: string) => Effect.Effect<GoalStatus | undefined>
  readonly notified: (sessionID: string, startedAt?: number) => Effect.Effect<boolean>
  readonly unfinished: (sessionID: string) => Effect.Effect<boolean>
  readonly runningShell: (sessionID: string) => Effect.Effect<boolean, never, Scope.Scope>
  readonly checkpoint?: Effect.Effect<void>
}

type TerminalEpisode = {
  readonly sessionID: string
  readonly initialGoalStatus?: GoalStatus
  startedAt?: number
  state: "active" | "waiting" | "terminal"
  version: number
}

export function make(dependencies: Dependencies) {
  const requests = new Map<string, object>()
  const delivered = new Set<string>()
  const terminals = new Map<string, TerminalEpisode>()
  const checkpoint = dependencies.checkpoint ?? CHECKPOINT

  const deliver = Effect.fn("NtfyAttention.deliver")(function* (
    sessionID: string,
    decision: Extract<Decision, { readonly notify: true }>,
    live: () => boolean,
  ) {
    if (!live() || delivered.has(decision.episode)) return
    delivered.add(decision.episode)
    const configured = topic(yield* dependencies.settings(sessionID))
    if (!configured) return
    if ((yield* dependencies.authorize(sessionID)) !== "allow") return
    const generated = yield* dependencies.generate(sessionID, NtfyMessage.prompt(decision.message)).pipe(
      Effect.map((message) => ({ type: "generated" as const, message: NtfyMessage.sanitize(message) })),
      Effect.catch(() => Effect.succeed({ type: "unavailable" as const })),
    )
    if (generated.type === "unavailable") {
      yield* Effect.logWarning("Skipped automatic ntfy attention message", { category: "generation_unavailable" })
      return
    }
    if (!generated.message) {
      yield* Effect.logWarning("Skipped automatic ntfy attention message", { category: "generation_invalid" })
      return
    }
    if (!live()) return
    const currentTopic = topic(yield* dependencies.settings(sessionID))
    if (!currentTopic || (yield* dependencies.authorize(sessionID)) !== "allow" || !live()) return
    yield* dependencies
      .send(sessionID, currentTopic, generated.message)
      .pipe(
        Effect.catch(() =>
          Effect.logWarning("Failed to deliver ntfy attention message", { category: "transport_failed" }).pipe(
            Effect.asVoid,
          ),
        ),
      )
  })

  const finishTerminal = Effect.fn("NtfyAttention.finishTerminal")(function* (
    episode: TerminalEpisode,
    version: number,
    event: Extract<AttentionEvent, { readonly type: "settled" | "interrupted" }>,
  ) {
    yield* checkpoint
    if (terminals.get(episode.sessionID) !== episode || episode.state !== "waiting" || episode.version !== version)
      return
    const session = yield* dependencies.session(episode.sessionID)
    const finalGoalStatus = yield* dependencies.goal(episode.sessionID)
    if (terminals.get(episode.sessionID) !== episode || episode.state !== "waiting" || episode.version !== version)
      return
    if (event.type === "settled" && event.outcome === "succeeded") {
      if (yield* dependencies.notified(episode.sessionID, episode.startedAt)) {
        episode.state = "terminal"
        return
      }
    }
    const decision = decide(event, {
      parentID: session?.parentID,
      goalStatus: episode.initialGoalStatus === "active" ? finalGoalStatus : undefined,
    })
    if (decision.notify && episode.initialGoalStatus === "active" && finalGoalStatus === "completed") {
      if ((yield* dependencies.unfinished(episode.sessionID)) || (yield* dependencies.runningShell(episode.sessionID))) {
        episode.state = "terminal"
        return
      }
    }
    const live = () =>
      terminals.get(episode.sessionID) === episode && episode.state === "waiting" && episode.version === version
    if (decision.notify) yield* deliver(episode.sessionID, decision, live)
    if (live()) episode.state = "terminal"
  })

  const terminal = Effect.fn("NtfyAttention.terminal")(function* (
    event: Extract<AttentionEvent, { readonly type: "settled" | "interrupted" }>,
  ) {
    const current = terminals.get(event.sessionID)
    if (current?.state === "waiting" || current?.state === "terminal") return
    const episode =
      current ??
      ({
        sessionID: event.sessionID,
        initialGoalStatus: yield* dependencies.goal(event.sessionID),
        startedAt: undefined,
        state: "active",
        version: 0,
      } satisfies TerminalEpisode)
    if (!current) terminals.set(event.sessionID, episode)
    episode.state = "waiting"
    episode.version += 1
    yield* finishTerminal(episode, episode.version, event).pipe(Effect.forkScoped({ startImmediately: true }))
  })

  const notify = (event: AttentionEvent) => {
    if (event.type === "resolved") {
      const episode = requestEpisode(event.kind, event.sessionID, event.requestID)
      requests.delete(episode)
      delivered.delete(episode)
      return Effect.void
    }
    if (event.type === "asked") {
      const decision = decide(event)
      if (!decision.notify || requests.has(decision.episode)) return Effect.void
      const request = {}
      requests.set(decision.episode, request)
      return checkpoint.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            requests.get(decision.episode) === request
              ? deliver(event.sessionID, decision, () => requests.get(decision.episode) === request)
              : Effect.void,
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
        Effect.asVoid,
      )
    }
    if (event.type === "started") {
      const current = terminals.get(event.sessionID)
      if (current?.state !== "terminal") {
        if (current) {
          current.state = "active"
          current.startedAt = event.at
          current.version += 1
          delivered.delete(terminalEpisode(event.sessionID))
          return Effect.void
        }
      }
      return dependencies.goal(event.sessionID).pipe(
        Effect.tap((initialGoalStatus) =>
          Effect.sync(() => {
            terminals.set(event.sessionID, {
              sessionID: event.sessionID,
              initialGoalStatus,
              startedAt: event.at,
              state: "active",
              version: 0,
            })
            delivered.delete(terminalEpisode(event.sessionID))
          }),
        ),
        Effect.asVoid,
      )
    }
    return terminal(event)
  }

  return { notify }
}

const Events = [
  PermissionV2.Event.Asked,
  PermissionV2.Event.Replied,
  QuestionV2.Event.Asked,
  QuestionV2.Event.Replied,
  QuestionV2.Event.Rejected,
  Guardrail.Event.Asked,
  Guardrail.Event.Replied,
  Form.Event.Created,
  Form.Event.Replied,
  Form.Event.Cancelled,
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
] as const

interface DeliveryInterface {
  readonly send: (topic: string, message: string) => Effect.Effect<void, unknown>
}

export class Delivery extends Context.Service<Delivery, DeliveryInterface>()("@ycoding/NtfyAttentionDelivery") {}

export const deliveryNode = makeLocationNode({
  service: Delivery,
  layer: Layer.effect(
    Delivery,
    Effect.map(HttpClient.HttpClient, (http) => Delivery.of({ send: (topic, message) => post(http, topic, message) })),
  ),
  deps: [LayerNodePlatform.httpClient],
})

type HistoryMessage = {
  readonly type: string
  readonly content?: ReadonlyArray<unknown>
}

const CompletedNtfyTool = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.Literal("ntfy"),
  state: Schema.Struct({ status: Schema.Literal("completed") }),
  time: Schema.Struct({ completed: Schema.DateTimeUtc }),
})
const isCompletedNtfyTool = Schema.is(CompletedNtfyTool)

export function notifiedSince(messages: ReadonlyArray<HistoryMessage>, startedAt?: number) {
  if (startedAt === undefined) return false
  return messages.some(
    (message) =>
      message.type === "assistant" &&
      message.content?.some(
        (part) => isCompletedNtfyTool(part) && DateTime.toEpochMillis(part.time.completed) >= startedAt,
      ) === true,
  )
}

export const lifecycleLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
    const locations = yield* LocationServiceMap.Service
    const sessions = Option.getOrUndefined(yield* Effect.serviceOption(SessionStore.Service))
    const autonomy = Option.getOrUndefined(yield* Effect.serviceOption(SessionAutonomy.Service))
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    if (!events || !sessions || !autonomy) return
    const services = Effect.fnUntraced(function* (sessionID: string) {
      if (!Schema.is(SessionSchema.ID)(sessionID)) return undefined
      const session = yield* sessions.get(sessionID)
      if (!session) return undefined
      const context = yield* locations.contextEffect(session.location)
      return {
        config: Context.get(context, Config.Service),
        delivery: Context.get(context, Delivery),
        generate: Context.get(context, SessionGenerate.Service),
        permission: Context.get(context, PermissionV2.Service),
        shell: Context.get(context, Shell.Service),
      }
    })
    const attention = make({
      send: (sessionID, topic, message) =>
        services(sessionID).pipe(
          Effect.flatMap((value) => (value ? value.delivery.send(topic, message) : Effect.void)),
        ),
      settings: (sessionID) =>
        services(sessionID).pipe(
          Effect.flatMap((value) =>
            value
              ? value.config.entries().pipe(Effect.map((entries) => Config.latest(entries, "ntfy")))
              : Effect.succeed(undefined),
          ),
        ),
      authorize: (sessionID) =>
        services(sessionID).pipe(
          Effect.flatMap((value) =>
            value && Schema.is(SessionSchema.ID)(sessionID)
              ? value.permission
                  .evaluateEffective({ sessionID, action: "ntfy", resource })
                  .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed("deny" as const)))
              : Effect.succeed("deny" as const),
          ),
        ),
      generate: (sessionID, prompt) =>
        services(sessionID).pipe(
          Effect.flatMap(
            (value): Effect.Effect<string, unknown> =>
              value && Schema.is(SessionSchema.ID)(sessionID)
                ? value.generate.generate({ sessionID, prompt }).pipe(Effect.mapError((error): unknown => error))
                : Effect.fail("generation_unavailable" as const),
          ),
        ),
      session: (sessionID) =>
        Schema.is(SessionSchema.ID)(sessionID) ? sessions.get(sessionID) : Effect.succeed(undefined),
      goal: (sessionID) =>
        Schema.is(SessionSchema.ID)(sessionID)
          ? autonomy.get(sessionID).pipe(
              Effect.map((state) => state.goal?.status),
              Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)),
            )
          : Effect.succeed(undefined),
      notified: (sessionID, startedAt) =>
        Schema.is(SessionSchema.ID)(sessionID)
          ? sessions.context(sessionID).pipe(
              Effect.map((messages) => notifiedSince(messages, startedAt)),
              Effect.catch(() => Effect.succeed(false)),
            )
          : Effect.succeed(false),
      unfinished: (sessionID) =>
        database && Schema.is(SessionSchema.ID)(sessionID)
          ? database.db
              .select({ active: count() })
              .from(SessionTaskTable)
              .where(
                and(
                  eq(SessionTaskTable.parent_id, sessionID),
                  inArray(SessionTaskTable.state, ["starting", "running", "waiting", "cancelling"]),
                ),
              )
              .get()
              .pipe(
                Effect.map((row) => (row?.active ?? 0) > 0),
                Effect.catch(() => Effect.succeed(true)),
              )
          : Effect.succeed(true),
      runningShell: (sessionID) =>
        services(sessionID).pipe(
          Effect.flatMap((value) =>
            value
              ? value.shell.list().pipe(
                  Effect.map((shells) =>
                    shells.some((shell) => shell.status === "running" && shell.metadata.sessionID === sessionID),
                  ),
                )
              : Effect.succeed(true),
          ),
          Effect.catch(() => Effect.succeed(true)),
        ),
    })
    const dispatch = (event: EventV2.SubscribePayload<typeof Events>) => {
      const input = (() => {
        if (event.type === "permission.v2.asked")
          return {
            type: "asked",
            kind: "permission",
            sessionID: event.data.sessionID,
            requestID: event.data.id,
          } as const
        if (event.type === "permission.v2.replied")
          return {
            type: "resolved",
            kind: "permission",
            sessionID: event.data.sessionID,
            requestID: event.data.requestID,
          } as const
        if (event.type === "question.v2.asked")
          return { type: "asked", kind: "question", sessionID: event.data.sessionID, requestID: event.data.id } as const
        if (event.type === "question.v2.replied" || event.type === "question.v2.rejected")
          return {
            type: "resolved",
            kind: "question",
            sessionID: event.data.sessionID,
            requestID: event.data.requestID,
          } as const
        if (event.type === "guardrail.asked")
          return {
            type: "asked",
            kind: "guardrail",
            sessionID: event.data.rootSessionID,
            requestID: event.data.id,
          } as const
        if (event.type === "guardrail.replied")
          return {
            type: "resolved",
            kind: "guardrail",
            sessionID: event.data.rootSessionID,
            requestID: event.data.requestID,
          } as const
        if (event.type === "form.created")
          return {
            type: "asked",
            kind: "form",
            sessionID: event.data.form.sessionID,
            requestID: event.data.form.id,
          } as const
        if (event.type === "form.replied" || event.type === "form.cancelled")
          return {
            type: "resolved",
            kind: "form",
            sessionID: event.data.sessionID,
            requestID: event.data.id,
          } as const
        if (event.type === "session.execution.started")
          return {
            type: "started",
            sessionID: event.data.sessionID,
            at: DateTime.toEpochMillis(event.created),
          } as const
        if (event.type === "session.execution.succeeded")
          return { type: "settled", outcome: "succeeded", sessionID: event.data.sessionID } as const
        if (event.type === "session.execution.failed")
          return { type: "settled", outcome: "failed", sessionID: event.data.sessionID } as const
        if (event.type === "session.execution.interrupted")
          return { type: "interrupted", sessionID: event.data.sessionID, reason: event.data.reason } as const
        return undefined
      })()
      if (!input) return Effect.void
      return attention.notify(input)
    }

    yield* events.subscribe(Events).pipe(Stream.runForEach(dispatch), Effect.forkScoped({ startImmediately: true }))
  }),
)
