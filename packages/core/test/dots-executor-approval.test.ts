import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Agent } from "../src/agent"
import { LocationServiceMap } from "../src/location-service-map"
import type { Permission } from "../src/permission"
import { Session } from "../src/session"
import { SessionReview } from "../src/session/review"
import { reviewLayer } from "./fixture/review"
import { channel, dotsExecutorHostWith, temporaryDirectory, uri } from "./fixture/dots-executor"
import { testEffect } from "./lib/effect"

const it = testEffect(reviewLayer())
const promise = <A>(run: () => Promise<A>) => Effect.promise(run)
const allowAll: Permission.Rule = { action: "*", resource: "*", effect: "allow" }
const askShell: Permission.Rule = { action: "shell", resource: "*", effect: "ask" }
type Mode = "manual" | "auto" | "yolo"

const approval = (input: {
  readonly permissions?: Mode
  readonly guardrails?: Mode
  readonly sleep?: boolean
  readonly rules?: readonly Permission.Rule[]
  readonly maxPendingReviews?: number
}) => Effect.gen(function* () {
  const f = yield* dotsExecutorHostWith({ realAuthorization: true })
  const cwd = yield* temporaryDirectory()
  if (input.maxPendingReviews !== undefined)
    yield* promise(() => Bun.write(path.join(cwd, "ycoding.json"), JSON.stringify({ guardrails: { max_pending_reviews: input.maxPendingReviews } })))
  const scope = yield* promise(() => f.host.threadScope({ environmentID: "environment", threadID: "thread-a", cwd }))
  const sessionID = Session.ID.make(scope.sessionID)
  const located = f.locations.get((yield* f.sessions.get(sessionID)).location, [LocationServiceMap.full])
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  const agent = yield* agents.default()
  yield* agents.transform((draft) => draft.update(agent!.id, (item) => { item.permissions = [...(input.rules ?? [allowAll, askShell])] }))
  yield* f.sessions.autonomy.set({
    sessionID,
    ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
    ...(input.guardrails === undefined ? {} : { guardrails: input.guardrails }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
  })
  const reviews = yield* SessionReview.Service
  const opened = yield* promise(() => channel(f.host))
  yield* Effect.addFinalizer(() => promise(() => Promise.allSettled([opened.executor.close(), scope.close()])))
  const run = (processId: string, command: string) => promise(async () => {
    const started = Date.now()
    await opened.executor.startProcess({
      processId, argv: ["/bin/sh", "-lc", command], cwd: uri(cwd), env: {}, metadata: { threadId: "thread-a", toolCallId: `call-${processId}` },
    }, opened.ctx)
    const output = { stdout: "", stderr: "" }
    let afterSeq = 0
    for (let attempt = 0; attempt < 40; attempt++) {
      const read = await opened.executor.readProcess({ processId, afterSeq, waitMs: 250 }, opened.ctx)
      for (const chunk of read.chunks) output[chunk.stream === "stderr" ? "stderr" : "stdout"] += Buffer.from(chunk.chunk, "base64").toString("utf8")
      afterSeq = read.nextSeq - 1
      if (read.closed) {
        const item = /Review item (\S+) in Session (\S+): (permission|guardrail) /.exec(output.stderr)
        return { ...output, exitCode: read.exitCode, elapsed: Date.now() - started, itemID: item?.[1], sessionOf: item?.[2], kind: item?.[3] }
      }
    }
    throw new Error("process did not close")
  })
  const decide = (itemID: string | undefined, reply: "once" | "always" | "reject", kind: "permission" | "guardrail" = "permission") =>
    reviews.decide({ sessionID, itemID: SessionReview.ID.make(itemID!), decision: { kind, reply } })
  return { f, cwd, scope, sessionID, reviews, opened, run, decide }
})

it.live("manual mode refuses at once with a review item and the commands to decide it", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual" })
  const refused = yield* a.run("p1", "echo synthetic")
  expect(refused.exitCode).toBe(1)
  expect(refused.elapsed).toBeLessThan(5_000)
  expect(refused.stderr).toStartWith("YCoding did not run this: it needs the user's decision.\n")
  expect(refused).toMatchObject({ sessionOf: a.sessionID, kind: "permission" })
  expect(refused.stderr).toContain(`ycoding api session.review.decide --param sessionID=${a.sessionID} --param itemID=${refused.itemID}`)
  expect((yield* a.reviews.list(a.sessionID)).map((item): string => item.itemID)).toEqual([refused.itemID ?? "missing"])
}).pipe(Effect.scoped))

