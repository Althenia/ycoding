import { expect, test } from "bun:test"
import { json, sessionSnapshot, type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const root = { id: "ses_safety", title: "Shell safety", projectID: "project", location: { directory: "/workspace/root" }, agent: "build",
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } }
const child = { ...root, id: "ses_child", parentID: root.id, title: "Child safety", location: { directory: "/workspace/child" } }
const shell = { id: "sh_safety", command: "private-command", status: "running", cwd: root.location.directory, shell: "bash", file: "capture.log",
  metadata: { sessionID: root.id }, time: { started: 1 } }
const location = (directory: string) => ({ directory, project: { id: root.projectID, directory } })

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve))
  expect(predicate()).toBe(true)
}

function fixture(override: FetchHandler): FetchHandler {
  return async (url, request) => {
    const response = await override(url, request)
    if (response) return response
    if (url.pathname === "/api/location") return json(location(root.location.directory))
    if (url.pathname === "/path") return json({ home: "", state: "", config: "", worktree: root.location.directory, directory: root.location.directory })
    if (url.pathname === "/api/session") return json({ data: url.searchParams.has("parentID") ? [] : [root], cursor: {} })
    if (url.pathname === `/api/session/${root.id}`) return json({ data: root })
    if (url.pathname === `/api/session/${root.id}/snapshot`) return sessionSnapshot(root.id, [], { session: root })
    if (url.pathname === `/api/session/${root.id}/subagent`) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (/^\/api\/session\/[^/]+\/(permission|todo|skills|pending|form|guardrail\/request)$/.test(url.pathname)) return json({ data: [] })
    if (url.pathname === `/api/session/${root.id}/guardrail`) return json({ data: { rootSessionID: root.id, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
    if (url.pathname === "/api/shell") return json({ location: location(root.location.directory), data: [shell] })
    if (url.pathname === `/api/shell/${shell.id}`) return json({ location: location(root.location.directory), data: shell })
    if (url.pathname === `/api/shell/${shell.id}/output`) return json({ location: location(root.location.directory), data: { output: "captured", cursor: 8, size: 8, truncated: false } })
    return undefined
  }
}

test("a restored shell route rejects foreign and unresolved owners before rendering, reading, or killing", async () => {
  for (const ownerID of ["ses_foreign", "ses_missing"]) {
    let reads = 0
    let kills = 0
    process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
    const screen = await renderScreen({ width: 100, height: 40, kittyKeyboard: true, config: { keybinds: { shell_output_kill: "ctrl+k" } },
      settle: (screen) => /private-command|Shell is not available/.test(screen.captureCharFrame()),
      route: fixture((url, request) => {
        if (url.pathname === `/api/session/${ownerID}`) return ownerID === "ses_missing" ? json({}, { status: 404 }) : json({ data: { ...root, id: ownerID } })
        if (url.pathname === "/api/shell") return json({ location: location(root.location.directory), data: [{ ...shell, metadata: { sessionID: ownerID } }] })
        if (url.pathname === `/api/shell/${shell.id}` && request.method === "DELETE") { kills++; return new Response(null, { status: 204 }) }
        if (url.pathname === `/api/shell/${shell.id}`) return json({ location: location(root.location.directory), data: { ...shell, metadata: { sessionID: ownerID } } })
        if (url.pathname.endsWith("/output")) { reads++; return json({ location: location(root.location.directory), data: { output: "foreign-output", cursor: 14, size: 14, truncated: false } }) }
        return undefined
      }) })
    try {
      screen.input.pressKey("k", { ctrl: true })
      await screen.renderer.idle(); await screen.renderOnce()
      if (screen.frame().includes("private-command")) await until(() => kills === 1)
      expect(screen.frame()).not.toContain("private-command")
      expect(screen.frame()).not.toContain("foreign-output")
      expect(screen.frame()).toContain("Shell is not available")
      expect(reads).toBe(0)
      expect(kills).toBe(0)
    } finally { await screen.dispose(); delete process.env.YCODING_ROUTE }
  }
}, 60_000)

test.each([["running", "verification"], ["queued", "verification"], ["running", "removal"], ["queued", "removal"]] as const)("picker shows %s shell %s errors without removing the row", async (status, failure) => {
  let failing = false
  let removes = 0
  const removal = Promise.withResolvers<Response>()
  const value = { ...shell, status, ...(status === "queued" ? { queuePosition: 2 } : {}) }
  process.env.YCODING_ROUTE = JSON.stringify({ type: "session", sessionID: root.id })
  const screen = await renderScreen({ width: 100, height: 40, args: { sessionID: root.id }, kittyKeyboard: true,
    config: { keybinds: { session_child_first: "ctrl+t" } }, settle: "Message YCoding", route: fixture((url, request) => {
      if (url.pathname === `/api/session/${root.id}` && failing && failure === "verification") return json({}, { status: 500 })
      if (url.pathname === "/api/shell") return json({ location: location(root.location.directory), data: [value] })
      if (url.pathname === `/api/shell/${shell.id}` && request.method === "DELETE") { removes++; return removal.promise }
      if (url.pathname === `/api/shell/${shell.id}`) return json({ location: location(root.location.directory), data: value })
      return undefined
    }) })
  try {
    screen.input.pressKey("t", { ctrl: true })
    await until(() => screen.frame().includes("Subagents") && screen.frame().includes("Shell"))
    screen.input.pressArrow("right")
    await until(() => screen.frame().includes("private-command"))
    failing = true
    screen.input.pressKey("x", { ctrl: true }); screen.input.pressKey("k")
    if (failure === "removal") {
      await until(() => removes === 1)
      expect(screen.frame()).toContain("private-command")
      removal.resolve(json({}, { status: 500 }))
    }
    await until(() => screen.frame().includes(failure === "verification" ? "Failed to verify shell owner" : "Failed to kill shell"))
    expect(screen.frame()).toContain("private-command")
    expect(removes).toBe(failure === "verification" ? 0 : 1)
  } finally { removal.resolve(json({}, { status: 500 })); await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test.each(["verification", "removal"] as const)("a late picker %s failure does not publish an error after close", async (failure) => {
  const response = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  let holding = false
  process.env.YCODING_ROUTE = JSON.stringify({ type: "session", sessionID: root.id })
  const screen = await renderScreen({ width: 100, height: 40, args: { sessionID: root.id }, kittyKeyboard: true,
    config: { keybinds: { session_child_first: "ctrl+t" } }, settle: "Message YCoding", route: fixture((url, request) => {
      if (holding && (failure === "verification" && url.pathname === `/api/session/${root.id}` || failure === "removal" && request.method === "DELETE")) { started.resolve(); return response.promise }
      return undefined
    }) })
  try {
    screen.input.pressKey("t", { ctrl: true })
    await until(() => screen.frame().includes("Subagents") && screen.frame().includes("Shell"))
    screen.input.pressArrow("right")
    await until(() => screen.frame().includes("private-command"))
    holding = true
    screen.input.pressKey("x", { ctrl: true }); screen.input.pressKey("k")
    await started.promise
    screen.input.pressKey("ESCAPE")
    await until(() => !screen.frame().includes("private-command"))
    response.resolve(json({}, { status: 500 }))
    for (let index = 0; index < 20; index++) { await new Promise<void>((resolve) => setImmediate(resolve)); await screen.renderOnce() }
    expect(screen.frame()).not.toContain("Failed to verify shell owner")
    expect(screen.frame()).not.toContain("Failed to kill shell")
  } finally { response.resolve(json({}, { status: 500 })); await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test.each(["running", "queued"] as const)("a deleted %s shell drops cached metadata and ignores its pending output", async (status) => {
  const page = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const value = { ...shell, status, ...(status === "queued" ? { queuePosition: 2 } : {}) }
  let reads = 0
  let removes = 0
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
  const screen = await renderScreen({ width: 100, height: 40, kittyKeyboard: true, config: { keybinds: { shell_output_kill: "ctrl+k" } }, settle: "private-command", route: fixture((url, request) => {
    if (url.pathname === "/api/shell") return json({ location: location(root.location.directory), data: [value] })
    if (url.pathname === `/api/shell/${shell.id}` && request.method === "DELETE") { removes++; return new Response(null, { status: 204 }) }
    if (url.pathname === `/api/shell/${shell.id}`) return json({ location: location(root.location.directory), data: value })
    if (url.pathname.endsWith("/output")) { reads++; started.resolve(); return page.promise }
    return undefined
  }) })
  try {
    await started.promise
    await screen.waitForEventStream()
    screen.events.emit({ id: `evt_deleted_${status}`, type: "shell.deleted", created: Date.now(), location: root.location, data: { id: shell.id } })
    await until(() => screen.frame().includes("Shell is not available"))
    page.resolve(json({ location: location(root.location.directory), data: { output: "deleted-output", cursor: 14, size: 30, truncated: false } }))
    screen.input.pressKey("k", { ctrl: true })
    for (let index = 0; index < 20; index++) { await new Promise<void>((resolve) => setImmediate(resolve)); await screen.renderOnce() }
    expect(screen.frame()).not.toContain("private-command")
    expect(screen.frame()).not.toContain("deleted-output")
    expect(screen.frame()).not.toContain("kill")
    expect(reads).toBe(1)
    expect(removes).toBe(0)
  } finally {
    page.resolve(json({ location: location(root.location.directory), data: { output: "", cursor: 0, size: 0, truncated: false } }))
    await screen.dispose(); delete process.env.YCODING_ROUTE
  }
}, 30_000)

test("a picker kill cannot remove its old family shell after verification settles on another Session", async () => {
  const verification = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const other = { ...root, id: "ses_other_family", title: "Family B", time: { created: 1, updated: 3 } }
  let hold = false
  let kills = 0
  let selectedOther = false
  process.env.YCODING_ROUTE = JSON.stringify({ type: "session", sessionID: root.id })
  const screen = await renderScreen({ width: 100, height: 40, args: { sessionID: root.id }, kittyKeyboard: true,
    config: { keybinds: { session_child_first: "ctrl+t", session_list: "ctrl+l" } }, settle: "Message YCoding", route: fixture((url, request) => {
      if (url.pathname === "/api/session") return json({ data: [root.id, other.id].includes(url.searchParams.get("parentID") ?? "") ? [] : [other, root], cursor: {} })
      if (url.pathname === `/api/session/${root.id}` && hold) { started.resolve(); return verification.promise }
      if (url.pathname === `/api/session/${other.id}`) return json({ data: other })
      if (url.pathname === `/api/session/${other.id}/snapshot`) { selectedOther = true; return sessionSnapshot(other.id, [{ id: "msg_other_family", type: "user", text: "Family B selected", time: { created: 1 } }], { session: other }) }
      if (url.pathname === `/api/session/${other.id}/subagent`) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (url.pathname === `/api/session/${other.id}/guardrail`) return json({ data: { rootSessionID: other.id, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
      if (url.pathname === `/api/shell/${shell.id}` && request.method === "DELETE") { kills++; return new Response(null, { status: 204 }) }
      return undefined
    }) })
  try {
    screen.input.pressKey("t", { ctrl: true })
    await until(() => screen.frame().includes("Subagents") && screen.frame().includes("Shell"))
    screen.input.pressArrow("right")
    await until(() => screen.frame().includes("private-command"))
    hold = true
    screen.input.pressKey("x", { ctrl: true }); screen.input.pressKey("k")
    await started.promise
    screen.input.pressKey("ESCAPE")
    screen.input.pressKey("l", { ctrl: true })
    await until(() => screen.frame().includes("Switch session"))
    await screen.input.typeText("Family B")
    await screen.renderer.idle(); await screen.renderOnce()
    screen.input.pressEnter()
    await until(() => selectedOther && screen.frame().includes("Family B selected")).catch(() => { throw new Error(JSON.stringify({ frame: screen.frame(), selectedOther })) })
    hold = false
    verification.resolve(json({ data: root }))
    for (let index = 0; index < 20; index++) { await new Promise<void>((resolve) => setImmediate(resolve)); await screen.renderOnce() }
    expect(kills).toBe(0)
  } finally {
    hold = false; verification.resolve(json({ data: root }))
    for (let index = 0; index < 20; index++) { await new Promise<void>((resolve) => setImmediate(resolve)); await screen.renderOnce() }
    await screen.dispose(); delete process.env.YCODING_ROUTE
  }
}, 30_000)

test("leaving during family discovery stops descendant pages and owner reads", async () => {
  const page = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const requests: string[] = []
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
  const screen = await renderScreen({ width: 100, height: 40, config: { keybinds: { shell_output_back: "q" } }, settle: "Loading shell data", route: fixture((url) => {
    if (url.pathname === "/api/session" && url.searchParams.get("parentID") === root.id) {
      requests.push(`page:${url.searchParams.get("cursor") ?? "first"}`)
      if (!url.searchParams.has("cursor")) { started.resolve(); return page.promise }
      return json({ data: [], cursor: {} })
    }
    if (url.pathname === `/api/session/${child.id}`) { requests.push("owner"); return json({ data: child }) }
    return undefined
  }) })
  try {
    await started.promise
    screen.input.pressKey("q")
    await until(() => screen.frame().includes("Message YCoding"))
    page.resolve(json({ data: [child], cursor: { next: "more" } }))
    for (let index = 0; index < 20; index++) { await new Promise<void>((resolve) => setImmediate(resolve)); await screen.renderOnce() }
    expect(requests).toEqual(["page:first"])
  } finally { page.resolve(json({ data: [], cursor: {} })); await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test.each([false, true])("family discovery caps concurrent Location reads without dropping active members (cancel=%s)", async (cancel) => {
  const children = Array.from({ length: 8 }, (_, index) => ({ ...child, id: `ses_bounded_${index}`, location: { directory: `/workspace/child-${index}` } }))
  const gates = children.map(() => Promise.withResolvers<void>())
  const reads: string[] = []
  let active = 0
  let peak = 0
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
  const screen = await renderScreen({ width: 100, height: 40, config: { keybinds: { shell_output_back: "q" } }, settle: "Loading shell data", route: fixture(async (url) => {
    if (url.pathname === "/api/session" && url.searchParams.has("parentID")) return json({ data: url.searchParams.get("parentID") === root.id ? children : [], cursor: { next: null } })
    const member = children.find((member) => url.pathname === `/api/session/${member.id}`)
    if (member) return json({ data: member })
    if (url.pathname === "/api/shell") {
      const index = children.findIndex((member) => member.location.directory === url.searchParams.get("location[directory]"))
      if (index < 0) return undefined
      reads.push(children[index]!.location.directory)
      active++; peak = Math.max(peak, active)
      await gates[index]!.promise
      active--
      return json({ location: location(children[index]!.location.directory), data: [] })
    }
    return undefined
  }) })
  try {
    await until(() => active >= 4)
    for (let index = 0; index < 20; index++) { await new Promise<void>((resolve) => setImmediate(resolve)); await screen.renderOnce() }
    expect(peak).toBeLessThanOrEqual(4)
    if (cancel) {
      screen.input.pressKey("q")
      await until(() => screen.frame().includes("Message YCoding"))
    }
    gates.forEach((gate) => gate.resolve())
    if (cancel) {
      for (let index = 0; index < 20; index++) { await new Promise<void>((resolve) => setImmediate(resolve)); await screen.renderOnce() }
      expect(reads).toHaveLength(4)
      return
    }
    await until(() => screen.frame().includes("captured"))
    expect(new Set(reads)).toEqual(new Set(children.map((member) => member.location.directory)))
  } finally { gates.forEach((gate) => gate.resolve()); await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("an exit during a delayed old-size page schedules a verified final catch-up", async () => {
  const page = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const cursors: number[] = []
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
  const screen = await renderScreen({ width: 100, height: 40, settle: "private-command", route: fixture((url) => {
    if (!url.pathname.endsWith("/output")) return undefined
    cursors.push(Number(url.searchParams.get("cursor") ?? 0))
    if (cursors.length === 1) { started.resolve(); return page.promise }
    return json({ location: location(root.location.directory), data: { output: "final", cursor: 10, size: 10, truncated: false } })
  }) })
  try {
    await started.promise
    await screen.waitForEventStream()
    screen.events.emit({ id: "evt_shell_exit_during_page", type: "shell.exited", created: Date.now(), location: root.location, data: { id: shell.id, status: "exited", exit: 0 } })
    await until(() => screen.frame().includes("exited"))
    page.resolve(json({ location: location(root.location.directory), data: { output: "first", cursor: 5, size: 5, truncated: false } }))
    await until(() => screen.frame().includes("firstfinal"))
    expect(cursors).toEqual([0, 5])
  } finally { page.resolve(json({})); await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("the Shell tab discovers descendants in their own Locations instead of the viewed list", async () => {
  const lists: string[] = []
  process.env.YCODING_ROUTE = JSON.stringify({ type: "session", sessionID: root.id })
  const screen = await renderScreen({ width: 100, height: 40, args: { sessionID: root.id }, kittyKeyboard: true, config: { keybinds: { session_child_first: "ctrl+t" } }, settle: "Message YCoding", route: fixture((url) => {
    if (url.pathname === "/api/session") return json({ data: url.searchParams.get("parentID") === root.id ? [child] : url.searchParams.has("parentID") ? [] : [root], cursor: { next: null } })
    if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
    if (url.pathname === "/api/shell") {
      const directory = url.searchParams.get("location[directory]") ?? root.location.directory
      lists.push(directory)
      return json({ location: location(directory), data: directory === child.location.directory ? [{ ...shell, command: "child-only-command", metadata: { sessionID: child.id } }] : [] })
    }
    return undefined
  }) })
  try {
    screen.input.pressKey("t", { ctrl: true })
    await until(() => screen.frame().includes("Subagents") && screen.frame().includes("Shell")).catch(() => { throw new Error(screen.frame()) })
    screen.input.pressArrow("right")
    await until(() => screen.frame().includes("child-only-command")).catch(() => { throw new Error(JSON.stringify({ frame: screen.frame(), lists })) })
    expect(lists).toContain(child.location.directory)
    expect(screen.frame()).toContain("SUBAGENT · BUILD · CHILD SAFETY")
  } finally { await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("catch-up re-verifies a descendant before every page and blocks kill after family ownership changes", async () => {
  let changed = false
  let reads = 0
  let kills = 0
  const owned = { ...shell, metadata: { sessionID: child.id } }
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
  const screen = await renderScreen({ width: 100, height: 40, kittyKeyboard: true, config: { keybinds: { shell_output_kill: "ctrl+k" } }, settle: "Shell is not available", route: fixture((url, request) => {
    if (url.pathname === "/api/session") return json({ data: url.searchParams.get("parentID") === root.id ? [child] : url.searchParams.has("parentID") ? [] : [root], cursor: {} })
    if (url.pathname === `/api/session/${child.id}`) return json({ data: changed ? { ...child, parentID: "ses_foreign" } : child })
    if (url.pathname === "/api/session/ses_foreign") return json({ data: { ...root, id: "ses_foreign" } })
    if (url.pathname === "/api/shell") return json({ location: location(url.searchParams.get("location[directory]") ?? root.location.directory), data: url.searchParams.get("location[directory]") === child.location.directory ? [owned] : [] })
    if (url.pathname === `/api/shell/${shell.id}` && request.method === "DELETE") { kills++; return new Response(null, { status: 204 }) }
    if (url.pathname === `/api/shell/${shell.id}`) return url.searchParams.get("location[directory]") === child.location.directory ? json({ location: location(child.location.directory), data: owned }) : json({}, { status: 404 })
    if (url.pathname.endsWith("/output")) { reads++; changed = true; return json({ location: location(child.location.directory), data: { output: "first", cursor: 5, size: 10, truncated: false } }) }
    return undefined
  }) })
  try {
    expect(reads).toBe(1)
    expect(screen.frame()).not.toContain("private-command")
    screen.input.pressKey("k", { ctrl: true })
    await screen.renderer.idle(); await screen.renderOnce()
    expect(kills).toBe(0)
  } finally { await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("an output read failure is visible and an explicit retry can recover", async () => {
  let reads = 0
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
  const screen = await renderScreen({ width: 100, height: 40, settle: "private-command", route: fixture((url) => {
    if (!url.pathname.endsWith("/output")) return undefined
    reads++
    return reads === 1 ? json({}, { status: 500 }) : json({ location: location(root.location.directory), data: { output: "recovered-output", cursor: 16, size: 16, truncated: false } })
  }) })
  try {
    await until(() => screen.frame().includes("Retry output"))
    expect(screen.frame()).not.toContain("No captured output")
    screen.input.pressKey("r")
    await until(() => screen.frame().includes("recovered-output"))
    expect(screen.frame()).not.toContain("Retry output")
    expect(reads).toBe(2)
  } finally { await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("leaving a shell route invalidates its in-flight catch-up page before another read", async () => {
  const page = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  let reads = 0
  process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
  const screen = await renderScreen({ width: 100, height: 40, settle: "private-command", config: { keybinds: { shell_output_back: "q" } }, route: fixture((url) => {
    if (!url.pathname.endsWith("/output")) return undefined
    reads++; started.resolve()
    return reads === 1 ? page.promise : json({ location: location(root.location.directory), data: { output: "late-second-page", cursor: 2, size: 2, truncated: false } })
  }) })
  try {
    await started.promise
    screen.input.pressKey("q")
    await until(() => screen.frame().includes("Message YCoding"))
    page.resolve(json({ location: location(root.location.directory), data: { output: "a", cursor: 1, size: 2, truncated: false } }))
    await screen.renderer.idle()
    for (let index = 0; index < 20; index++) { await new Promise<void>((resolve) => setImmediate(resolve)); await screen.renderOnce() }
    expect(reads).toBe(1)
    expect(screen.frame()).not.toContain("late-second-page")
  } finally { page.resolve(json({})); await screen.dispose(); delete process.env.YCODING_ROUTE }
}, 30_000)

test("a restored exited shell uses direct lookup at a verified family Location and reports lookup failure", async () => {
  for (const missing of [false, true]) {
    const gets: string[] = []
    process.env.YCODING_ROUTE = JSON.stringify({ type: "shell-output", sessionID: root.id, shellID: shell.id })
    const screen = await renderScreen({ width: 100, height: 40, settle: (screen) => /captured|Shell is not available/.test(screen.captureCharFrame()), route: fixture((url) => {
      if (url.pathname === "/api/shell") return json({ location: location(root.location.directory), data: [] })
      if (url.pathname === `/api/shell/${shell.id}`) { gets.push(url.searchParams.get("location[directory]") ?? ""); return missing ? json({}, { status: 404 }) : json({ location: location(root.location.directory), data: { ...shell, status: "exited" } }) }
      return undefined
    }) })
    try {
      await until(() => screen.frame().includes(missing ? "Shell is not available" : "captured"))
      expect(gets.some((value) => value.includes(root.location.directory))).toBe(true)
      expect(screen.frame()).not.toContain("Loading shell data")
    } finally { await screen.dispose(); delete process.env.YCODING_ROUTE }
  }
}, 60_000)
