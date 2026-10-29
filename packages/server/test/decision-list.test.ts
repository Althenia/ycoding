import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@ycoding-ai/core/database/database"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { Question } from "@ycoding-ai/core/question"
import { Form } from "@ycoding-ai/core/form"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionDecisions } from "@ycoding-ai/core/session/decisions"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Guardrail } from "../../schema/src/guardrail"
import { Model } from "../../schema/src/model"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { eq } from "drizzle-orm"
import { Api } from "../src/api"
import { createRoutes } from "../src/routes"
import { DecisionHandler } from "../src/handlers/decision"
import { PermissionHandler } from "../src/handlers/permission"
import { QuestionHandler } from "../src/handlers/question"
import { FormHandler } from "../src/handlers/form"
import { GuardrailHandler } from "../src/handlers/guardrail"
import { ReviewHandler } from "../src/handlers/review"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { SessionLocationMiddleware } from "../src/middleware/session-location"
import { FormLocationMiddleware } from "../src/middleware/form-location"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ycoding-decision-list-"))
  let globals: Context.Context<Database.Service | SessionReview.Service> | undefined
  let requestContext: Context.Context<PermissionSaved.Service> | undefined
  let runtimeLocations: LocationServiceMap.Interface | undefined
  const owners: { id: Session.ID; title: string; directory: string }[] = []
  const runtime = HttpRouter.toWebHandler(createRoutes({
    database: { path: join(root, "session.db") },
    config: { directory: join(root, "config"), project: false },
    models: { fetch: false }, fs: { filewatcher: false, fff: false },
  }).pipe(Layer.provide(HttpServer.layerServices), Layer.tap((context) => Effect.gen(function* () {
    globals = Context.pick(Database.Service, SessionReview.Service)(context)
    requestContext = Context.pick(PermissionSaved.Service)(context)
    runtimeLocations = Context.get(context, LocationServiceMap.Service)
    const sessions = Context.get(context, Session.Service)
    for (const title of ["First", "Second", "Cold", "Archived"]) {
      const directory = join(root, title)
      const session = yield* sessions.create({ title, model: Model.Ref.parse("synthetic/model"), location: { directory: AbsolutePath.make(directory) } })
      owners.push({ id: session.id, title, directory })
    }
    const database = Context.get(context, Database.Service)
    yield* database.db.update(SessionTable).set({ time_archived: 1 }).where(eq(SessionTable.id, owners[3]!.id)).run().pipe(Effect.orDie)
    const review = Context.get(context, SessionReview.Service)
    for (const owner of owners.slice(2)) {
      yield* review.open({ sessionID: owner.id, kind: "permission", reason: "sleep_entry", limit: 20,
        origin: { requestID: "per_deferred" }, payload: {
          type: "permission", action: "edit", resources: ["outside.txt"], requestID: Permission.ID.make("per_deferred"),
          fingerprint: SessionReview.fingerprint({ action: "edit", resources: ["outside.txt"], workdir: owner.directory }), fingerprintVersion: 2,
        },
      })
    }
    yield* review.open({ sessionID: owners[2]!.id, kind: "guardrail", reason: "sleep_entry", limit: 20,
      origin: { requestID: "grq_deferred" }, payload: {
        type: "guardrail", action: "shell", resources: ["synthetic"], ruleIDs: ["standard.hard_review"], reason: "Hard review", hardReview: true,
        directories: [owners[2]!.directory], requestID: SessionGuardrail.RequestID.make("grq_deferred"),
        fingerprint: SessionReview.fingerprint({ action: "shell", resources: ["synthetic"], workdir: owners[2]!.directory, hardReview: true }),
      },
    })
  }))))
  await runtime.handler(new Request("http://localhost/api/health"))
  if (!requestContext) throw new Error("Fixture request services were not initialized")
  const requestServices = requestContext
  const permissions = owners.slice(0, 2).concat(owners[3]!).map((owner, index): Permission.Request => ({
    id: Permission.ID.make(`per_${index}`), sessionID: owner.id, action: "edit", resources: ["file.txt"], save: ["*.txt"], metadata: {},
  }))
  const questions: Question.Request[] = [
    { id: Question.ID.make("que_finite"), sessionID: owners[0]!.id, questions: [{ header: "Choice", question: "Pick a value", custom: false, options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }] },
    { id: Question.ID.make("que_multiple"), sessionID: owners[0]!.id, questions: [{ header: "Many", question: "Pick values", multiple: true, custom: false, options: [{ label: "One", description: "First" }] }] },
    { id: Question.ID.make("que_text"), sessionID: owners[1]!.id, questions: [{ header: "Text", question: "Enter text", options: [] }] },
  ]
  const forms: Form.Info[] = [
    { id: Form.ID.make("frm_enum"), sessionID: owners[1]!.id, title: "Enum", fields: [{ key: "pick", type: "string", required: true, options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }], custom: false }] },
    { id: Form.ID.make("frm_text"), sessionID: owners[1]!.id, title: "Text", fields: [{ key: "email", type: "string", required: true }] },
    { id: Form.ID.make("frm_typed"), sessionID: owners[1]!.id, title: "Typed", fields: [
      { key: "count", type: "integer", minimum: 3, required: true },
      { key: "confirmed", type: "boolean", required: true },
      { key: "tags", type: "multiselect", minItems: 2, required: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      { key: "external", type: "external", url: "https://example.com/" },
    ] },
    { id: Form.ID.make("frm_conditional"), sessionID: owners[1]!.id, title: "Conditional", fields: [
      { key: "choice", type: "string", required: true, custom: false, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      { key: "a", type: "string", required: true, when: [{ key: "choice", op: "eq", value: "a" }] },
      { key: "b", type: "string", required: true, when: [{ key: "choice", op: "eq", value: "b" }] },
    ] },
  ]
  const guardrails = [false, true].map((hardReview, index) => new Guardrail.Request({
    id: Guardrail.RequestID.make(`grq_${index}`), sessionID: owners[index]!.id, rootSessionID: owners[index]!.id,
    action: "shell", resources: ["synthetic"], reason: "Review command", ruleIDs: ["standard.review"], standard: true, hardReview,
  }))
  const settled = new Set<string>()
  const contexts = await Promise.all(owners.slice(0, 2).map((owner) => Effect.runPromise(Effect.scoped(Layer.build(Layer.mergeAll(
    Layer.mock(Permission.Service, {
      get: (id) => Effect.succeed(permissions.find((item) => item.id === id && !settled.has(item.id))),
      list: () => Effect.succeed(permissions.filter((item) => !settled.has(item.id) && (item.sessionID === owner.id || item.sessionID === owners[3]!.id))),
      reply: (input) => Effect.sync(() => { settled.add(input.requestID) }),
    }),
    Layer.mock(Question.Service, {
      list: () => Effect.succeed(questions.filter((item) => item.sessionID === owner.id && !settled.has(item.id))),
      reply: (input) => Effect.gen(function* () {
        const item = questions.find((item) => item.id === input.requestID)!
        const message = Question.validateAnswers(item.questions, input.answers)
        if (message) return yield* new Question.InvalidAnswerError({ requestID: item.id, message })
        settled.add(item.id)
      }),
      reject: (id) => Effect.sync(() => { settled.add(id) }),
    }),
    Layer.mock(Form.Service, {
      list: () => Effect.succeed(forms.filter((item) => item.sessionID === owner.id && !settled.has(item.id))),
      get: (id) => Effect.succeed(forms.find((item) => item.id === id)!),
      reply: (input) => Effect.gen(function* () {
        const form = forms.find((item) => item.id === input.id)!
        const message = Form.validateAnswer(form, input.answer)
        if (message) return yield* new Form.InvalidAnswerError({ id: input.id, message })
        settled.add(input.id)
      }),
      cancel: (id) => Effect.sync(() => { settled.add(id) }),
    }),
    Layer.mock(SessionGuardrail.Service, {
      reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
      list: () => Effect.succeed(guardrails.filter((item) => item.sessionID === owner.id && !settled.has(item.id))),
      reply: (input) => Effect.sync(() => {
        expect(input.sessionID).toBe(guardrails.find((item) => item.id === input.requestID)!.sessionID)
        settled.add(input.requestID)
      }),
    }),
  ))))))
  const nodes = [Permission.node, Question.node, Form.node, SessionGuardrail.node]
  const reads: string[][] = []
  const loaded = [
    ...owners.slice(0, 2).map((owner) => ({ ref: { directory: AbsolutePath.make(owner.directory) }, built: nodes.map((node) => node.name) })),
    { ref: { directory: AbsolutePath.make(join(root, "Catalog")) }, built: [] },
  ]
  const locations = Layer.succeed(LocationServiceMap.Service, LocationServiceMap.Service.of({
    loaded: () => Effect.succeed(loaded),
    get: () => { throw new Error("get must not boot a Location") },
    invalidate: () => Effect.void,
    contextEffect: (ref, requested) => Effect.sync(() => {
      const index = owners.findIndex((owner) => owner.directory === ref.directory)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(2)
      expect(requested.every((node) => loaded[index]!.built.includes(node.name))).toBe(true)
      reads.push(requested.map((node) => node.name))
      return Context.makeUnsafe(contexts[index]!.mapUnsafe)
    }),
  }))
  const locationMiddleware = <A, E>(effect: Effect.Effect<A, E, LocationServices>) => Effect.provide(effect, Context.makeUnsafe<LocationServices>(
    contexts.reduce((map, context) => new Map([...map, ...context.mapUnsafe]), new Map()),
  ))
  const scopedMiddleware = <A, E>(effect: Effect.Effect<A, E, LocationServices>) => Effect.gen(function* () {
    const { HttpServerRequest } = yield* Effect.promise(() => import("effect/unstable/http"))
    const request = yield* HttpServerRequest.HttpServerRequest
    const owner = owners.findIndex((owner) => request.url.includes(owner.id))
    return yield* Effect.provide(effect, Context.makeUnsafe<LocationServices>((contexts[owner] ?? contexts[0])!.mapUnsafe))
  })
  const globalServices = Layer.succeedContext(globals!)
  const services = Layer.mergeAll(globalServices, locations,
    SessionDecisions.layer.pipe(Layer.provide(locations), Layer.provide(globalServices)),
    Layer.succeed(Authorization, (effect) => effect), Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    Layer.succeed(LocationMiddleware, locationMiddleware), Layer.succeed(SessionLocationMiddleware, scopedMiddleware),
    Layer.succeed(FormLocationMiddleware, scopedMiddleware),
  )
  const api = HttpApi.make("server").add(Api.groups["server.decision"]).add(Api.groups["server.permission"])
    .add(Api.groups["server.question"]).add(Api.groups["server.form"]).add(Api.groups["server.guardrail"]).add(Api.groups["server.review"])
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Layer.mergeAll(DecisionHandler, PermissionHandler, QuestionHandler, FormHandler, GuardrailHandler, ReviewHandler).pipe(Layer.provide(services))),
    Layer.provide(services), Layer.provide(HttpServer.layerServices),
  ))
  const request = (path: string, init?: RequestInit) => handler.handler(new Request(`http://localhost${path}`, init), requestServices)
  return { owners, reads, settled, request,
    runtimeRequest: (path: string) => runtime.handler(new Request(`http://localhost${path}`)),
    loaded: () => Effect.runPromise(runtimeLocations!.loaded()),
    async list() {
      const response = await request("/api/decision")
      expect(response.status).toBe(200)
      return (await response.json()).data as SessionDecisions.Item[]
    },
    async [Symbol.asyncDispose]() { await handler.dispose(); await runtime.dispose(); await rm(root, { recursive: true, force: true }) },
  }
}

