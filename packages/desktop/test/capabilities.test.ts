import { expect, test } from "bun:test"
import { message } from "./synthetic-backend"
import { syntheticDesktop, type SyntheticCall } from "./synthetic-desktop"

const hidden = "synthetic-secret-never-return"
const parent = "ses_parent"
const child = "ses_child"
const side = "ses_side"
const repo = "/synthetic/repo"
const info = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Title ${id}`, location: { directory: repo }, time: { created: 1, updated: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, ...extra })
const envelope = (data: unknown) => ({ location: { directory: repo, project: { id: "prj_test", directory: repo } }, data })
const writes = (calls: readonly SyntheticCall[]) => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.route}`)
const sessionRoute = (call: SyntheticCall, id: string, extra: Record<string, unknown> = {}) => call.method === "GET" && call.route === `/api/session/${id}` ? { data: info(id, extra) } : undefined

test("paged history reads canonical snapshots and refuses stale, foreign or non-advancing pages", async () => {
  let page: Record<string, unknown> = { sourceEpoch: "epoch-a", session: info(parent), messages: [{ id: "msg_2", type: "user", text: "hi" }], watermark: { type: "log.synced", aggregateID: parent, seq: 7 }, before: "cursor-1" }
  const owned = await syntheticDesktop((call) => call.route === `/api/session/${parent}/snapshot` ? page : undefined)
  try {
    const first = await owned.controller.sessionSnapshot({ sessionID: parent })
    expect(first).toMatchObject({ revision: owned.revision, sessionID: parent, sourceEpoch: "epoch-a", watermark: { seq: 7 }, before: "cursor-1", messages: [{ id: "msg_2" }] })
    expect(first.item.id).toBe(parent)
    expect(owned.calls[0]?.query.get("limit")).toBe("100")
    expect(owned.calls[0]?.query.has("before")).toBe(false)
    page = { ...page, messages: [{ id: "msg_1", type: "user", text: "older" }], before: undefined }
    const older = await owned.controller.sessionSnapshot({ sessionID: parent, revision: owned.revision, sourceEpoch: "epoch-a", before: "cursor-1" })
    expect(older.before).toBeUndefined()
    expect(owned.calls[1]?.query.get("before")).toBe("cursor-1")
    const before = owned.calls.length
    expect(await message(owned.controller.sessionSnapshot({ sessionID: parent, revision: owned.revision + 1, sourceEpoch: "epoch-a", before: "cursor-1" }))).toContain("connection changed")
    expect(await message(owned.controller.sessionSnapshot({ sessionID: parent, before: "cursor-1" } as never))).toContain("resident page")
    expect(owned.calls).toHaveLength(before)
    page = { ...page, before: "cursor-1" }
    expect(await message(owned.controller.sessionSnapshot({ sessionID: parent, revision: owned.revision, sourceEpoch: "epoch-a", before: "cursor-1" }))).toContain("does not belong")
    expect(await message(owned.controller.sessionSnapshot({ sessionID: parent, revision: owned.revision, sourceEpoch: "epoch-b", before: "cursor-2" }))).toContain("does not belong")
    page = { ...page, watermark: { type: "log.synced", aggregateID: child } }
    expect(await message(owned.controller.sessionSnapshot({ sessionID: parent }))).toContain("invalid Session history")
  } finally { await owned.close() }
})

test("durable pending inputs and Session insights project canonical reads with per-section notices", async () => {
  let pending: unknown[] = [
    { admittedSeq: 1, id: "msg_q", sessionID: parent, timeCreated: 5, type: "user", delivery: "queue", data: { text: "queued", metadata: { secret: hidden } } },
    { admittedSeq: 2, id: "msg_s", sessionID: parent, timeCreated: 6, type: "synthetic", delivery: "steer", data: { text: "context", description: "Editor" } },
  ]
  let usageBroken = false
  const owned = await syntheticDesktop((call) => {
    if (call.route === `/api/session/${parent}/pending`) return { data: pending }
    if (call.route === `/api/session/${parent}/todo`) return { data: [{ content: "Write tests", status: "in_progress", priority: "high", extra: hidden }] }
    if (call.route === `/api/session/${parent}/diagnostics`) return {}
    if (call.route === `/api/session/${parent}/compaction`) return { data: [], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 }
    if (call.route === `/api/session/${parent}/usage`) return usageBroken ? new Response(null, { status: 503 }) : { data: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } }
    if (call.route === `/api/session/${parent}/usage/tasks`) {
      const ids = [...call.query.entries()].filter(([key]) => key.startsWith("sessionIDs")).map(([, value]) => value)
      return { data: { tasks: ids.slice(0, 1).map((sessionID) => ({ sessionID, status: "settled" })), total: {}, history: ids.length > 50 ? "retained" : "partial" } }
    }
    return undefined
  })
  try {
    const listed = await owned.controller.pendingInputs(parent)
    expect(listed).toEqual({ revision: owned.revision, sessionID: parent, items: [
      { id: "msg_q", sessionID: parent, admittedSeq: 1, timeCreated: 5, type: "user", delivery: "queue", text: "queued" },
      { id: "msg_s", sessionID: parent, admittedSeq: 2, timeCreated: 6, type: "synthetic", delivery: "steer", text: "context", description: "Editor" },
    ] })
    expect(JSON.stringify(listed)).not.toContain(hidden)
    pending = [{ ...pending[0] as object, sessionID: child }]
    expect(await message(owned.controller.pendingInputs(parent))).toContain("invalid pending input")

    const ids = Array.from({ length: 150 }, (_, index) => `ses_task${String(index).padStart(3, "0")}`)
    const insights = await owned.controller.sessionInsights({ sessionID: parent, taskSessionIDs: ids })
    expect(insights.todos).toEqual([{ content: "Write tests", status: "in_progress", priority: "high" }])
    expect(insights.diagnostics).toBeNull()
    expect(insights.usage).toMatchObject({ logical: 1, tokens: { output: 2 } })
    expect(insights.taskCosts).toEqual({ tasks: [{ sessionID: "ses_task000", status: "settled" }, { sessionID: "ses_task100", status: "settled" }], history: "partial" })
    expect(insights.notices).toEqual({})
    expect(owned.calls.filter((call) => call.route.endsWith("/usage/tasks"))).toHaveLength(2)
    usageBroken = true
    const partial = await owned.controller.sessionInsights({ sessionID: parent })
    expect(partial.usage).toBeUndefined()
    expect(partial.taskCosts).toBeUndefined()
    expect(partial.notices).toEqual({ Usage: "Usage could not be read. Refresh to retry." })
    await expect(owned.controller.sessionInsights({ sessionID: parent, taskSessionIDs: ["not-a-session"] })).rejects.toThrow()
    expect(writes(owned.calls)).toEqual([])
  } finally { await owned.close() }
})