it.live("approve once lets one identical retry run with a new processId and refuses the next", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual" })
  const refused = yield* a.run("p1", "printf %s \"$YCODING_SESSION_ID\"")
  yield* a.decide(refused.itemID, "once")
  expect(yield* a.run("p2", "printf %s \"$YCODING_SESSION_ID\"")).toMatchObject({ exitCode: 0, stdout: a.sessionID, stderr: "" })
  const third = yield* a.run("p3", "printf %s \"$YCODING_SESSION_ID\"")
  expect(third.exitCode).toBe(1)
  expect(third.itemID).toBeDefined()
}).pipe(Effect.scoped))

it.live("approve always lets every later identical attempt run", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual" })
  const refused = yield* a.run("p1", "echo synthetic")
  yield* a.decide(refused.itemID, "always")
  expect(yield* a.run("p2", "echo synthetic")).toMatchObject({ exitCode: 0, stdout: "synthetic\n" })
  expect(yield* a.run("p3", "echo synthetic")).toMatchObject({ exitCode: 0, stdout: "synthetic\n" })
}).pipe(Effect.scoped))

it.live("a rejected item keeps the identical action refused", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual" })
  const refused = yield* a.run("p1", "echo synthetic")
  yield* a.decide(refused.itemID, "reject")
  expect(yield* a.run("p2", "echo synthetic")).toMatchObject({
    exitCode: 1, stdout: "", stderr: `YCoding did not run this: the user rejected review item ${refused.itemID}. Do not retry it.\n`,
  })
}).pipe(Effect.scoped))

it.live("a deny rule refuses without a review item", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual", rules: [allowAll, { action: "shell", resource: "*", effect: "deny" }] })
  const error = yield* promise(() => a.opened.executor.startProcess({
    processId: "p1", argv: ["/bin/sh", "-lc", "echo synthetic"], cwd: uri(a.cwd), env: {}, metadata: { threadId: "thread-a" },
  }, a.opened.ctx).then(() => undefined, (caught: unknown) => caught))
  expect(error).toMatchObject({ code: -32001 })
  expect(yield* a.reviews.list(a.sessionID)).toEqual([])
}).pipe(Effect.scoped))

it.live("auto mode runs an ask-rule command without an item", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "auto", guardrails: "auto" })
  expect(yield* a.run("p1", "echo synthetic")).toMatchObject({ exitCode: 0, stdout: "synthetic\n" })
  expect(yield* a.reviews.list(a.sessionID)).toEqual([])
}).pipe(Effect.scoped))

it.live("a hard guardrail review in auto mode gets an item that cannot be approved always", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "auto", guardrails: "auto", rules: [allowAll] })
  const refused = yield* a.run("p1", "git reset --hard HEAD")
  expect(refused).toMatchObject({ exitCode: 1, kind: "guardrail" })
  expect(refused.stderr).not.toContain("approve always")
}).pipe(Effect.scoped))

it.live("yolo mode refuses with an item when its evaluator escalates", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "yolo" })
  const refused = yield* a.run("p1", "echo synthetic")
  expect(refused.exitCode).toBe(1)
  expect(refused.itemID).toBeDefined()
}).pipe(Effect.scoped))

it.live("asleep behaves like manual", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual", sleep: true })
  const refused = yield* a.run("p1", "echo synthetic")
  expect(refused).toMatchObject({ exitCode: 1, kind: "permission" })
  expect(refused.itemID).toBeDefined()
}).pipe(Effect.scoped))

