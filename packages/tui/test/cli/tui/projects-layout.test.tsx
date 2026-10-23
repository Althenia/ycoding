/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { ProjectsScreenContent } from "../../../src/routes/session/projects"
import { DialogProvider } from "../../../src/ui/dialog"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import type {
  CoordinationGroupView,
  CoordinationService,
  GlobalDelegationView,
  NotificationFilter,
} from "../../../src/util/coordination"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const now = 1_800_000_000_000
const lead = { sessionID: "ses_lead", title: "Lead session" }
const worker = { sessionID: "ses_worker", title: "Worker A" }
const watcher = { sessionID: "ses_watcher", title: "Watcher" }
const fresh = { sessionID: "ses_fresh", title: "Fresh session" }
const delegatedDecisions = {
  categories: ["permission"] as const,
  actions: ["shell:git status"],
  resources: ["/repo/src/**"],
  expiresAt: now + 2 * 3_600_000,
}

const highSelection = {
  agent: "omoikane",
  model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" },
  reason: "Needs deep reasoning",
}
const plainSelection = { agent: "build", model: { providerID: "openai", id: "gpt-6", profile: "work" }, reason: "Quick   lease check" }

const release: CoordinationGroupView = {
  id: "grp_release",
  name: "Release train",
  status: "armed",
  revision: 7,
  roster: [
    { ...lead, role: "coordinator", allowedTools: ["read"], resourceScopes: ["/repo/**"] },
    { ...worker, role: "worker", allowedTools: ["read", "grep"], resourceScopes: ["/repo/src/**"] },
    { ...watcher, role: "observer" },
  ],
  capacity: { active: 2, hardLimit: 5 },
  policy: { concurrency: 3, queueCapacity: 40, budget: 5, delegatedDecisions },
  queue: [{ id: "q1", title: "Refactor parser", reason: "capacity", selection: plainSelection }],
  leases: [{ id: "l1", holder: "Worker A", resource: "src/parser.ts", expiresAt: now + 30_000 }],
  receipts: [
    { id: "r1", worker: "Worker A", outcome: "dispatched", time: now - 5_000, selection: highSelection },
    { id: "r2", worker: "Worker B", outcome: "queued", reason: "capacity", time: now - 65_000 },
  ],
}
const docs: CoordinationGroupView = {
  id: "grp_docs",
  name: "Docs sweep",
  status: "disarmed",
  revision: 2,
  roster: [{ ...lead, role: "coordinator" }],
  capacity: { active: 0, hardLimit: 5 },
  policy: { concurrency: null, queueCapacity: 20 },
  queue: [],
  leases: [],
  receipts: [],
}
const sessions = [lead, worker, watcher, fresh]
const openGlobal: GlobalDelegationView = { enabled: true, categories: ["question", "permission", "review"] }

type Call = [string, ...unknown[]]

function recordingService(overrides: Partial<CoordinationService> = {}) {
  const calls: Call[] = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  const service = {
    create: record("create"),
    rename: record("rename"),
    addMember: record("addMember"),
    setMemberRole: record("setMemberRole"),
    setMemberAccess: record("setMemberAccess"),
    removeMember: record("removeMember"),
    updatePolicy: record("updatePolicy"),
    arm: record("arm"),
    stop: record("stop"),
    complete: record("complete"),
    ...overrides,
  } as CoordinationService
  return { service, calls }
}

async function mount(
  input: {
    groups?: CoordinationGroupView[] | undefined
    error?: string
    width?: number
    height?: number
    service?: CoordinationService
    filter?: NotificationFilter
    global?: GlobalDelegationView | undefined
    onFilterChange?: (filter: NotificationFilter) => void
  } = {},
) {
  const [groups, setGroups] = createSignal<CoordinationGroupView[] | undefined>("groups" in input ? input.groups : [release, docs])
  const [filter, setFilter] = createSignal<NotificationFilter>(input.filter ?? { scope: "all" })
  const recording = recordingService()
  const changes: NotificationFilter[] = []
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProjectsScreenContent
                    groups={groups}
                    error={() => input.error}
                    sessions={() => sessions}
                    service={input.service ?? recording.service}
                    filter={filter}
                    globalDelegation={() => ("global" in input ? input.global : openGlobal)}
                    onFilterChange={(next) => {
                      changes.push(next)
                      setFilter(next)
                      input.onFilterChange?.(next)
                    }}
                    now={() => now}
                  />
                </DialogProvider>
                <Toast />
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 100, height: input.height ?? 120, kittyKeyboard: true },
  )
  app.renderer.start()
  return { app, setGroups, setFilter, calls: recording.calls, changes }
}

