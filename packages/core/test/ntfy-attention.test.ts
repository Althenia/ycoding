import { describe, expect, test } from "bun:test"
import { Money } from "@ycoding-ai/schema/money"
import { DateTime, Deferred, Effect, Layer, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "@ycoding-ai/core/config"
import { ConfigNtfy } from "@ycoding-ai/core/config/ntfy"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { EventV2 } from "@ycoding-ai/core/event"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Location } from "@ycoding-ai/core/location"
import { NtfyAttention, type GoalStatus, type RequestKind } from "@ycoding-ai/core/ntfy/attention"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGenerate } from "@ycoding-ai/core/session/generate"
import { SessionGenerateNode } from "@ycoding-ai/core/session/generate-node"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionStore } from "@ycoding-ai/core/session/store"

const requests: Array<{ url: string; body: string }> = []
let responseStatus = 200

const http = HttpClient.make((request) =>
  Effect.gen(function* () {
    const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
    requests.push({ url: request.url, body: yield* Effect.promise(() => web.text()) })
    return HttpClientResponse.fromWeb(request, new Response("server response", { status: responseStatus }))
  }),
)

const reset = (status = 200) => {
  requests.length = 0
  responseStatus = status
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))
const settle = Effect.forEach(Array.from({ length: 4 }), () => Effect.yieldNow, { discard: true })

const make = (input: {
  readonly config?: (sessionID: string) => { enabled?: boolean; topic?: string } | undefined
  readonly permission?: (sessionID: string) => "allow" | "ask" | "deny"
  readonly generate?: (sessionID: string, prompt: string) => Effect.Effect<string, unknown>
  readonly parentID?: (sessionID: string) => string | undefined
  readonly goal?: (sessionID: string) => GoalStatus | undefined
  readonly notified?: (sessionID: string, startedAt?: number) => boolean
  readonly checkpoint?: Effect.Effect<void>
}) => {
  const dependencies = {
    send: (_sessionID: string, topic: string, message: string) => NtfyAttention.post(http, topic, message),
    settings: (sessionID: string) => Effect.sync(() => input.config?.(sessionID)),
    authorize: (sessionID: string) => Effect.sync(() => input.permission?.(sessionID) ?? "allow"),
    generate: (sessionID: string, prompt: string) =>
      input.generate?.(sessionID, prompt) ?? Effect.succeed("Generated session update"),
    session: (sessionID: string) =>
      Effect.sync(() => ({ parentID: input.parentID?.(sessionID) }) as { readonly parentID?: string }),
    goal: (sessionID: string) => Effect.sync(() => input.goal?.(sessionID)),
    notified: (sessionID: string, startedAt?: number) =>
      Effect.sync(() => input.notified?.(sessionID, startedAt) ?? false),
    checkpoint: input.checkpoint ?? Effect.void,
  }
  return NtfyAttention.make(dependencies)
}

const asked = (kind: RequestKind, requestID = "req-1") =>
  ({ type: "asked", kind, sessionID: "ses_root", requestID }) as const
const resolved = (kind: RequestKind, requestID = "req-1") =>
  ({ type: "resolved", kind, sessionID: "ses_root", requestID }) as const
const started = (sessionID = "ses_root") => ({ type: "started", sessionID }) as const
const settled = (outcome: "succeeded" | "failed", sessionID = "ses_root") =>
  ({ type: "settled", outcome, sessionID }) as const
const interrupted = (reason: "user" | "shutdown" | "superseded", sessionID = "ses_root") =>
  ({ type: "interrupted", reason, sessionID }) as const

