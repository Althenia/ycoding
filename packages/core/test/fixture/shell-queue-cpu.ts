import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { ConfigShell } from "@ycoding-ai/core/config/shell"
import { Global } from "@ycoding-ai/core/global"
import { ShellQueue } from "@ycoding-ai/core/shell/queue"
import { Shell } from "@ycoding-ai/schema/shell"
import { Effect, Schema } from "effect"

const decodeEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ admitted: Schema.Finite.pipe(Schema.optional) })),
)
const mode = process.argv[2] === "--unpublished" ? "unpublished" : "published"

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "ycoding-queue-cpu-"))),
        (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
      )
      const observations = { passes: 0, snapshots: 0, samples: 0 }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* ShellQueue.Service
          const limits = ConfigShell.queueLimits({ max_running: 1 })
          if (mode === "published") {
            const holder = yield* queue.enqueue({
              id: Shell.ID.make("sh_holder"),
              sessionID: "ses_holder",
              command: "holder",
              cwd: state,
              limits,
            })
            yield* holder.admitted(() => Effect.void)
          }
          if (mode === "unpublished") {
            const holder = Bun.spawn(
              [
                process.execPath,
                path.join(import.meta.dir, "shell-queue-worker.ts"),
                JSON.stringify({
                  state,
                  log: path.join(state, "log"),
                  backstopMs: 2_000,
                  maxRunning: 1,
                  maxRunningPerSession: 1,
                  maxQueuedPerSession: 16,
                  stopAt: "claimed",
                  entries: [{ id: "sh_holder", sessionID: "ses_holder", holdMs: -1 }],
                }),
              ],
              { stdout: "ignore", stderr: "inherit" },
            )
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                holder.kill("SIGKILL")
                await holder.exited
              }),
            )
            yield* Effect.promise(async () => {
              for (let attempt = 0; attempt < 250; attempt++) {
                if ((await Bun.$`ps -o stat= -p ${holder.pid}`.quiet().nothrow().text()).trim().startsWith("T")) return
                await Bun.sleep(20)
              }
              throw new Error("holder did not stop with unpublished capacity")
            })
          }
          yield* Effect.forEach(
            Array.from({ length: 80 }, (_, index) => index),
            (index) =>
              queue.enqueue({
                id: Shell.ID.make(`sh_waiting_${index}`),
                sessionID: `ses_${index % 5}`,
                command: `waiting ${index}`,
                cwd: state,
                limits,
              }),
            { concurrency: "unbounded", discard: true },
          )
          yield* Effect.sleep(250)
          observations.passes = 0
          observations.snapshots = 0
          observations.samples = 0
          const rssBeforeMiB = process.memoryUsage().rss / 1024 / 1024
          const before = process.cpuUsage()
          const started = performance.now()
          yield* Effect.sleep(10_000)
          const elapsedMs = performance.now() - started
          const cpu = process.cpuUsage(before)
          const files = yield* Effect.promise(() => fs.readdir(path.join(state, "shell-queue", "entries")))
          const entries = yield* Effect.promise(() =>
            Promise.all(
              files
                .filter((name) => name.endsWith(".json"))
                .map((name) =>
                  fs.readFile(path.join(state, "shell-queue", "entries", name), "utf8").then((raw) => decodeEntry(raw)),
                ),
            ),
          )
          console.log(
            JSON.stringify({
              mode,
              waiting: entries.filter((entry) => entry.admitted === undefined).length,
              running: entries.filter((entry) => entry.admitted !== undefined).length,
              elapsedMs,
              userCPUms: cpu.user / 1_000,
              systemCPUms: cpu.system / 1_000,
              cpuPercent: (cpu.user + cpu.system) / elapsedMs / 10,
              evaluationPasses: observations.passes,
              snapshots: observations.snapshots,
              samples: observations.samples,
              rssBeforeMiB,
              rssAfterMiB: process.memoryUsage().rss / 1024 / 1024,
            }),
          )
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              ShellQueue.configured({
                sample: Effect.sync(() => {
                  observations.samples++
                  return { availableMb: 1_000_000, load: 0 }
                }),
                trace: (event) => {
                  if (event === "pass") observations.passes++
                  if (event === "snapshot") observations.snapshots++
                },
              }),
              [[Global.node, Global.layerWith({ state })]],
            ),
          ),
        ),
      )
    }),
  ),
)
