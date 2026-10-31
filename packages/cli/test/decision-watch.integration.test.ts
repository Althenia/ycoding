import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { createSession, password, providerConfig, startProviderStandIn, startServer, type IsolatedServer } from "./remote-harness"

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const json = { "content-type": "application/json" }
const home = `${process.env.YCODING_TEST_XDG_ROOT}/home`

type Reply = (request: unknown) => readonly object[]

const shellReply: Reply = (request) => {
  const messages = typeof request === "object" && request !== null ? Reflect.get(request, "messages") : undefined
  if (Array.isArray(messages) && messages.some((message) => message?.role === "tool"))
    return [deltaChunk({ role: "assistant", content: "Watched task finished." }), finishChunk("stop")]
  return [toolCallChunk("call_watch_shell", "shell", JSON.stringify({ command: "printf watched", description: "Synthetic watched check" })), finishChunk("tool_calls")]
}

async function boot(reply: Reply = shellReply) {
  const scratch = join(homedir(), ".local/share/ycoding/tasks")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, "decision-watch-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const standIn = await startProviderStandIn({ text: "Finished.", reply })
  cleanups.push(() => standIn.close())
  const server = await startServer(directory, {
    config: {
      ...JSON.parse(providerConfig(standIn)),
      default_agent: "watch-gate",
      agents: { "watch-gate": { description: "Every shell call asks.", mode: "primary", permissions: [{ action: "shell", resource: "*", effect: "ask" }] } },
    },
  })
  cleanups.push(() => server.close())
  for (const sessionID of ["ses_watch_target", "ses_watch_other"]) {
    await createSession(server, sessionID, directory, { providerID: standIn.providerID, id: standIn.modelID })
    const response = await server.request(`/api/session/${sessionID}/autonomy`, { method: "PUT", headers: json, body: JSON.stringify({ permissions: "manual", guardrails: "manual", answers: "manual" }) })
    expect(response.status, await response.clone().text()).toBe(200)
  }
  return { server, directory }
}

async function prompt(server: IsolatedServer, sessionID: string, id: string) {
  const response = await server.request(`/api/session/${sessionID}/prompt`, { method: "POST", headers: json, body: JSON.stringify({ id, text: "Run the watched check." }) })
  expect(response.status, await response.clone().text()).toBe(200)
}

async function permissions(server: IsolatedServer, sessionID: string) {
  const response = await server.request(`/api/session/${sessionID}/permission`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: Array<{ id: string }> }).data
}

async function until<A>(read: () => Promise<A | undefined>, message: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(message)
}

function watch(server: IsolatedServer, args: string[]) {
  return rerun(server, ["ycoding", "decision", "watch", ...args, "--json", "--server", server.base])
}

function rerun(server: IsolatedServer, argv: readonly string[]) {
  expect(argv.slice(argv.indexOf("--server"), argv.indexOf("--server") + 2)).toEqual(["--server", server.base])
  const child = Bun.spawn([process.execPath, new URL("../src/index.ts", import.meta.url).pathname, ...argv.slice(1)], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, YCODING_TEST_HOME: home, YCODING_PASSWORD: password },
  })
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, exit]) => ({ stdout, stderr, exit }))
}

