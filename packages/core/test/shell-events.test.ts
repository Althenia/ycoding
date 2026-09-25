import { afterAll, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppProcess } from "@ycoding-ai/core/process"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Config } from "@ycoding-ai/core/config"
import { EventV2 } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Shell } from "@ycoding-ai/core/shell"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { Effect, Layer } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const workspace = await mkdtemp(join(tmpdir(), "ycoding-shell-events-"))
afterAll(() => rm(workspace, { recursive: true, force: true }))

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ shell: "/bin/sh", shell_sandbox: "disabled" }),
        }),
      ]),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      Config.node,
      EventV2.node,
      Global.node,
      Location.node,
      ShellSandbox.node,
      Shell.node,
    ]),
    [
      [Config.node, config],
      [Global.node, Global.layerWith({ data: join(workspace, "data") })],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workspace) }))),
      ],
    ],
  ),
)

// Memory-limited shells sample the process group before watching for exit, so a command that
// finishes during that sample is the case most likely to report its exit before its creation.
const posixIt = process.platform === "win32" ? it.live.skip : it.live

posixIt("publishes shell.created before shell.exited for commands that finish immediately", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const shell = yield* Shell.Service
    const seen: string[] = []
    yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type === "shell.created" || event.type === "shell.exited") seen.push(event.type)
      }),
    )

    for (const memoryLimitMb of [undefined, 512, 512, 512]) {
      seen.length = 0
      const info = yield* shell.create(yield* shell.prepare({ command: "true", timeout: 0, memoryLimitMb }))
      yield* shell.wait(info.id)
      // Waiters resolve just before the exit event is published.
      for (let attempt = 0; seen.length < 2 && attempt < 100; attempt++) yield* Effect.sleep(10)
      expect(seen).toEqual(["shell.created", "shell.exited"])
    }
  }),
)
