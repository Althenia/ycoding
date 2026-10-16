import { expect, test } from "bun:test"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Schema, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const rootID = SessionSchema.ID.make("ses_restart_boot_root")
const finalID = SessionSchema.ID.make("ses_restart_boot_final")
const toolID = SessionSchema.ID.make("ses_restart_boot_tool")
const loneRootID = SessionSchema.ID.make("ses_restart_boot_lone")
const model = CatalogModel.Ref.make({ providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("child") })

for (const mode of ["managed", "standalone"] as const)
  test(`${mode} startup recovers only managed children and never resumes a root`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ycoding-restart-boot-"))
    const file = join(directory, "ycoding.db")
    const scope = await Effect.runPromise(Scope.make())
    try {
      await seed(file, directory)
      const startingRaw = ServerProcess.start<never, never>(
        {
          hostname: "127.0.0.1",
          port: await availablePort(),
          password: "test-password",
          database: { path: file },
          config: { directory, project: false, content: "{}" },
          fs: { filewatcher: false, fff: false },
        },
        mode === "managed" ? { instanceID: "restart-boot", onListen: () => Effect.succeed(Effect.void) } : undefined,
      ).pipe(Effect.provideService(Scope.Scope, scope))
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runtime-owned router requirement markers are not services callers can provide
      const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
      await Effect.runPromise(starting)
      const recovered = await state(file)
      expect(recovered.tasks).toEqual(
        mode === "managed"
          ? { [finalID]: "completed", [toolID]: "waiting" }
          : { [finalID]: "lost", [toolID]: "lost" },
      )
      expect(recovered.deferred).toEqual(
        mode === "managed" ? [{ sessionID: toolID, kind: "recovery", reason: "restart", tools: ["shell"] }] : [],
      )
      expect(recovered.loneRootStarts).toBe(1)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await rm(directory, { recursive: true, force: true })
    }
  })

function seed(file: string, directory: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventRuntime.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      for (const [sessionID, parentID] of [[rootID, undefined], [finalID, rootID], [toolID, rootID], [loneRootID, undefined]] as const)
        yield* events.publish(SessionEvent.Created, {
          sessionID,
          parentID,
          projectID: Project.ID.global,
          location: { directory: AbsolutePath.make(directory) },
          title: sessionID,
          created: Date.now(),
        })
      for (const childID of [finalID, toolID])
        yield* db
          .insert(SessionTaskTable)
          .values({
            session_id: childID,
            parent_id: rootID,
            parent_assistant_message_id: SessionMessage.ID.make(`msg_launch_${childID}`),
            tool_call_id: `call_launch_${childID}`,
            input_id: SessionMessage.ID.make(`msg_input_${childID}`),
            description: "boot recovery",
            agent: Agent.ID.make("build"),
            model,
            prompt_digest: "digest",
            background: true,
            delivery: "steer",
            state: "running",
            revision: 1,
            owner_pid: 2_000_000_000,
            owner_started: "Thu Jan  1 00:00:00 1970",
            time_created: 1,
            time_updated: 1,
          })
          .run()
          .pipe(Effect.orDie)
      const step = (sessionID: SessionSchema.ID, text: string) =>
        Effect.gen(function* () {
          const assistantMessageID = SessionMessage.ID.create()
          yield* events.publish(SessionEvent.Execution.Started, { sessionID })
          yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: Agent.ID.make("build"), model })
          yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
          yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text })
          return assistantMessageID
        })
      const finalMessageID = yield* step(finalID, "Finished.")
      yield* events.publish(
        SessionEvent.Step.Ended,
        Schema.decodeUnknownSync(SessionEvent.Step.Ended.data)({
          sessionID: finalID,
          assistantMessageID: finalMessageID,
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      )
      const toolMessageID = yield* step(toolID, "Running the migration")
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID: toolID, assistantMessageID: toolMessageID, callID: "call_shell", name: "shell" })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: toolID,
        assistantMessageID: toolMessageID,
        callID: "call_shell",
        input: { command: "./migrate" },
        executed: false,
      })
      yield* step(loneRootID, "Halfway")
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node]), [
          [Database.node, Database.layer({ path: file })],
        ]),
      ),
      Effect.scoped,
    ),
  )
}

function state(file: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const tasks = yield* db.select({ sessionID: SessionTaskTable.session_id, state: SessionTaskTable.state }).from(SessionTaskTable).all().pipe(Effect.orDie)
      const history = yield* db
        .select({ aggregateID: EventTable.aggregate_id, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      return {
        tasks: Object.fromEntries(tasks.map((row) => [row.sessionID, row.state])),
        deferred: history
          .filter((row) => row.type.startsWith(SessionEvent.Review.Deferred.type))
          .map((row) => {
            const data = Schema.decodeUnknownSync(SessionEvent.Review.Deferred.data)(row.data)
            return {
              sessionID: row.aggregateID,
              kind: data.kind,
              reason: data.reason,
              tools: data.payload.type === "recovery" ? data.payload.tools.map((tool) => tool.name) : [],
            }
          }),
        loneRootStarts: history.filter(
          (row) => row.aggregateID === loneRootID && row.type.startsWith(SessionEvent.Execution.Started.type),
        ).length,
      }
    }).pipe(Effect.provide(Database.layer({ path: file })), Effect.scoped),
  )
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
