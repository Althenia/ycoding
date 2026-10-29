import { expect } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { reviewLayer } from "./fixture/review"
import { channel, dotsExecutorHost, temporaryDirectory, uri, type DotsExecutorFixture } from "./fixture/dots-executor"
import { testEffect } from "./lib/effect"

const it = testEffect(reviewLayer())
const promise = <A>(run: () => Promise<A>) => Effect.promise(run)
const metadata = { threadId: "thread-a", toolCallId: "call-1" }
const threadScope = (f: DotsExecutorFixture) => promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a" }))
const synthetic = (f: DotsExecutorFixture, sessionID: string) => f.log(sessionID).pipe(Effect.map((events) => events
  .filter((event) => event.type === SessionEvent.Synthetic.type)
  .map((event) => event.data as SessionEvent.Synthetic["data"])))
const dots = (record: SessionEvent.Synthetic["data"]) => (record.metadata as { readonly dots: Record<string, unknown> }).dots

const drain = async (executor: Awaited<ReturnType<typeof channel>>["executor"], ctx: Awaited<ReturnType<typeof channel>>["ctx"], processId: string) => {
  const chunks: Awaited<ReturnType<typeof executor.readProcess>>["chunks"][number][] = []
  let afterSeq = 0
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await executor.readProcess({ processId, afterSeq, waitMs: 250 }, ctx)
    chunks.push(...result.chunks)
    afterSeq = result.nextSeq - 1
    if (result.closed) return { ...result, chunks }
  }
  throw new Error("process did not close")
}

