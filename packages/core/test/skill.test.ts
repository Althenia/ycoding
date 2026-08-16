import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { SkillDiscovery } from "@ycoding-ai/core/skill/discovery"
import { FileSystem } from "@ycoding-ai/schema/filesystem"
import { Instruction } from "@ycoding-ai/schema/instruction"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node, EventV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

function waitForSkillUpdate() {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const deferred = yield* Deferred.make<void>()
    const fiber = yield* events.subscribe(SkillV2.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(deferred, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    return { deferred, fiber }
  })
}

describe("SkillV2", () => {
  it.live("publishes updates when skill sources change", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service

      yield* Effect.acquireUseRelease(
        waitForSkillUpdate(),
        ({ deferred }) =>
          skill
            .transform((editor) =>
              editor.source({ type: "directory", path: AbsolutePath.make("/tmp/ycoding-skills") }),
            )
            .pipe(Effect.andThen(Deferred.await(deferred)), Effect.timeout("1 second")),
        ({ fiber }) => Fiber.interrupt(fiber),
      )
    }),
  )

  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              id: SkillV2.ID.make("foo"),
              name: SkillV2.Name.make("foo"),
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              id: SkillV2.ID.make("review"),
              name: SkillV2.Name.make("review"),
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual([SkillV2.Name.make("deploy")])
          expect((yield* skill.list()).map((item) => item.name)).toEqual([SkillV2.Name.make("deploy")])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )

  it.live("parses ycoding metadata flags from skill frontmatter", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "manual"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "manual", "SKILL.md"),
              `---
name: manual
description: Manual only
metadata:
  ycoding/slash: true
  ycoding/autoinvoke: false
---
# manual`,
            )
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))

          expect(yield* skill.list()).toEqual([
            {
              id: SkillV2.ID.make("manual"),
              name: SkillV2.Name.make("manual"),
              description: "Manual only",
              slash: true,
              autoinvoke: false,
              location: AbsolutePath.make(path.join(tmp.path, "manual", "SKILL.md")),
              content: "# manual",
            },
          ])
        }),
      ),
    ),
  )

  it.live("normalizes conflict declarations from skill metadata", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "manual"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "manual", "SKILL.md"),
              `---
name: manual
metadata:
  ycoding/conflicts:
    skills: [" other ", other]
    instructions: [" core/instructions ", core/instructions]
---
# manual`,
            )
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))

          const [loaded] = yield* skill.list()
          expect(loaded?.conflicts).toEqual({
            skills: [SkillV2.ID.make("other")],
            instructions: [Instruction.Key.make("core/instructions")],
          })
        }),
      ),
    ),
  )

  it.live("rejects malformed conflict declarations", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "manual"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "manual", "SKILL.md"),
              `---
name: manual
metadata:
  ycoding/conflicts:
    skills: [other, 1]
---
# manual`,
            )
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))

          expect(yield* skill.list()).toEqual([])
        }),
      ),
    ),
  )

  it.live("rejects empty and whitespace-only conflict declaration values", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const cases = [
            { directory: "empty-skill", field: "skills", value: '""' },
            { directory: "whitespace-skill", field: "skills", value: '"  "' },
            { directory: "empty-instruction", field: "instructions", value: '""' },
            { directory: "whitespace-instruction", field: "instructions", value: '"  "' },
          ]
          yield* Effect.promise(() =>
            Promise.all(
              cases.map((item) =>
                fs
                  .mkdir(path.join(tmp.path, item.directory), { recursive: true })
                  .then(() =>
                    fs.writeFile(
                      path.join(tmp.path, item.directory, "SKILL.md"),
                      `---
name: ${item.directory}
metadata:
  ycoding/conflicts:
    ${item.field}: [${item.value}]
---
# ${item.directory}`,
                    ),
                  ),
              ),
            ),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))

          expect(yield* skill.list()).toEqual([])
        }),
      ),
    ),
  )

  it.live("drops skills whose files were deleted from disk", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))
          expect((yield* skill.list()).map((item) => item.id)).toEqual([SkillV2.ID.make("deploy")])

          // Ecosystem roots such as ~/.claude/skills are deliberately unwatched, so deleting a
          // skill there never produces a filesystem event: list must still reflect disk.
          yield* Effect.promise(() => fs.rm(path.join(tmp.path, "deploy"), { recursive: true, force: true }))

          expect(yield* skill.list()).toEqual([])
        }),
      ),
    ),
  )

  it.live("publishes updates for watcher changes inside skill directories", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Initial deploy")
          })

          const events = yield* EventV2.Service
          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))

          expect((yield* skill.list()).find((item) => item.name === "deploy")?.description).toBe("Initial deploy")

          const file = path.join(tmp.path, "deploy", "SKILL.md")
          yield* Effect.promise(() => write(tmp.path, "deploy", "Updated deploy"))

          yield* Effect.acquireUseRelease(
            waitForSkillUpdate(),
            ({ deferred }) =>
              events
                .publish(FileSystem.Event.Changed, { file, event: "change" })
                .pipe(Effect.andThen(Deferred.await(deferred)), Effect.timeout("1 second")),
            ({ fiber }) => Fiber.interrupt(fiber),
          )

          expect((yield* skill.list()).find((item) => item.name === "deploy")?.description).toBe("Updated deploy")
        }),
      ),
    ),
  )
})