it.live("a full review box refuses without an item", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual", maxPendingReviews: 1 })
  expect((yield* a.run("p1", "echo one")).itemID).toBeDefined()
  expect(yield* a.run("p2", "echo two")).toMatchObject({
    exitCode: 1, stderr: "YCoding did not run this: the review box is full. Run ycoding decision list and decide or clear items first.\n",
  })
}).pipe(Effect.scoped))

it.live("concurrent identical attempts share one review item", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual" })
  const [first, second] = yield* Effect.all([a.run("p1", "echo synthetic"), a.run("p2", "echo synthetic")], { concurrency: 2 })
  expect(first?.itemID).toBeDefined()
  expect(second?.itemID).toBe(first?.itemID)
  expect(yield* a.reviews.list(a.sessionID)).toHaveLength(1)
}).pipe(Effect.scoped))

it.live("a command needing both permission and guardrail lists both items and runs after both are approved once", () => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual", guardrails: "manual" })
  const command = "git reset --hard HEAD"
  const refused = yield* a.run("p1", command)
  const items = [...refused.stderr.matchAll(/Review item (\S+) in Session \S+: (permission|guardrail) /g)].map((match) => ({ itemID: match[1]!, kind: match[2]! }))
  expect(items.map((item) => item.kind)).toEqual(["permission", "guardrail"])
  expect(refused.exitCode).toBe(1)
  yield* a.decide(items[0]!.itemID, "once")
  yield* a.decide(items[1]!.itemID, "once", "guardrail")
  const ran = yield* a.run("p2", command)
  expect(ran.stderr).not.toContain("YCoding did not run this")
  expect((yield* a.run("p3", command)).stderr).toContain("YCoding did not run this: it needs the user's decision.")
}).pipe(Effect.scoped))

const askOutside: Permission.Rule = { action: "external_directory", resource: "*", effect: "ask" }
const outsideCase = (rules: readonly Permission.Rule[] = [allowAll, askOutside]) => Effect.gen(function* () {
  const a = yield* approval({ permissions: "manual", rules })
  const outside = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const { mkdir, mkdtemp, realpath } = await import("node:fs/promises")
      const parent = path.join(import.meta.dir, "..", "tmp")
      await mkdir(parent, { recursive: true })
      return realpath(await mkdtemp(path.join(parent, "dots-executor-outside-")))
    }),
    (directory) => Effect.promise(async () => { const { rm } = await import("node:fs/promises"); await rm(directory, { recursive: true, force: true }) }),
  )
  yield* promise(() => Bun.write(path.join(outside, "present.txt"), "synthetic outside"))
  yield* a.run("bind", "true")
  const attempt = <A>(operation: () => Promise<A>) => promise(() => operation().then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error: error as { readonly code: number; readonly message: string } }),
  ))
  const read = (file = "present.txt") => attempt(() => a.opened.executor.readFile({ path: uri(path.join(outside, file)) }, a.opened.ctx))
  const write = (file: string) => attempt(() => a.opened.executor.writeFile({ path: uri(path.join(outside, file)), dataBase64: Buffer.from("written").toString("base64") }, a.opened.ctx))
  const itemOf = (error: { readonly message: string } | undefined) => /Review item (\S+) in Session \S+: permission external_directory (\S+)\./.exec(error?.message ?? "")
  return { ...a, outside, read, write, itemOf }
})

it.live("an outside-roots read or write is refused at once with an external_directory item", () => Effect.gen(function* () {
  const o = yield* outsideCase()
  const read = yield* o.read()
  expect(read.error?.code).toBe(-32600)
  expect(read.error?.message).toStartWith("Permission denied: YCoding did not run this: it needs the user's decision.\n")
  expect(o.itemOf(read.error)?.[2]).toBe(`${o.outside}/*`)
  const write = yield* o.write("new.txt")
  expect(write.error?.code).toBe(-32600)
  expect(o.itemOf(write.error)).not.toBeNull()
}).pipe(Effect.scoped))

