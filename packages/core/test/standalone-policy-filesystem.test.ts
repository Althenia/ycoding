import { expect } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, Option } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { ScopeUnavailableError } from "@ycoding-ai/core/session/error"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const native = testEffect(AppNodeBuilder.build(FSUtil.node))
const markdown = (id: string) => `---\nid: ${id}\ndecision: ask\nactions: [synthetic]\nresources: [example]\nreason: "Synthetic literal {env:IGNORED} {file:/synthetic/ignored}"\n---\n`
const fixture = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ycoding-policy-fixture-" }).pipe(Effect.flatMap((directory) => fs.realPath(directory)))
  const config = `${root}/config`
  yield* fs.makeDirectory(config)
  yield* fs.writeFileString(`${config}/ycoding.json`, "{}")
  const reads: string[] = []
  const enumerationErrors: FSUtil.Error[] = []
  let revokeDirectoryRead = false
  const context = yield* Layer.build(AppNodeBuilder.build(
    LayerNode.group([Database.node, EventRuntime.node, SessionGuardrail.standaloneObservationNode]),
    [
      [Global.node, Layer.succeed(Global.Service, Global.make({ config }))],
      [FSUtil.node, Layer.succeed(FSUtil.Service, FSUtil.Service.of({
        ...fs,
        readFileString: (...args) => { reads.push(args[0]); return fs.readFileString(...args) },
        realPath: (target) => fs.realPath(target).pipe(Effect.tap(() => target === `${config}/guardrails` && revokeDirectoryRead ? fs.chmod(target, 0o111) : Effect.void)),
        readDirectoryEntries: (target) => fs.readDirectoryEntries(target).pipe(Effect.tapError((error) => Effect.sync(() => { if (target === `${config}/guardrails`) enumerationErrors.push(error) }))),
      }))],
    ],
  ))
  const db = Context.get(context, Database.Service).db
  const sessionID = SessionSchema.ID.make("ses_native_policy_fixture")
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] }).run()
  yield* db.insert(SessionTable).values({ id: sessionID, scope: "standalone", project_id: Project.ID.global, directory: `${root}/session`, title: "Synthetic" }).run()
  const observation = Context.get(context, SessionGuardrail.Observation)
  return { fs, root, config, reads, enumerationErrors, sessionID, observation, revokeDirectoryRead: () => { revokeDirectoryRead = true } }
})

native.effect("native standalone policy reads only direct global Markdown and keeps tokens literal", () => Effect.gen(function* () {
  const f = yield* fixture
  yield* f.fs.makeDirectory(`${f.config}/guardrails/nested`, { recursive: true })
  yield* f.fs.writeFileString(`${f.config}/guardrails/direct.md`, markdown("synthetic-direct"))
  yield* f.fs.writeFileString(`${f.config}/guardrails/nested/ignored.md`, markdown("synthetic-nested"))
  const first = yield* f.observation.snapshot(f.sessionID)
  expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(f.reads).toContain(`${f.config}/guardrails/direct.md`)
  expect(f.reads).not.toContain(`${f.config}/guardrails/nested/ignored.md`)
  expect(f.reads).not.toContain("/synthetic/ignored")
  yield* f.fs.writeFileString(`${f.config}/guardrails/direct.md`, "---\nid: malformed\n---\n")
  expect((yield* f.observation.snapshot(f.sessionID)).digest).not.toBe(first.digest)
}))

native.effect("native standalone policy permits missing configuration and guardrail directories", () => Effect.gen(function* () {
  const f = yield* fixture
  expect((yield* f.observation.snapshot(f.sessionID)).digest).toMatch(/^[a-f0-9]{64}$/)
  yield* f.fs.remove(f.config, { recursive: true })
  expect((yield* f.observation.snapshot(f.sessionID)).digest).toMatch(/^[a-f0-9]{64}$/)
}))

