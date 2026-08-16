export * as InstructionDiscovery from "./instruction-discovery"

import { Array, Context, Effect, Layer, Schema } from "effect"
import { isAbsolute, join, relative, sep } from "path"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { renderInstructionContent } from "./instruction-content"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { Instructions } from "./instructions/index"
import { makeLocationNode } from "./effect/app-node"

class File extends Schema.Class<File>("InstructionDiscovery.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = Instructions.Key.make("core/instructions")

export interface Interface {
  readonly load: () => Effect.Effect<Instructions.Instructions>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/InstructionDiscovery") {}

export const layer = (options?: Options) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service

    const source = (
      value: ReadonlyArray<File> | Instructions.Unavailable | Instructions.Removed,
      maxBytes?: number,
    ) =>
      Instructions.make<ReadonlyArray<File>>({
        key,
        codec: Schema.toCodecJson(Files),
        read: Effect.succeed(value),
        render: {
          initial: (files) => render(files, maxBytes),
          changed: (_previous, current) =>
            `These instructions replace all previously loaded ambient instructions.\n\n${render(current, maxBytes)}`,
          removed: () => "Previously loaded instructions no longer apply.",
        },
      })

    const observe = Effect.fn("InstructionDiscovery.observe")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        yield* Effect.forEach(
          options?.project === false || !insideProject
            ? []
            : yield* fs.up({
                targets: ["AGENTS.md"],
                start,
                stop,
              }),
          fs.resolve,
        ),
      )
      const paths = Array.dedupe([yield* fs.resolve(join(global.config, "AGENTS.md")), ...discovered])
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return Instructions.unavailable
      return files.filter((file): file is File => file !== undefined)
    })

    return Service.of({
      load: Effect.fn("InstructionDiscovery.load")(function* () {
        const maxBytes = Config.latest(yield* config.entries(), "instruction_max_bytes")
        return yield* observe().pipe(
          Effect.map((files) =>
            Array.isArray(files) && files.length === 0
              ? source(Instructions.removed, maxBytes)
              : source(files, maxBytes),
          ),
          Effect.catch(() => Effect.succeed(source(Instructions.unavailable, maxBytes))),
          Effect.catchDefect(() => Effect.succeed(source(Instructions.unavailable, maxBytes))),
        )
      }),
    })
  }),
)

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [Config.node, FSUtil.node, Global.node, Location.node],
  })
}

export const node = configured()

function render(files: ReadonlyArray<File>, maxBytes?: number) {
  return files
    .map((file) =>
      [
        `Instructions from: ${file.path}`,
        renderInstructionContent({ source: file.path, content: file.content, maxBytes, retrieval: "read" }).content,
      ].join("\n"),
    )
    .join("\n\n")
}
