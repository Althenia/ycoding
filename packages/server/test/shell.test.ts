import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Fiber, Layer, PlatformError, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { AppProcess } from "@ycoding-ai/core/process"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Config } from "@ycoding-ai/core/config"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Shell } from "@ycoding-ai/core/shell"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { location } from "../../core/test/fixture/location"
import { cleanGroup, fileReady, groupAlive, shellProcess } from "../../core/test/fixture/shell-process"
import { Api } from "../src/api"
import { ShellHandler } from "../src/handlers/shell"
import { LocationMiddleware, type LocationServices } from "../src/location"

const posix = process.platform === "win32" ? test.skip : test

posix(
  "DELETE /api/shell/:id cancels queued and running commands and rejects unknown IDs",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ycoding-shell-http-"))
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const placement = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
          )
          const config = Layer.succeed(
            Config.Service,
            Config.Service.of({
              diagnostics: () => Effect.succeed([]),
              reload: () => Effect.void,
              entries: () =>
                Effect.succeed([
                  new Config.Document({
                    type: "document",
                    info: new Config.Info({
                      shell: "/bin/sh",
                      shell_sandbox: "disabled",
                      shell_queue: { max_running: 1 },
                    }),
                  }),
                ]),
            }),
          )
          const scope = yield* Scope.Scope
          const termination = { denied: false }
          const context = yield* Layer.buildWithScope(
            AppNodeBuilder.build(LayerNode.group([Shell.node, Location.node]), [
              [Config.node, config],
              [
                AppProcess.node,
                Layer.effect(
                  AppProcess.Service,
                  Effect.gen(function* () {
                    const real = yield* AppProcess.Service
                    return AppProcess.Service.of({
                      ...real,
                      spawn: (input) =>
                        real.spawn(input).pipe(
                          Effect.map((handle) =>
                            ChildProcessSpawner.makeHandle({
                              ...handle,
                              kill: (options) =>
                                termination.denied
                                  ? Effect.fail(
                                      PlatformError.systemError({
                                        _tag: "PermissionDenied",
                                        module: "ChildProcess",
                                        method: "kill",
                                        cause: new Error("EPERM"),
                                      }),
                                    )
                                  : handle.kill(options),
                            }),
                          ),
                        ),
                    })
                  }),
                ).pipe(Layer.provide(AppNodeBuilder.build(AppProcess.node))),
              ],
              [Location.node, placement],
              [Global.node, Global.layerWith({ data: join(directory, "data"), state: join(directory, "state") })],
            ]),
            scope,
          )
          const shell = Context.get(context, Shell.Service)
          const handler = HttpRouter.toWebHandler(
            HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.shell"])).pipe(
              Layer.provide(ShellHandler),
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(LocationMiddleware, (effect) =>
                    Effect.provide(effect, Context.makeUnsafe<LocationServices>(context.mapUnsafe)),
                  ),
                  Layer.succeed(Authorization, (effect) => effect),
                  Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
                ),
              ),
              Layer.provide(HttpServer.layerServices),
            ),
          )
          yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()))
          const remove = (id: string) =>
            Effect.promise(() =>
              handler.handler(
                new Request(`http://localhost/api/shell/${id}`, {
                  method: "DELETE",
                  signal: AbortSignal.timeout(8_000),
                }),
              ),
            )
          const command = shellProcess(directory)
          const running = yield* shell.enqueue(
            yield* shell.prepare({ command: command.command, timeout: 0 }),
            SessionSchema.ID.make("ses_http_holder"),
          )
          const pid = Number(yield* fileReady(command.ready))
          yield* Effect.addFinalizer(() => cleanGroup(pid))
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              termination.denied = false
            }),
          )
          yield* Effect.gen(function* () {
            while ((yield* shell.get(running.id)).status !== "running") yield* Effect.sleep(10)
          }).pipe(Effect.timeout(5_000))
          const marker = join(directory, "must-not-start")
          const waiting = yield* shell.enqueue(
            yield* shell.prepare({ command: `touch '${marker}'`, timeout: 0 }),
            SessionSchema.ID.make("ses_http_waiting"),
          )
          const waitingDone = yield* shell.wait(waiting.id).pipe(Effect.forkScoped({ startImmediately: true }))
          expect((yield* remove(waiting.id)).status).toBe(204)
          expect((yield* Fiber.join(waitingDone).pipe(Effect.timeout(5_000))).status).toBe("killed")
          expect(yield* Effect.promise(() => readdir(join(directory, "state", "shell-queue", "entries")))).toEqual([
            `${running.id}.json`,
          ])
          expect((yield* remove(waiting.id)).status).toBe(404)
          termination.denied = true
          expect((yield* remove(running.id)).status).toBe(500)
          expect(groupAlive(pid)).toBe(true)
          expect((yield* shell.get(running.id)).status).toBe("running")
          termination.denied = false
          const runningDone = yield* shell.wait(running.id).pipe(Effect.forkScoped({ startImmediately: true }))
          expect((yield* remove(running.id)).status).toBe(204)
          expect(groupAlive(pid)).toBe(false)
          expect((yield* Fiber.join(runningDone).pipe(Effect.timeout(5_000))).status).toBe("killed")
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
          expect((yield* remove("sh_unknown")).status).toBe(404)
        }).pipe(Effect.scoped),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  20_000,
)