test("active-agent switching, skill activation, shell mode and editor context use their own Session operations", async () => {
  let current = "build"
  let scope = "bound"
  const owned = await syntheticDesktop((call) => {
    const found = sessionRoute(call, parent, { agent: current, scope })
    if (found) return found
    if (call.route === "/api/agent") return envelope([{ id: "plan", name: "plan", mode: "primary", hidden: false }, { id: "scout", name: "scout", mode: "subagent", hidden: false }, { id: "ghost", name: "ghost", mode: "primary", hidden: true }, { id: "btw", name: "btw", mode: "primary", hidden: false }])
    if (call.route === "/api/skill") return envelope([{ id: "garm", name: "garm", location: "/skills/garm", content: hidden }])
    if (call.route === `/api/session/${parent}/synthetic`) return { data: { admittedSeq: 3, id: call.body.id, sessionID: parent, timeCreated: 9, type: "synthetic", delivery: "queue", data: { text: call.body.text } } }
    return undefined
  })
  try {
    await owned.controller.switchAgent({ sessionID: parent, revision: owned.revision, agent: "plan" })
    expect(owned.calls.find((call) => call.route === "/api/agent")?.query.get("location[directory]")).toBe(repo)
    const switched = owned.calls.filter((call) => call.route === `/api/session/${parent}/agent`)
    expect(switched.map((call) => [call.method, call.body])).toEqual([["POST", { agent: "plan" }]])
    for (const agent of ["scout", "ghost", "btw", "missing"]) expect(await message(owned.controller.switchAgent({ sessionID: parent, revision: owned.revision, agent }))).toContain("unavailable")
    current = "plan"
    await owned.controller.switchAgent({ sessionID: parent, revision: owned.revision, agent: "plan" })
    const before = owned.calls.length
    expect(await message(owned.controller.switchAgent({ sessionID: parent, revision: owned.revision + 1, agent: "plan" }))).toContain("connection changed")
    expect(owned.calls).toHaveLength(before)
    expect(writes(owned.calls)).toEqual([`POST /api/session/${parent}/agent`])

    await owned.controller.activateSkill({ sessionID: parent, revision: owned.revision, promptID: "msg_skill", skill: "garm" })
    expect(owned.calls.at(-1)).toMatchObject({ method: "POST", route: `/api/session/${parent}/skill`, body: { id: "msg_skill", skill: "garm" } })
    expect(await message(owned.controller.activateSkill({ sessionID: parent, revision: owned.revision, promptID: "msg_skill2", skill: "unknown" }))).toContain("unavailable")
    await expect(owned.controller.activateSkill({ sessionID: parent, revision: owned.revision, promptID: "bad", skill: "garm" })).rejects.toThrow()

    await owned.controller.runShell({ sessionID: parent, revision: owned.revision, command: "ls -la" })
    expect(owned.calls.at(-1)).toMatchObject({ method: "POST", route: `/api/session/${parent}/shell`, body: { command: "ls -la" } })
    for (const command of ["", "   ", "a\0b"]) await expect(owned.controller.runShell({ sessionID: parent, revision: owned.revision, command })).rejects.toThrow()
    scope = "standalone"
    expect(await message(owned.controller.runShell({ sessionID: parent, revision: owned.revision, command: "ls" }))).toContain("no working folder")
    scope = "bound"

    const context = await owned.controller.sendEditorContext({ sessionID: parent, revision: owned.revision, promptID: "msg_editor", text: "selection" })
    expect(context).toEqual({ id: "msg_editor", sessionID: parent, admittedSeq: 3, timeCreated: 9, type: "synthetic", delivery: "queue", text: "selection" })
    expect(owned.calls.at(-1)?.body).toEqual({ id: "msg_editor", text: "selection", resume: false })
    expect(writes(owned.calls)).toEqual([`POST /api/session/${parent}/agent`, `POST /api/session/${parent}/skill`, `POST /api/session/${parent}/shell`, `POST /api/session/${parent}/synthetic`])
  } finally { await owned.close() }
})