test("a real Session's permission ask wakes the watch, stays pending, and the resumed watch reports the correlated completion", async () => {
  const { server } = await boot()
  await prompt(server, "ses_watch_other", "msg_watch_other")
  const unrelated = await until(async () => (await permissions(server, "ses_watch_other"))[0], "the unrelated permission was never asked")

  const watching = watch(server, ["ses_watch_target", "--input", "msg_watch_target", "--timeout", "45"])
  await Bun.sleep(1_500)
  await prompt(server, "ses_watch_target", "msg_watch_target")
  const first = await watching
  expect(first.stderr).toBe("")
  expect(first.exit).toBe(2)
  const decision = JSON.parse(first.stdout)
  expect(decision.outcome).toBe("decision")
  expect(decision.decisions).toHaveLength(1)
  expect(decision.decisions[0]).toMatchObject({ kind: "permission", sessionID: "ses_watch_target" })
  expect(JSON.stringify(decision)).not.toContain(unrelated.id)
  const pending = await permissions(server, "ses_watch_target")
  expect(pending.map((item) => item.id)).toEqual([decision.decisions[0].id])

  const again = await watch(server, ["ses_watch_target", "--timeout", "5"])
  expect(again.exit).toBe(2)
  expect(JSON.parse(again.stdout).decisions.map((item: { id: string }) => item.id)).toEqual([decision.decisions[0].id])

  const reply = await server.request(`/api/session/ses_watch_target/permission/${decision.decisions[0].id}/reply`, { method: "POST", headers: json, body: JSON.stringify({ reply: "once" }) })
  expect(reply.status, await reply.clone().text()).toBeLessThan(300)
  const resume: string[] = decision.resume
  expect(resume).toEqual(["ycoding", "decision", "watch", "ses_watch_target", "--input", "msg_watch_target", ...resume.slice(6, -5), "--server", server.base, "--timeout", "45", "--json"])
  const second = await rerun(server, resume)
  expect(second.stderr).toBe("")
  expect(second.exit).toBe(0)
  const settled = JSON.parse(second.stdout)
  expect(settled.outcome).toBe("settled")
  expect(settled.execution).toMatchObject({ status: "succeeded", inputIDs: ["msg_watch_target"], response: "Watched task finished." })
  expect(new Date(settled.execution.settledAt).getTime()).toBeGreaterThanOrEqual(new Date(settled.execution.startedAt).getTime())
  expect(settled.execution.endEvent.seq).toBeGreaterThan(settled.execution.startEvent.seq)
  expect(settled.work.receipt).toBeUndefined()
  expect(["incomplete", "running"]).toContain(settled.work.state)
  expect(settled.work).toMatchObject({ todos: { sessionID: "ses_watch_target", open: 0, items: [] }, decisions: [], tasks: [], lost: [], pending: 0 })
  expect(JSON.stringify(settled.work)).not.toContain("ses_watch_other")
  expect(settled.resume).toEqual(["ycoding", "decision", "watch", "ses_watch_target", "--after", String(settled.after), "--server", server.base, "--timeout", "45", "--json"])
  expect((await permissions(server, "ses_watch_other")).map((item) => item.id)).toEqual([unrelated.id])
}, 120_000)

