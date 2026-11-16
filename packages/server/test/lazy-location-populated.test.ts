import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Database } from "@ycoding-ai/core/database/database"
import { LocationWatcher } from "@ycoding-ai/core/filesystem/location-watcher"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { CatalogModel } from "@ycoding-ai/core/model"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Project } from "@ycoding-ai/core/project"
import { ProjectDirectoryTable, ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { createRoutes } from "../src/routes"

test("repeated seven-read sweeps preserve eleven active full graphs in a populated Location map", async () => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-populated-location-"))
  const directories = Array.from({ length: 87 }, (_, index) => AbsolutePath.make(join(root, `location-${index}`)))
  await Promise.all(directories.map((directory) => mkdir(directory)))
  const sessionID = (index: number) => Session.ID.make(`ses_populated_${index}`)
  const childID = (index: number, child: number) => Session.ID.make(`ses_populated_child_${index}_${child}`)
  const standaloneID = Session.ID.make("ses_populated_standalone")
  const leases = Effect.runSync(Scope.make())
  let locations: LocationServiceMap.Interface | undefined
  const handler = HttpRouter.toWebHandler(createRoutes({
    password: "fixture",
    database: { path: join(root, "session.db") },
    config: { directory: join(root, "config"), project: false },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  }).pipe(
    Layer.provide(NodeHttpServer.layerHttpServices),
    Layer.tap((context) => Effect.gen(function* () {
      locations = Context.get(context, LocationServiceMap.Service)
      const db = Context.get(context, Database.Service).db
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] }).run()
      yield* db.insert(ProjectDirectoryTable).values(directories.map((directory) => ({
        project_id: Project.ID.global, directory,
      }))).run()
      yield* db.insert(SessionTable).values(directories.map((directory, index) => ({
        id: sessionID(index), project_id: Project.ID.global, directory, title: `Synthetic ${index}`,
      }))).run()
      yield* db.insert(SessionTable).values([
        ...directories.flatMap((directory, index) => [0, 1].map((child) => ({
          id: childID(index, child), parent_id: sessionID(index), project_id: Project.ID.global, directory, title: `Child ${index}/${child}`,
        }))),
        { id: standaloneID, project_id: Project.ID.global, directory: directories[11], scope: "standalone", title: "Standalone" },
      ]).run()
      for (let index = 0; index < directories.length; index++)
        yield* db.insert(SessionTaskTable).values([0, 1].map((child): typeof SessionTaskTable.$inferInsert => ({
          session_id: childID(index, child), parent_id: sessionID(index),
          parent_assistant_message_id: SessionMessage.ID.make(`msg_populated_assistant_${index}`),
          tool_call_id: `call_populated_${index}_${child}`,
          input_id: SessionMessage.ID.make(`msg_populated_input_${index}_${child}`),
          description: "Synthetic completed task", agent: "build",
          model: CatalogModel.Ref.make({ providerID: Provider.ID.make("synthetic"), id: CatalogModel.ID.make("fixture") }),
          prompt_digest: "synthetic", background: true, delivery: "steer", state: "completed",
        }))).run()
    })),
  ))
  const authorization = `Basic ${Buffer.from("ycoding:fixture").toString("base64")}`
  const request = (path: string, headers: Record<string, string> = {}) => handler.handler(
    new Request(`http://localhost${path}`, { headers: { authorization, ...headers } }), Context.empty(),
  )
  const query = (directory: string) => `location[directory]=${encodeURIComponent(directory)}`
  const paths = (index: number) => [
    `/api/location?${query(directories[index])}`,
    `/api/config/diagnostics?${query(directories[index])}`,
    `/api/session/${sessionID(index)}/usage`,
    `/api/session/${sessionID(index)}/usage/report?group=model`,
    `/api/session/${sessionID(index)}/usage/prompts?inputIDs=msg_populated_missing&inputIDs=msg_populated_other`,
    `/api/session/${sessionID(index)}/usage/tasks?sessionIDs=${childID(index, 0)}&sessionIDs=${childID(index, 1)}`,
    `/api/session/${sessionID(index)}/instructions/entries`,
  ]
  const loaded = async () => {
    const entries = await Effect.runPromise(locations!.loaded())
    return entries.map((entry) => ({ directory: entry.ref.directory, built: [...entry.built].toSorted() }))
      .toSorted((left, right) => left.directory.localeCompare(right.directory))
  }
  try {
    expect((await request("/api/health")).status).toBe(200)
    for (const directory of directories) expect((await request(`/api/location?${query(directory)}`)).status).toBe(200)
    for (const directory of directories.slice(0, 11))
      await Effect.runPromise(locations!.contextEffect(Location.Ref.make({ directory }), [LocationServiceMap.full]).pipe(
        Scope.provide(leases),
      ))
    const before = await loaded()
    expect(before).toHaveLength(87)
    expect(before.filter((entry) => entry.built.includes(MCP.node.name))).toHaveLength(11)
    for (const path of paths(11)) expect((await request(path, { authorization: "" })).status).toBe(401)
    for (const path of paths(11).slice(2)) {
      expect((await request(path, { "x-ycoding-directory": "/other" })).status).toBe(400)
      expect((await request(path, { "x-ycoding-workspace": "wrk_other" })).status).toBe(400)
      expect((await request(path.replace(sessionID(11), standaloneID))).status).toBe(400)
      expect((await request(path.replace(sessionID(11), "ses_missing"))).status).toBe(404)
    }
    expect(await loaded()).toEqual(before)
    let plateau: Awaited<ReturnType<typeof loaded>> | undefined
    for (let round = 0; round < 3; round++) {
      for (let index = 11; index < 81; index++) {
        for (const [read, path] of paths(index).entries()) {
          const response = await request(path)
          expect(response.status).toBe(200)
          const body = await response.json()
          if (read === 0) expect(body).toMatchObject({ directory: directories[index], project: { id: Project.ID.global } })
          else if (read === 1) expect(body).toMatchObject({ location: { directory: directories[index] }, data: [] })
          else if (read === 2) expect(body).toMatchObject({ data: { logical: 0, physical: 0, helpers: 0 } })
          else if (read === 3) expect(body).toMatchObject({ data: { rows: [] } })
          else if (read === 4) expect(body.data.units).toMatchObject([
            { anchor: { sessionID: sessionID(index), inputID: "msg_populated_missing" }, total: { requests: 0 } },
            { anchor: { sessionID: sessionID(index), inputID: "msg_populated_other" }, total: { requests: 0 } },
          ])
          else if (read === 5) expect(body.data.tasks).toMatchObject([
            { sessionID: childID(index, 0), total: { requests: 0 } },
            { sessionID: childID(index, 1), total: { requests: 0 } },
          ])
          else expect(body).toEqual({ data: [] })
        }
      }
      const after = await loaded()
      expect(after).toHaveLength(87)
      for (const entry of after) {
        const index = directories.indexOf(entry.directory)
        if (index < 11 || index >= 81) {
          expect([entry]).toEqual(before.filter((prior) => prior.directory === entry.directory))
          continue
        }
        for (const heavy of [MCP.node.name, LocationWatcher.node.name, PluginSupervisor.node.name])
          expect(entry.built).not.toContain(heavy)
      }
      expect(after.filter((entry) => entry.built.includes(MCP.node.name))).toHaveLength(11)
      if (plateau) expect(after).toEqual(plateau)
      else plateau = after
    }
  } finally {
    await Effect.runPromise(Scope.close(leases, Exit.void))
    await handler.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