describe("NtfyAttention", () => {
  describe("decide", () => {
    test("requires human attention for unresolved requests", () => {
      for (const kind of ["permission", "question", "guardrail", "form"] as const) {
        expect(NtfyAttention.decide(asked(kind), {}).notify).toBe(true)
      }
    })

    test("clears a request episode when the request resolves", () => {
      expect(NtfyAttention.decide(resolved("permission"))).toEqual({
        notify: false,
        clear: "request:permission:ses_root:req-1",
      })
    })

    test("stays silent for routine active-goal continuation settlement", () => {
      expect(NtfyAttention.decide(settled("succeeded"), { goalStatus: "active" }).notify).toBe(false)
    })

    test("notifies for verified normal completion and terminal goal settlement", () => {
      expect(NtfyAttention.decide(settled("succeeded"), {})).toMatchObject({ notify: true, message: "Session done" })
      expect(NtfyAttention.decide(settled("succeeded"), { goalStatus: "completed" })).toMatchObject({ notify: true })
      expect(NtfyAttention.decide(settled("succeeded"), { goalStatus: "exhausted" })).toMatchObject({
        notify: true,
        message: "Goal exhausted",
      })
    })

    test("stays silent for child completion", () => {
      expect(NtfyAttention.decide(settled("succeeded"), { parentID: "ses_root" }).notify).toBe(false)
      expect(NtfyAttention.decide(settled("failed"), { parentID: "ses_root" }).notify).toBe(false)
    })

    test("notifies for a root failure and for attention-requiring interruptions", () => {
      expect(NtfyAttention.decide(settled("failed"), {})).toMatchObject({ notify: true, message: "Session failed" })
      expect(NtfyAttention.decide(interrupted("shutdown"), {}).notify).toBe(true)
      expect(NtfyAttention.decide(interrupted("shutdown", "ses_child"), { parentID: "ses_root" }).notify).toBe(false)
      expect(NtfyAttention.decide(interrupted("user"), {}).notify).toBe(false)
      expect(NtfyAttention.decide(interrupted("superseded"), {}).notify).toBe(false)
    })

    test("notifies when an active goal is stopped", () => {
      expect(NtfyAttention.decide(settled("succeeded"), { goalStatus: "stopped" })).toMatchObject({
        notify: true,
        message: "Goal stopped",
      })
    })

    test("clears the terminal episode when the session runs again", () => {
      expect(NtfyAttention.decide(started())).toEqual({ notify: false, clear: "terminal:ses_root" })
    })
  })

  test("recognizes only a completed ntfy tool from the current execution", () => {
    const tool = (name: string, status: "completed" | "error", completed: number) => ({
      type: "assistant",
      content: [
        {
          type: "tool",
          name,
          state: { status },
          time: { completed: DateTime.makeUnsafe(completed) },
        },
      ],
    })

    expect(NtfyAttention.notifiedSince([tool("ntfy", "completed", 200)], 100)).toBe(true)
    expect(NtfyAttention.notifiedSince([tool("ntfy", "completed", 200)], 300)).toBe(false)
    expect(NtfyAttention.notifiedSince([tool("ntfy", "error", 200)], 100)).toBe(false)
    expect(NtfyAttention.notifiedSince([tool("read", "completed", 200)], 100)).toBe(false)
  })

  describe("notify", () => {
    test("sends one configured attention message for an unresolved request", () =>
      run(
        Effect.gen(function* () {
          reset()
          let generatedPrompt = ""
          const attention = make({
            config: () => ({ enabled: true, topic: "attention" }),
            generate: (sessionID, prompt) =>
              Effect.sync(() => {
                expect(sessionID).toBe("ses_root")
                generatedPrompt = prompt
                return "Generated session update"
              }),
          })
          yield* attention.notify(asked("permission"))
          yield* settle
          expect(requests).toHaveLength(1)
          expect(requests[0]?.url).toBe("https://ntfy.sh/attention")
          expect(requests[0]?.body).toBe("Generated session update")
          expect(generatedPrompt).toContain("latest assistant response")
          expect(generatedPrompt).toContain("Attention trigger: Permission needs input")
        }),
      ))

    test("preserves a pending guardrail review as genuine human attention", () =>
      run(
        Effect.gen(function* () {
          reset()
          const attention = make({ config: () => ({ enabled: true, topic: "attention" }) })
          yield* attention.notify(asked("guardrail", "grq-hard"))
          yield* settle
          expect(requests.map((item) => item.body)).toEqual(["Generated session update"])
        }),
      ))

    test("does not repeat the same unresolved request episode until it resolves", () =>
      run(
        Effect.gen(function* () {
          reset()
          const attention = make({ config: () => ({ enabled: true, topic: "attention" }) })
          yield* attention.notify(asked("permission"))
          yield* attention.notify(asked("permission"))
          yield* settle
          expect(requests).toHaveLength(1)
          yield* attention.notify(resolved("permission"))
          yield* attention.notify(asked("permission"))
          yield* settle
          expect(requests).toHaveLength(2)
        }),
      ))

    test("waits for the checkpoint and suppresses a request resolved before it", () =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            reset()
            const checkpoint = yield* Deferred.make<void>()
            const attention = make({
              config: () => ({ enabled: true, topic: "attention" }),
              checkpoint: Deferred.await(checkpoint),
            })
            yield* attention.notify(asked("permission"))
            expect(requests).toEqual([])
            yield* attention.notify(resolved("permission"))
            yield* Deferred.succeed(checkpoint, undefined)
            yield* Effect.yieldNow
            expect(requests).toEqual([])
          }),
        ),
      ))

    test("requires an existing noninteractive allow without asking or sending on ask or deny", () =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            reset()
            const effects: Array<"allow" | "ask" | "deny"> = ["ask", "deny", "allow", "allow"]
            const attention = make({
              config: () => ({ enabled: true, topic: "attention" }),
              permission: () => effects.shift() ?? "deny",
            })
            yield* attention.notify(asked("permission", "req-ask"))
            yield* attention.notify(asked("permission", "req-deny"))
            yield* attention.notify(asked("permission", "req-allow"))
            yield* Effect.yieldNow
            expect(requests.map((item) => item.body)).toEqual(["Generated session update"])
          }),
        ),
      ))

    test("generates only after authorization and rechecks authorization before sending", () =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            reset()
            const generationStarted = yield* Deferred.make<void>()
            const generated = yield* Deferred.make<string>()
            const permissions: Array<"allow" | "deny"> = ["allow", "deny"]
            let generations = 0
            const attention = make({
              config: () => ({ enabled: true, topic: "attention" }),
              permission: () => permissions.shift() ?? "deny",
              generate: () =>
                Effect.gen(function* () {
                  generations += 1
                  yield* Deferred.succeed(generationStarted, undefined)
                  return yield* Deferred.await(generated)
                }),
            })
            yield* attention.notify(asked("question"))
            yield* Deferred.await(generationStarted)
            expect(generations).toBe(1)
            yield* Deferred.succeed(generated, "Generated question update")
            yield* settle
            expect(requests).toEqual([])
          }),
        ),
      ))

    test("skips delivery without a static fallback when generation is unavailable", () =>
      run(
        Effect.gen(function* () {
          reset()
          const attention = make({
            config: () => ({ enabled: true, topic: "attention" }),
            generate: () => Effect.fail("unavailable"),
          })
          yield* attention.notify(settled("failed"))
          yield* settle
          expect(requests).toEqual([])
        }),
      ))

    test("suppresses a generated request notification resolved while generation is pending", () =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            reset()
            const generationStarted = yield* Deferred.make<void>()
            const generated = yield* Deferred.make<string>()
            const attention = make({
              config: () => ({ enabled: true, topic: "attention" }),
              generate: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(generationStarted, undefined)
                  return yield* Deferred.await(generated)
                }),
            })
            yield* attention.notify(asked("permission"))
            yield* Deferred.await(generationStarted)
            yield* attention.notify(resolved("permission"))
            yield* Deferred.succeed(generated, "Permission input is needed")
            yield* settle
            expect(requests).toEqual([])
          }),
        ),
      ))

    test("stays silent for routine active-goal settlement and child completion", () =>
      run(
        Effect.gen(function* () {
          reset()
          const attention = make({
            config: () => ({ enabled: true, topic: "attention" }),
            goal: () => "active",
            parentID: (sessionID) => (sessionID === "ses_child" ? "ses_root" : undefined),
          })
          yield* attention.notify(settled("succeeded"))
          yield* attention.notify(settled("succeeded", "ses_child"))
          expect(requests).toEqual([])
        }),
      ))

    test("notifies once per session terminal episode", () =>
      run(
        Effect.gen(function* () {
          reset()
          const attention = make({ config: () => ({ enabled: true, topic: "attention" }) })
          yield* attention.notify(settled("succeeded", "ses_a"))
          yield* attention.notify(settled("succeeded", "ses_a"))
          yield* attention.notify(settled("succeeded", "ses_b"))
          yield* settle
          expect(requests.map((item) => item.body)).toEqual(["Generated session update", "Generated session update"])
        }),
      ))

    test("coalesces successor executions behind one stable terminal checkpoint", () =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            reset()
            const checkpoint = yield* Deferred.make<void>()
            const attention = make({
              config: () => ({ enabled: true, topic: "attention" }),
              checkpoint: Deferred.await(checkpoint),
            })
            yield* attention.notify(started())
            yield* attention.notify(settled("succeeded"))
            yield* attention.notify(started())
            yield* attention.notify(settled("succeeded"))
            expect(requests).toEqual([])
            yield* Deferred.succeed(checkpoint, undefined)
            yield* settle
            expect(requests.map((item) => item.body)).toEqual(["Generated session update"])
          }),
        ),
      ))

    test("suppresses a generated terminal notification when a successor execution starts", () =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            reset()
            const generationStarted = yield* Deferred.make<void>()
            const firstGenerated = yield* Deferred.make<string>()
            let generations = 0
            const attention = make({
              config: () => ({ enabled: true, topic: "attention" }),
              generate: () => {
                generations += 1
                if (generations > 1) return Effect.succeed("Current execution finished")
                return Deferred.succeed(generationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(firstGenerated)),
                )
              },
            })
            yield* attention.notify(started())
            yield* attention.notify(settled("succeeded"))
            yield* Deferred.await(generationStarted)
            yield* attention.notify(started())
            yield* Deferred.succeed(firstGenerated, "Stale execution finished")
            yield* settle
            expect(requests).toEqual([])

            yield* attention.notify(settled("succeeded"))
            yield* settle
            expect(requests.map((item) => item.body)).toEqual(["Current execution finished"])
          }),
        ),
      ))

    test("alerts once when an active goal reaches a terminal status", () =>
      run(
        Effect.gen(function* () {
          reset()
          let goal: GoalStatus = "active"
          const attention = make({
            config: () => ({ enabled: true, topic: "attention" }),
            goal: () => goal,
          })
          yield* attention.notify(started())
          yield* attention.notify(settled("succeeded"))
          yield* settle
          expect(requests).toEqual([])
          yield* attention.notify(started())
          goal = "stopped"
          yield* attention.notify(settled("succeeded"))
          yield* settle
          expect(requests.map((item) => item.body)).toEqual(["Generated session update"])
        }),
      ))

    test("does not replay a retained exhausted goal as the outcome of later ordinary work", () =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            reset()
            const attention = make({
              config: () => ({ enabled: true, topic: "attention" }),
              goal: () => "exhausted",
            })
            yield* attention.notify(started())
            yield* attention.notify(settled("succeeded"))
            yield* Effect.yieldNow
            expect(requests.map((item) => item.body)).toEqual(["Generated session update"])
          }),
        ),
      ))

    test("does not duplicate a successful ntfy tool notification at successful settlement", () =>
      run(
        Effect.gen(function* () {
          reset()
          const attention = make({
            config: () => ({ enabled: true, topic: "attention" }),
            notified: () => true,
          })
          yield* attention.notify(started())
          yield* attention.notify(settled("succeeded"))
          yield* settle
          expect(requests).toEqual([])
        }),
      ))

    test("ignores disabled or blank-topic configuration", () =>
      run(
        Effect.gen(function* () {
          reset()
          const disabled = make({ config: () => ({ enabled: false, topic: "attention" }) })
          const blank = make({ config: () => ({ enabled: true, topic: "  " }) })
          const absent = make({ config: () => undefined })
          yield* disabled.notify(asked("permission", "req-d"))
          yield* blank.notify(asked("permission", "req-b"))
          yield* absent.notify(asked("permission", "req-a"))
          expect(requests).toEqual([])
        }),
      ))

    test("records one episode even when transport fails, without failing the caller", () =>
      run(
        Effect.gen(function* () {
          reset(500)
          const attention = make({ config: () => ({ enabled: true, topic: "attention" }) })
          yield* attention.notify(asked("permission"))
          yield* settle
          expect(requests).toHaveLength(1)
          yield* attention.notify(asked("permission"))
          yield* settle
          expect(requests).toHaveLength(1)
        }),
      ))
  })

  test("observes execution start before a cold Location boots and labels its terminal goal", async () => {
    reset()
    const ref = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
    const sessionID = SessionSchema.ID.make("ses_cold")
    let goal: GoalStatus = "active"
    const session = SessionSchema.Info.make({
      id: sessionID,
      projectID: ProjectV2.ID.make("project"),
      title: "Cold session",
      cost: Money.USD.make(0),
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
      location: ref,
    })
    const store = Layer.mock(SessionStore.Service, {
      get: (input) => Effect.succeed(input === sessionID ? session : undefined),
      context: () => Effect.succeed([]),
    })
    const autonomy = Layer.mock(SessionAutonomy.Service, {
      get: () =>
        Effect.succeed({
          mode: "normal",
          yolo: 0,
          goal: { text: "Cold goal", status: goal, iteration: 1, noProgress: 0, maxNoProgress: 2 },
        }),
    })
    const permission = Layer.mock(PermissionV2.Service, {
      evaluateEffective: () => Effect.succeed("allow"),
    })
    const generate = Layer.mock(SessionGenerate.Service, {
      generate: () => Effect.succeed("Generated goal update"),
    })
    const config = Layer.mock(Config.Service, {
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({ ntfy: new ConfigNtfy.Info({ enabled: true, topic: "attention" }) }),
          }),
        ]),
    })
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, SessionStore.node, SessionAutonomy.node, LocationServiceMap.node]),
      [
        [SessionStore.node, store],
        [SessionAutonomy.node, autonomy],
        [Config.node, config],
        [PermissionV2.node, permission],
        [SessionGenerateNode.node, generate],
        [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, http)],
      ],
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          const locations = yield* LocationServiceMap.Service
          yield* events.publish(SessionEvent.Execution.Started, { sessionID })
          yield* locations.contextEffect(ref)
          goal = "exhausted"
          yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
          yield* Effect.sleep("600 millis")
          expect(requests.filter((item) => item.url === "https://ntfy.sh/attention").map((item) => item.body)).toEqual([
            "Generated goal update",
          ])
        }).pipe(Effect.provide(layer)),
      ),
    )
  })
})
