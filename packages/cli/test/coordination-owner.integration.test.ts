import { afterEach, expect, test } from "bun:test"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Logger, Scope } from "effect"
import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { auth, availablePort, createSession, password, providerConfig, startProviderStandIn, startServer } from "./remote-harness"

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const json = { "content-type": "application/json" }
const home = `${process.env.YCODING_TEST_XDG_ROOT}/home`
const MASTER = "MASTER-SCRIPT"
const OWNER = "OWNER-TASK"
const UNRELATED = "UNRELATED-ROOT"

type Body = { readonly messages?: ReadonlyArray<Message>; readonly tools?: ReadonlyArray<unknown> }
type Message = {
  readonly role?: string
  readonly content?: unknown
  readonly tool_call_id?: string
  readonly tool_calls?: ReadonlyArray<{ readonly id: string; readonly function: { readonly name: string; readonly arguments: string } }>
}
type Notice = { readonly id: string; readonly event: string; readonly memberSessionID: string; readonly requestID?: string; readonly [key: string]: unknown }
type Server = { readonly base: string; readonly logs: string[]; request(path: string, options?: RequestInit): Promise<Response>; close(): Promise<void> }

const textOf = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.flatMap((part: { text?: unknown }) => (typeof part.text === "string" ? [part.text] : [])).join("")
      : ""
const messagesOf = (request: unknown): ReadonlyArray<Message> => (request as Body).messages ?? []
const firstUser = (request: unknown) => textOf(messagesOf(request).find((message) => message.role === "user") ?? {})
const calledIDs = (request: unknown) => new Set(messagesOf(request).flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []))
const toolOutput = (request: unknown, callID: string) => {
  const message = messagesOf(request).find((item) => item.role === "tool" && item.tool_call_id === callID)
  return message === undefined ? undefined : textOf(message)
}
const noticesIn = (request: unknown) =>
  messagesOf(request).flatMap((message) =>
    [...textOf(message).matchAll(/Project notification:\n(\{.*\})/g)].map((match) => JSON.parse(match[1]!) as Notice),
  )
const say = (content: string) => [deltaChunk({ role: "assistant", content }), finishChunk("stop")]
const call = (id: string, tool: string, args: unknown) => [toolCallChunk(id, tool, JSON.stringify(args)), finishChunk("tool_calls")]

function gate<T = undefined>() {
  let open = (_value: T) => {}
  let opened = false
  const promise = new Promise<T>((resolve) => {
    open = (value) => {
      opened = true
      resolve(value)
    }
  })
  return { promise, open: (value: T) => open(value), get opened() { return opened } }
}

function command(id: string, tool: string, args: unknown) {
  return `${MASTER} CMD ${id} ${tool} ${JSON.stringify(args)}`
}

/** The Master issues every scripted command once, in order, and acknowledges everything else. */
function masterReply(request: unknown) {
  const called = calledIDs(request)
  const commands = messagesOf(request)
    .filter((message) => message.role === "user")
    .flatMap((message) => [...textOf(message).matchAll(/MASTER-SCRIPT CMD (\S+) (\S+) (\{.*\})/g)])
  const next = commands.find((match) => !called.has(`call_${match[1]}`))
  if (next !== undefined) return call(`call_${next[1]}`, next[2]!, JSON.parse(next[3]!))
  return say("Master acknowledged.")
}

/** The owner inspects each question notice, attempts to answer it, then escalates it. */
function ownerReply(request: unknown) {
  const called = calledIDs(request)
  for (const notice of noticesIn(request)) {
    if (notice.event !== "question" || notice.requestID === undefined) continue
    const requestID = notice.requestID
    const target = { sessionID: notice.memberSessionID, requestID }
    if (!called.has(`call_inspect_${requestID}`)) return call(`call_inspect_${requestID}`, "project", { action: "inspect", ...target })
    const inspected = toolOutput(request, `call_inspect_${requestID}`)
    if (inspected === undefined) return say("Waiting for inspection.")
    const detail = (JSON.parse(inspected) as { request: { fingerprint: string; fields: Array<{ key: string }> } }).request
    if (!called.has(`call_answer_${requestID}`))
      return call(`call_answer_${requestID}`, "project", {
        action: "answer", ...target, kind: "question", fingerprint: detail.fingerprint,
        rationale: "Synthetic owner attempt to answer a human-only question.", answer: { [detail.fields[0]!.key]: "Synthetic answer" },
      })
    if (!called.has(`call_escalate_${requestID}`))
      return call(`call_escalate_${requestID}`, "project", {
        action: "escalate", ...target, kind: "question", fingerprint: detail.fingerprint, reason: "Human-only question; the Master must route it.",
      })
  }
  return say("Owner acknowledged.")
}

