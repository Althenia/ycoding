import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { ConfigSkillPlugin } from "@ycoding-ai/core/config/plugin/skill"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make("/repo/packages/core")
      const sources: SkillV2.Source[] = []
      const transform = Effect.fnUntraced(function* (update: (draft: SkillV2.Draft) => void | Effect.Effect<void>) {
        const result = update({
          source: (source) => {
            sources.push(source)
          },
          list: () => sources,
        })
        if (Effect.isEffect(result)) yield* result
        const dispose = Effect.sync(() => {
          sources.length = 0
        })
        yield* Effect.addFinalizer(() => dispose)
        return { dispose }
      })

      yield* ConfigSkillPlugin.Plugin.effect(
        host({
          skill: { list: () => Effect.die("unused skill.list"), transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/home/test" })),
        Effect.provideService(Location.Service, Location.Service.of(location({ directory }))),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.ClaudeDirectory({ type: "claude", path: AbsolutePath.make("/repo/.claude") }),
                new Config.AgentsDirectory({ type: "agents", path: AbsolutePath.make("/repo/.agents") }),
                new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.ycoding") }),
                new Config.Document({
                  type: "document",
                  info: decode({
                    skills: ["./skills", "~/shared-skills", "/opt/skills", "https://example.test/skills/"],
                  }),
                }),
              ]),
          }),
        ),
      )

      expect(sources).toEqual([
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.claude", "skills")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.agents", "skills")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.ycoding", "skill")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.ycoding", "skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        SkillV2.UrlSource.make({ type: "url", url: "https://example.test/skills/" }),
      ])
    }),
  )
})