test("decision.list aggregates loaded Locations and cold durable reviews without building missing services or exposing archived Sessions", async () => {
  await using f = await fixture()
  const items = await f.list()
  expect(items.filter((item) => item.kind !== "review").map((item) => item.directory)).toContain(f.owners[0]!.directory)
  expect(items.map((item) => item.directory)).toContain(f.owners[1]!.directory)
  expect(items.filter((item) => item.kind === "review")).toHaveLength(2)
  expect(items.find((item) => item.kind === "review")).toMatchObject({ sessionID: f.owners[2]!.id, sessionTitle: "Cold", directory: f.owners[2]!.directory })
  expect(items.some((item) => item.sessionID === f.owners[3]!.id)).toBe(false)
  expect(f.reads.length).toBeGreaterThan(0)
  const hard = items.find((item) => item.id === "grq_1")!
  expect(hard.decide.map((choice) => JSON.parse(choice.argv.at(-1)!).reply)).toEqual(["once", "reject"])
  const deferredHard = items.find((item) => item.kind === "review" && item.options && "type" in item.options && item.options.type === "guardrail")!
  expect(deferredHard.decide.map((choice) => JSON.parse(choice.argv.at(-1)!).decision.reply)).toEqual(["once", "reject"])
  expect(items.find((item) => item.id === "que_finite")!.options).toMatchObject([{ custom: false }])
  expect(items.find((item) => item.id === "frm_text")!.options).toMatchObject([{ key: "email", type: "string" }])
}, 60_000)