function memberReply(request: unknown, marker: string) {
  if (marker.includes("MEMBER-QUESTION")) {
    if (!calledIDs(request).has("call_member_question"))
      return call("call_member_question", "question", { questions: [{ header: "Evidence", question: "Which synthetic input should the member use?", options: [] }] })
    return say("Member question answered.")
  }
  return say(`Member finished: ${marker.slice(0, 40)}`)
}

const isOwner = (marker: string) => !marker.startsWith(MASTER) && marker.includes(OWNER)

type Script = {
  /** Optional per-request override; return undefined to fall through to the default scripts. */
  readonly before?: (request: unknown, marker: string) => readonly object[] | Promise<readonly object[]> | undefined
}

function reply(script: Script = {}) {
  return (request: unknown) => {
    if (((request as Body).tools ?? []).length === 0) return say("Synthetic title")
    const marker = firstUser(request)
    const override = script.before?.(request, marker)
    if (override !== undefined) return override
    if (marker.startsWith(MASTER)) return masterReply(request)
    if (isOwner(marker)) return ownerReply(request)
    if (marker.startsWith("MEMBER-")) return memberReply(request, marker)
    return say("Unrelated root finished.")
  }
}

async function gitRepository() {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "ycoding-project-owner-")))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: directory, env })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  git("init", "-q", "-b", "main")
  await Bun.write(join(directory, "README.md"), "synthetic\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "initial")
  return { directory, git }
}

function config(standIn: { readonly url: string }) {
  return {
    ...JSON.parse(providerConfig(standIn)),
    permissions: [
      { action: "worktree", resource: "*", effect: "allow" },
      { action: "project", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "subagent_control", resource: "*", effect: "allow" },
    ],
    agents: { owner: { description: "Synthetic Project owner", mode: "subagent" } },
    guardrails: { decide_reviews: false },
    efficiency: { title: "off" },
  }
}

async function openProject(server: Server, directory: string, model: { providerID: string; id: string }, sessionIDs: readonly string[]) {
  const opened = await server.request(`/api/location?location[directory]=${encodeURIComponent(directory)}`)
  expect(opened.status, await opened.clone().text()).toBe(200)
  for (const sessionID of sessionIDs) await createSession(server as Parameters<typeof createSession>[0], sessionID, directory, model)
  const created = await server.request("/api/coordination", {
    method: "POST", headers: json, body: JSON.stringify({ name: "Owner Project", masterSessionID: "ses_master", memberSessionIDs: [] }),
  })
  expect(created.status, await created.clone().text()).toBe(200)
  return ((await created.json()) as { data: { id: string } }).data.id
}

async function boot(script: Script = {}) {
  const repository = await gitRepository()
  const standIn = await startProviderStandIn({ text: "unused", reply: reply(script) })
  cleanups.push(() => standIn.close())
  const server = await startServer(repository.directory, { config: config(standIn) })
  cleanups.push(() => server.close())
  const model = { providerID: standIn.providerID, id: standIn.modelID }
  const groupID = await openProject(server, repository.directory, model, ["ses_master", "ses_unrelated"])
  return { repository, standIn, server, model, groupID }
}

async function prompt(server: Server, sessionID: string, text: string) {
  const response = await server.request(`/api/session/${sessionID}/prompt`, { method: "POST", headers: json, body: JSON.stringify({ text }) })
  expect(response.status, await response.clone().text()).toBe(200)
}

async function until<A>(read: () => Promise<A | undefined | false>, message: string, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined && value !== false) return value
    await Bun.sleep(50)
  }
  throw new Error(message)
}

