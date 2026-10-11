import { describe, expect } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import path from "node:path"
import { Agent } from "@ycoding-ai/core/agent"
import { Command } from "@ycoding-ai/core/command"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { emptyConfigLayer, emptyMcpLayer, testLocationLayer } from "./fixture/mcp"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()), workspaceID: undefined })
const wakes: Session.ID[] = []
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      AppNodeBuilder.build(LayerNode.group([Command.node, Agent.node, Catalog.node]), [
        [Config.node, emptyConfigLayer],
        [MCP.node, emptyMcpLayer],
        [Location.node, testLocationLayer],
      ]) as unknown as Layer.Layer<LocationServices>,
    { idleTimeToLive: "60 minutes" },
  ),
)
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    wake: (sessionID) =>
      Effect.sync(() => {
        wakes.push(sessionID)
      }),
    awaitIdle: () => Effect.void,
    withTransition: (_sessionID, effect) => effect,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      LocationServiceMap.node,
    ]),
    [
      [LocationServiceMap.node, locations],
      [SessionExecution.node, execution],
      [
        Project.node,
        Layer.mock(Project.Service, {
          resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
        }),
      ],
    ],
  ),
)

const fixture = Effect.gen(function* () {
  const temporary = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  )
  const counter = path.join(temporary.path, "evaluations.txt")
  yield* Effect.promise(() => Bun.write(counter, "seed\n"))
  wakes.length = 0
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ location })
  const locations = yield* LocationServiceMap.Service
  const commands = yield* Command.Service.pipe(Effect.provide(locations.get(location)))
  yield* commands.transform((draft) =>
    draft.update("counted", (command) => {
      command.template = `Result: !\`printf 'evaluation\\n' >> ${JSON.stringify(counter)}; printf once\``
      command.agent = Agent.ID.make("reviewer")
    }),
  )
  return { sessions, session, commands, counter }
})

