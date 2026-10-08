import { describe, expect } from "bun:test"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Integration } from "@ycoding-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))
const failingCredentialNode = makeGlobalNode({
  service: Credential.Service,
  layer: Layer.succeed(
    Credential.Service,
    Credential.Service.of({
      all: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      refresh: () => Effect.die("unused Credential.refresh"),
      create: () => Effect.die(new Error("credential persistence failed")),
      update: () => Effect.void,
      activate: () => Effect.void,
      remove: () => Effect.void,
    }),
  ),
  deps: [],
})
const failingIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([Integration.node, EventRuntime.node]), [[Credential.node, failingCredentialNode]]),
)

function eventually<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  remaining = 1000,
): Effect.Effect<A, E | Error, R> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

describe("Integration", () => {
  it.effect("registers integrations through the editor", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const openai = Integration.ID.make("openai")

      yield* integrations
        .transform((editor) => editor.update(openai, (integration) => (integration.name = "OpenAI")))
        .pipe(Scope.provide(scope))
      expect(yield* integrations.get(openai)).toEqual(
        Integration.Info.make({ id: openai, name: "OpenAI", methods: [], connections: [] }),
      )

      yield* Scope.close(scope, Exit.void)
      expect(yield* integrations.get(openai)).toBeUndefined()
    }),
  )

  it.effect("reveals the previous registration when an override closes", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const id = Integration.ID.make("openai")
      const first = yield* Scope.fork(yield* Scope.Scope)
      const second = yield* Scope.fork(yield* Scope.Scope)

      yield* integrations
        .transform((editor) => editor.update(id, (integration) => (integration.name = "OpenAI")))
        .pipe(Scope.provide(first))
      yield* integrations
        .transform((editor) => editor.update(id, (integration) => (integration.name = "OpenAI Override")))
        .pipe(Scope.provide(second))
      expect((yield* integrations.get(id))?.name).toBe("OpenAI Override")

      yield* Scope.close(second, Exit.void)
      expect((yield* integrations.get(id))?.name).toBe("OpenAI")
      expect((yield* integrations.list()).map((integration) => integration.id)).toEqual([id])
    }),
  )

  it.effect("registers and overrides methods independently", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("chatgpt")
      const first = yield* Scope.fork(yield* Scope.Scope)
      const second = yield* Scope.fork(yield* Scope.Scope)
      const authorize = () =>
        Effect.succeed({
          mode: "auto" as const,
          url: "https://example.com/authorize",
          instructions: "Sign in",
          callback: Effect.never,
        })

      yield* integrations
        .transform((editor) =>
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "ChatGPT" },
            authorize,
          }),
        )
        .pipe(Scope.provide(first))
      yield* integrations
        .transform((editor) => {
          expect(editor.get(integrationID)).toEqual({ id: integrationID, name: "openai" })
          expect(editor.list()).toEqual([{ id: integrationID, name: "openai" }])
          expect(editor.method.list(integrationID)).toEqual([
            expect.objectContaining({ id: methodID, label: "ChatGPT" }),
          ])
          editor.method.update({
            integrationID,
            method: { id: methodID, type: "oauth", label: "ChatGPT Override" },
            authorize,
          })
        })
        .pipe(Scope.provide(second))

      expect((yield* integrations.get(integrationID))?.name).toBe("openai")
      expect((yield* integrations.get(integrationID))?.methods[0]).toMatchObject({ label: "ChatGPT Override" })

      yield* Scope.close(second, Exit.void)
      expect((yield* integrations.get(integrationID))?.methods[0]).toMatchObject({ label: "ChatGPT" })
      expect((yield* integrations.get(integrationID))?.methods).toEqual([expect.objectContaining({ id: methodID })])
    }),
  )

  it.effect("connects with a key and stores the credential", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const events = yield* EventRuntime.Service
      const integrationID = Integration.ID.make("openai")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { type: "key", label: "API key" },
        }),
      )
      const updated = yield* events
        .subscribe(Integration.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* integrations.connection.key({
        integrationID,
        key: "secret",
        label: "Work",
      })

      expect(yield* credentials.list(integrationID)).toEqual([
        expect.objectContaining({
          integrationID,
          label: "Work",
          value: Credential.Key.make({ type: "key", key: "secret" }),
        }),
      ])
      expect((yield* Fiber.join(updated)).length).toBe(1)
    }),
  )

  it.live("runs command authentication and stores the final output line", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("company")
      const methodID = Integration.MethodID.make("login")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: {
            id: methodID,
            type: "command",
            label: "Log in",
            command: [
              process.execPath,
              "-e",
              'process.stderr.write("https://example.com/login" + String.fromCharCode(10)); await Bun.sleep(50); console.log("secret")',
            ],
          },
        }),
      )

      const attempt = yield* integrations.command.connect({ integrationID, methodID, label: "Work" })
      const pending = yield* eventually(
        integrations.command.status({ integrationID, attemptID: attempt.attemptID }),
        (status) => status.status === "pending" && status.message?.includes("https://example.com/login") === true,
      )
      expect(pending).toMatchObject({ status: "pending", message: "https://example.com/login\n" })

      expect(
        yield* eventually(
          integrations.command.status({ integrationID, attemptID: attempt.attemptID }),
          (status) => status.status === "complete",
        ),
      ).toEqual({ status: "complete", time: attempt.time })
      expect(yield* credentials.list(integrationID)).toEqual([
        expect.objectContaining({
          integrationID,
          label: "Work",
          value: Credential.Key.make({ type: "key", key: "secret" }),
        }),
      ])
    }),
  )

  it.effect("completes code OAuth once and stores the credential", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("chatgpt")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "ChatGPT" },
          authorize: () =>
            Effect.succeed({
              mode: "code" as const,
              url: "https://example.com/authorize",
              instructions: "Paste the code",
              callback: (code: string) =>
                Effect.succeed(
                  Credential.OAuth.make({
                    type: "oauth",
                    methodID,
                    access: "access",
                    refresh: "refresh",
                    expires: 1,
                    metadata: { code },
                  }),
                ),
            }),
        }),
      )

      const attempt = yield* integrations.oauth.connect({
        integrationID,
        methodID,
        inputs: {},
        label: "Personal",
      })
      expect(attempt.mode).toBe("code")
      yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code: "1234" })

      expect((yield* credentials.list(integrationID))[0]).toEqual(
        expect.objectContaining({
          integrationID,
          label: "Personal",
          value: Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: "access",
            refresh: "refresh",
            expires: 1,
            metadata: { code: "1234" },
          }),
        }),
      )
    }),
  )

  it.effect("keeps code attempts open when the code is missing and closes them on cancel", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("chatgpt")
      let closed = false
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "ChatGPT" },
          authorize: () =>
            Effect.addFinalizer(() => Effect.sync(() => (closed = true))).pipe(
              Effect.as({
                mode: "code" as const,
                url: "https://example.com/authorize",
                instructions: "Paste the code",
                callback: () => Effect.die("unexpected callback"),
              }),
            ),
        }),
      )

      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
      expect(
        yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID }).pipe(Effect.flip),
      ).toBeInstanceOf(Integration.CodeRequiredError)
      expect(closed).toBe(false)
      yield* integrations.oauth.cancel({
        integrationID: Integration.ID.make("other"),
        attemptID: attempt.attemptID,
      })
      expect(closed).toBe(false)
      yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
      expect(closed).toBe(true)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("completes auto OAuth in the background", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("browser")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Browser" },
          authorize: () =>
            Effect.succeed({
              mode: "auto" as const,
              url: "https://example.com/authorize",
              instructions: "Sign in",
              callback: Effect.succeed(
                Credential.OAuth.make({ type: "oauth", methodID, access: "access", refresh: "refresh", expires: 1 }),
              ),
            }),
        }),
      )

      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
      expect(attempt.manualCode).toBeUndefined()
      yield* Effect.yieldNow
      expect(yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).toEqual({
        status: "complete",
        time: attempt.time,
      })
      expect(yield* credentials.list(integrationID)).toHaveLength(1)
    }),
  )

  it.effect("submits one manual code to an auto attempt without settling before its callback", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("browser-manual")
      const finished = yield* Deferred.make<void>()
      const submissionStarted = yield* Deferred.make<void>()
      const submissionRelease = yield* Deferred.make<void>()
      const submitted: string[] = []
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Browser" },
          authorize: () => Effect.succeed({
            mode: "auto" as const,
            url: "https://example.com/authorize",
            instructions: "Sign in or enter the code",
            submitCode: (code: string) => Effect.gen(function* () {
              submitted.push(code)
              yield* Deferred.succeed(submissionStarted, undefined)
              yield* Deferred.await(submissionRelease)
            }),
            callback: Deferred.await(finished).pipe(Effect.as(Credential.OAuth.make({ type: "oauth", methodID, access: "access", refresh: "refresh", expires: 1 }))),
          }),
        }),
      )

      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
      expect(attempt.manualCode).toBe(true)
      expect(yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).toMatchObject({ status: "pending" })
      const submission = yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code: "code#state" }).pipe(Effect.forkChild)
      yield* Deferred.await(submissionStarted)
      expect(submitted).toEqual(["code#state"])
      expect(yield* credentials.list(integrationID)).toEqual([])
      expect(yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).toMatchObject({ status: "pending" })
      expect(yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code: "second" }).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect(submitted).toEqual(["code#state"])
      yield* Deferred.succeed(submissionRelease, undefined)
      yield* Fiber.join(submission)
      yield* Deferred.succeed(finished, undefined)
      yield* eventually(integrations.oauth.status({ integrationID, attemptID: attempt.attemptID }), (value) => value.status === "complete")
      expect(yield* credentials.list(integrationID)).toHaveLength(1)
      expect(yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code: "late" }).pipe(Effect.exit)).toMatchObject({ _tag: "Success" })
      expect(submitted).toEqual(["code#state"])
    }),
  )

  it.effect("rejects missing or malformed manual codes and never submits after cancellation", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("browser-manual")
      const submitted: string[] = []
      yield* integrations.transform((editor) => editor.method.update({
        integrationID,
        method: { id: methodID, type: "oauth", label: "Browser" },
        authorize: () => Effect.succeed({
          mode: "auto" as const,
          url: "https://example.com/authorize",
          instructions: "Sign in",
          submitCode: (code: string) => Effect.sync(() => { submitted.push(code) }),
          callback: Effect.never,
        }),
      }))
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
      for (const code of [undefined, "", "  "]) {
        expect(yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code }).pipe(Effect.flip)).toBeInstanceOf(Integration.CodeRequiredError)
      }
      expect(submitted).toEqual([])
      yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
      expect(yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code: "late" }).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect(submitted).toEqual([])
    }),
  )

  it.effect("fails an auto attempt when its manual submission is rejected", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("browser-manual")
      let closed = false
      yield* integrations.transform((editor) => editor.method.update({
        integrationID,
        method: { id: methodID, type: "oauth", label: "Browser" },
        authorize: () => Effect.addFinalizer(() => Effect.sync(() => { closed = true })).pipe(Effect.as({
          mode: "auto" as const,
          url: "https://example.com/authorize",
          instructions: "Sign in",
          submitCode: () => Effect.fail(new Error("Submission refused")),
          callback: Effect.never,
        })),
      }))
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
      const failure = yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code: "code#state" }).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Integration.AuthorizationError)
      expect(yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).toEqual({ status: "failed", message: "Submission refused", time: attempt.time })
      expect(closed).toBe(true)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("interrupts an in-flight manual submission when its auto attempt is cancelled", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("browser-manual")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const submitted: string[] = []
      yield* integrations.transform((editor) => editor.method.update({
        integrationID,
        method: { id: methodID, type: "oauth", label: "Browser" },
        authorize: () => Effect.addFinalizer(() => Deferred.succeed(closed, undefined).pipe(Effect.asVoid)).pipe(Effect.as({
          mode: "auto" as const,
          url: "https://example.com/authorize",
          instructions: "Sign in",
          submitCode: (code: string) => Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            submitted.push(code)
          }),
          callback: Effect.never,
        })),
      }))
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
      const submission = yield* integrations.oauth.complete({ integrationID, attemptID: attempt.attemptID, code: "code#state" }).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(started)
      yield* integrations.oauth.cancel({ integrationID, attemptID: attempt.attemptID })
      expect(yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID }).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      yield* Deferred.await(closed)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(submission)
      expect(submitted).toEqual([])
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  failingIt.effect("fails the attempt when credential persistence fails", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("chatgpt")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "ChatGPT" },
          authorize: () =>
            Effect.succeed({
              mode: "code" as const,
              url: "https://example.com/authorize",
              instructions: "Paste the code",
              callback: () =>
                Effect.succeed(
                  Credential.OAuth.make({
                    type: "oauth",
                    methodID,
                    access: "access",
                    refresh: "refresh",
                    expires: 1,
                  }),
                ),
            }),
        }),
      )

      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
      const exit = yield* integrations.oauth
        .complete({ integrationID, attemptID: attempt.attemptID, code: "1234" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).toEqual({
        status: "failed",
        message: "credential persistence failed",
        time: attempt.time,
      })
    }),
  )

  it.effect("expires abandoned OAuth attempts", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const methodID = Integration.MethodID.make("browser")
      let closed = false
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID,
          method: { id: methodID, type: "oauth", label: "Browser" },
          authorize: () =>
            Effect.addFinalizer(() => Effect.sync(() => (closed = true))).pipe(
              Effect.as({
                mode: "auto" as const,
                url: "https://example.com/authorize",
                instructions: "Sign in",
                callback: Effect.never,
              }),
            ),
        }),
      )

      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
      expect(attempt.time.expires - attempt.time.created).toBe(Duration.toMillis(Duration.minutes(10)))
      yield* TestClock.adjust(Duration.minutes(10))
      yield* Effect.yieldNow
      expect(yield* integrations.oauth.status({ integrationID, attemptID: attempt.attemptID })).toEqual({
        status: "expired",
        time: attempt.time,
      })
      expect(closed).toBe(true)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("uses provider-defined OAuth attempt expirations", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* Clock.currentTimeMillis
      const expirations = [
        created + Duration.toMillis(Duration.minutes(5)),
        created + Duration.toMillis(Duration.minutes(20)),
      ]

      yield* Effect.forEach(expirations, (expiresAt, index) => {
        const methodID = Integration.MethodID.make(`browser-${index}`)
        return Effect.gen(function* () {
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID,
              method: { id: methodID, type: "oauth", label: "Browser" },
              authorize: () =>
                Effect.succeed({
                  mode: "auto" as const,
                  url: "https://example.com/authorize",
                  instructions: "Sign in",
                  expiresAt,
                  callback: Effect.never,
                }),
            }),
          )

          const attempt = yield* integrations.oauth.connect({ integrationID, methodID, inputs: {} })
          expect(attempt.time).toEqual({ created, expires: expiresAt })
        })
      })
    }),
  )

  it.effect("projects credential and env connections", () => {
    const integrationID = Integration.ID.make("acme")
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.INTEGRATION_TEST_ACME_KEY
        process.env.INTEGRATION_TEST_ACME_KEY = "secret"
        delete process.env.INTEGRATION_TEST_ACME_MISSING
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const credentials = yield* Credential.Service
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID,
              method: {
                type: "env",
                names: ["INTEGRATION_TEST_ACME_KEY", "INTEGRATION_TEST_ACME_MISSING"],
              },
            }),
          )
          const work = yield* credentials.create({
            integrationID,
            label: "Work",
            value: Credential.Key.make({ type: "key", key: "a" }),
          })
          const personal = yield* credentials.create({
            integrationID,
            label: "Personal",
            value: Credential.Key.make({ type: "key", key: "b" }),
          })

          // Stored credentials and detected env vars appear as connections. Both profiles are
          // kept; the newest is active until the user activates another one.
          expect((yield* integrations.get(integrationID))?.connections).toEqual([
            {
              type: "credential",
              id: personal.id,
              label: "Personal",
              active: true,
            },
            {
              type: "credential",
              id: work.id,
              label: "Work",
              active: false,
            },
            { type: "env", name: "INTEGRATION_TEST_ACME_KEY" },
          ])
          expect(yield* integrations.connection.active(integrationID)).toEqual({
            type: "credential",
            id: personal.id,
            label: "Personal",
            active: true,
          })
          expect(work.id).not.toBe(personal.id)

          // Activating a profile makes it the one a request resolves, without dropping the other.
          yield* integrations.connection.activate(work.id)
          expect(yield* integrations.connection.active(integrationID)).toEqual({
            type: "credential",
            id: work.id,
            label: "Work",
            active: true,
          })

          // Removing the active profile promotes the remaining one.
          yield* integrations.connection.remove(work.id)
          expect(yield* integrations.connection.active(integrationID)).toEqual({
            type: "credential",
            id: personal.id,
            label: "Personal",
            active: true,
          })
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.INTEGRATION_TEST_ACME_KEY
          else process.env.INTEGRATION_TEST_ACME_KEY = previous
        }),
    )
  })
})