test("side chats are created with the btw agent and reviewed conclusions steer only the immediate parent", async () => {
  let failSynthetic = false
  let sideAgent = "btw"
  const owned = await syntheticDesktop((call) => {
    if (call.method === "GET" && call.route === `/api/session/${parent}`) return { data: info(parent) }
    if (call.method === "GET" && call.route === `/api/session/${side}`) return { data: info(side, { parentID: parent, agent: sideAgent }) }
    if (call.route === `/api/session/${parent}/snapshot`) return { sourceEpoch: "epoch", session: info(parent), messages: [{ id: "msg_1", type: "user", text: "Parent question" }, { id: "msg_2", type: "assistant", content: [{ type: "text", text: "Parent answer" }] }], watermark: { type: "log.synced", aggregateID: parent } }
    if (call.method === "POST" && call.route === "/api/session") return { data: info(String(call.body.id), { parentID: call.body.parentID, agent: call.body.agent }) }
    if (call.route === `/api/session/${side}/synthetic`) return failSynthetic ? new Response(JSON.stringify({ message: hidden }), { status: 409 }) : { data: { admittedSeq: 1, id: "msg_ctx", sessionID: side, timeCreated: 1, type: "synthetic", delivery: "steer", data: { text: call.body.text } } }
    if (call.route.endsWith("/prompt")) return { data: { admittedSeq: 2, id: call.body.id, sessionID: call.route.split("/")[3], timeCreated: 2, type: "user", delivery: call.body.delivery ?? "queue", data: { text: call.body.text } } }
    return undefined
  })
  try {
    const opened = await owned.controller.openSideChat({ parentID: parent, sessionID: side, revision: owned.revision, model: { id: "model", providerID: "provider", variant: "high" }, text: "Side question", promptID: "msg_side" })
    expect(opened.item).toMatchObject({ id: side, parentID: parent, agent: "btw" })
    expect(opened.admitted).toMatchObject({ id: "msg_side", sessionID: side, text: "Side question" })
    const posted = owned.calls.filter((call) => call.method === "POST")
    expect(posted.map((call) => call.route)).toEqual(["/api/session", `/api/session/${side}/synthetic`, `/api/session/${side}/prompt`])
    expect(posted[0]?.body).toEqual({ id: side, parentID: parent, agent: "btw", model: { id: "model", providerID: "provider", variant: "high" } })
    expect(posted[1]?.body).toEqual({ text: "Recent parent session history (latest projected window):\n\nUser:\nParent question\n\nAssistant:\nParent answer", description: "Parent session history snapshot", delivery: "steer", resume: false })
    expect(posted[2]?.body).toEqual({ id: "msg_side", text: "Side question" })
    await expect(owned.controller.openSideChat({ parentID: parent, sessionID: side, revision: owned.revision, text: "missing prompt id" })).rejects.toThrow()

    failSynthetic = true
    const before = owned.calls.length
    const failure = await message(owned.controller.openSideChat({ parentID: parent, sessionID: "ses_side2", revision: owned.revision, text: "again", promptID: "msg_side2" }))
    expect(failure).toContain("Side chat ses_side2 was created, but setup was not confirmed")
    expect(failure).not.toContain(hidden)
    expect(owned.calls.slice(before).filter((call) => call.method === "POST").map((call) => call.route)).toEqual(["/api/session", "/api/session/ses_side2/synthetic"])

    const steered = await owned.controller.steerParent({ sessionID: side, revision: owned.revision, promptID: "msg_conclusion", text: "Conclusion" })
    expect(steered).toMatchObject({ id: "msg_conclusion", sessionID: parent, delivery: "steer" })
    expect(owned.calls.at(-1)).toMatchObject({ method: "POST", route: `/api/session/${parent}/prompt`, body: { id: "msg_conclusion", text: "Conclusion", delivery: "steer" } })
    sideAgent = "build"
    const count = owned.calls.length
    expect(await message(owned.controller.steerParent({ sessionID: side, revision: owned.revision, promptID: "msg_c2", text: "Conclusion" }))).toContain("Only a side chat")
    expect(writes(owned.calls.slice(count))).toEqual([])
  } finally { await owned.close() }
})