type App = Awaited<ReturnType<typeof mount>>["app"]

const cursorLine = (app: App) => app.captureCharFrame().split("\n").find((line) => line.trimStart().startsWith("▸")) ?? ""

async function focus(app: App, label: string) {
  app.mockInput.pressKey("HOME")
  await app.renderOnce()
  for (let attempt = 0; attempt < 120; attempt++) {
    if (cursorLine(app).includes(label)) return
    app.mockInput.pressArrow("down")
    await app.renderOnce()
  }
  throw new Error(`The cursor never reached "${label}":\n${app.captureCharFrame()}`)
}

async function edit(app: App, label: string, text: string) {
  await focus(app, label)
  app.mockInput.pressEnter()
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  for (let index = 0; index < 160; index++) app.mockInput.pressBackspace()
  await app.mockInput.typeText(text)
  app.mockInput.pressEnter()
  await app.renderOnce()
}

async function activate(app: App, label: string) {
  await focus(app, label)
  app.mockInput.pressEnter()
  await app.renderOnce()
}

const row = (app: App, label: string) =>
  app.captureCharFrame().split("\n").find((line) => line.replace(/^\s*▸?\s*/, "").startsWith(label)) ?? ""

function toastText(frame: string) {
  return frame
    .split("\n")
    .map((line) => {
      const start = line.indexOf("│")
      const end = line.lastIndexOf("│")
      return start >= 0 && end > start ? line.slice(start + 1, end).trim() : ""
    })
    .filter(Boolean)
    .join(" ")
    .replaceAll("( ", "(")
}

async function toast(app: App, text: string) {
  await app.waitForFrame((frame) => toastText(frame).includes(text))
}

for (const width of [60, 80, 120]) {
  test(`one screen lists Projects and shows the selected project's sections without overflow at ${width} columns`, async () => {
    const { app } = await mount({ width })
    try {
      await app.waitForFrame((frame) => frame.includes("Release train"))
      const frame = app.captureCharFrame()
      for (const expected of [
        "Projects",
        "Release train",
        "armed",
        "Docs sweep",
        "disarmed",
        "+ New project",
        "Sessions",
        "Policy",
        "Work",
        "Notifications",
        "esc back",
        "r refresh",
      ])
        expect(frame).toContain(expected)
      for (const line of frame.split("\n")) expect(line.trimEnd().length).toBeLessThanOrEqual(width)
      expect(frame.split("\n").filter((line) => line.trimStart().startsWith("▸"))).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })
}

test("loading, load-error and empty states read explicitly and keep New project reachable", async () => {
  const loading = await mount({ groups: undefined })
  try {
    await loading.app.waitForFrame((frame) => frame.includes("Loading projects…"))
  } finally {
    loading.app.renderer.destroy()
  }
  const failed = await mount({ groups: undefined, error: "Projects could not be loaded: offline" })
  try {
    await failed.app.waitForFrame((frame) => frame.includes("could not be loaded: offline"))
    expect(failed.app.captureCharFrame()).not.toContain("Loading projects…")
  } finally {
    failed.app.renderer.destroy()
  }
  const empty = await mount({ groups: [] })
  try {
    await empty.app.waitForFrame((frame) => frame.includes("No projects"))
    expect(cursorLine(empty.app)).toContain("+ New project")
  } finally {
    empty.app.renderer.destroy()
  }
})

test("opening another project swaps the detail sections and marks the open project", async () => {
  const { app } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    expect(row(app, "● Release train")).toContain("armed")
    expect(app.captureCharFrame()).toContain("Refactor parser")
    await activate(app, "Docs sweep")
    const frame = app.captureCharFrame()
    expect(row(app, "● Docs sweep")).toContain("disarmed")
    expect(row(app, "Name")).toContain("Docs sweep")
    expect(frame).not.toContain("Refactor parser")
    expect(frame).toContain("Arm group")
    expect(frame).toContain("Nothing queued")
  } finally {
    app.renderer.destroy()
  }
})