async function events(server: Server, sessionID: string) {
  const response = await server.request(`/api/experimental/session/${sessionID}/log?follow=false`)
  expect(response.status).toBe(200)
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as { type: string; id?: string; data: Record<string, any> })
}

type SyntheticInput = { readonly id: string; readonly [key: string]: unknown }

const syntheticInputs = async (server: Server, sessionID: string, source: string) =>
  (await events(server, sessionID)).flatMap((event): SyntheticInput[] =>
    event.type === "session.input.admitted" && event.data.input?.type === "synthetic" && event.data.input.data?.metadata?.source === source
      ? [{ id: String(event.data.inputID), ...(event.data.input.data.metadata as Record<string, unknown>) }]
      : [],
  )

const notices = (server: Server, sessionID: string) => syntheticInputs(server, sessionID, "project_notification") as Promise<Notice[]>

async function tasks(server: Server, parentID: string) {
  const response = await server.request(`/api/session/${parentID}/subagent`)
  expect(response.status, await response.clone().text()).toBe(200)
  return ((await response.json()) as { data: Array<{ sessionID: string; state: string; revision: number }> }).data
}

async function group(server: Server, groupID: string) {
  const response = await server.request(`/api/coordination/${groupID}`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: { active: boolean; members: Array<{ sessionID: string; owner?: { sessionID: string }; pending: Array<{ requestID: string }> }> } }).data
}

async function forms(server: Server, sessionID: string) {
  const response = await server.request(`/api/session/${sessionID}/form`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: Array<{ id: string }> }).data
}

function toolResultFrom(standIn: { requests: () => readonly unknown[] }, callID: string) {
  for (const request of standIn.requests()) {
    const output = toolOutput(request, callID)
    if (output !== undefined) return output
  }
  return undefined
}

function expectedWorktree(repository: string, name: string) {
  const common = realpathSync(join(repository, ".git"))
  return join(process.env.XDG_DATA_HOME!, "ycoding", "worktrees", `repo_${createHash("sha256").update(common).digest("hex")}`, name)
}

type Created = { action: "create"; sessionID: string; directory: string; branch: string; owner?: { sessionID: string }; prompt?: { messageID?: string; refused?: string } }

async function createMember(
  context: { server: Server; standIn: { requests: () => readonly unknown[] }; model: { providerID: string; id: string } },
  id: string,
  args: { name: string; ownerSessionID?: string; prompt?: string },
) {
  await prompt(context.server, "ses_master", command(id, "project", { action: "create", ...args, model: context.model }))
  const output = await until(async () => toolResultFrom(context.standIn, `call_${id}`), `project create ${args.name} never returned`)
  const created = JSON.parse(output) as Created
  expect(created).toMatchObject({ action: "create", branch: args.name })
  return created
}

async function expectWorktree(repository: { directory: string; git: (...args: string[]) => string }, created: Created, name: string) {
  expect(existsSync(created.directory)).toBe(true)
  expect(realpathSync(created.directory)).toBe(realpathSync(expectedWorktree(repository.directory, name)))
  expect(repository.git("-C", created.directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe(name)
  expect(repository.git("branch", "--list", name)).toContain(name)
}

async function sessionInfo(server: Server, sessionID: string) {
  const response = await server.request(`/api/session/${sessionID}`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: Record<string, any> }).data
}

async function launchOwner(context: { server: Server; standIn: { requests: () => readonly unknown[] } }) {
  await prompt(context.server, "ses_master", command("launch_owner", "subagent", { agent: "owner", description: "Own Project members", prompt: `${OWNER}: supervise assigned members.` }))
  const launched = await until(async () => toolResultFrom(context.standIn, "call_launch_owner"), "the owner subagent was never launched")
  const ownerID = /\(id: (ses_[^)]+)\)/.exec(launched)?.[1]
  expect(ownerID, launched).toBeDefined()
  await until(async () => (await tasks(context.server, "ses_master")).find((task) => task.sessionID === ownerID && task.state === "completed"), "the owner task never completed")
  return ownerID!
}

const subagentCompletions = async (server: Server, ownerID: string) =>
  (await syntheticInputs(server, "ses_master", "subagent_notification")).filter((item) => item.childID === ownerID && item.type === "completed")

