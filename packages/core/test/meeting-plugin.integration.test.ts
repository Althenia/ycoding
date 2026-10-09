import { afterAll, expect } from "bun:test"
import fs from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Agent } from "@ycoding-ai/core/agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Database } from "@ycoding-ai/core/database/database"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { MeetingStore } from "../../../extensions/meeting/src/store"
import { connectControl, meetingDirectory, validateDescriptor } from "../../../extensions/meeting/src/discovery"
import { sendControl } from "../../../extensions/meeting/src/bridge-client"
import { Effect } from "effect"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { fixtureModels } from "./lib/models"

const globalDirectory = mkdtempSync(path.join(os.tmpdir(), "ycoding-meeting-plugin-global-"))

afterAll(() => rmSync(globalDirectory, { recursive: true, force: true }))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, LocationServiceMap.node]), [
    [
      Global.node,
      Global.layerWith({
        data: path.join(globalDirectory, "data"),
        config: globalDirectory,
        home: path.join(globalDirectory, "home"),
      }),
    ],
    fixtureModels,
  ]),
)

it.live("loads the absolute Meeting plugin, exposes its local bridge, and unloads without recording", () =>
  withDataHome(
    Effect.gen(function* () {
      const plugin = path.resolve(import.meta.dir, "../../../extensions/meeting/src/plugin.ts")
      let paths: { directory: string; descriptor: string; database: string; lock: string; url: string; token: string } | undefined
      let locationRef: Location.Ref | undefined

      yield* withLocation(
        { plugins: ["-*", plugin] },
        Effect.gen(function* () {
          yield* ready()
          const plugins = yield* PluginRegistry.Service
          expect((yield* plugins.list()).map((entry) => String(entry.id))).toContain("ycoding.meeting")

          const agents = yield* Agent.Service
          const agent = yield* agents.get(Agent.ID.make("meeting-intelligence"))
          expect(agent).toMatchObject({
            mode: "primary",
            hidden: true,
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
          })

          const tools = yield* ToolRegistry.Service
          const registered = yield* tools.materialize([{ action: "*", resource: "*", effect: "allow" }])
          const denied = yield* tools.materialize(agent!.permissions)
          expect(registered.definitions.map((definition) => definition.name)).toContain("execute")
          expect(denied.definitions.map((definition) => definition.name)).not.toContain("execute")

          const location = yield* Location.Service
          locationRef = Location.Ref.make({ directory: location.directory })
          const directory = yield* Effect.promise(() => meetingDirectory(location.directory))
          const descriptorPath = path.join(directory, "bridge.json")
          const descriptor = yield* Effect.promise(async () =>
            validateDescriptor(JSON.parse(await fs.readFile(descriptorPath, "utf8"))),
          )
          const control = yield* Effect.promise(() => connectControl(location.directory))
          const status = (yield* Effect.promise(() => control({ action: "status" }))) as {
            meeting?: unknown
            meetings: unknown[]
            analysis: { status: string }
          }
          expect(status.meeting).toBeUndefined()
          expect(status.meetings).toEqual([])
          expect(status.analysis.status).toBe("idle")

          const store = new MeetingStore(path.join(directory, "meetings.sqlite"))
          expect(store.listMeetings()).toEqual([])
          store.close()

          paths = {
            directory,
            descriptor: descriptorPath,
            database: path.join(directory, "meetings.sqlite"),
            lock: path.join(directory, "runtime.lock"),
            url: descriptor.url,
            token: descriptor.token,
          }
        }),
      ).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const ref = locationRef
            if (!ref) return
            const locations = yield* LocationServiceMap.Service
            yield* locations.invalidate(ref)
          }),
        ),
      )

      expect(paths).toBeDefined()
      expect(yield* Effect.promise(() => Bun.file(paths!.descriptor).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(paths!.lock).exists())).toBe(false)
      expect(yield* Effect.promise(() => sendControl(paths!.url, paths!.token, { action: "status" }).then(
        () => false,
        () => true,
      ))).toBe(true)

      const store = new MeetingStore(paths!.database)
      expect(store.listMeetings()).toEqual([])
      store.close()
    }),
  ),
)

function ready() {
  return Effect.gen(function* () {
    const supervisor = yield* PluginSupervisor.Service
    yield* supervisor.flush
  })
}

function withLocation<A, E, R>(config: unknown, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  ).pipe(
    Effect.tap((directory) =>
      Effect.promise(async () => {
        await fs.writeFile(path.join(directory.path, "ycoding.json"), JSON.stringify(config))
      }),
    ),
    Effect.flatMap((directory) =>
      effect.pipe(
        Effect.scoped,
        Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      ),
    ),
  )
}

function withDataHome<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.XDG_DATA_HOME
      const directory = mkdtempSync(path.join(os.tmpdir(), "ycoding-meeting-data-"))
      process.env.XDG_DATA_HOME = directory
      return { directory, previous }
    }),
    () => effect,
    ({ directory, previous }) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previous
        rmSync(directory, { recursive: true, force: true })
      }),
  )
}