test("prediction and prompt drafting use distinct operations and accept unavailable outcomes", async () => {
  let unavailable = false
  const owned = await syntheticDesktop((call) => {
    if (call.route === `/api/session/${parent}/prediction`) return { data: unavailable ? { status: "unavailable" } : { status: "suggested", text: "Next" } }
    if (call.route === `/api/session/${parent}/prompt-generate`) return { data: unavailable ? { status: "unavailable" } : { status: "generated", text: "Draft" } }
    return undefined
  })
  try {
    expect(await owned.controller.prediction({ sessionID: parent, memory: ["repository"], hint: "tests" })).toEqual({ revision: owned.revision, sessionID: parent, result: { status: "suggested", text: "Next" } })
    expect(owned.calls.at(-1)?.body).toEqual({ memory: ["repository"], hint: "tests" })
    expect(await owned.controller.promptGenerate({ sessionID: parent, mode: "goal", intent: "Ship it", memory: [] })).toEqual({ revision: owned.revision, sessionID: parent, result: { status: "generated", text: "Draft" } })
    expect(owned.calls.at(-1)?.body).toEqual({ mode: "goal", intent: "Ship it", memory: [] })
    unavailable = true
    expect((await owned.controller.prediction({ sessionID: parent, memory: [] })).result).toEqual({ status: "unavailable" })
    expect((await owned.controller.promptGenerate({ sessionID: parent, mode: "start", intent: "x", memory: ["knowledge"] })).result).toEqual({ status: "unavailable" })
    const before = owned.calls.length
    for (const input of [{ sessionID: parent, memory: ["other"] }, { sessionID: parent, memory: ["repository", "repository"] }, { sessionID: parent, memory: [], hint: "x".repeat(2001) }]) await expect(owned.controller.prediction(input)).rejects.toThrow()
    for (const intent of ["", "   ", "x".repeat(4001)]) await expect(owned.controller.promptGenerate({ sessionID: parent, mode: "start", intent, memory: [] })).rejects.toThrow()
    await expect(owned.controller.promptGenerate({ sessionID: parent, mode: "other", intent: "x", memory: [] })).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
})

test("Session terminals list and read only PTYs attributed to the selected Session", async () => {
  const pty = (id: string, sessionID: string) => ({ id, title: "Terminal", command: "zsh", args: [], cwd: repo, sessionID, status: "running", pid: 1, generation: 1, size: { rows: 24, cols: 80 }, control: { owner: "user", fence: 1 }, output: { startOffset: 0, endOffset: 10, truncated: false }, limits: { maxRuntimeSeconds: 60, maxRetainedBytes: 1024, maxInputBytes: 1024 }, env: { TOKEN: hidden } })
  const owned = await syntheticDesktop((call) => {
    const found = sessionRoute(call, parent)
    if (found) return found
    if (call.route === "/api/pty") return envelope([pty("pty_a", parent), pty("pty_b", child), { id: "pty_bad" }])
    if (call.route === "/api/pty/pty_a") return envelope(pty("pty_a", parent))
    if (call.route === "/api/pty/pty_b") return envelope(pty("pty_b", child))
    return undefined
  })
  try {
    const listed = await owned.controller.terminals({ sessionID: parent })
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.id === "pty_a").toBe(true)
    expect(JSON.stringify(listed)).not.toContain(hidden)
    const request = owned.calls.find((call) => call.route === "/api/pty")
    expect(request?.query.get("sessionID")).toBe(parent)
    expect(request?.query.get("location[directory]")).toBe(repo)
    const terminal = await owned.controller.terminal({ sessionID: parent, ptyID: "pty_a" })
    expect(terminal.item.id === "pty_a").toBe(true)
    expect(terminal.item).toMatchObject({ size: { rows: 24, cols: 80 }, control: { owner: "user" } })
    expect(await message(owned.controller.terminal({ sessionID: parent, ptyID: "pty_b" }))).toContain("not attributed")
    await expect(owned.controller.terminal({ sessionID: parent, ptyID: "sh_1" })).rejects.toThrow()
    expect(writes(owned.calls)).toEqual([])
  } finally { await owned.close() }
})

test("transcript export returns structured JSON or a full Markdown transcript", async () => {
  const messages = [
    { id: "msg_1", type: "user", text: "Question" },
    { id: "msg_2", type: "assistant", content: [{ type: "reasoning", text: "Pondering" }, { type: "text", text: "First" }, { type: "tool", name: "read", state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "file body" }] } }] },
    { id: "msg_3", type: "shell", command: "ls", output: { output: "a.txt" } },
    { id: "msg_4", type: "assistant", content: [{ type: "text", text: "Latest" }] },
  ]
  const owned = await syntheticDesktop((call) => sessionRoute(call, parent) ?? (call.route === "/api/message" || call.route.endsWith("/message") ? { data: messages } : undefined))
  try {
    const json = await owned.controller.exportSession({ sessionID: parent, format: "json" })
    expect(JSON.parse(json.content)).toEqual({ info: info(parent), messages })
    expect(json).toMatchObject({ revision: owned.revision, sessionID: parent, format: "json", filename: `title-ses-parent-${parent}.json`, mimeType: "application/json" })
    const exported = await owned.controller.exportSession({ sessionID: parent, format: "markdown" })
    expect(exported).toMatchObject({ filename: `title-ses-parent-${parent}.md`, mimeType: "text/markdown" })
    const markdown = exported.content
    expect(markdown.startsWith(`# Title ${parent}\n\n**Session ID:** ${parent}`)).toBe(true)
    for (const part of ["## User\n\nQuestion", "## Assistant\n\nFirst", "**Tool: read**", "file body", "$ ls\na.txt", "Latest"]) expect(markdown).toContain(part)
    expect(markdown).not.toContain("Pondering")
    expect((await owned.controller.exportSession({ sessionID: parent, format: "markdown", thinking: true })).content).toContain("_Thinking:_\n\nPondering")
    await expect(owned.controller.exportSession({ sessionID: parent, format: "pdf" })).rejects.toThrow()
  } finally { await owned.close() }
})

