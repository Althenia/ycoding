import { expect } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, PlatformError, Schema, Scope, Stream } from "effect"
import { eq } from "drizzle-orm"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeGlobalNode, makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Watcher } from "@ycoding-ai/core/filesystem/watcher"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { ModelsDev } from "@ycoding-ai/core/models-dev"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Git } from "@ycoding-ai/core/git"
import { Shell } from "@ycoding-ai/core/shell"
import { AppProcess } from "@ycoding-ai/core/process"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Npm } from "@ycoding-ai/core/npm"
import { WellKnown } from "@ycoding-ai/core/wellknown"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Form } from "@ycoding-ai/core/form"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { StandaloneConfig } from "@ycoding-ai/core/config/standalone"
import { Session } from "@ycoding-ai/core/session"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { InstructionEntry } from "@ycoding-ai/core/session/instruction-entry"
import { SessionStepBoundary } from "@ycoding-ai/core/session/step-boundary"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionMessageTable, SessionProviderRequestTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { testEffect } from "../../core/test/lib/effect"
import { Api } from "../src/api"
import { FormHandler } from "../src/handlers/form"
import { PermissionHandler } from "../src/handlers/permission"
import { layer } from "../src/location"
import { formLocationLayer } from "../src/middleware/form-location"
import { permissionLocationLayer } from "../src/middleware/permission-location"