describe("Session.command retry admission", () => {
  for (const source of ["command", "input"] as const)
    it.effect(`rejects the internal decision helper from ${source} before command evaluation or admission`, () =>
      Effect.gen(function* () {
        const input = yield* fixture
        yield* input.commands.transform((draft) => draft.update("counted", (command) => {
          command.agent = source === "command" ? Agent.ID.make("decision") : undefined
        }))

        expect(yield* input.sessions.command({
          sessionID: input.session.id,
          command: "counted",
          ...(source === "input" ? { agent: Agent.ID.make("decision") } : {}),
        }).pipe(Effect.flip)).toMatchObject({ _tag: "Command.EvaluationError", command: "counted" })
        expect(yield* Effect.promise(() => Bun.file(input.counter).text())).toBe("seed\n")
        expect(yield* input.sessions.get(input.session.id)).toEqual(input.session)
        expect(yield* input.sessions.pending(input.session.id)).toEqual([])
        expect(yield* input.sessions.messages({ sessionID: input.session.id })).toEqual([])
        expect(wakes).toEqual([])
      }),
    )

  it.effect("preserves command-agent precedence over an unused decision-helper input", () =>
    Effect.gen(function* () {
      const input = yield* fixture

      yield* input.sessions.command({ sessionID: input.session.id, command: "counted",
        agent: Agent.ID.make("decision"), resume: false })
      expect((yield* input.sessions.get(input.session.id)).agent).toBe(Agent.ID.make("reviewer"))
      expect(yield* input.sessions.pending(input.session.id)).toHaveLength(1)
      expect(yield* Effect.promise(() => Bun.file(input.counter).text())).toBe("seed\nevaluation\n")
      expect(wakes).toEqual([])
    }),
  )

  for (const promoted of [false, true])
    it.effect(
      `reconciles ${promoted ? "promoted" : "pending"} command IDs before shell effects or selection changes`,
      () =>
        Effect.gen(function* () {
          const input = yield* fixture
          const id = SessionMessage.ID.create()
          const first = yield* input.sessions.command({
            sessionID: input.session.id,
            id,
            command: "counted",
            resume: false,
          })
          if (promoted) {
            const database = yield* Database.Service
            const events = yield* EventRuntime.Service
            yield* SessionPending.promoteSteers(database.db, events, input.session.id)
          }
          yield* input.sessions.switchAgent({ sessionID: input.session.id, agent: Agent.ID.make("build") })
          const retry = yield* input.sessions.command({
            sessionID: input.session.id,
            id,
            command: "counted",
            resume: false,
          })
          expect(retry).toEqual(first)
          expect(yield* Effect.promise(() => Bun.file(input.counter).text())).toBe("seed\nevaluation\n")
          expect((yield* input.sessions.get(input.session.id)).agent).toBe(Agent.ID.make("build"))
          expect(wakes).toEqual([])
          yield* input.commands.transform((draft) => draft.remove("counted"))
          const awakened = yield* input.sessions.command({
            sessionID: input.session.id,
            id,
            command: "missing",
            arguments: "changed",
            model: CatalogModel.Ref.make({
              providerID: Provider.ID.make("unavailable"),
              id: CatalogModel.ID.make("unavailable"),
            }),
          })
          expect(awakened).toEqual(first)
          expect(wakes).toEqual([input.session.id])
          expect((yield* input.sessions.get(input.session.id)).model).toBeUndefined()
          expect(yield* Effect.promise(() => Bun.file(input.counter).text())).toBe("seed\nevaluation\n")
        }),
    )

  it.effect("evaluates one shell effect for concurrent identical command IDs", () =>
    Effect.gen(function* () {
      const input = yield* fixture
      const id = SessionMessage.ID.create()
      const admitted = yield* Effect.all(
        [
          input.sessions.command({ sessionID: input.session.id, id, command: "counted", resume: false }),
          input.sessions.command({ sessionID: input.session.id, id, command: "counted", resume: false }),
        ],
        { concurrency: "unbounded" },
      )
      expect(admitted[1]).toEqual(admitted[0])
      expect(yield* Effect.promise(() => Bun.file(input.counter).text())).toBe("seed\nevaluation\n")
      expect(yield* input.sessions.pending(input.session.id)).toHaveLength(1)
    }),
  )

  for (const promoted of [false, true])
    it.effect(
      `rejects ${promoted ? "promoted" : "pending"} Session and input-kind ownership before template side effects`,
      () =>
        Effect.gen(function* () {
          const input = yield* fixture
          const id = SessionMessage.ID.create()
          yield* input.sessions.command({ sessionID: input.session.id, id, command: "counted", resume: false })
          const database = yield* Database.Service
          const events = yield* EventRuntime.Service
          if (promoted) yield* SessionPending.promoteSteers(database.db, events, input.session.id)
          const other = yield* input.sessions.create({ location })
          const crossSession = yield* input.sessions
            .command({ sessionID: other.id, id, command: "counted", resume: false })
            .pipe(Effect.flip)
          expect(crossSession).toMatchObject({
            _tag: "Session.PromptConflictError",
            sessionID: other.id,
            messageID: id,
          })
          const syntheticID = SessionMessage.ID.create()
          yield* input.sessions.synthetic({
            sessionID: input.session.id,
            id: syntheticID,
            text: "Synthetic work",
            resume: false,
          })
          if (promoted) yield* SessionPending.promoteSteers(database.db, events, input.session.id)
          const crossKind = yield* input.sessions
            .command({ sessionID: input.session.id, id: syntheticID, command: "counted", resume: false })
            .pipe(Effect.flip)
          expect(crossKind).toMatchObject({
            _tag: "Session.PromptConflictError",
            sessionID: input.session.id,
            messageID: syntheticID,
          })
          expect(yield* Effect.promise(() => Bun.file(input.counter).text())).toBe("seed\nevaluation\n")
        }),
    )
})