test("subagent answers retain parent, child and current question identity", async () => {
  const task = (sessionID: string, question?: string) => ({ sessionID, parentID: parent, description: "Task", agent: "build", model: { id: "model", providerID: "provider" }, background: true, state: question ? "waiting" : "running", revision: 1, time: { created: 1, updated: 2 }, ...(question ? { question: { id: question, text: "Which?", time: 1 } } : {}) })
  const owned = await syntheticDesktop((call) => {
    if (call.route === `/api/session/${parent}/subagent` && call.method === "GET") return call.query.get("cursor") === "next" ? { data: [task(child, "qst_current")], summary: { total: 2, active: 2 }, cursor: {} } : { data: [task("ses_other")], summary: { total: 2, active: 2 }, cursor: { next: "next" } }
    if (call.route.endsWith("/answer")) return { data: task(child) }
    return undefined
  })
  try {
    const result = await owned.controller.manageSession({ kind: "answer-subagent", revision: owned.revision, sessionID: parent, childSessionID: child, questionID: "qst_current", text: "This one", data: { choice: 1 } })
    expect(result).toEqual({ revision: owned.revision, sessionID: parent })
    expect(owned.calls.at(-1)).toMatchObject({ method: "POST", route: `/api/session/${parent}/subagent/${child}/question/qst_current/answer`, body: { text: "This one", data: { choice: 1 } } })
    expect(owned.calls.filter((call) => call.method === "GET").map((call) => call.query.get("cursor"))).toEqual([null, "next"])
    expect(await message(owned.controller.manageSession({ kind: "answer-subagent", revision: owned.revision, sessionID: parent, childSessionID: child, questionID: "qst_stale", text: "Old" }))).toContain("question changed")
    expect(await message(owned.controller.manageSession({ kind: "answer-subagent", revision: owned.revision, sessionID: parent, childSessionID: "ses_other", questionID: "qst_current", text: "Wrong child" }))).toContain("question changed")
    await expect(owned.controller.manageSession({ kind: "answer-subagent", revision: owned.revision, sessionID: parent, childSessionID: child, questionID: "bad", text: "x" })).rejects.toThrow()
    expect(writes(owned.calls)).toEqual([`POST /api/session/${parent}/subagent/${child}/question/qst_current/answer`])
  } finally { await owned.close() }
})

test("Dots access, computer attachment and isolated browser pause check current state before writing", async () => {
  const target = { dotID: "dot", threadID: "thread", environmentID: "env", revision: "b".repeat(64) }
  let dots: Record<string, unknown> = { access: { enabled: true, revision: 4 }, configuration: { ready: true }, connection: { state: "connected" }, computer: { state: "detached", target } }
  let browser = "ready"
  const owned = await syntheticDesktop((call) => {
    const found = sessionRoute(call, parent)
    if (found) return found
    if (call.route === "/api/dots" || call.route.startsWith("/api/dots/")) return { data: dots }
    if (call.route === `/api/session/${parent}/browser/isolated` || call.route.endsWith("/browser/isolated/control")) return { data: { mode: "isolated", state: browser } }
    return undefined
  })
  try {
    expect(await message(owned.controller.manageSystem({ kind: "dots-set", revision: owned.revision, enabled: false, expectedRevision: 3 }))).toContain("Dots access changed")
    await owned.controller.manageSystem({ kind: "dots-set", revision: owned.revision, enabled: false, expectedRevision: 4 })
    expect(owned.calls.find((call) => call.method === "PUT")).toMatchObject({ route: "/api/dots", body: { enabled: false, expectedRevision: 4 } })
    expect(await message(owned.controller.manageSystem({ kind: "dots-attach", revision: owned.revision, replaceOthers: false, expectedTarget: { ...target, revision: "c".repeat(64) } }))).toContain("computer changed")
    expect(await message(owned.controller.manageSystem({ kind: "dots-attach", revision: owned.revision, replaceOthers: false }))).toContain("computer changed")
    await owned.controller.manageSystem({ kind: "dots-attach", revision: owned.revision, replaceOthers: false, expectedTarget: target })
    expect(owned.calls.find((call) => call.route === "/api/dots/computer")?.body).toEqual({ replaceOthers: false, expectedTarget: target })
    expect(await message(owned.controller.manageSystem({ kind: "dots-detach", revision: owned.revision, expectedTarget: target }))).toContain("computer changed")
    dots = { ...dots, computer: { state: "attached", target } }
    await owned.controller.manageSystem({ kind: "dots-detach", revision: owned.revision, expectedTarget: target })
    expect(owned.calls.find((call) => call.route === "/api/dots/computer/detach")?.body).toEqual({ expectedTarget: target })

    expect(await message(owned.controller.manageSystem({ kind: "isolated-browser-pause", revision: owned.revision }))).toContain("Choose a Session")
    await owned.controller.manageSystem({ kind: "isolated-browser-pause", revision: owned.revision, sessionID: parent })
    expect(owned.calls.find((call) => call.route.endsWith("/control"))?.body).toEqual({ action: "pause" })
    expect(await message(owned.controller.manageSystem({ kind: "isolated-browser-resume", revision: owned.revision, sessionID: parent }))).toContain("isolated browser is ready")
    browser = "paused"
    await owned.controller.manageSystem({ kind: "isolated-browser-resume", revision: owned.revision, sessionID: parent })
    expect(owned.calls.filter((call) => call.route.endsWith("/control")).map((call) => call.body)).toEqual([{ action: "pause" }, { action: "resume" }])
    expect(writes(owned.calls)).toEqual(["PUT /api/dots", "POST /api/dots/computer", "POST /api/dots/computer/detach", `POST /api/session/${parent}/browser/isolated/control`, `POST /api/session/${parent}/browser/isolated/control`])
  } finally { await owned.close() }
})