test("details show status, capacity with the hard limit, queue reasons, leases and receipts", async () => {
  const { app } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    const frame = app.captureCharFrame()
    for (const expected of [
      "2/3 workers · hard limit 5",
      "waiting for a free worker slot",
      "src/parser.ts · held by Worker A · expires in 30s",
      "dispatched → Worker A",
      "5s ago",
      "queued → Worker B · waiting for a free worker slot",
      "1m ago",
    ])
      expect(frame).toContain(expected)
    expect(row(app, "Concurrency")).toContain("3")
    expect(row(app, "Queue capacity")).toContain("40")
    expect(row(app, "Budget")).toContain("$5.00")
  } finally {
    app.renderer.destroy()
  }
})

test("dispatch receipts and queued items show the chosen agent, honest variant and reason, not a transcript persona", async () => {
  const { app } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("agent omoikane · anthropic/claude-sonnet-5-5 · variant high · Needs deep reasoning")
    expect(frame).toContain("agent build · openai/gpt-6 (work) · variant unavailable · Quick lease check")
    const lines = frame.split("\n")
    const receipt = lines.findIndex((line) => line.includes("dispatched → Worker A"))
    expect(lines[receipt + 1]).toContain("agent omoikane")
    const queued = lines.findIndex((line) => line.includes("Refactor parser"))
    expect(lines[queued + 1]).toContain("agent build")
    expect(lines.filter((line) => line.includes("agent ")).every((line) => line.trimStart().startsWith("agent "))).toBe(true)
    expect(lines.filter((line) => line.includes("agent ")).join("\n")).not.toMatch(/Coordinator|Master|on your behalf/)
    expect(frame).not.toContain("Master")
  } finally {
    app.renderer.destroy()
  }
})

test("lifecycle actions follow the reported status and stop never claims to cancel workers", async () => {
  const { app, calls } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Stop dispatch · workers keep running")
    expect(frame).toContain("Complete project")
    expect(frame).not.toContain("Arm group")
    expect(frame).not.toContain("Re-arm group")
    await activate(app, "Stop dispatch · workers keep running")
    expect(calls).toEqual([["stop", "grp_release"]])
  } finally {
    app.renderer.destroy()
  }
  for (const [status, expected, absent] of [
    ["stopped", "Re-arm group", "Stop dispatch"],
    ["needs-rearm", "Re-arm group", "Stop dispatch"],
    ["waiting", "Stop dispatch · workers keep running", "Arm group"],
    ["completed", "Name", "Complete project"],
  ] as const) {
    const other = await mount({ groups: [{ ...release, status }] })
    try {
      await other.app.waitForFrame((frame) => frame.includes("Release train"))
      expect(other.app.captureCharFrame()).toContain(expected)
      expect(other.app.captureCharFrame()).not.toContain(absent)
      if (status === "completed") for (const gone of ["Arm group", "Re-arm group", "Stop dispatch"]) expect(other.app.captureCharFrame()).not.toContain(gone)
      if (status === "stopped") {
        await activate(other.app, "Re-arm group")
        expect(other.calls).toEqual([["arm", "grp_release"]])
      }
    } finally {
      other.app.renderer.destroy()
    }
  }
})

test("a pending lifecycle call blocks a second one and a failure keeps the action", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const recording = recordingService({
    arm: async (groupID: string) => {
      recording.calls.push(["arm", groupID])
      await gate
    },
  })
  const { app } = await mount({ service: recording.service, groups: [docs] })
  try {
    await app.waitForFrame((frame) => frame.includes("Docs sweep"))
    await activate(app, "Arm group")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(recording.calls).toEqual([["arm", "grp_docs"]])
    release()
  } finally {
    app.renderer.destroy()
  }
  const failing = recordingService({
    arm: async () => {
      throw new Error("coordinator offline")
    },
  })
  const second = await mount({ service: failing.service, groups: [docs] })
  try {
    await second.app.waitForFrame((frame) => frame.includes("Docs sweep"))
    await activate(second.app, "Arm group")
    await toast(second.app, "Failed to arm project: coordinator offline")
    expect(second.app.captureCharFrame()).toContain("Arm group")
  } finally {
    second.app.renderer.destroy()
  }
})

