import { afterAll, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppProcess } from "@ycoding-ai/core/process"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Config } from "@ycoding-ai/core/config"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Shell } from "@ycoding-ai/core/shell"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { Effect, Layer, Queue } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const workspace = await mkdtemp(join(tmpdir(), "ycoding-shell-events-"))
afterAll(() => rm(workspace, { recursive: true, force: true }))

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    diagnostics: () => Effect.succeed([]),
    reload: () => Effect.void,
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ shell: "/bin/sh", shell_sandbox: "disabled" }),
        }),
      ]),
  }),
)

const layer = (exitBeforeSpawn = false) =>
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      Config.node,
      EventRuntime.node,
      Global.node,
      Location.node,
      ShellSandbox.node,
      Shell.node,
    ]),
    [
      [
        AppProcess.node,
        Layer.effect(
          AppProcess.Service,
          Effect.gen(function* () {
            const real = yield* AppProcess.Service
            return AppProcess.Service.of({
              ...real,
              spawn: (command) =>
                real
                  .spawn(command)
                  .pipe(Effect.tap((handle) => (exitBeforeSpawn ? handle.exitCode.pipe(Effect.asVoid) : Effect.void))),
            })
          }),
        ).pipe(Layer.provide(AppNodeBuilder.build(AppProcess.node))),
      ],
      [Config.node, config],
      [Global.node, Global.layerWith({ data: join(workspace, "data") })],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workspace) }))),
      ],
    ],
  )

const it = testEffect(layer())
const earlyExit = testEffect(layer(true))

// Memory-limited shells sample the process group before watching for exit, so a command that
// finishes during that sample is the case most likely to report its exit before its creation.
const posixIt = process.platform === "win32" ? it.live.skip : it.live

posixIt("publishes shell.created before shell.exited for commands that finish immediately", () =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const shell = yield* Shell.Service
    expect(shell).not.toHaveProperty("enqueue")
    expect(shell).not.toHaveProperty("cancelQueued")
    const observed = yield* Queue.unbounded<string>()
    yield* events.listen((event) =>
      event.type === "shell.created" || event.type === "shell.exited"
        ? Queue.offer(observed, event.type).pipe(Effect.asVoid)
        : Effect.void,
    )
    for (const memoryLimitMb of [undefined, 512, 512, 512]) {
      const info = yield* shell.create(yield* shell.prepare({ command: "true", timeout: 0, memoryLimitMb }))
      yield* shell.wait(info.id)
      const seen = yield* Effect.all([Queue.take(observed), Queue.take(observed)]).pipe(Effect.timeout("5 seconds"))
      expect(seen).toEqual(["shell.created", "shell.exited"])
    }
  }),
)

const posixEarlyExit = process.platform === "win32" ? earlyExit.live.skip : earlyExit.live

posixEarlyExit("retains stdout and stderr when the process exits before spawn returns", () =>
  Effect.gen(function* () {
    const shell = yield* Shell.Service
    for (const memoryLimitMb of [undefined, 512]) {
      const info = yield* shell.create(
        yield* shell.prepare({
          command: "printf hello; printf error >&2",
          timeout: 0,
          memoryLimitMb,
        }),
      )
      expect((yield* shell.wait(info.id)).status).toBe("exited")
      const output = yield* shell.output(info.id)
      expect(output.output).toContain("hello")
      expect(output.output).toContain("error")
    }
  }),
)