test("credential refresh reports refreshed and failed outcomes separately from key replacement", async () => {
  let outcome: unknown = { status: "refreshed", expires: 99 }
  const owned = await syntheticDesktop((call) => call.route === "/api/credential/cred_test/refresh" ? { location: { directory: owned.resources, project: { id: "prj", directory: owned.resources } }, data: outcome } : call.route === "/api/location" ? { directory: owned.resources, project: { id: "prj" } } : undefined)
  try {
    expect(await owned.controller.manageIntegration({ kind: "credential-refresh", revision: owned.revision, credentialID: "cred_test" })).toEqual({ revision: owned.revision, refresh: { status: "refreshed", expires: 99 } })
    expect(owned.calls.at(-1)).toMatchObject({ method: "POST", route: "/api/credential/cred_test/refresh" })
    outcome = { status: "failed", message: "Sign in again" }
    expect((await owned.controller.manageIntegration({ kind: "credential-refresh", revision: owned.revision, credentialID: "cred_test" })).refresh).toEqual({ status: "failed", message: "Sign in again" })
    outcome = { status: "maybe" }
    await expect(owned.controller.manageIntegration({ kind: "credential-refresh", revision: owned.revision, credentialID: "cred_test" })).rejects.toThrow("invalid refresh result")
    const before = owned.calls.length
    await expect(owned.controller.manageIntegration({ kind: "credential-refresh", revision: owned.revision + 1, credentialID: "cred_test" })).rejects.toThrow()
    expect(owned.calls).toHaveLength(before)
  } finally { await owned.close() }
})

test("Project members attach and detach through the named endpoints without rewriting the member list", async () => {
  const participant = (sessionID: string) => ({ sessionID, title: sessionID, location: { directory: repo }, state: "idle", lastActivity: 1, pending: [] })
  const group = { id: "cgrp_team", name: "Team", revision: 5, active: true, master: participant(parent), members: [participant(child)], settings: { concurrency: null }, time: { created: 1, updated: 2 } }
  let fail = false
  const owned = await syntheticDesktop((call) => {
    if (call.route === "/api/coordination/cgrp_team" && call.method === "GET") return { data: group }
    if (call.route === "/api/coordination/cgrp_team/members" && call.method === "POST") return fail ? new Response(JSON.stringify({ message: hidden }), { status: 409 }) : { data: { groupID: "cgrp_team", sessionID: call.body.sessionID, location: { directory: "/plain/folder" }, ownerSessionID: call.body.ownerSessionID ?? parent, reconciled: false } }
    if (call.route === `/api/coordination/cgrp_team/members/${child}` && call.method === "DELETE") return { data: { sessionID: child, removed: true } }
    return undefined
  })
  try {
    await owned.controller.changeProject({ kind: "attach-member", revision: owned.revision, groupID: "cgrp_team", sessionID: "ses_plain" })
    await owned.controller.changeProject({ kind: "attach-member", revision: owned.revision, groupID: "cgrp_team", sessionID: "ses_owned", ownerSessionID: child })
    await owned.controller.changeProject({ kind: "detach-member", revision: owned.revision, groupID: "cgrp_team", sessionID: child })
    expect(writes(owned.calls)).toEqual(["POST /api/coordination/cgrp_team/members", "POST /api/coordination/cgrp_team/members", `DELETE /api/coordination/cgrp_team/members/${child}`])
    expect(owned.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{ sessionID: "ses_plain" }, { sessionID: "ses_owned", ownerSessionID: child }])
    expect(owned.calls.some((call) => call.method === "PATCH")).toBe(false)
    const before = writes(owned.calls).length
    expect(await message(owned.controller.changeProject({ kind: "attach-member", revision: owned.revision + 1, groupID: "cgrp_team", sessionID: "ses_plain" }))).toContain("out of date")
    expect(await message(owned.controller.changeProject({ kind: "detach-member", revision: owned.revision, groupID: "cgrp_team", sessionID: "ses_plain", groupRevision: 5 }))).toContain("Invalid project change")
    expect(await message(owned.controller.changeProject({ kind: "attach-member", revision: owned.revision, groupID: "team", sessionID: "ses_plain" }))).toContain("Invalid project change")
    expect(writes(owned.calls)).toHaveLength(before)
    fail = true
    const failure = await message(owned.controller.changeProject({ kind: "attach-member", revision: owned.revision, groupID: "cgrp_team", sessionID: "ses_plain" }))
    expect(failure).not.toContain(hidden)
    expect(writes(owned.calls)).toHaveLength(before + 1)
  } finally { await owned.close() }
})

