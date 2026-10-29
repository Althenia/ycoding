import { expect } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { NativeDots } from "../src/dots/native"
import { Session } from "../src/session"
import { AbsolutePath } from "../src/schema"
import { reviewLayer } from "./fixture/review"
import { channel, dotsExecutorHost, temporaryDirectory, uri, type DotsExecutorFixture } from "./fixture/dots-executor"
import { testEffect } from "./lib/effect"

const it = testEffect(reviewLayer())
const answered = async () => ({ stdout: "answered\n", stderr: "", exitCode: 0 })
const start = (threadId: string | undefined, cwd: string, processId: string, command = "echo synthetic") => ({
  processId, argv: ["/bin/sh", "-lc", command], cwd: uri(cwd), env: {},
  ...(threadId === undefined ? {} : { metadata: { threadId, toolCallId: `call-${processId}` } }),
})
const sessionIDs = (f: DotsExecutorFixture) => f.sessions.list({}).pipe(Effect.map((result) => result.data.map((session) => session.id)))
const promise = <A>(run: () => Promise<A>) => Effect.promise(run)

it.live("one Session serves a thread across two channels", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const first = yield* promise(() => channel(f.host, { answerProcess: answered }))
  const second = yield* promise(() => channel(f.host, { answerProcess: answered }))
  yield* promise(() => first.executor.startProcess(start("thread-a", cwd, "p1"), first.ctx))
  yield* promise(() => second.executor.startProcess(start("thread-a", cwd, "p2"), second.ctx))
  const scope = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a" }))
  yield* promise(() => scope.transcript.flush())
  expect(yield* sessionIDs(f)).toEqual([Session.ID.make(scope.sessionID)])
  expect((yield* f.messages(scope.sessionID)).filter((message) => message.type === "shell")).toHaveLength(2)
  expect(yield* f.kv.get("dots.cca.thread.environment.thread-a")).toEqual({ sessionID: scope.sessionID })
  yield* promise(() => Promise.all([scope.close(), first.executor.close(), second.executor.close()]))
}).pipe(Effect.scoped))

it.live("concurrent first calls on one thread create exactly one Session", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const scopes = yield* promise(() => Promise.all(Array.from({ length: 5 }, () => f.host.threadScope({ environmentID: "environment", threadID: "thread-a", cwd }))))
  expect(new Set(scopes.map((scope) => scope.sessionID)).size).toBe(1)
  expect(yield* sessionIDs(f)).toHaveLength(1)
  expect(scopes[0]?.directory).toBe(cwd)
  yield* promise(() => Promise.all(scopes.map((scope) => scope.close())))
}).pipe(Effect.scoped))

it.live("the thread Session survives a restart with the same database", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const before = yield* Effect.gen(function* () {
    const host = yield* f.restart()
    const scope = yield* promise(() => host.threadScope({ environmentID: "environment", threadID: "thread-a", cwd }))
    yield* promise(() => scope.close())
    return scope.sessionID
  }).pipe(Effect.scoped)
  const host = yield* f.restart()
  const after = yield* promise(() => host.threadScope({ environmentID: "environment", threadID: "thread-a" }))
  expect(after.sessionID).toBe(before)
  expect(after.directory).toBe(cwd)
  yield* promise(() => after.close())
}).pipe(Effect.scoped))

it.live("an archived thread Session is replaced and the mapping overwritten", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const first = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a", cwd }))
  yield* promise(() => first.close())
  yield* f.sessions.archive(Session.ID.make(first.sessionID))
  const second = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a", cwd }))
  expect(second.sessionID).not.toBe(first.sessionID)
  expect(yield* f.kv.get("dots.cca.thread.environment.thread-a")).toEqual({ sessionID: second.sessionID })
  yield* promise(() => second.close())
}).pipe(Effect.scoped))