it.live("a spawned process is recorded as Shell Started and Ended with its exit status and renders as a Shell message", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const opened = yield* promise(() => channel(f.host))
  const script = "process.stdout.write('synthetic output'); process.exit(3)"
  yield* promise(() => opened.executor.startProcess({ processId: "p1", argv: [process.execPath, "-e", script], cwd: uri(cwd), env: {}, metadata }, opened.ctx))
  yield* promise(() => drain(opened.executor, opened.ctx, "p1"))
  const scope = yield* threadScope(f)
  yield* promise(() => scope.transcript.flush())
  const shells = (yield* f.messages(scope.sessionID)).filter((message): message is SessionMessage.Shell => message.type === "shell")
  expect(shells).toHaveLength(1)
  expect(shells[0]).toMatchObject({ command: `${process.execPath} -e ${script}`, status: "exited", exit: 3, output: { output: "synthetic output", truncated: false } })
  const ended = (yield* f.log(scope.sessionID)).find((event) => event.type === SessionEvent.Shell.Ended.type)
  const shell = (ended!.data as SessionEvent.Shell.Ended["data"]).shell
  expect(shell.metadata).toEqual({ dots: { threadId: "thread-a", toolCallId: "call-1", processId: "p1", cwd, sandboxDenied: false } })
  expect(path.isAbsolute(shell.file)).toBe(true)
  expect(shell.file.startsWith(path.join(f.data, "shell") + path.sep)).toBe(true)
  expect(yield* promise(() => readFile(shell.file, "utf8"))).toBe("synthetic output")
  yield* promise(() => Promise.all([scope.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("an answered process emits the completed-process notifications and is recorded as a Shell message", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const seen: unknown[] = []
  const opened = yield* promise(() => channel(f.host, {
    answerProcess: async (params, context) => {
      seen.push({ processId: params.processId, attribution: context.attribution, sessionId: context.sessionId })
      return { stdout: "answered out", stderr: "answered err", exitCode: 7 }
    },
  }))
  expect(yield* promise(() => opened.executor.startProcess({ processId: "p1", argv: ["/bin/sh", "-lc", "synthetic answer"], cwd: uri(cwd), env: {}, metadata }, opened.ctx)))
    .toEqual({ processId: "p1", sandboxType: "none" })
  expect(seen).toEqual([{ processId: "p1", attribution: metadata, sessionId: opened.ctx.sessionId }])
  const read = yield* promise(() => drain(opened.executor, opened.ctx, "p1"))
  expect(read).toMatchObject({ exited: true, exitCode: 7, closed: true, sandboxDenied: false })
  expect(read.chunks.map((chunk) => [chunk.stream, Buffer.from(chunk.chunk, "base64").toString("utf8")]))
    .toEqual([["stdout", "answered out"], ["stderr", "answered err"]])
  expect(yield* promise(() => opened.executor.writeProcess({ processId: "p1", chunk: "", writeId: "w1" }, opened.ctx))).toEqual({ status: "stdinClosed" })
  expect(yield* promise(() => opened.executor.terminateProcess({ processId: "p1" }, opened.ctx))).toEqual({ running: false })
  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(opened.notifications.map((item) => [item.method, (item.params as { seq: number }).seq])).toEqual([
    ["process/output", 1], ["process/output", 2], ["process/exited", 3], ["process/closed", 4],
  ])
  expect(opened.notifications[2]?.params).toEqual({ processId: "p1", seq: 3, exitCode: 7, sandboxDenied: false })
  const scope = yield* threadScope(f)
  yield* promise(() => scope.transcript.flush())
  expect((yield* f.messages(scope.sessionID)).filter((message) => message.type === "shell")).toMatchObject([
    { type: "shell", command: "synthetic answer", status: "exited", exit: 7, output: { output: "answered outanswered err" } },
  ])
  yield* promise(() => Promise.all([scope.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("recorded process output is capped at 1 MiB", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const opened = yield* promise(() => channel(f.host, { answerProcess: async () => ({ stdout: "y".repeat(1536 * 1024), stderr: "", exitCode: 0 }) }))
  yield* promise(() => opened.executor.startProcess({ processId: "p1", argv: ["/bin/sh", "-lc", "large"], cwd: uri(cwd), env: {}, metadata }, opened.ctx))
  const scope = yield* threadScope(f)
  yield* promise(() => scope.transcript.flush())
  const shell = (yield* f.messages(scope.sessionID)).find((message): message is SessionMessage.Shell => message.type === "shell")
  expect(shell?.output).toMatchObject({ size: 1024 * 1024, cursor: 1024 * 1024, truncated: true })
  expect(shell?.output?.output.length).toBe(1024 * 1024)
  const ended = (yield* f.log(scope.sessionID)).find((event) => event.type === SessionEvent.Shell.Ended.type)
  expect((yield* promise(() => stat((ended!.data as SessionEvent.Shell.Ended["data"]).shell.file))).size).toBe(1024 * 1024)
  yield* promise(() => Promise.all([scope.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("records never contain env values, envPolicy values, header values or query strings", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const server = Bun.serve({ port: 0, fetch: () => new Response("synthetic body") })
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
  const opened = yield* promise(() => channel(f.host, { answerProcess: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }))
  yield* promise(() => opened.executor.startProcess({
    processId: "p1", argv: ["/bin/sh", "-lc", "true"], cwd: uri(cwd), env: { SYNTHETIC_TOKEN: "synthetic-env-value" }, metadata,
    envPolicy: { inherit: "none", ignoreDefaultExcludes: true, exclude: [], set: { SYNTHETIC_POLICY: "synthetic-policy-value" }, includeOnly: [] },
  }, opened.ctx))
  const connection = opened.executor.openConnection()
  const outcome = yield* promise(() => connection.http.request({
    method: "GET", url: `http://127.0.0.1:${server.port}/synthetic/path?token=synthetic-query-value`,
    headers: [{ name: "x-synthetic", value: "synthetic-header-value" }], redirectPolicy: "follow", requestId: "r1", streamResponse: false,
  }, { signal: new AbortController().signal, emit: () => {}, sessionId: opened.ctx.sessionId }))
  expect(outcome.response.status).toBe(200)
  const scope = yield* threadScope(f)
  yield* promise(() => scope.transcript.flush())
  const http = (yield* synthetic(f, scope.sessionID)).map(dots).find((item) => item.operation === "http")
  expect(http).toEqual({ operation: "http", method: "GET", origin: `http://127.0.0.1:${server.port}`, path: "/synthetic/path", status: 200, bytes: 14 })
  const serialized = JSON.stringify(yield* f.log(scope.sessionID))
  for (const secret of ["synthetic-env-value", "synthetic-policy-value", "synthetic-header-value", "synthetic-query-value", "token="])
    expect(serialized).not.toContain(secret)
  yield* promise(() => Promise.all([connection.close(), scope.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("a write inside the Session directory records a FileChange and a content-free Synthetic summary", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  yield* promise(() => writeFile(path.join(cwd, "a.txt"), "synthetic before\n"))
  const opened = yield* promise(() => channel(f.host, { answerProcess: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }))
  yield* promise(() => opened.executor.startProcess({ processId: "p1", argv: ["/bin/sh", "-lc", "true"], cwd: uri(cwd), env: {}, metadata }, opened.ctx))
  yield* promise(() => opened.executor.writeFile({ path: uri(path.join(cwd, "a.txt")), dataBase64: Buffer.from("synthetic after\n").toString("base64") }, opened.ctx))
  yield* promise(() => opened.executor.writeFile({ path: uri(path.join(f.home, "outside.txt")), dataBase64: Buffer.from("synthetic outside\n").toString("base64") }, opened.ctx))
  const scope = yield* threadScope(f)
  yield* promise(() => scope.transcript.flush())
  const changes = (yield* f.log(scope.sessionID)).filter((event) => event.type === SessionEvent.FileChange.Recorded.type)
  expect(changes.map((event) => (event.data as SessionEvent.FileChange.Recorded["data"]).change)).toMatchObject([{ path: "a.txt", additions: 1, deletions: 1 }])
  const writes = (yield* synthetic(f, scope.sessionID)).filter((message) => dots(message).operation === "write")
  expect(writes.map(dots)).toEqual([
    { operation: "write", path: path.join(cwd, "a.txt"), bytes: 16 },
    { operation: "write", path: path.join(f.home, "outside.txt"), bytes: 18 },
  ])
  for (const record of writes) expect(`${record.text} ${record.description ?? ""}`).not.toContain("synthetic after")
  yield* promise(() => Promise.all([scope.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("a denial is recorded with its decision trace", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const opened = yield* promise(() => channel(f.host, { answerProcess: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }))
  yield* promise(() => opened.executor.startProcess({ processId: "p1", argv: ["/bin/sh", "-lc", "true"], cwd: uri(cwd), env: {}, metadata }, opened.ctx))
  f.deny(true)
  const error = yield* promise(() => opened.executor.readFile({ path: uri(path.join(cwd, "missing.txt")) }, opened.ctx).then(() => undefined, (caught: unknown) => caught))
  expect(error).toMatchObject({ code: -32004 })
  yield* promise(() => writeFile(path.join(cwd, "present.txt"), "synthetic"))
  const denied = yield* promise(() => opened.executor.readFile({ path: uri(path.join(cwd, "present.txt")) }, opened.ctx).then(() => undefined, (caught: unknown) => caught))
  expect(denied).toMatchObject({ code: -32001 })
  const scope = yield* threadScope(f)
  yield* promise(() => scope.transcript.flush())
  expect((yield* synthetic(f, scope.sessionID)).map(dots).filter((item) => item.operation === "denied")).toEqual([
    { operation: "denied", action: "read", subject: path.join(cwd, "present.txt"), trace: [{ kind: "permission", reply: "reject", by: "rule" }] },
  ])
  yield* promise(() => Promise.all([scope.close(), opened.executor.close()]))
}).pipe(Effect.scoped))

it.live("records from two channels on one thread keep their order", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  const first = yield* promise(() => channel(f.host, { answerProcess: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }))
  const second = yield* promise(() => channel(f.host, { answerProcess: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }))
  yield* promise(() => first.executor.startProcess({ processId: "p1", argv: ["/bin/sh", "-lc", "true"], cwd: uri(cwd), env: {}, metadata }, first.ctx))
  yield* promise(() => second.executor.startProcess({ processId: "p2", argv: ["/bin/sh", "-lc", "true"], cwd: uri(cwd), env: {}, metadata }, second.ctx))
  const order = ["one", "two", "three", "four"]
  for (const [index, name] of order.entries()) {
    const target = index % 2 === 0 ? first : second
    yield* promise(() => target.executor.writeFile({ path: uri(path.join(cwd, `${name}.txt`)), dataBase64: Buffer.from(name).toString("base64") }, target.ctx))
  }
  const scope = yield* threadScope(f)
  yield* promise(() => scope.transcript.flush())
  expect((yield* synthetic(f, scope.sessionID)).map(dots).filter((item) => item.operation === "write").map((item) => path.basename(String(item.path), ".txt")))
    .toEqual(order)
  expect(existsSync(path.join(cwd, "four.txt"))).toBe(true)
  yield* promise(() => Promise.all([scope.close(), first.executor.close(), second.executor.close()]))
}).pipe(Effect.scoped))

it.live("a read through the unattributed scope publishes no Synthetic record while a thread read still does", () => Effect.gen(function* () {
  const f = yield* dotsExecutorHost
  const cwd = yield* temporaryDirectory()
  yield* promise(() => writeFile(path.join(f.home, "skill.md"), "synthetic skill"))
  yield* promise(() => writeFile(path.join(f.home, "denied.md"), "synthetic denied"))
  const opened = yield* promise(() => channel(f.host, { answerProcess: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }))
  expect(yield* promise(() => opened.executor.readFile({ path: uri(path.join(f.home, "skill.md")) }, opened.ctx)))
    .toEqual({ dataBase64: Buffer.from("synthetic skill").toString("base64") })
  yield* promise(() => opened.executor.writeFile({ path: uri(path.join(f.home, "unattributed.txt")), dataBase64: Buffer.from("w").toString("base64") }, opened.ctx))
  f.deny(true)
  const denied = yield* promise(() => opened.executor.readFile({ path: uri(path.join(f.home, "denied.md")) }, opened.ctx).then(() => undefined, (caught: unknown) => caught))
  expect(denied).toMatchObject({ code: -32001 })
  f.deny(false)
  yield* promise(() => opened.executor.startProcess({ processId: "p1", argv: ["/bin/sh", "-lc", "true"], cwd: uri(cwd), env: {}, metadata }, opened.ctx))
  yield* promise(() => opened.executor.readFile({ path: uri(path.join(f.home, "skill.md")) }, opened.ctx))
  const unattributed = yield* promise(() => f.host.unattributedScope({ environmentID: "environment" }))
  const thread = yield* threadScope(f)
  yield* promise(() => Promise.all([unattributed.transcript.flush(), thread.transcript.flush()]))
  expect((yield* synthetic(f, unattributed.sessionID)).map(dots).map((item) => item.operation)).toEqual(["write", "denied"])
  expect((yield* synthetic(f, thread.sessionID)).map(dots)).toEqual([{ operation: "read", path: path.join(f.home, "skill.md"), bytes: 15 }])
  yield* promise(() => Promise.all([unattributed.close(), thread.close(), opened.executor.close()]))
}).pipe(Effect.scoped))