test("a Master-owned member created by the project tool reports only to the Master", async () => {
  const context = await boot()
  const { server, repository, groupID } = context
  await prompt(server, "ses_unrelated", "UNRELATED-ROOT: summarize nothing.")
  const created = await createMember(context, "create_alpha", { name: "alpha", prompt: "MEMBER-ALPHA: run the synthetic check." })

  await expectWorktree(repository, created, "alpha")
  expect(created.owner).toBeUndefined()
  expect(created.prompt?.messageID).toEqual(expect.any(String))
  const member = await sessionInfo(server, created.sessionID)
  expect(member.parentID).toBeUndefined()
  expect(realpathSync(member.location?.directory ?? member.directory)).toBe(realpathSync(created.directory))
  expect((await group(server, groupID)).members.map((item) => [item.sessionID, item.owner])).toEqual([[created.sessionID, undefined]])

  const admitted = (await events(server, created.sessionID)).filter((event) => event.type === "session.input.admitted" && event.data.input?.type === "user")
  expect(admitted.map((event) => [event.data.inputID, event.data.input.data.text, event.data.input.data.metadata?.inputOrigin])).toEqual([
    [created.prompt!.messageID, "MEMBER-ALPHA: run the synthetic check.", "coordination"],
  ])

  const master = await until(async () => {
    const items = await notices(server, "ses_master")
    return items.some((item) => item.event === "completed") ? items : undefined
  }, "the Master never received the member's completed notice")
  expect(master.every((item) => item.memberSessionID === created.sessionID && item.groupID === groupID)).toBe(true)
  expect(master.filter((item) => item.event === "started")).toHaveLength(1)
  expect(master.filter((item) => item.event === "completed")).toHaveLength(1)
  await until(async () => (await events(server, "ses_unrelated")).some((event) => event.type === "session.execution.succeeded"), "the unrelated root never settled")
  expect(await notices(server, "ses_unrelated")).toEqual([])
  expect(await notices(server, created.sessionID)).toEqual([])
  expect(server.logs.filter((line) => line.includes("Project event handling failed"))).toEqual([])
}, 120_000)

test("a delegated owner alone receives its member's notices and is resumed after completing", async () => {
  const ownerWoken = gate()
  const releaseOwner = gate()
  cleanups.push(async () => releaseOwner.open(undefined))
  const context = await boot({
    before: (request, marker) => {
      if (!isOwner(marker) || ownerWoken.opened || !noticesIn(request).some((item) => item.title === "beta")) return undefined
      ownerWoken.open(undefined)
      return releaseOwner.promise.then(() => say("Owner saw the member notice."))
    },
  })
  const { server, repository, standIn, groupID } = context
  await prompt(server, "ses_unrelated", "UNRELATED-ROOT: summarize nothing.")
  const alpha = await createMember(context, "create_alpha", { name: "alpha" })
  const ownerID = await launchOwner(context)
  await until(async () => (await subagentCompletions(server, ownerID)).length === 1, "the Master never received the owner's first completion")
  const before = (await tasks(server, "ses_master")).find((task) => task.sessionID === ownerID)!
  expect(before.state).toBe("completed")

  const beta = await createMember(context, "create_beta", { name: "beta", ownerSessionID: ownerID, prompt: "MEMBER-BETA: run the delegated check." })
  await expectWorktree(repository, beta, "beta")
  expect(beta.directory).not.toBe(alpha.directory)
  expect(beta.branch).not.toBe(alpha.branch)
  expect(beta.owner?.sessionID).toBe(ownerID)
  expect(beta.prompt?.messageID).toEqual(expect.any(String))
  const owners = new Map((await group(server, groupID)).members.map((item) => [item.sessionID, item.owner?.sessionID]))
  expect([...owners.keys()].toSorted()).toEqual([alpha.sessionID, beta.sessionID].toSorted())
  expect(owners.get(alpha.sessionID)).toBeUndefined()
  expect(owners.get(beta.sessionID)).toBe(ownerID)

  await ownerWoken.promise
  const resumed = (await tasks(server, "ses_master")).find((task) => task.sessionID === ownerID)!
  expect(resumed.state).toBe("running")
  expect(resumed.revision).toBeGreaterThan(before.revision)
  const ownerRequest = standIn.requests().find((request) => isOwner(firstUser(request)) && noticesIn(request).some((item) => item.memberSessionID === beta.sessionID))
  expect(noticesIn(ownerRequest)).toContainEqual(expect.objectContaining({ source: "project_notification", groupID, memberSessionID: beta.sessionID, event: "started" }))
  releaseOwner.open(undefined)

  const ownerNotices = await until(async () => {
    const items = await notices(server, ownerID)
    return items.some((item) => item.event === "completed") ? items : undefined
  }, "the owner never received the member's completed notice")
  await until(async () => (await subagentCompletions(server, ownerID)).length >= 2, "the Master never received the resumed owner's completion")
  await until(async () => (await tasks(server, "ses_master")).find((task) => task.sessionID === ownerID && task.state === "completed"), "the resumed owner never settled")
  expect(ownerNotices.every((item) => item.memberSessionID === beta.sessionID)).toBe(true)
  expect(ownerNotices.filter((item) => item.event === "started")).toHaveLength(1)
  expect(ownerNotices.filter((item) => item.event === "completed")).toHaveLength(1)
  expect((await notices(server, "ses_master")).filter((item) => item.memberSessionID === beta.sessionID)).toEqual([])
  expect(await notices(server, alpha.sessionID)).toEqual([])
  expect(await notices(server, beta.sessionID)).toEqual([])
  expect(await notices(server, "ses_unrelated")).toEqual([])
  const completions = await subagentCompletions(server, ownerID)
  expect(new Set(completions.map((item) => item.revision)).size).toBe(completions.length)
  expect(server.logs.filter((line) => line.includes("Project event handling failed"))).toEqual([])
}, 180_000)