test("completing asks for confirmation, can be cancelled, and preserves a backend refusal", async () => {
  const recording = recordingService({
    complete: async (groupID: string) => {
      recording.calls.push(["complete", groupID])
      throw new Error("2 workers still hold leases")
    },
  })
  const { app } = await mount({ service: recording.service })
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    await activate(app, "Complete project")
    await app.waitForFrame((frame) => frame.includes("Complete Release train?"))
    app.mockInput.pressEscape()
    await app.renderOnce()
    expect(recording.calls).toEqual([])
    await activate(app, "Complete project")
    await app.waitForFrame((frame) => frame.includes("Complete Release train?"))
    app.mockInput.pressEnter()
    await toast(app, "Failed to complete project: 2 workers still hold leases")
    expect(recording.calls).toEqual([["complete", "grp_release"]])
    expect(app.captureCharFrame()).not.toContain("completed")
  } finally {
    app.renderer.destroy()
  }
})

test("renaming edits the name in place, refuses an empty name and cancels with escape", async () => {
  const { app, calls } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    await edit(app, "Name", "Shipping train")
    expect(calls).toEqual([["rename", "grp_release", "Shipping train"]])
    await edit(app, "Name", "   ")
    await toast(app, "Project name is required")
    expect(calls).toHaveLength(1)
    await focus(app, "Name")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("ignored")
    app.mockInput.pressEscape()
    await app.renderOnce()
    expect(calls).toHaveLength(1)
    expect(row(app, "Name")).toContain("Release train")
    expect(row(app, "Name")).not.toContain("ignored")
  } finally {
    app.renderer.destroy()
  }
})

test("sessions show roles, tools and scopes and expand into editable role, tools, scopes and removal", async () => {
  const { app } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    expect(row(app, "Worker A")).toContain("worker")
    expect(row(app, "Worker A")).toContain("tools read, grep")
    expect(row(app, "Watcher")).toContain("tools all")
    expect(app.captureCharFrame()).not.toContain("Allowed tools")
    await activate(app, "Worker A")
    const frame = app.captureCharFrame()
    for (const expected of ["Role", "Allowed tools", "Resource scopes", "Remove from project"]) expect(frame).toContain(expected)
    expect(row(app, "Resource scopes")).toContain("/repo/src/**")
  } finally {
    app.renderer.destroy()
  }
})

test("changing a role sends one targeted member change and keeps the coordinator rule", async () => {
  const { app, calls } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    await activate(app, "Worker A")
    await focus(app, "Role")
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(calls).toEqual([["setMemberRole", "grp_release", "ses_worker", "observer"]])
    await focus(app, "Role")
    app.mockInput.pressArrow("left")
    await app.renderOnce()
    app.mockInput.pressArrow("left")
    await app.renderOnce()
    expect(calls.at(-1)).toEqual(["setMemberRole", "grp_release", "ses_worker", "coordinator"])
  } finally {
    app.renderer.destroy()
  }
})