it.live("approving an outside directory once lets one identical retry run and refuses the next", () => Effect.gen(function* () {
  const o = yield* outsideCase()
  const refused = yield* o.read()
  yield* o.decide(o.itemOf(refused.error)?.[1], "once")
  expect((yield* o.read()).result).toEqual({ dataBase64: Buffer.from("synthetic outside").toString("base64") })
  expect((yield* o.read()).error?.code).toBe(-32600)
  const writeRefused = yield* o.write("new.txt")
  yield* o.decide(o.itemOf(writeRefused.error)?.[1], "once")
  expect((yield* o.write("new.txt")).result).toEqual({})
  expect(yield* promise(() => Bun.file(path.join(o.outside, "new.txt")).text())).toBe("written")
}).pipe(Effect.scoped))

it.live("approving an outside directory always lets later calls under it run", () => Effect.gen(function* () {
  const o = yield* outsideCase()
  const refused = yield* o.read()
  yield* o.decide(o.itemOf(refused.error)?.[1], "always")
  expect((yield* o.read()).error).toBeUndefined()
  expect((yield* o.write("later.txt")).error).toBeUndefined()
  expect((yield* o.read("later.txt")).result).toEqual({ dataBase64: Buffer.from("written").toString("base64") })
}).pipe(Effect.scoped))

it.live("a rejected outside directory stays refused", () => Effect.gen(function* () {
  const o = yield* outsideCase()
  const refused = yield* o.read()
  const item = o.itemOf(refused.error)?.[1]
  yield* o.decide(item, "reject")
  expect((yield* o.read()).error).toEqual(expect.objectContaining({
    code: -32600, message: `Permission denied: YCoding did not run this: the user rejected review item ${item}. Do not retry it.`,
  }))
}).pipe(Effect.scoped))

it.live("a process/start whose cwd is outside the roots follows the same approval pattern", () => Effect.gen(function* () {
  const o = yield* outsideCase()
  const start = (processId: string) => promise(async () => {
    await o.opened.executor.startProcess({ processId, argv: ["/bin/sh", "-lc", "pwd"], cwd: uri(o.outside), env: {}, metadata: { threadId: "thread-a" } }, o.opened.ctx)
    for (let attempt = 0; attempt < 40; attempt++) {
      const read = await o.opened.executor.readProcess({ processId, waitMs: 250 }, o.opened.ctx)
      if (read.closed) return { exitCode: read.exitCode, output: read.chunks.map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8")).join("") }
    }
    throw new Error("process did not close")
  })
  const refused = yield* start("outside-1")
  expect(refused.exitCode).toBe(1)
  const item = /Review item (\S+) in Session \S+: permission external_directory /.exec(refused.output)?.[1]
  expect(item).toBeDefined()
  yield* o.decide(item, "once")
  expect(yield* start("outside-2")).toEqual({ exitCode: 0, output: `${o.outside}\n` })
  expect((yield* start("outside-3")).exitCode).toBe(1)
}).pipe(Effect.scoped))

it.live("a deny rule on the outside directory is a plain denial with no item", () => Effect.gen(function* () {
  const o = yield* outsideCase([allowAll, askOutside])
  const located = o.f.locations.get((yield* o.f.sessions.get(o.sessionID)).location, [LocationServiceMap.full])
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  const agent = yield* agents.default()
  yield* agents.transform((draft) => draft.update(agent!.id, (item) => {
    item.permissions = [allowAll, askOutside, { action: "external_directory", resource: `${o.outside}/*`, effect: "deny" }]
  }))
  expect((yield* o.read()).error).toEqual(expect.objectContaining({ code: -32001, message: "Permission denied" }))
  expect(yield* o.reviews.list(o.sessionID)).toEqual([])
}).pipe(Effect.scoped))

it.live("a symlink inside the roots that points outside asks for the real target directory", () => Effect.gen(function* () {
  const o = yield* outsideCase()
  const { symlink } = yield* promise(() => import("node:fs/promises"))
  yield* promise(() => symlink(o.outside, path.join(o.cwd, "linked")))
  const refused = yield* promise(() => o.opened.executor.readFile({ path: uri(path.join(o.cwd, "linked", "present.txt")) }, o.opened.ctx).then(() => undefined, (error: unknown) => error as { readonly message: string }))
  expect(o.itemOf(refused)?.[2]).toBe(`${o.outside}/*`)
}).pipe(Effect.scoped))
