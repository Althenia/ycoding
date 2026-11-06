import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
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

test("source CLI follow observes isolated descendant execution and resumes its durable cursor", async () => {
  const scratch = join(homedir(), ".local/share/ycoding/tasks/session-activity-owners-20261106/watch-activity")
  await mkdir(scratch, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(scratch, "source-follow-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let requests = 0
  const server = await startServer(directory, { provider: { text: "Synthetic descendant settled.", reply: async () => {
    if (++requests === 2) entered.resolve()
    await release.promise
    return [deltaChunk({ role: "assistant", content: "Synthetic descendant settled." }), finishChunk("stop")]
  } } })
  cleanups.push(async () => { release.resolve(); await server.close() })
  const model = { providerID: server.provider!.providerID, id: server.provider!.modelID }
  await createSession(server, "ses_follow_root", directory, model)
  for (const [id, parentID] of [["ses_follow_child", "ses_follow_root"], ["ses_follow_grandchild", "ses_follow_child"]]) {
    const response = await server.request("/api/session", { method: "POST", headers: json, body: JSON.stringify({ id, parentID, directory, model }) })
    expect(response.status, await response.clone().text()).toBe(200)
  }
  const state = join(directory, "follow.json")
  const start = () => {
    const child = Bun.spawn([process.execPath, new URL("../src/index.ts", import.meta.url).pathname,
      "decision", "watch", "ses_follow_root", "--family", "--follow", "--state", state, "--timeout", "60", "--json", "--server", server.base], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, YCODING_PASSWORD: password },
    })
    const receipts: Array<Record<string, unknown>> = []
    const listeners = new Set<() => void>()
    const stderr = new Response(child.stderr).text()
    const collecting = (async () => {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let buffered = ""
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          buffered += decoder.decode(next.value, { stream: true })
          let end = buffered.indexOf("\n")
          while (end >= 0) {
            const line = buffered.slice(0, end)
            buffered = buffered.slice(end + 1)
            if (line.trim()) receipts.push(JSON.parse(line))
            for (const notify of listeners) notify()
            end = buffered.indexOf("\n")
          }
        }
      } finally { reader.releaseLock() }
    })()
    const wait = (predicate: (receipt: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Source follower did not emit expected receipt: ${JSON.stringify(receipts)}`)) }, 45_000)
      const check = () => {
        const receipt = receipts.find(predicate)
        if (!receipt) return
        clearTimeout(timer)
        listeners.delete(check)
        resolve(receipt)
      }
      listeners.add(check)
      check()
    })
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      child.kill("SIGINT")
      await child.exited
      await collecting
      expect(await stderr).toBe("")
    }
    cleanups.push(stop)
    return { wait, receipts, stop }
  }
  const follower = start()
  await follower.wait((receipt) => receipt.kind === "ready" && receipt.rootActive === false)
  await prompt(server, "ses_follow_child", "msg_follow_child")
  await prompt(server, "ses_follow_grandchild", "msg_follow_grandchild")
  await follower.wait((receipt) => receipt.rootActive === true && receipt.activity === "running")
  const active = await (await server.request("/api/session/active")).json() as { data: Record<string, unknown> }
  expect(Object.keys(active.data)).not.toContain("ses_follow_root")
  expect(Object.keys(active.data)).toContain("ses_follow_child")
  expect(Object.keys(active.data)).toContain("ses_follow_grandchild")
  const outstanding = await (await server.request("/api/session/outstanding")).json() as { data: string[]; running: string[] }
  expect(outstanding.running).toEqual(expect.arrayContaining(["ses_follow_root", "ses_follow_child", "ses_follow_grandchild"]))
  await entered.promise
  release.resolve()
  await follower.wait((receipt) => receipt.kind === "durable" && receipt.type === "session.execution.succeeded" && receipt.sessionID === "ses_follow_child")
  await follower.wait((receipt) => receipt.kind === "durable" && receipt.type === "session.execution.succeeded" && receipt.sessionID === "ses_follow_grandchild")
  await follower.wait((receipt) => receipt.kind === "activity" && receipt.rootActive === false)
  await follower.stop()
  const saved = JSON.parse(await readFile(state, "utf8"))
  expect(saved.cursors.map((cursor: { sessionID: string }) => cursor.sessionID).sort()).toEqual(["ses_follow_child", "ses_follow_grandchild", "ses_follow_root"])
  expect(saved.cursors.filter((cursor: { sessionID: string }) => cursor.sessionID !== "ses_follow_root").every((cursor: { after: number }) => cursor.after > 0)).toBe(true)
  const resumed = start()
  await resumed.wait((receipt) => receipt.kind === "ready")
  await resumed.stop()
  expect(resumed.receipts.filter((receipt) => receipt.kind === "durable")).toEqual([])
}, 120_000)

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