test("a member question wakes only its owner, watch reports it, Manual refuses the owner's answer, escalation reaches the Master, and cancelling the owner hands the request to the Master", async () => {
  const ownerHeld = gate()
  const releaseOwner = gate()
  cleanups.push(async () => releaseOwner.open(undefined))
  const context = await boot({
    before: (request, marker) => {
      if (!isOwner(marker) || ownerHeld.opened || !messagesOf(request).some((message) => message.tool_call_id?.startsWith("call_escalate_"))) return undefined
      ownerHeld.open(undefined)
      return releaseOwner.promise.then(() => say("Owner escalated."))
    },
  })
  const { server, standIn, groupID } = context
  await prompt(server, "ses_unrelated", "UNRELATED-ROOT: summarize nothing.")
  const ownerID = await launchOwner(context)
  const beta = await createMember(context, "create_beta", { name: "beta", ownerSessionID: ownerID, prompt: "MEMBER-QUESTION: ask before acting." })
  const ceiling: Array<{ action: string; effect: string }> = (await sessionInfo(server, beta.sessionID)).permissionCeiling ?? []
  const denied = ceiling.filter((rule) => rule.effect === "deny").map((rule) => rule.action)
  expect(denied).not.toContain("question")
  expect(denied).not.toContain("plan_enter")
  expect(denied).toContain("plan_exit")
  const formID = await until(async () => (await forms(server, beta.sessionID))[0]?.id, "the member question was never asked")

  const watched = Bun.spawn([process.execPath, new URL("../src/index.ts", import.meta.url).pathname, "decision", "watch", beta.sessionID, "--json", "--server", server.base, "--timeout", "30"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, YCODING_TEST_HOME: home, YCODING_PASSWORD: password },
  })
  const [stdout, stderr, exit] = await Promise.all([new Response(watched.stdout).text(), new Response(watched.stderr).text(), watched.exited])
  expect(stderr).toBe("")
  expect(exit).toBe(2)
  const decision = JSON.parse(stdout) as { outcome: string; decisions: Array<{ id: string; kind: string; sessionID: string }> }
  expect(decision.outcome).toBe("decision")
  expect(decision.decisions.map((item) => [item.id, item.sessionID])).toEqual([[formID, beta.sessionID]])
  expect(["form", "question"]).toContain(decision.decisions[0]!.kind)

  const answered = JSON.parse(await until(async () => toolResultFrom(standIn, `call_answer_${formID}`), "the owner never attempted an answer"))
  expect(answered).toMatchObject({ action: "answer", result: { outcome: "escalated", settled: false, requestID: formID, reason: "explicit-decision:manual-answers" } })
  const escalated = JSON.parse(await until(async () => toolResultFrom(standIn, `call_escalate_${formID}`), "the owner never escalated"))
  expect(escalated).toMatchObject({ action: "escalate", sessionID: beta.sessionID, requestID: formID, delivered: true, decision: { outcome: "escalated", to: "master" } })

  const ownerQuestions = (await notices(server, ownerID)).filter((item) => item.event === "question")
  expect(ownerQuestions).toEqual([expect.objectContaining({ groupID, memberSessionID: beta.sessionID, requestID: formID })])
  const ownerStarts = (await events(server, ownerID)).filter((event) => event.type === "session.execution.started")
  expect(ownerStarts.length).toBeGreaterThanOrEqual(2)
  const masterBefore = await notices(server, "ses_master")
  expect(masterBefore.filter((item) => item.event === "question")).toEqual([])
  expect(masterBefore.filter((item) => item.event === "escalated")).toEqual([
    expect.objectContaining({ memberSessionID: beta.sessionID, requestID: formID, kind: "question", escalatedBy: expect.objectContaining({ sessionID: ownerID }) }),
  ])
  expect(masterBefore.filter((item) => item.event !== "escalated")).toEqual([])
  expect(await notices(server, "ses_unrelated")).toEqual([])
  expect((await forms(server, beta.sessionID)).map((item) => item.id)).toEqual([formID])

  await ownerHeld.promise
  expect((await tasks(server, "ses_master")).find((task) => task.sessionID === ownerID)?.state).toBe("running")
  const cancelled = await server.request(`/api/session/ses_master/subagent/${ownerID}/cancel`, { method: "POST" })
  expect(cancelled.status, await cancelled.clone().text()).toBe(200)
  expect(((await cancelled.json()) as { data: { state: string } }).data.state).toBe("cancelled")

  const handedOff = await until(async () => {
    const items = (await notices(server, "ses_master")).filter((item) => item.event === "question")
    return items.length > 0 ? items : undefined
  }, "the pending question was never handed to the Master")
  expect(handedOff).toEqual([expect.objectContaining({ groupID, memberSessionID: beta.sessionID, requestID: formID })])
  expect((await group(server, groupID)).members.find((item) => item.sessionID === beta.sessionID)?.owner).toBeUndefined()
  expect((await forms(server, beta.sessionID)).map((item) => item.id)).toEqual([formID])

  await prompt(server, "ses_master", command("assign_cancelled", "project", { action: "assign", sessionID: beta.sessionID, ownerSessionID: ownerID }))
  const refused = await until(async () => toolResultFrom(standIn, "call_assign_cancelled"), "the assign attempt never returned")
  expect(refused).toContain(`Subagent ${ownerID} is cancelled and cannot own members`)
  expect((await group(server, groupID)).members.find((item) => item.sessionID === beta.sessionID)?.owner).toBeUndefined()

  const ownerCount = (await notices(server, ownerID)).length
  const interrupted = await server.request(`/api/session/${beta.sessionID}/interrupt`, { method: "POST" })
  expect(interrupted.status, await interrupted.clone().text()).toBeLessThan(300)
  await until(async () => (await notices(server, "ses_master")).some((item) => item.event === "interrupted" && item.memberSessionID === beta.sessionID), "the next member notice never reached the Master")
  expect(await notices(server, ownerID)).toHaveLength(ownerCount)
  expect(await notices(server, "ses_unrelated")).toEqual([])
  expect(server.logs.filter((line) => line.includes("Project event handling failed"))).toEqual([])
}, 180_000)

