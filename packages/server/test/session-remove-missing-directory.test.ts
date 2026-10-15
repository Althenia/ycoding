import { expect, test } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { inArray } from "drizzle-orm"
import { Context, Effect, Layer, Stream } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmbeddedRoutes } from "../src/routes"

test("deletes a root Session family whose directory no longer exists without recreating it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-session-remove-"))
  const workspace = join(directory, "workspace")
  await Promise.all([mkdir(workspace), mkdir(join(directory, "config"))])
  const options = {
    database: { path: join(directory, "session.db") },
    config: { directory: join(directory, "config"), project: false },
    fs: { filewatcher: false, fff: false },
  }
  const ids: { root?: Session.ID; child?: Session.ID } = {}

  const seeding = HttpRouter.toWebHandler(
    createEmbeddedRoutes(options).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          const session = Context.get(context, Session.Service)
          const root = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(workspace) }),
          })
          const child = yield* session.create({ parentID: root.id })
          ids.root = root.id
          ids.child = child.id
        }),
      ),
    ),
  )
  await seeding.handler(new Request("http://localhost/api/session"), Context.empty())
  await seeding.dispose()
  await rm(workspace, { recursive: true, force: true })

  const deleted: string[] = []
  const familyDeleted = Promise.withResolvers<void>()
  let database: Database.Interface | undefined
  const handler = HttpRouter.toWebHandler(
    createEmbeddedRoutes(options).pipe(
      Layer.provide(NodeHttpServer.layerHttpServices),
      Layer.tap((context) =>
        Effect.gen(function* () {
          database = Context.get(context, Database.Service)
          yield* Context.get(context, EventRuntime.Service)
            .subscribe(SessionEvent.Deleted)
            .pipe(
              Stream.runForEach((event) => Effect.sync(() => {
                  deleted.push(event.data.sessionID)
                  if (deleted.length === 2) familyDeleted.resolve()
                })),
              Effect.forkDetach,
            )
        }),
      ),
    ),
  )

  try {
    const root = ids.root!
    const child = ids.child!
    expect((await handler.handler(new Request(`http://localhost/api/session/${root}`), Context.empty())).status).toBe(200)
    const response = await handler.handler(
      new Request(`http://localhost/api/session/${root}`, { method: "DELETE" }),
      Context.empty(),
    )
    expect(response.status).toBe(204)
    await familyDeleted.promise
    expect(deleted.toSorted()).toEqual([root, child].toSorted())

    const rows = await Effect.runPromise(
      Effect.all([
        database!.db.select({ id: SessionTable.id }).from(SessionTable).where(inArray(SessionTable.id, [root, child])).all(),
        database!.db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(inArray(EventTable.aggregate_id, [root, child]))
          .all(),
      ]).pipe(Effect.orDie),
    )
    expect(rows).toEqual([[], []])
    expect((await handler.handler(new Request(`http://localhost/api/session/${root}`), Context.empty())).status).toBe(404)
    expect(await stat(workspace).then(() => true, () => false)).toBe(false)
  } finally {
    await handler.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
