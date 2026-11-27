import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AutonomyDefaults } from "@ycoding-ai/core/autonomy-defaults"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"

async function withDirectory<A>(body: (directory: string, config: string) => Promise<A>) {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-autonomy-defaults-"))
  const config = path.join(directory, "config")
  await mkdir(config)
  try {
    return await body(directory, config)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const service = <A, E>(config: string, body: (defaults: AutonomyDefaults.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    AutonomyDefaults.Service.use(body).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([AutonomyDefaults.node]), [[Global.node, Global.layerWith({ config })]]),
      ),
      Effect.scoped,
    ),
  )

const manual = { permissions: "manual", guardrails: "manual", answers: "manual" } as const

describe("autonomy defaults configuration", () => {
  test("absent defaults read as manual", () =>
    withDirectory(async (_, config) => {
      expect(await service(config, (defaults) => defaults.get)).toEqual(manual)
    }))

  test("saving yolo without acceptance is refused and writes nothing", () =>
    withDirectory(async (_, config) => {
      const file = path.join(config, "ycoding.json")
      await writeFile(file, '{"shell":"zsh"}\n')
      const refusal = await service(config, (defaults) => defaults.set({ permissions: "yolo" }).pipe(Effect.flip))
      expect(refusal).toMatchObject({ _tag: "AutonomyDefaults.Refused", reason: "risk-not-accepted", message: "Saving a YOLO default requires explicit risk acceptance" })
      expect(await readFile(file, "utf8")).toBe('{"shell":"zsh"}\n')
      const mixed = await service(config, (defaults) => defaults.set({ guardrails: "auto", answers: "yolo", acceptYolo: false }).pipe(Effect.flip))
      expect(mixed).toMatchObject({ reason: "risk-not-accepted" })
      expect(await readFile(file, "utf8")).toBe('{"shell":"zsh"}\n')
    }))

  test("a change without any category is refused", () =>
    withDirectory(async (_, config) => {
      const refusal = await service(config, (defaults) => defaults.set({ acceptYolo: true }).pipe(Effect.flip))
      expect(refusal).toMatchObject({ _tag: "AutonomyDefaults.Refused", reason: "no-category" })
    }))

  test("accepted yolo records its acceptance time and keeps comments and unrelated keys", () =>
    withDirectory(async (_, config) => {
      const file = path.join(config, "ycoding.jsonc")
      await writeFile(file, '{\n  // keep this note\n  "shell": "zsh",\n}\n')
      const before = Date.now()
      const saved = await service(config, (defaults) => defaults.set({ permissions: "yolo", guardrails: "auto", acceptYolo: true }))
      expect(saved).toMatchObject({ permissions: "yolo", guardrails: "auto", answers: "manual" })
      expect(saved.yoloAcceptedAt?.permissions).toBeGreaterThanOrEqual(before)
      expect(Object.keys(saved.yoloAcceptedAt ?? {})).toEqual(["permissions"])
      const text = await readFile(file, "utf8")
      expect(text).toContain("// keep this note")
      expect(text).toContain('"shell": "zsh"')
      expect(await service(config, (defaults) => defaults.get)).toEqual(saved)
    }))

  test("an already accepted yolo category stays accepted without a new acceptance and keeps its time", () =>
    withDirectory(async (_, config) => {
      const first = await service(config, (defaults) => defaults.set({ answers: "yolo", acceptYolo: true }))
      const second = await service(config, (defaults) => defaults.set({ answers: "yolo", guardrails: "auto" }))
      expect(second).toEqual({ ...first, guardrails: "auto" })
    }))

  test("setting manual or auto drops the acceptance of that category only", () =>
    withDirectory(async (_, config) => {
      await service(config, (defaults) => defaults.set({ permissions: "yolo", answers: "yolo", acceptYolo: true }))
      const reset = await service(config, (defaults) => defaults.set({ permissions: "manual" }))
      expect(reset).toMatchObject({ permissions: "manual", answers: "yolo" })
      expect(Object.keys(reset.yoloAcceptedAt ?? {})).toEqual(["answers"])
      const auto = await service(config, (defaults) => defaults.set({ answers: "auto" }))
      expect(auto).toEqual({ permissions: "manual", guardrails: "manual", answers: "auto" })
      const document = JSON.parse(await readFile(path.join(config, "ycoding.json"), "utf8"))
      expect(document.autonomy.defaults).toEqual({ permissions: "manual", guardrails: "manual", answers: "auto" })
    }))

  test("a yolo default without a recorded acceptance reads as manual", () =>
    withDirectory(async (_, config) => {
      await writeFile(
        path.join(config, "ycoding.json"),
        JSON.stringify({ autonomy: { defaults: { permissions: "yolo", guardrails: "yolo", answers: "auto", yolo_accepted_at: { guardrails: 1_700_000_000_000 } } } }),
      )
      expect(await service(config, (defaults) => defaults.get)).toEqual({
        permissions: "manual",
        guardrails: "yolo",
        answers: "auto",
        yoloAcceptedAt: { guardrails: 1_700_000_000_000 },
      })
    }))

  test("project configuration never supplies defaults", () =>
    withDirectory(async (directory, config) => {
      await writeFile(path.join(directory, "ycoding.json"), JSON.stringify({ autonomy: { defaults: { answers: "auto" } } }))
      expect(await service(config, (defaults) => defaults.get)).toEqual(manual)
    }))
})

const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    recordOpened: () => Effect.void,
    commit: () => Effect.void,
  }),
)

describe("autonomy defaults on session creation", () => {
  test("new root Sessions start in the saved defaults and child Sessions do not", () =>
    withDirectory(async (directory, config) => {
      await writeFile(
        path.join(config, "ycoding.json"),
        JSON.stringify({
          autonomy: { defaults: { permissions: "yolo", guardrails: "auto", answers: "manual", yolo_accepted_at: { permissions: 1_700_000_000_000 } } },
        }),
      )
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      const states = await Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const autonomy = yield* SessionAutonomy.Service
          const root = yield* session.create({ location })
          const child = yield* session.create({ parentID: root.id })
          return [yield* autonomy.get(root.id), yield* autonomy.get(child.id)] as const
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, SessionAutonomy.node, Session.node, LocationServiceMap.node]),
              [
                [Global.node, Global.layerWith({ config, state: directory, data: path.join(directory, "data") })],
                [Project.node, projects],
                [SessionExecution.node, SessionExecution.noopLayer],
              ],
            ),
          ),
          Effect.scoped,
        ),
      )
      expect(states[0]).toMatchObject({ permissions: "yolo", guardrails: "auto", answers: "manual" })
      expect(states[1]).toMatchObject({ permissions: "manual", guardrails: "manual", answers: "manual" })
    }), 30_000)

  test("a yolo default without acceptance starts the Session in manual", () =>
    withDirectory(async (directory, config) => {
      await writeFile(path.join(config, "ycoding.json"), JSON.stringify({ autonomy: { defaults: { permissions: "yolo", answers: "yolo" } } }))
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      const state = await Effect.runPromise(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const autonomy = yield* SessionAutonomy.Service
          return yield* autonomy.get((yield* session.create({ location })).id)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, SessionAutonomy.node, Session.node, LocationServiceMap.node]),
              [
                [Global.node, Global.layerWith({ config, state: directory, data: path.join(directory, "data") })],
                [Project.node, projects],
                [SessionExecution.node, SessionExecution.noopLayer],
              ],
            ),
          ),
          Effect.scoped,
        ),
      )
      expect(state).toMatchObject({ permissions: "manual", guardrails: "manual", answers: "manual" })
    }), 30_000)
})