async function startPersistentServer(directory: string, database: string, content: Record<string, unknown>): Promise<Server> {
  const port = await availablePort()
  const scope = await Effect.runPromise(Scope.make())
  const logs: string[] = []
  const logger = Logger.map(Logger.formatStructured, (entry) => logs.push(JSON.stringify(entry)))
  const starting = ServerProcess.start<never, never>({
    hostname: "127.0.0.1", port, password, database: { path: database },
    config: { directory, project: false, content: JSON.stringify(content) },
    models: { fetch: false }, fs: { filewatcher: false, fff: false },
  }).pipe(Effect.provideService(Scope.Scope, scope)) as Effect.Effect<unknown, unknown>
  await Effect.runPromise(starting.pipe(Effect.provide(Logger.layer([logger]))))
  const base = `http://127.0.0.1:${port}`
  let closed = false
  return {
    base,
    logs,
    request(path, options = {}) {
      const headers = new Headers(options.headers)
      headers.set("authorization", auth)
      return fetch(`${base}${path}`, { ...options, headers })
    },
    async close() {
      if (closed) return
      closed = true
      await Effect.runPromise(Scope.close(scope, Exit.void))
    },
  }
}

test("an interrupted and re-sent member yields one notice per event, and replaying its events after a restart adds none", async () => {
  const repository = await gitRepository()
  const state = await mkdtemp(join(tmpdir(), "ycoding-project-owner-db-"))
  cleanups.push(() => rm(state, { recursive: true, force: true }))
  const held = gate()
  const release = gate()
  cleanups.push(async () => release.open(undefined))
  const standIn = await startProviderStandIn({
    text: "unused",
    reply: reply({
      before: (_request, marker) => {
        if (!marker.startsWith("MEMBER-HOLD") || held.opened) return undefined
        held.open(undefined)
        return release.promise.then(() => say("Released."))
      },
    }),
  })
  cleanups.push(() => standIn.close())
  const settings = config(standIn)
  const database = join(state, "ycoding.db")
  let server = await startPersistentServer(repository.directory, database, settings)
  cleanups.push(() => server.close())
  const model = { providerID: standIn.providerID, id: standIn.modelID }
  await openProject(server, repository.directory, model, ["ses_master"])

  const gamma = await createMember({ server, standIn, model }, "create_gamma", { name: "gamma", prompt: "MEMBER-HOLD: wait for release." })
  await held.promise
  await until(async () => (await notices(server, "ses_master")).some((item) => item.event === "started"), "the held member never reported started")
  const interrupt = await server.request(`/api/session/${gamma.sessionID}/interrupt`, { method: "POST" })
  expect(interrupt.status, await interrupt.clone().text()).toBeLessThan(300)
  await until(async () => (await notices(server, "ses_master")).some((item) => item.event === "interrupted"), "the interrupted notice never arrived")

  await prompt(server, "ses_master", command("resend_gamma", "project", { action: "send", sessionID: gamma.sessionID, text: "MEMBER-HOLD again: finish now." }))
  const resent = JSON.parse(await until(async () => toolResultFrom(standIn, "call_resend_gamma"), "the re-send never returned"))
  expect(resent).toMatchObject({ action: "send", sessionID: gamma.sessionID, reconciled: false })
  await until(async () => (await notices(server, "ses_master")).some((item) => item.event === "completed"), "the re-sent member never completed")

  const memberEvents = await events(server, gamma.sessionID)
  const count = (type: string) => memberEvents.filter((event) => event.type === type).length
  const expected = {
    started: count("session.execution.started"),
    progress: count("session.step.ended"),
    interrupted: count("session.execution.interrupted"),
    completed: count("session.execution.succeeded"),
  }
  expect(expected).toMatchObject({ started: 2, interrupted: 1, completed: 1 })
  const tally = (items: Notice[]) => ({
    started: items.filter((item) => item.event === "started").length,
    progress: items.filter((item) => item.event === "progress").length,
    interrupted: items.filter((item) => item.event === "interrupted").length,
    completed: items.filter((item) => item.event === "completed").length,
  })
  const before = await notices(server, "ses_master")
  expect(before.every((item) => item.memberSessionID === gamma.sessionID)).toBe(true)
  expect(new Set(before.map((item) => item.id)).size).toBe(before.length)
  expect(tally(before)).toEqual(expected)
  expect(server.logs.filter((line) => line.includes("Project event handling failed"))).toEqual([])

  await server.close()
  server = await startPersistentServer(repository.directory, database, settings)
  const after = await notices(server, "ses_master")
  expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id))
  expect(tally(after)).toEqual(expected)
  expect(server.logs.filter((line) => line.includes("Project event handling failed"))).toEqual([])
}, 180_000)