test("a family checkpoint observes a real child settlement without completing its idle root", async () => {
  const { server } = await boot()
  const response = await server.request("/api/session", {
    method: "POST", headers: json, body: JSON.stringify({ id: "ses_watch_child", parentID: "ses_watch_target" }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  await prompt(server, "ses_watch_child", "msg_watch_child")
  const first = await watch(server, ["ses_watch_target", "--family", "--timeout", "20"])
  expect(first.stderr).toBe("")
  expect(first.exit).toBe(2)
  const pending = JSON.parse(first.stdout)
  expect(pending.decisions).toEqual([expect.objectContaining({ kind: "permission", sessionID: "ses_watch_child" })])
  expect(pending.checkpoint).toEqual(expect.any(String))
  const reply = await server.request(`/api/session/ses_watch_child/permission/${pending.decisions[0].id}/reply`, {
    method: "POST", headers: json, body: JSON.stringify({ reply: "once" }),
  })
  expect(reply.status, await reply.clone().text()).toBeLessThan(300)
  const second = await rerun(server, pending.resume)
  expect(second.stderr).toBe("")
  expect(second.exit).toBe(0)
  const settled = JSON.parse(second.stdout)
  expect(settled).toMatchObject({ outcome: "family", sessionID: "ses_watch_target", work: { state: "incomplete" } })
  expect(settled.changes).toContainEqual(expect.objectContaining({ sessionID: "ses_watch_child", type: "session.execution.succeeded" }))
  expect(settled).not.toHaveProperty("execution")
  expect(settled.work).not.toHaveProperty("receipt")
  expect(settled.resume).toContain("--checkpoint")
}, 120_000)

test("a real question tool's form wakes the watch and the answered input completes", async () => {
  let asked = false
  const { server } = await boot((request) => {
    const messages = typeof request === "object" && request !== null ? Reflect.get(request, "messages") : undefined
    if (asked && Array.isArray(messages) && messages.some((message) => message?.role === "tool"))
      return [deltaChunk({ role: "assistant", content: "Answer received." }), finishChunk("stop")]
    asked = true
    return [toolCallChunk("call_watch_question", "question", JSON.stringify({ questions: [{ header: "Evidence", question: "Which synthetic input should I use?", options: [] }] })), finishChunk("tool_calls")]
  })
  await prompt(server, "ses_watch_target", "msg_watch_question")
  const first = await watch(server, ["ses_watch_target", "--input", "msg_watch_question", "--timeout", "45"])
  expect(first.stderr).toBe("")
  expect(first.exit).toBe(2)
  const decision = JSON.parse(first.stdout)
  expect(decision.decisions).toHaveLength(1)
  expect(decision.decisions[0]).toMatchObject({ sessionID: "ses_watch_target" })
  expect(["form", "question"]).toContain(decision.decisions[0].kind)
  const forms = await server.request("/api/session/ses_watch_target/form")
  const pending = ((await forms.json()) as { data: Array<{ id: string }> }).data
  expect(pending.map((item) => item.id)).toEqual([decision.decisions[0].id])
  const reply = await server.request(`/api/session/ses_watch_target/form/${pending[0]!.id}/reply`, { method: "POST", headers: json, body: JSON.stringify({ answer: { q0: "Synthetic input" } }) })
  expect(reply.status, await reply.clone().text()).toBeLessThan(300)
  expect((decision.resume as string[]).slice(-5)).toEqual(["--server", server.base, "--timeout", "45", "--json"])
  const second = await rerun(server, decision.resume)
  expect(second.stderr).toBe("")
  expect(second.exit).toBe(0)
  expect(JSON.parse(second.stdout).execution).toMatchObject({ status: "succeeded", inputIDs: ["msg_watch_question"], response: "Answer received." })
}, 120_000)

async function executionStarts(server: IsolatedServer, sessionID: string) {
  const response = await server.request(`/api/experimental/session/${sessionID}/log?follow=false`)
  expect(response.status).toBe(200)
  return (await response.text()).split("\n").filter((line) => line.includes('"type":"session.execution.started"')).length
}

test("after real history pruning a resumed watch reports unknown for the pruned execution and success only for the retained one", async () => {
  const { server } = await boot((request) => {
    const text = JSON.stringify(request).includes("Second synthetic task") ? "Second answer." : "First answer."
    return [deltaChunk({ role: "assistant", content: text }), finishChunk("stop")]
  })
  const snapshot = await server.request("/api/session/ses_watch_target/snapshot?limit=1")
  const watermark = ((await snapshot.json()) as { watermark: { seq?: number } }).watermark.seq
  const after = watermark === undefined ? [] : ["--after", String(watermark)]
  const run = async (id: string, text: string) => {
    const response = await server.request("/api/session/ses_watch_target/prompt", { method: "POST", headers: json, body: JSON.stringify({ id, text }) })
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await watch(server, ["ses_watch_target", "--input", id, ...after, "--timeout", "45"])
    expect(result.stderr).toBe("")
    expect(result.exit).toBe(0)
    return JSON.parse(result.stdout).execution
  }
  expect(await run("msg_prune_first", "First synthetic task")).toMatchObject({ status: "succeeded", inputIDs: ["msg_prune_first"], response: "First answer." })
  expect(await run("msg_prune_second", "Second synthetic task")).toMatchObject({ status: "succeeded", inputIDs: ["msg_prune_second"], response: "Second answer." })
  expect(await executionStarts(server, "ses_watch_target")).toBe(2)

  const deadline = Date.now() + 100_000
  while (await executionStarts(server, "ses_watch_target") !== 1) {
    if (Date.now() > deadline) throw new Error("settled history was never pruned")
    await Bun.sleep(1_000)
  }

  const first = await watch(server, ["ses_watch_target", "--input", "msg_prune_first", ...after, "--timeout", "20"])
  expect(first.stderr).toBe("")
  expect(first.exit).toBe(0)
  expect(JSON.parse(first.stdout).execution).toEqual({ status: "unknown", inputIDs: ["msg_prune_first"] })
  const second = await watch(server, ["ses_watch_target", "--input", "msg_prune_second", ...after, "--timeout", "20"])
  expect(second.stderr).toBe("")
  expect(second.exit).toBe(0)
  expect(JSON.parse(second.stdout).execution).toMatchObject({ status: "succeeded", inputIDs: ["msg_prune_second"], response: "Second answer." })
}, 180_000)

test("cancelling a real watch exits without answering a pending decision of another Session", async () => {
  const { server } = await boot()
  await prompt(server, "ses_watch_other", "msg_watch_other")
  const pending = await until(async () => (await permissions(server, "ses_watch_other"))[0], "the unrelated permission was never asked")
  const child = Bun.spawn([process.execPath, new URL("../src/index.ts", import.meta.url).pathname, "decision", "watch", "ses_watch_target", "--json", "--timeout", "60", "--server", server.base], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, YCODING_TEST_HOME: home, YCODING_PASSWORD: password },
  })
  await Bun.sleep(3_000)
  child.kill("SIGINT")
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect([0, 2, 3]).not.toContain(exit)
  expect(stdout).toBe("")
  expect((await permissions(server, "ses_watch_other")).map((item) => item.id)).toEqual([pending.id])
}, 60_000)