const configDirectory = "/synthetic/runner-controls-config"
const stateDirectory = "/synthetic/runner-controls-state"
const configText = JSON.stringify({ default_agent: "god", permissions: [{ action: "question", resource: "*", effect: "ask" }] })
const questionInput = { questions: [{ question: "Continue the synthetic task?", header: "Synthetic choice", options: [{ label: "Proceed", description: "Continue the synthetic task" }], custom: false }] }
const providerID = Provider.ID.make("openai")
const modelID = CatalogModel.ID.make("synthetic-controls")
const credential = Credential.Info.make({
  id: Credential.ID.make("cred_runner_controls_B"), integrationID: Integration.ID.make("openai"), label: "B", active: false,
  value: Credential.Key.make({ type: "key", key: "synthetic-controls-B" }), generation: 1, accountGeneration: 1,
})
const forbidden: string[] = []
const wire: string[] = []
const observed: { database: Database.Interface; events: EventRuntime.Interface; boundary: ReturnType<typeof SessionStepBoundary.make>; locations: LocationServiceMap.Interface; instructions: InstructionEntry.Interface }[] = []
const eventOwners: { database: Database.Interface; events: EventRuntime.Interface }[] = []
const ContinuationRequest = Schema.Struct({ input: Schema.Array(Schema.Unknown) })
const QuestionOutput = Schema.Struct({
  type: Schema.Literal("function_call_output"), call_id: Schema.Literal("call_runner_controls"),
  output: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }))]),
})
const expectQuestionAnswer = (request: typeof ContinuationRequest.Type) => {
  const matching = request.input.filter(Schema.is(QuestionOutput))
  expect(matching).toHaveLength(1)
  const output = matching[0]?.output
  const text = typeof output === "string" ? output : output?.map((part) => part.text).join("\n")
  expect(text).toBe('User has answered your questions: "Continue the synthetic task?"="Proceed". You can now continue with the user\'s answers in mind.')
}
const missing = () => PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readFileString" })
const filesystem = Layer.effect(FSUtil.Service, Effect.map(FSUtil.Service, (fs) => FSUtil.Service.of({
  ...fs,
  readFileString: (target) => target === `${configDirectory}/ycoding.json` ? Effect.succeed(configText) : Effect.fail(missing()),
  readFileStringSafe: (target) => Effect.succeed(target === `${configDirectory}/ycoding.json` ? configText : undefined),
  realPath: () => Effect.fail(missing()),
  readLink: () => Effect.fail(missing()),
}))).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const failConstruction = <I, S>(service: Context.Service<I, S>, name: string) => Layer.effect(service, Effect.sync(() => {
  forbidden.push(name)
  throw new Error(`Forbidden standalone constructor: ${name}`)
}))
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  SessionExecution.node, LocationServiceMap.node, Database.node, EventRuntime.node, SessionContextState.node,
  SessionStepBoundary.node, SessionStore.node, Global.node,
]), [
  [Global.node, Layer.succeed(Global.Service, Global.make({ config: configDirectory, state: stateDirectory }))],
  [FSUtil.node, filesystem],
  [Watcher.node, Layer.mock(Watcher.Service, { subscribe: () => Stream.never })],
  [ModelsDev.standaloneNode, Layer.mock(ModelsDev.ReadonlyService, {
    get: () => Effect.succeed([{
      info: { id: providerID, name: "Synthetic OpenAI", package: "@ycoding-ai/ai/providers/openai" },
      models: [{ ...CatalogModel.Info.empty(providerID, modelID), package: "@ycoding-ai/ai/providers/openai" }],
      environment: [],
    }]),
  })],
  [Credential.node, Layer.mock(Credential.Service, {
    all: () => Effect.succeed([credential]), list: () => Effect.succeed([credential]), get: () => Effect.succeed(credential),
  })],
  [EventRuntime.node, makeGlobalNode({
    service: EventRuntime.Service,
    layer: Layer.tap(EventRuntime.layer, (context) => Effect.gen(function* () {
      eventOwners.push({ database: yield* Database.Service, events: Context.get(context, EventRuntime.Service) })
    })),
    deps: [Database.node],
  })],
  [InstructionEntry.node, makeLocationNode({
    service: InstructionEntry.Service,
    layer: Layer.tap(InstructionEntry.layer, (context) => Effect.gen(function* () {
      observed.push({ database: yield* Database.Service, events: yield* EventRuntime.Service, boundary: yield* SessionStepBoundary.Service, locations: yield* LocationServiceMap.Service, instructions: Context.get(context, InstructionEntry.Service) })
    })),
    deps: [Database.node, EventRuntime.node, SessionStepBoundary.node, LocationServiceMap.node],
  })],
  [AppProcess.node, failConstruction(AppProcess.Service, "process")],
  [Project.node, failConstruction(Project.Service, "project")],
  [Git.node, failConstruction(Git.Service, "git")],
  [Shell.node, failConstruction(Shell.Service, "shell")],
  [PluginSupervisor.node, failConstruction(PluginSupervisor.Service, "plugins")],
  [Npm.node, failConstruction(Npm.Service, "npm")],
  [WellKnown.node, failConstruction(WellKnown.Service, "well-known")],
  [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.sync(() => {
      expect(request.url).toBe("https://api.openai.com/v1/responses")
      expect(request.headers.authorization).toBe("Bearer synthetic-controls-B")
      if (request.body._tag !== "Uint8Array") throw new Error("Expected an encoded synthetic request")
      wire.push(new TextDecoder().decode(request.body.body))
      const attempt = wire.length
      if (attempt > 2) throw new Error("Unexpected standalone continuation")
      const item = attempt === 1
        ? { type: "function_call", id: "fc_runner_controls", call_id: "call_runner_controls", name: "question", arguments: JSON.stringify(questionInput), status: "completed" }
        : { type: "message", id: "msg_runner_controls_output", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic controls completed", annotations: [] }] }
      const response = { id: `resp_runner_controls_${attempt}`, object: "response", status: "completed", model: modelID, output: [item], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
      const output = attempt === 1
        ? [
            { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
            { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: JSON.stringify(questionInput) },
            { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: JSON.stringify(questionInput) },
          ]
        : [
            { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
            { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Synthetic controls completed" },
            { type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text: "Synthetic controls completed" },
          ]
      const events = [
        { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
        ...output,
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ]
      return HttpClientResponse.fromWeb(request, new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
  })))],
]))

it.effect("standalone runner resumes through HTTP permission and question settlement while borrowed scopes close", () => Effect.gen(function* () {
  forbidden.length = 0
  wire.length = 0
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const execution = yield* SessionExecution.Service
  const locations = yield* LocationServiceMap.Service
  const boundary = yield* SessionStepBoundary.Service
  const sessionID = Session.ID.make("ses_runner_http_controls")
  const ref = Location.Ref.make({ directory: AbsolutePath.make(`${stateDirectory}/standalone-sessions`) })
  yield* database.db.insert(ProjectTable).values({ id: Location.standaloneProjectID, worktree: ref.directory, sandboxes: [] }).run()
  yield* database.db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Location.standaloneProjectID, directory: ref.directory, title: "Synthetic controls", agent: "god", model: { providerID, id: modelID, profile: "B" } }).run()
  yield* SessionContextState.initialize(database.db, sessionID, 0)
  const permissionAsked = yield* Deferred.make<Permission.Request>()
  const questionAsked = yield* Deferred.make<Form.Info>()
  const stop = yield* events.listen((event) => {
    if (event.type === Permission.Event.Asked.type && Schema.is(Permission.Request)(event.data) && event.data.sessionID === sessionID)
      return Deferred.succeed(permissionAsked, event.data).pipe(Effect.asVoid)
    if (event.type === Form.Event.Created.type && Schema.is(Form.Event.Created.data)(event.data) && event.data.form.sessionID === sessionID)
      return Deferred.succeed(questionAsked, event.data.form).pipe(Effect.asVoid)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => stop)
  const application = yield* Layer.build(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.form"]).add(Api.groups["server.permission"])).pipe(
    Layer.provide(FormHandler),
    Layer.provide(PermissionHandler),
    Layer.provide(Layer.mergeAll(
      formLocationLayer, permissionLocationLayer, layer,
      Layer.succeed(Authorization, (effect) => effect),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    HttpRouter.provideRequest(Layer.mock(PermissionSaved.Service, { list: () => Effect.die("Unexpected saved permission read"), add: () => Effect.die("Unexpected saved permission write"), remove: () => Effect.die("Unexpected saved permission removal") })),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  ))
  const router = Context.get(application, HttpRouter.HttpRouter)
  const request = (path: string, method = "GET", body?: unknown) => router.asHttpEffect().pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }))),
    Effect.scoped,
  )
  const running = yield* execution.resume(sessionID).pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
  const pending = <A>(ready: Deferred.Deferred<A>) => Effect.raceFirst(Deferred.await(ready), Fiber.join(running).pipe(Effect.flatMap((exit) =>
    Effect.die(Exit.isFailure(exit) ? Cause.squash(exit.cause) : new Error("Runner settled before the pending control")),
  )))
  const permission = yield* pending(permissionAsked)
  expect(permission.action).toBe("question")
  expect(permission.source).toMatchObject({ type: "tool", callID: "call_runner_controls" })
  expect(yield* Deferred.isDone(questionAsked)).toBe(false)
  expect((yield* execution.active).has(sessionID)).toBe(true)
  const borrower = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(borrower, Exit.void))
  const borrowed = yield* locations.contextEffect(ref, [StandaloneConfig.node, InstructionEntry.node], "standalone").pipe(Effect.provideService(Scope.Scope, borrower))
  const config = Context.get(borrowed, StandaloneConfig.Service)
  const dependencies = observed.filter((entry) => entry.instructions === Context.get(borrowed, InstructionEntry.Service))
  expect(dependencies).toHaveLength(1)
  expect(dependencies[0]?.database).toBe(database)
  expect(dependencies[0]?.events).toBe(events)
  expect(dependencies[0]?.boundary).toBe(boundary)
  expect(dependencies[0]?.locations).toBe(locations)
  expect(new Set(eventOwners.filter((entry) => entry.database === database).map((entry) => entry.events))).toEqual(new Set([events]))
  yield* Scope.close(borrower, Exit.void)
  expect(Exit.isSuccess(yield* Effect.exit(config.snapshot()))).toBe(true)
  const base = `/api/session/${sessionID}`
  expect((yield* request(`${base}/permission/${permission.id}`)).status).toBe(200)
  expect(wire).toHaveLength(1)
  expect((yield* request(`${base}/permission/${permission.id}/reply`, "POST", { reply: "once" })).status).toBe(204)
  const question = yield* pending(questionAsked)
  expect(question.metadata).toMatchObject({ kind: "question", tool: { callID: "call_runner_controls" } })
  expect((yield* request(`${base}/form/${question.id}/state`)).status).toBe(200)
  expect((yield* execution.active).has(sessionID)).toBe(true)
  expect(wire).toHaveLength(1)
  expect((yield* request(`${base}/form/${question.id}/reply`, "POST", { answer: { q0: "Proceed" } })).status).toBe(204)
  const result = yield* Fiber.join(running)
  if (Exit.isFailure(result)) return yield* Effect.die(Cause.squash(result.cause))
  yield* execution.awaitIdle(sessionID)
  expect(yield* execution.active).toEqual(new Set())
  expect(wire).toHaveLength(2)
  const continuation = Schema.decodeUnknownSync(ContinuationRequest)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(wire[1]))
  expectQuestionAnswer(continuation)
  const optionDecoy = { type: "function_call", call_id: "call_runner_controls", name: "question", arguments: JSON.stringify(questionInput) }
  const altered = { ...continuation, input: [optionDecoy, ...continuation.input.map((item) => Schema.is(QuestionOutput)(item)
    ? { ...item, output: [{ type: "input_text", text: 'User has answered your questions: "Continue the synthetic task?"="Different answer". You can now continue with the user\'s answers in mind.' }] }
    : item)] }
  expect(altered.input[0]).toBe(optionDecoy)
  expect(optionDecoy.arguments).toContain('"label":"Proceed"')
  expect(() => expectQuestionAnswer(altered)).toThrow()
  const removed = { ...continuation, input: [optionDecoy, ...continuation.input.filter((item) => !Schema.is(QuestionOutput)(item))] }
  expect(removed.input[0]).toBe(optionDecoy)
  expect(() => expectQuestionAnswer(removed)).toThrow()
  const store = yield* SessionStore.Service
  expect(yield* store.get(sessionID)).toMatchObject({ projectID: Location.standaloneProjectID, scope: "standalone", location: ref, model: { profile: "B" } })
  const messages = yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).all()
  expect(JSON.stringify(messages)).toContain("Synthetic controls completed")
  expect(yield* database.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, sessionID)).all()).toHaveLength(2)
  expect((yield* request(`${base}/permission/${permission.id}`)).status).toBe(404)
  expect((yield* request(`${base}/form/${question.id}/reply`, "POST", { answer: { q0: "Proceed" } })).status).toBe(409)
  yield* locations.invalidate(ref, "standalone")
  const closed = yield* Effect.exit(config.snapshot())
  expect(Exit.isFailure(closed) && Option.getOrUndefined(Cause.findErrorOption(closed.cause))).toMatchObject({ _tag: "StandaloneConfig.InvalidError", reason: "closed" })
  expect(forbidden).toEqual([])
}))