test("the registered global route leaves cold Locations absent and a catalog-only Location unextended", async () => {
  await using f = await fixture()
  expect(await f.loaded()).toEqual([])
  const cold = await f.runtimeRequest("/api/decision")
  expect(cold.status).toBe(200)
  expect((await cold.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "review", sessionTitle: "Cold" })]))
  expect(await f.loaded()).toEqual([])
  expect((await f.runtimeRequest(`/api/model?location[directory]=${encodeURIComponent(f.owners[0]!.directory)}`)).status).toBe(200)
  const partial = await f.loaded()
  expect(partial).toHaveLength(1)
  expect(partial[0]!.built).not.toContain(Permission.node.name)
  expect((await f.runtimeRequest("/api/decision")).status).toBe(200)
  expect(await f.loaded()).toEqual(partial)
}, 60_000)

test("every decision command resolves through OpenAPI and settles its item; templates remain JSON and accept filled answers", async () => {
  await using f = await fixture()
  const initial = await f.list()
  const spec = await (await f.request("/openapi.json")).json()
  for (const item of initial) {
    for (const choice of item.decide) {
      const argv = choice.argv
      expect(argv.slice(0, 2)).toEqual(["ycoding", "api"])
      const resolved = resolveCommand(spec, argv)
      const body = resolved.body
      if (choice.template) {
        expect(choice.label).toBe("Reply (replace answer values)")
        expect(body).toMatch(/<answer:/)
        expect(() => JSON.parse(body!)).not.toThrow()
        expect(choice.hint).toContain("entire quoted placeholder")
      }
      const response = await f.request(resolved.path, { method: resolved.method, headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(JSON.parse(body, (_, value) => {
          if (typeof value !== "string" || !value.startsWith("<answer:")) return value
          if (value === "<answer:fields>") return { choice: "a", a: "Synthetic" }
          if (value === "<answer:count>") return 3
          if (value === "<answer:confirmed>" || value === "<answer:external>") return true
          if (value === "<answer:tags>") return ["a", "b"]
          return item.id === "que_multiple" ? "One" : "Synthetic"
        })) }),
      })
      expect(response.status).toBe(204)
      expect((await f.list()).some((current) => current.id === item.id)).toBe(false)
      if (item.kind !== "review") f.settled.delete(item.id)
      else break
    }
  }
}, 60_000)