it.live("fs calls before any threadId go to the unattributed Session", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  yield* promise(() => writeFile(path.join(f.home, "early.txt"), "early"))
  const opened = yield* promise(() => channel(f.host, { answerProcess: answered }))
  yield* promise(() => opened.executor.readFile({ path: uri(path.join(f.home, "early.txt")) }, opened.ctx))
  yield* promise(() => opened.executor.startProcess(start("thread-a", cwd, "p1"), opened.ctx))
  yield* promise(() => opened.executor.readFile({ path: uri(path.join(f.home, "early.txt")) }, opened.ctx))
  const unattributed = yield* promise(() => f.host.unattributedScope({ environmentID: "environment" }))
  const thread = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a" }))
  yield* promise(() => Promise.all([unattributed.transcript.flush(), thread.transcript.flush()]))
  expect(unattributed.directory).toBe(f.home)
  expect(unattributed.roots).toEqual([f.home])
  expect(yield* f.kv.get("dots.cca.unattributed.environment")).toEqual({ sessionID: unattributed.sessionID })
  expect((yield* f.messages(unattributed.sessionID)).filter((message) => message.type === "synthetic")).toHaveLength(0)
  expect((yield* f.messages(thread.sessionID)).filter((message) => message.type === "synthetic")).toHaveLength(1)
  yield* promise(() => Promise.all([unattributed.close(), thread.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("an exec-server session that has seen two threads sends unattributed fs calls to the unattributed Session", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  yield* promise(() => writeFile(path.join(f.home, "shared.txt"), "shared"))
  const opened = yield* promise(() => channel(f.host, { answerProcess: answered }))
  yield* promise(() => opened.executor.startProcess(start("thread-a", cwd, "p1"), opened.ctx))
  yield* promise(() => opened.executor.startProcess(start("thread-b", cwd, "p2"), opened.ctx))
  yield* promise(() => opened.executor.readFile({ path: uri(path.join(f.home, "shared.txt")) }, opened.ctx))
  const unattributed = yield* promise(() => f.host.unattributedScope({ environmentID: "environment" }))
  const a = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a" }))
  const b = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-b" }))
  yield* promise(() => Promise.all([unattributed, a, b].map((scope) => scope.transcript.flush())))
  expect(a.sessionID).not.toBe(b.sessionID)
  expect((yield* f.messages(unattributed.sessionID)).map((message) => message.type)).toEqual([])
  expect((yield* f.messages(a.sessionID)).map((message) => message.type)).toEqual(["shell"])
  expect((yield* f.messages(b.sessionID)).map((message) => message.type)).toEqual(["shell"])
  yield* promise(() => Promise.all([unattributed.close(), a.close(), b.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("the title gains the first command once and a user rename is kept", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const opened = yield* promise(() => channel(f.host, { answerProcess: answered }))
  const long = `printf '%s' ${"x".repeat(80)}`
  yield* promise(() => opened.executor.startProcess(start("thread-a", cwd, "p1", long), opened.ctx))
  yield* promise(() => opened.executor.startProcess(start("thread-a", cwd, "p2", "echo second"), opened.ctx))
  const scope = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a" }))
  yield* promise(() => scope.transcript.flush())
  const name = path.basename(cwd)
  expect((yield* f.sessions.get(Session.ID.make(scope.sessionID))).title).toBe(`Dots · ${name} · ${long.slice(0, 60)}`)
  yield* promise(() => opened.executor.startProcess(start("thread-b", cwd, "p3"), opened.ctx))
  const renamed = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-b" }))
  yield* promise(() => renamed.transcript.flush())
  expect((yield* f.sessions.get(Session.ID.make(renamed.sessionID))).title).toBe(`Dots · ${name} · echo synthetic`)
  const user = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-c", cwd }))
  expect((yield* f.sessions.get(Session.ID.make(user.sessionID))).title).toBe(`Dots · ${name}`)
  yield* f.sessions.rename({ sessionID: Session.ID.make(user.sessionID), title: "Chosen by user" })
  yield* promise(() => opened.executor.startProcess(start("thread-c", cwd, "p4"), opened.ctx))
  yield* promise(() => user.transcript.flush())
  expect((yield* f.sessions.get(Session.ID.make(user.sessionID))).title).toBe("Chosen by user")
  yield* promise(() => Promise.all([scope.close(), renamed.close(), user.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("assignProject moves a thread Session only while it has no messages", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const worktree = yield* temporaryDirectory()
  f.catalog.push({ id: "prj_synthetic", worktree, name: "Synthetic project", updated: 1 })
  const empty = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a", cwd }))
  expect(yield* promise(() => f.host.assignProject({ environmentID: "environment", threadID: "thread-a", projectID: "prj_synthetic" })))
    .toEqual({ environmentId: "environment", projectId: "prj_synthetic", threadId: "thread-a" })
  const moved = yield* f.sessions.get(Session.ID.make(empty.sessionID))
  expect(moved.location.directory).toBe(AbsolutePath.make(worktree))
  expect(moved.title).toBe("Dots · Synthetic project")
  expect(empty.directory).toBe(worktree)
  const opened = yield* promise(() => channel(f.host, { answerProcess: answered }))
  yield* promise(() => opened.executor.startProcess(start("thread-b", cwd, "p1"), opened.ctx))
  const busy = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-b" }))
  yield* promise(() => busy.transcript.flush())
  yield* promise(() => f.host.assignProject({ environmentID: "environment", threadID: "thread-b", projectID: "prj_synthetic" }))
  expect((yield* f.sessions.get(Session.ID.make(busy.sessionID))).location.directory).toBe(AbsolutePath.make(cwd))
  const fresh = yield* promise(() => f.host.assignProject({ environmentID: "environment", threadID: "thread-c", projectID: "prj_synthetic" }).then(() =>
    f.host.threadScope({ environmentID: "environment", threadID: "thread-c", cwd })))
  expect(fresh.directory).toBe(worktree)
  yield* promise(() => Promise.all([empty.close(), busy.close(), fresh.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("project catalog lists, prepares and assigns with typed errors for unknown ids", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const older = yield* temporaryDirectory()
  const newer = yield* temporaryDirectory()
  const repository = yield* temporaryDirectory()
  yield* promise(() => mkdir(path.join(repository, ".git")))
  yield* promise(() => mkdir(path.join(repository, "nested")))
  yield* promise(() => mkdir(path.join(newer, "inside")))
  f.catalog.push(
    { id: "global", worktree: "/", updated: 9 },
    { id: "prj_older", worktree: older, updated: 1 },
    { id: "prj_newer", worktree: newer, name: "Newer", updated: 2 },
    { id: "prj_missing", worktree: path.join(older, "missing"), updated: 3 },
  )
  expect(yield* promise(() => f.host.projectCatalog({ environmentID: "environment" }))).toEqual({
    environmentId: "environment",
    projects: [
      { projectId: "prj_newer", name: "Newer", rootPaths: [newer] },
      { projectId: "prj_older", name: path.basename(older), rootPaths: [older] },
    ],
  })
  expect(yield* promise(() => f.host.prepareWorkspace({ environmentID: "environment", cwd: path.join(newer, "inside"), projectID: "prj_newer" })))
    .toEqual({ cwd: path.join(newer, "inside"), runtimeWorkspaceRoots: [newer], projectId: "prj_newer" })
  expect(yield* promise(() => f.host.prepareWorkspace({ environmentID: "environment", cwd: older, projectID: "prj_newer" })))
    .toEqual({ cwd: newer, runtimeWorkspaceRoots: [newer], projectId: "prj_newer" })
  expect(yield* promise(() => f.host.prepareWorkspace({ environmentID: "environment", cwd: null, projectID: "prj_newer" })))
    .toEqual({ cwd: newer, runtimeWorkspaceRoots: [newer], projectId: "prj_newer" })
  expect(yield* promise(() => f.host.prepareWorkspace({ environmentID: "environment", cwd: path.join(repository, "nested") })))
    .toEqual({ cwd: path.join(repository, "nested"), runtimeWorkspaceRoots: [repository] })
  expect(yield* promise(() => f.host.prepareWorkspace({ environmentID: "environment", cwd: older })))
    .toEqual({ cwd: older, runtimeWorkspaceRoots: [older] })
  expect(yield* promise(() => f.host.prepareWorkspace({ environmentID: "environment", cwd: null })))
    .toEqual({ cwd: f.home, runtimeWorkspaceRoots: [f.home] })
  const prepared = yield* promise(() => f.host.prepareWorkspace({ environmentID: "environment", threadID: "thread-a", cwd: path.join(repository, "nested") })
    .then(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a" })))
  expect(prepared.directory).toBe(repository)
  for (const operation of [
    () => f.host.prepareWorkspace({ environmentID: "environment", cwd: null, projectID: "prj_unknown" }),
    () => f.host.prepareWorkspace({ environmentID: "environment", cwd: null, projectID: "prj_missing" }),
    () => f.host.prepareWorkspace({ environmentID: "environment", cwd: null, projectID: "global" }),
    () => f.host.assignProject({ environmentID: "environment", threadID: "thread-a", projectID: "prj_unknown" }),
  ]) {
    const error = yield* promise(() => operation().then(() => undefined, (caught: unknown) => caught))
    expect(error).toBeInstanceOf(NativeDots.Error)
    expect((error as NativeDots.Error).code).toBe("not_found")
  }
  const relative = yield* promise(() => f.host.prepareWorkspace({ environmentID: "environment", cwd: "relative/path" }).then(() => undefined, (caught: unknown) => caught))
  expect((relative as NativeDots.Error).code).toBe("invalid_input")
  yield* promise(() => prepared.close())
}).pipe(Effect.scoped))
