import { expect, test } from "bun:test"
import type { ShellInfo } from "@ycoding-ai/client"
import { json, sessionSnapshot, type FetchHandler } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"
import type { useData } from "../src/context/data"

const root = { id: "ses_picker", title: "Shell picker", projectID: "project", location: { directory: "/workspace/root" }, agent: "build",
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } }
const child = { ...root, id: "ses_picker_child", parentID: root.id, title: "Child checks", agent: "reviewer", location: { directory: "/workspace/child" } }
const location = (directory: string) => ({ directory, project: { id: root.projectID, directory } })

function shell(id: string, ownerID: string, started: number, status: ShellInfo["status"] = "running"): ShellInfo {
  return { id, command: `command ${id}`, status, cwd: "/workspace/commands", shell: "bash", file: `/tmp/${id}`, metadata: { sessionID: ownerID }, time: { started } }
}

async function open(shells: ShellInfo[], override?: FetchHandler) {
  let data: ReturnType<typeof useData> | undefined
  const outputReads: { id: string; directory: string | null }[] = []
  const kills: { id: string; directory: string | null }[] = []
  const route: FetchHandler = async (url, request) => {
    const response = await override?.(url, request)
    if (response) return response
    if (url.pathname === "/api/location") return json(location(root.location.directory))
    if (url.pathname === "/path") return json({ home: "", state: "", config: "", worktree: root.location.directory, directory: root.location.directory })
    if (url.pathname === "/api/session") return json({ data: url.searchParams.get("parentID") === root.id ? [child] : url.searchParams.has("parentID") ? [] : [root], cursor: {} })
    const member = [root, child].find((member) => url.pathname === `/api/session/${member.id}`)
    if (member) return json({ data: member })
    if (url.pathname === `/api/session/${root.id}/snapshot`) return sessionSnapshot(root.id, [], { session: root })
    if (url.pathname === `/api/session/${root.id}/subagent`) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (/^\/api\/session\/[^/]+\/(permission|todo|skills|pending|form|guardrail\/request)$/.test(url.pathname)) return json({ data: [] })
    if (url.pathname === `/api/session/${root.id}/guardrail`) return json({ data: { rootSessionID: root.id, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
    if (url.pathname === "/api/shell") {
      const directory = url.searchParams.get("location[directory]") ?? root.location.directory
      return json({ location: location(directory), data: shells.filter((shell) => (shell.metadata.sessionID === child.id ? child : root).location.directory === directory) })
    }
    const value = shells.find((shell) => url.pathname === `/api/shell/${shell.id}` || url.pathname === `/api/shell/${shell.id}/output`)
    if (!value) return undefined
    const directory = url.searchParams.get("location[directory]")
    if (request.method === "DELETE") { kills.push({ id: value.id, directory }); return new Response(null, { status: 204 }) }
    const owner = value.metadata.sessionID === child.id ? child : root
    if (directory !== owner.location.directory) return json({}, { status: 404 })
    if (url.pathname.endsWith("/output")) {
      outputReads.push({ id: value.id, directory })
      const output = `Captured ${value.id}`
      return json({ location: location(directory), data: { output, cursor: output.length, size: output.length, truncated: false } })
    }
    return json({ location: location(directory), data: value })
  }
  process.env.YCODING_ROUTE = JSON.stringify({ type: "session", sessionID: root.id })
  const screen = await renderScreen({ width: 100, height: 40, args: { sessionID: root.id }, kittyKeyboard: true,
    config: { keybinds: { session_child_first: "ctrl+t" } }, settle: "Message YCoding", route, data: (value) => { data = value } })
  screen.input.pressKey("t", { ctrl: true })
  await until(() => screen.frame().includes("Subagents") && screen.frame().includes("Shell"))
  screen.input.pressArrow("right")
  await until(() => screen.frame().includes("command "))
  await screen.waitForEventStream()
  return { screen, outputReads, kills, data: () => data! }
}

test("selected running shell survives insertion, reorder and archival before Enter opens its owned output", async () => {
  const target = shell("sh_target", child.id, 5)
  const values = [shell("sh_main", root.id, 10), target]
  const { screen, outputReads, kills } = await open(values)
  try {
    screen.input.pressArrow("down")
    const newer = shell("sh_newer", root.id, 30)
    values.push(newer)
    screen.events.emit({ id: "evt_insert", type: "shell.created", created: 30, location: root.location, data: { info: newer } })
    const latest = shell("sh_latest", root.id, 50)
    values.push(latest)
    screen.events.emit({ id: "evt_latest", type: "shell.created", created: 50, location: root.location, data: { info: latest } })
    Object.assign(target, { status: "exited", time: { started: target.time.started, completed: 100 } })
    screen.events.emit({ id: "evt_archive", type: "shell.exited", created: 100, location: child.location, data: { id: target.id, status: "exited", exit: 0 } })
    await until(() => screen.frame().includes("Archived"))
    expect(screen.frame()).toContain("command sh_target")
    screen.input.pressEnter()
    await until(() => screen.frame().includes("Captured sh_target"))
    expect(outputReads.length).toBeGreaterThan(0)
    expect(outputReads.every((read) => read.id === target.id && read.directory === child.location.directory)).toBe(true)
    expect(kills).toEqual([])
  } finally { await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("kill retains the selected running shell and owner Location while verification is pending across insertion and reorder", async () => {
  const target = shell("sh_target", child.id, 10)
  const values = [shell("sh_main", root.id, 20), target]
  const verification = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  let hold = false
  const { screen, kills, outputReads } = await open(values, (url) => {
    if (hold && url.pathname === `/api/session/${child.id}`) { started.resolve(); return verification.promise }
    return undefined
  })
  try {
    screen.input.pressArrow("down")
    hold = true
    screen.input.pressKey("x", { ctrl: true }); screen.input.pressKey("k")
    await started.promise
    const newer = shell("sh_newer", root.id, 30)
    values.push(newer)
    screen.events.emit({ id: "evt_kill_insert", type: "shell.created", created: 30, location: root.location, data: { info: newer } })
    await until(() => screen.frame().includes("command sh_newer"))
    expect(kills).toEqual([])
    expect(screen.frame()).toContain("command sh_target")
    hold = false
    verification.resolve(json({ data: child }))
    await until(() => kills.length === 1)
    expect(kills).toEqual([{ id: target.id, directory: child.location.directory }])
    Object.assign(target, { status: "killed", time: { started: target.time.started, completed: 100 } })
    screen.events.emit({ id: "evt_kill_archive", type: "shell.exited", created: 100, location: child.location, data: { id: target.id, status: "killed" } })
    await until(() => screen.frame().includes("Archived"))
    await screen.renderer.idle(); await screen.renderOnce()
    screen.input.pressEnter()
    await until(() => screen.frame().includes("Captured sh_target"))
    expect(outputReads.every((read) => read.id === target.id && read.directory === child.location.directory)).toBe(true)
  } finally { hold = false; verification.resolve(json({ data: child })); await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("observed archive survives live-only sync and picker reopen, ignores Kill and opens owned output", async () => {
  const target = shell("sh_target", child.id, 10)
  const values = [shell("sh_main", root.id, 20), target]
  let ownerLookups = 0
  const { screen, data, kills, outputReads } = await open(values, (url) => {
    if (url.pathname === `/api/session/${child.id}`) ownerLookups++
    if (url.pathname !== "/api/shell") return undefined
    const directory = url.searchParams.get("location[directory]") ?? root.location.directory
    return json({ location: location(directory), data: values.filter((value) => value.status === "running" && (value.metadata.sessionID === child.id ? child : root).location.directory === directory) })
  })
  try {
    screen.input.pressArrow("down")
    Object.assign(target, { status: "exited", time: { started: 10, completed: 100 } })
    screen.events.emit({ id: "evt_retained_exit", type: "shell.exited", created: 100, location: child.location, data: { id: target.id, status: "exited", exit: 0 } })
    await until(() => screen.frame().includes("Archived"))
    data().shell.invalidate(child.location)
    await data().shell.sync(child.location)
    await screen.renderOnce()
    expect(screen.frame()).toContain("command sh_target")
    expect(screen.frame()).toContain("Archived")
    screen.input.pressKey("ESCAPE")
    await until(() => !screen.frame().includes("command sh_target"))
    screen.input.pressKey("t", { ctrl: true })
    await until(() => screen.frame().includes("Subagents") && screen.frame().includes("Shell"))
    screen.input.pressArrow("right")
    await until(() => screen.frame().includes("command sh_target"))
    if (screen.frame().includes("⌃x k kill")) screen.input.pressArrow("down")
    await screen.renderer.idle(); await screen.renderOnce()
    expect(screen.frame()).not.toContain("⌃x k kill")
    const before = ownerLookups
    screen.input.pressKey("x", { ctrl: true }); screen.input.pressKey("k")
    await screen.renderer.idle(); await screen.renderOnce()
    expect(ownerLookups).toBe(before)
    expect(kills).toEqual([])
    screen.input.pressEnter()
    await until(() => screen.frame().includes("Captured sh_target"))
    expect(outputReads.every((read) => read.id === target.id && read.directory === child.location.directory)).toBe(true)
  } finally { await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test.each(["settled", "deleted"] as const)("a shell becoming %s during owner verification cancels Kill without retargeting", async (outcome) => {
  const target = shell("sh_target", child.id, 10)
  const verification = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  let hold = false
  const { screen, kills } = await open([shell("sh_main", root.id, 20), target], (url) => {
    if (hold && url.pathname === `/api/session/${child.id}`) { started.resolve(); return verification.promise }
    return undefined
  })
  try {
    screen.input.pressArrow("down")
    hold = true
    screen.input.pressKey("x", { ctrl: true }); screen.input.pressKey("k")
    await started.promise
    if (outcome === "settled") {
      Object.assign(target, { status: "exited", time: { started: 10, completed: 100 } })
      screen.events.emit({ id: "evt_verification_exit", type: "shell.exited", created: 100, location: child.location, data: { id: target.id, status: "exited", exit: 0 } })
      await until(() => screen.frame().includes("Archived"))
    }
    if (outcome === "deleted") {
      screen.events.emit({ id: "evt_verification_delete", type: "shell.deleted", created: 100, location: child.location, data: { id: target.id } })
      await until(() => !screen.frame().includes("command sh_target"))
    }
    hold = false
    verification.resolve(json({ data: child }))
    await screen.renderer.idle(); await screen.renderOnce()
    expect(kills).toEqual([])
    if (outcome === "settled") {
      expect(screen.frame()).not.toContain("⌃x k kill")
      screen.input.pressEnter()
      await until(() => screen.frame().includes("Captured sh_target"))
    }
    expect(kills).toEqual([])
  } finally { hold = false; verification.resolve(json({ data: child })); await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("keyboard movement reveals the selected row inside a long status section across owners", async () => {
  const values = Array.from({ length: 24 }, (_, index) => shell(`sh_row_${String(index).padStart(2, "0")}`, index % 2 ? child.id : root.id, 100 - index))
  const { screen, outputReads } = await open(values)
  try {
    for (let index = 0; index < 20; index++) screen.input.pressArrow("down")
    await screen.renderer.idle(); await screen.renderOnce()
    const visible = screen.frame().includes("command sh_row_20")
    screen.input.pressEnter()
    await until(() => outputReads.length > 0)
    expect(outputReads[0]?.id).toBe("sh_row_20")
    expect(visible).toBe(true)
    await until(() => screen.frame().includes("Captured sh_row_20"))
    expect(outputReads.every((read) => read.id === "sh_row_20" && read.directory === root.location.directory)).toBe(true)
  } finally { await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve))
  expect(predicate()).toBe(true)
}