native.effect("native standalone policy rejects a non-directory policy root instead of empty enumeration", () => Effect.gen(function* () {
  const f = yield* fixture
  const directory = `${f.config}/guardrails`
  yield* f.fs.writeFileString(directory, "Synthetic non-directory policy root")
  expect(yield* f.fs.realPath(directory)).toBe(directory)
  expect(Exit.isFailure(yield* Effect.exit(f.fs.readDirectoryEntries(directory)))).toBe(true)
  const result = yield* Effect.exit(f.observation.snapshot(f.sessionID))
  expect(Exit.isFailure(result) && Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(ScopeUnavailableError)
}))

native.effect("native standalone policy rejects a guardrail directory symlink escape before document reads", () => Effect.gen(function* () {
  const f = yield* fixture
  yield* f.fs.makeDirectory(`${f.root}/outside`)
  yield* f.fs.writeFileString(`${f.root}/outside/escaped.md`, markdown("synthetic-outside"))
  yield* f.fs.symlink(`${f.root}/outside`, `${f.config}/guardrails`)
  expect(Exit.isFailure(yield* Effect.exit(f.observation.snapshot(f.sessionID)))).toBe(true)
  expect(f.reads).not.toContain(`${f.config}/guardrails/escaped.md`)
  expect(f.reads).not.toContain(`${f.root}/outside/escaped.md`)
}))

native.effect("native standalone policy rejects a direct Markdown symlink escape before reading its target", () => Effect.gen(function* () {
  const f = yield* fixture
  yield* f.fs.makeDirectory(`${f.config}/guardrails`)
  yield* f.fs.writeFileString(`${f.root}/outside.md`, markdown("synthetic-outside"))
  yield* f.fs.symlink(`${f.root}/outside.md`, `${f.config}/guardrails/escaped.md`)
  expect(Exit.isFailure(yield* Effect.exit(f.observation.snapshot(f.sessionID)))).toBe(true)
  expect(f.reads).not.toContain(`${f.config}/guardrails/escaped.md`)
  expect(f.reads).not.toContain(`${f.root}/outside.md`)
}))

native.effect("native standalone policy rejects a dangling direct Markdown link instead of observing no policy", () => Effect.gen(function* () {
  const f = yield* fixture
  yield* f.fs.makeDirectory(`${f.config}/guardrails`)
  yield* f.fs.symlink(`${f.root}/missing.md`, `${f.config}/guardrails/dangling.md`)
  expect(Exit.isFailure(yield* Effect.exit(f.observation.snapshot(f.sessionID)))).toBe(true)
  expect(f.reads).not.toContain(`${f.config}/guardrails/dangling.md`)
}))

const permissionCase = process.platform === "win32" || process.geteuid?.() === undefined || process.geteuid?.() === 0
  ? native.effect.skip
  : native.effect

permissionCase("native standalone policy propagates an unreadable directory instead of successful empty enumeration", () => Effect.gen(function* () {
  const f = yield* fixture
  const directory = `${f.config}/guardrails`
  yield* f.fs.makeDirectory(directory)
  yield* f.fs.writeFileString(`${directory}/synthetic.md`, markdown("synthetic-unreadable"))
  expect(yield* f.fs.realPath(directory)).toBe(directory)
  f.revokeDirectoryRead()
  yield* Effect.gen(function* () {
    expect(Exit.isFailure(yield* Effect.exit(f.observation.snapshot(f.sessionID)))).toBe(true)
    expect(f.enumerationErrors).toHaveLength(1)
    expect(f.enumerationErrors[0]).toHaveProperty("cause.code", "EACCES")
  }).pipe(Effect.ensuring(f.fs.chmod(directory, 0o700).pipe(Effect.orDie)))
}))

permissionCase("native standalone policy propagates an unreadable direct document", () => Effect.gen(function* () {
  const f = yield* fixture
  yield* f.fs.makeDirectory(`${f.config}/guardrails`)
  const file = `${f.config}/guardrails/synthetic.md`
  yield* f.fs.writeFileString(file, markdown("synthetic-unreadable"))
  yield* f.fs.chmod(file, 0o000)
  yield* Effect.gen(function* () {
    expect(Exit.isFailure(yield* Effect.exit(f.fs.readFileString(file)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(f.observation.snapshot(f.sessionID)))).toBe(true)
  }).pipe(Effect.ensuring(f.fs.chmod(file, 0o600).pipe(Effect.orDie)))
}))