for (const [kind, reply] of [["permission", "always"], ["permission", "reject"], ["guardrail", "reject"]] as const) test(`a fresh cold ${kind} review accepts its exact ${reply} command`, async () => {
  await using f = await fixture()
  const items = await f.list()
  const spec = await (await f.request("/openapi.json")).json()
  const review = items.find((item) => item.kind === "review" && item.options && "type" in item.options && item.options.type === kind)!
  const resolved = resolveCommand(spec, review.decide.find((choice) => choice.label === reply)!.argv)
  expect((await f.request(resolved.path, { method: resolved.method, headers: { "content-type": "application/json" }, body: resolved.body })).status).toBe(204)
  expect((await f.list()).some((item) => item.id === review.id)).toBe(false)
}, 60_000)

function resolveCommand(spec: { paths: Record<string, Record<string, { operationId?: string }>> }, argv: readonly string[]) {
  const params = Object.fromEntries(argv.flatMap((part, index) => part === "--param" ? [argv[index + 1]!.split("=")] : []))
  const operation = Object.entries(spec.paths).flatMap(([path, operations]) => Object.entries(operations).map(([method, op]) => ({ path, method, op }))).find((entry) => entry.op.operationId === argv[2])!
  expect(operation).toBeDefined()
  const data = argv.indexOf("--data")
  return {
    path: operation.path.replaceAll(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(params[key]!)),
    method: operation.method.toUpperCase(), body: data < 0 ? undefined : argv[data + 1]!,
  }
}