test("Project members are created and deleted against the current coordination revision", async () => {
  const participant = (sessionID: string) => ({ sessionID, title: sessionID, location: { directory: repo }, state: "idle", lastActivity: 1, pending: [] })
  const group = { id: "cgrp_team", name: "Team", revision: 5, active: true, master: participant(parent), members: [participant(child)], settings: { concurrency: null }, time: { created: 1, updated: 2 } }
  let failUpdate = false
  const owned = await syntheticDesktop((call) => {
    if (call.route === "/api/coordination/cgrp_team" && call.method === "GET") return { data: group }
    if (call.route === "/api/coordination/cgrp_team/members" && call.method === "POST") return failUpdate ? new Response(JSON.stringify({ message: hidden }), { status: 409 }) : { data: { groupID: "cgrp_team", sessionID: "ses_new", location: { directory: owned.resources }, ownerSessionID: parent, reconciled: false } }
    if (call.route === "/api/location") return { directory: call.query.get("location[directory]"), project: { id: "prj_test" } }
    if (call.route === "/api/session" && call.method === "POST") return { data: info("ses_new", { location: { directory: owned.resources } }) }
    return undefined
  })
  try {
    await owned.controller.changeProject({ kind: "new-member", revision: owned.revision, groupID: "cgrp_team", groupRevision: 5, directory: owned.resources, title: " Helper " })
    expect(writes(owned.calls)).toEqual(["POST /api/session", "POST /api/coordination/cgrp_team/members"])
    expect(owned.calls.find((call) => call.route === "/api/session")?.body).toEqual({ location: { directory: owned.resources }, title: "Helper" })
    expect(owned.calls.find((call) => call.route === "/api/coordination/cgrp_team/members")?.body).toEqual({ sessionID: "ses_new" })
    failUpdate = true
    const failure = await message(owned.controller.changeProject({ kind: "new-member", revision: owned.revision, groupID: "cgrp_team", groupRevision: 5, directory: owned.resources }))
    expect(failure).toContain("Session created: ses_new. Project membership not confirmed")
    expect(failure).not.toContain(hidden)

    const before = writes(owned.calls).length
    expect(await message(owned.controller.changeProject({ kind: "new-member", revision: owned.revision, groupID: "cgrp_team", groupRevision: 4, directory: owned.resources }))).toContain("project changed")
    expect(await message(owned.controller.changeProject({ kind: "delete-member", revision: owned.revision, groupID: "cgrp_team", groupRevision: 5, sessionID: parent }))).toContain("Only a member")
    expect(await message(owned.controller.changeProject({ kind: "delete-member", revision: owned.revision + 1, groupID: "cgrp_team", groupRevision: 5, sessionID: child }))).toContain("out of date")
    expect(writes(owned.calls)).toHaveLength(before)
    await owned.controller.changeProject({ kind: "delete-member", revision: owned.revision, groupID: "cgrp_team", groupRevision: 5, sessionID: child })
    expect(writes(owned.calls).at(-1)).toBe(`DELETE /api/session/${child}`)
  } finally { await owned.close() }
})

test("every capability operation crosses RPC and both bridge surfaces with its exact input", async () => {
  const inputs: Record<string, unknown> = {
    sessionSnapshot: { sessionID: parent }, pendingInputs: parent, sessionRecall: parent, sessionInsights: { sessionID: parent, taskSessionIDs: [child] },
    switchAgent: { sessionID: parent, revision: 1, agent: "plan" }, activateSkill: { sessionID: parent, revision: 1, promptID: "msg_a", skill: "garm" },
    runShell: { sessionID: parent, revision: 1, command: "ls" }, sendEditorContext: { sessionID: parent, revision: 1, promptID: "msg_b", text: "x" },
    openSideChat: { parentID: parent, sessionID: side, revision: 1 }, steerParent: { sessionID: side, revision: 1, promptID: "msg_c", text: "y" },
    prediction: { sessionID: parent, memory: [] }, promptGenerate: { sessionID: parent, mode: "start", intent: "z", memory: [] },
    terminals: { sessionID: parent }, terminal: { sessionID: parent, ptyID: "pty_a" }, exportSession: { sessionID: parent, format: "json" },
    usageDashboard: { refresh: true }, incidents: { kind: "report", group: "model" }, manageIncident: { revision: 1, kind: "guidance-clear", provider: "openai", model: "gpt" },
    appendTelemetry: { samples: [{ kind: "long-task", at: "2026-11-15T00:00:00.000Z", durationMs: 60 }] }, requests: { scope: "global", directory: "/synthetic/repo" },
    setAutonomyDefaults: { revision: 1, payload: { answers: "yolo", acceptYolo: true } },
  }
  const bare = ["telemetryConsent", "autonomyDefaults"]
  const { createDesktopRPC } = await import("../src/rpc")
  const calls: unknown[][] = []
  const controller = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(undefined) } })
  const handlers = createDesktopRPC(controller as never, { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" }) }) as unknown as Record<string, (input: unknown) => Promise<unknown>>
  for (const [name, input] of Object.entries(inputs)) await handlers[name]!(input)
  expect(calls).toEqual(Object.entries(inputs))
  calls.length = 0
  for (const name of bare) await (handlers[name] as () => Promise<unknown>)()
  expect(calls).toEqual(bare.map((name) => [name]))
  const original = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", {})
  try {
    const { createDesktopBridge, desktop } = await import("../src/bridge")
    calls.length = 0
    const request = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => { calls.push([key, ...args]); return Promise.resolve(undefined) } })
    const bridge = createDesktopBridge({ request } as never, () => undefined) as unknown as Record<string, (input: unknown) => Promise<unknown>>
    for (const [name, input] of Object.entries(inputs)) await bridge[name]!(input)
    expect(calls).toEqual(Object.entries(inputs))
    calls.length = 0
    for (const name of bare) await (bridge[name] as () => Promise<unknown>)()
    expect(calls).toEqual(bare.map((name) => [name]))
    const listeners = ["onState", "onEvent", "onResync", "onMenuAction"]
    expect(Object.keys(desktop).sort()).toEqual([...Object.keys(handlers), ...listeners].sort())
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(desktop).sort())
  } finally { if (original === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", original) }
})