test("the only coordinator cannot be demoted or removed", async () => {
  const { app, calls } = await mount({ groups: [docs] })
  try {
    await app.waitForFrame((frame) => frame.includes("Docs sweep"))
    await activate(app, "Lead session")
    await focus(app, "Role")
    app.mockInput.pressArrow("right")
    await toast(app, "A group needs exactly one coordinator")
    await activate(app, "Remove from project")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Remove Lead session")
    expect(calls).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("editing tools and scopes sends only that member's access and an empty list means all", async () => {
  const { app, calls } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    await activate(app, "Worker A")
    await edit(app, "Allowed tools", "read, edit")
    expect(calls).toEqual([["setMemberAccess", "grp_release", "ses_worker", { allowedTools: ["read", "edit"] }]])
    await edit(app, "Resource scopes", "")
    expect(calls.at(-1)).toEqual(["setMemberAccess", "grp_release", "ses_worker", { resourceScopes: undefined }])
    await edit(app, "Allowed tools", "x".repeat(129))
    await toast(app, "Each tool name must be 1 to 128 characters")
    expect(calls).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
})

test("removing a session confirms first, and adding offers sessions outside the roster as workers", async () => {
  const { app, calls } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    expect(row(app, "Add session")).toContain("Fresh session")
    await activate(app, "Add session")
    expect(calls).toEqual([["addMember", "grp_release", "ses_fresh", "worker"]])
    await activate(app, "Watcher")
    await activate(app, "Remove from project")
    await app.waitForFrame((frame) => frame.includes("Remove Watcher from Release train?"))
    app.mockInput.pressEscape()
    await app.renderOnce()
    expect(calls).toHaveLength(1)
    await activate(app, "Remove from project")
    await app.waitForFrame((frame) => frame.includes("Remove Watcher from Release train?"))
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(calls.at(-1)).toEqual(["removeMember", "grp_release", "ses_watcher"])
  } finally {
    app.renderer.destroy()
  }
})

test("capacity edits send only the changed policy fields and an explicit uncapped choice shows the hard bound", async () => {
  const { app, calls } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    await edit(app, "Concurrency", "uncapped")
    expect(calls).toEqual([["updatePolicy", "grp_release", { concurrency: null }]])
    await edit(app, "Concurrency", "0")
    await toast(app, "Concurrency must be a whole number of at least 1, or uncapped")
    await edit(app, "Queue capacity", "75")
    expect(calls.at(-1)).toEqual(["updatePolicy", "grp_release", { queueCapacity: 75 }])
    await edit(app, "Queue capacity", "5000")
    await toast(app, "Queue capacity must be a whole number from 1 to 1000")
    await edit(app, "Budget", "none")
    expect(calls.at(-1)).toEqual(["updatePolicy", "grp_release", { budget: null }])
    expect(calls).toHaveLength(3)
  } finally {
    app.renderer.destroy()
  }
  const uncapped = await mount({ groups: [docs] })
  try {
    await uncapped.app.waitForFrame((frame) => frame.includes("Docs sweep"))
    expect(row(uncapped.app, "Concurrency")).toContain("uncapped policy · hard limit 5 applies")
  } finally {
    uncapped.app.renderer.destroy()
  }
})

test("delegated decisions show the global state and offer narrowing controls only", async () => {
  const { app, calls } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    expect(row(app, "Delegated decisions")).toContain("custom narrowing (permission)")
    expect(row(app, "Allow question")).toContain("off")
    expect(row(app, "Allow permission")).toContain("on")
    expect(row(app, "Actions")).toContain("shell:git status")
    expect(row(app, "Resources")).toContain("/repo/src/**")
    expect(row(app, "Expires")).toContain("in 2h")
    await activate(app, "Allow question")
    expect(calls).toEqual([
      [
        "updatePolicy",
        "grp_release",
        { delegatedDecisions: { ...delegatedDecisions, categories: ["question", "permission"] } },
      ],
    ])
    await activate(app, "Allow permission")
    expect(calls.at(-1)).toEqual([
      "updatePolicy",
      "grp_release",
      { delegatedDecisions: { ...delegatedDecisions, categories: [] } },
    ])
    await edit(app, "Actions", "shell:git status, shell:ls")
    expect(calls.at(-1)).toEqual([
      "updatePolicy",
      "grp_release",
      { delegatedDecisions: { ...delegatedDecisions, actions: ["shell:git status", "shell:ls"] } },
    ])
    await edit(app, "Expires", "30m")
    expect(calls.at(-1)).toEqual([
      "updatePolicy",
      "grp_release",
      { delegatedDecisions: { ...delegatedDecisions, expiresAt: now + 30 * 60_000 } },
    ])
    await activate(app, "Delegated decisions")
    expect(calls.at(-1)).toEqual(["updatePolicy", "grp_release", { delegatedDecisions: null }])
  } finally {
    app.renderer.destroy()
  }
})

test("an inheriting project switches to custom narrowing within what the global policy allows", async () => {
  const { app, calls } = await mount({
    groups: [docs],
    global: { enabled: true, categories: ["permission"], actions: ["shell:ls"], expiresAt: now + 3_600_000 },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Docs sweep"))
    expect(row(app, "Delegated decisions")).toContain("inherit global (permission)")
    await activate(app, "Delegated decisions")
    expect(calls).toEqual([["updatePolicy", "grp_docs", { delegatedDecisions: { categories: ["permission"] } }]])
  } finally {
    app.renderer.destroy()
  }
  const custom = await mount({
    groups: [{ ...docs, policy: { concurrency: null, queueCapacity: 20, delegatedDecisions: { categories: ["permission"] } } }],
    global: { enabled: true, categories: ["permission"], actions: ["shell:ls"], expiresAt: now + 3_600_000 },
  })
  try {
    await custom.app.waitForFrame((frame) => frame.includes("Docs sweep"))
    expect(row(custom.app, "Allow question")).toContain("not allowed globally")
    await activate(custom.app, "Allow question")
    await toast(custom.app, "question is not allowed by the global policy (permission)")
    await edit(custom.app, "Actions", "shell:rm")
    await toast(custom.app, "Actions must stay within the global policy: shell:ls")
    await edit(custom.app, "Expires", "2h")
    await toast(custom.app, "Expiry cannot be later than the global policy allows")
    expect(custom.calls).toEqual([])
  } finally {
    custom.app.renderer.destroy()
  }
})

test("a globally disabled or unavailable delegation policy is reported and exposes no controls", async () => {
  const disabled = await mount({ global: { enabled: false, categories: [] } })
  try {
    await disabled.app.waitForFrame((frame) => frame.includes("Release train"))
    expect(row(disabled.app, "Delegated decisions")).toContain("globally disabled")
    expect(disabled.app.captureCharFrame()).not.toContain("Allow permission")
    await activate(disabled.app, "Delegated decisions")
    await toast(disabled.app, "Delegated decisions are disabled by the global policy")
    expect(disabled.calls).toEqual([])
  } finally {
    disabled.app.renderer.destroy()
  }
  const unavailable = await mount({ global: undefined })
  try {
    await unavailable.app.waitForFrame((frame) => frame.includes("Release train"))
    expect(row(unavailable.app, "Delegated decisions")).toContain("global policy unavailable")
    expect(unavailable.app.captureCharFrame()).not.toContain("Allow permission")
    await activate(unavailable.app, "Delegated decisions")
    await toast(unavailable.app, "The global delegation policy is unavailable")
    expect(unavailable.calls).toEqual([])
  } finally {
    unavailable.app.renderer.destroy()
  }
})

test("notification filters persist scope, coordinator Sessions and categories from the same screen", async () => {
  const { app, changes } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    expect(row(app, "External scope")).toContain("all sessions")
    await activate(app, "External scope")
    expect(changes.at(-1)).toEqual({ scope: "coordinators" })
    expect(row(app, "External scope")).toContain("all coordinators")
    await activate(app, "External scope")
    expect(changes.at(-1)).toEqual({ scope: "selected", sessionIDs: [] })
    expect(row(app, "External scope")).toContain("no coordinators selected")
    await activate(app, "Coordinator: Lead session")
    expect(changes.at(-1)).toEqual({ scope: "selected", sessionIDs: ["ses_lead"] })
    expect(row(app, "Coordinator: Lead session")).toContain("selected")
    expect(app.captureCharFrame()).not.toContain("Coordinator: Worker A")
    await activate(app, "Category: failure")
    expect(changes.at(-1)).toEqual({
      scope: "selected",
      sessionIDs: ["ses_lead"],
      categories: ["question", "permission", "review", "completion"],
    })
    expect(row(app, "Category: failure")).toContain("off")
    await activate(app, "External scope")
    expect(changes.at(-1)).toMatchObject({ scope: "all" })
  } finally {
    app.renderer.destroy()
  }
})

test("an unavailable coordinator list keeps the explicit scope and says delivery is withheld", async () => {
  const { app } = await mount({ groups: undefined, filter: { scope: "coordinators" } })
  try {
    await app.waitForFrame((frame) => frame.includes("External scope"))
    expect(row(app, "External scope")).toContain("all coordinators · list unavailable")
    expect(row(app, "External scope")).toContain("delivery withheld")
  } finally {
    app.renderer.destroy()
  }
})

test("creating a project names it, picks the coordinator Session and submits one coordinator", async () => {
  const { app, calls } = await mount()
  try {
    await app.waitForFrame((frame) => frame.includes("Release train"))
    await activate(app, "+ New project")
    await app.waitForFrame((frame) => frame.includes("Create project"))
    expect(app.captureCharFrame()).not.toContain("Refactor parser")
    await activate(app, "Create project")
    await toast(app, "Project name is required")
    expect(calls).toEqual([])
    await edit(app, "Name", "Nightly build")
    expect(row(app, "Coordinator session")).toContain("Lead session")
    await focus(app, "Coordinator session")
    app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(row(app, "Coordinator session")).toContain("Worker A")
    await activate(app, "Create project")
    expect(calls).toEqual([
      ["create", { name: "Nightly build", roster: [{ sessionID: "ses_worker", role: "coordinator" }] }],
    ])
  } finally {
    app.renderer.destroy()
  }
  const cancelled = await mount()
  try {
    await cancelled.app.waitForFrame((frame) => frame.includes("Release train"))
    await activate(cancelled.app, "+ New project")
    await activate(cancelled.app, "Cancel")
    await cancelled.app.waitForFrame((frame) => frame.includes("Refactor parser"))
    expect(cancelled.calls).toEqual([])
  } finally {
    cancelled.app.renderer.destroy()
  }
})