test("export filenames are safe basenames derived from the Session", async () => {
  const { exportFilename } = await import("../src/capabilities")
  expect(exportFilename({ id: parent, title: "../Secret/Plan: Café ✓" }, "markdown")).toBe(`secret-plan-cafe-${parent}.md`)
  expect(exportFilename({ id: parent, title: "✓✓" }, "json")).toBe(`session-${parent}.json`)
  const long = exportFilename({ id: parent, title: "x".repeat(500) }, "json")
  expect(long.length).toBeLessThanOrEqual(255)
  expect(long).not.toMatch(/[/\\\u0000-\u001f]/)
})

test("saving an export hands the canonical output to the native port with a connection fence", async () => {
  const owned = await syntheticDesktop((call) => sessionRoute(call, parent) ?? (call.route.endsWith("/message") ? { data: [{ id: "msg_1", type: "user", text: "Question" }] } : undefined))
  const { createDesktopRPC } = await import("../src/rpc")
  const preferences = { path: "/synthetic/preferences", read: async () => ({}), save: async () => {}, validate: () => ({ mode: "own" as const }) }
  try {
    const unavailable = createDesktopRPC(owned.controller, preferences)
    const before = owned.calls.length
    expect(await message(unavailable.saveExportSession({ sessionID: parent, format: "markdown" }))).toContain("unavailable in this runtime")
    expect(owned.calls).toHaveLength(before)

    const received: { filename: string; mimeType: string; content: string; revision: number; current: boolean }[] = []
    let fence: (() => boolean) | undefined
    const handlers = createDesktopRPC(owned.controller, preferences, { saveExport: async (exported, current) => {
      fence = current
      received.push({ filename: exported.filename, mimeType: exported.mimeType, content: exported.content, revision: exported.revision, current: current() })
      return { saved: true, path: `/chosen/${exported.filename}` }
    } })
    expect(await handlers.saveExportSession({ sessionID: parent, format: "json" })).toEqual({ saved: true, path: `/chosen/title-ses-parent-${parent}.json` })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ filename: `title-ses-parent-${parent}.json`, mimeType: "application/json", revision: owned.revision, current: true })
    expect(JSON.parse(received[0]!.content).info.id).toBe(parent)
    await expect(handlers.saveExportSession({ sessionID: parent, format: "pdf" } as never)).rejects.toThrow()
    expect(received).toHaveLength(1)
    await owned.controller.disconnect()
    expect(fence?.()).toBe(false)
  } finally { await owned.close() }
})

test("new chats carry an explicit primary agent and never reuse an existing Session with another agent", async () => {
  let existingAgent: string | undefined
  const owned = await syntheticDesktop((call) => {
    if (call.route === "/api/project/inventory") return { data: [{ projectID: "prj_test", projectWorktree: repo, directory: repo, sessions: 1, timeActive: 1, available: true }], cursor: {} }
    if (call.route === "/api/agent") return envelope([{ id: "plan", name: "plan", mode: "all", hidden: false }, { id: "scout", name: "scout", mode: "subagent", hidden: false }, { id: "btw", name: "btw", mode: "primary", hidden: false }])
    if (call.method === "POST" && call.route === "/api/session") return { data: info(String(call.body.id), { agent: existingAgent ?? call.body.agent ?? "build" }) }
    return undefined
  })
  try {
    const created = await owned.controller.createSession({ sessionID: "ses_new", directory: repo, agent: "plan" })
    expect(created.agent).toBe("plan")
    expect(owned.calls.find((call) => call.route === "/api/agent")?.query.get("location[directory]")).toBe(repo)
    expect(owned.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{ id: "ses_new", location: { directory: repo }, agent: "plan" }])
    for (const agent of ["scout", "btw", "missing"]) expect(await message(owned.controller.createSession({ sessionID: "ses_other", directory: repo, agent }))).toContain("agent is unavailable")
    await expect(owned.controller.createSession({ sessionID: "ses_other", agent: "bad\nagent" })).rejects.toThrow("Choose an available agent")
    expect(writes(owned.calls)).toEqual(["POST /api/session"])
    existingAgent = "build"
    expect(await message(owned.controller.createSession({ sessionID: "ses_new", directory: repo, agent: "plan" }))).toContain("already exists with a different agent")
    await owned.controller.createSession({ sessionID: "ses_plain" })
    expect(owned.calls.at(-1)?.body).toEqual({ id: "ses_plain" })
  } finally { await owned.close() }
})
