/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { readableTint } from "../../../src/theme/component"
import { ProjectsScreenContent } from "../../../src/routes/session/projects"
import { ProjectMembers } from "../../../src/routes/session/project-members"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import type { ProjectView, ProjectService, ProjectSessionChoice } from "../../../src/util/coordination"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const member = (
  id: string,
  title: string,
  role: "master" | "member",
  state: "running" | "idle" | "waiting" | "failed" = "idle",
) => ({ sessionID: id, title, role, state, directory: `/repo/${id}`, lastActivity: 0, pending: 0 })
export const release: ProjectView = {
  id: "cgrp_release",
  name: "Release train",
  revision: 1,
  active: true,
  concurrency: 2,
  created: 0,
  master: member("ses_lead", "Lead", "master", "running"),
  members: [
    member("ses_docs", "Docs worker", "member"),
    { ...member("ses_api", "Api worker", "member", "running"), drivenBy: "Migration agent" },
    member("ses_infra", "Infra worker", "member", "waiting"),
  ],
}

const probe: { theme?: ReturnType<typeof useTheme>["theme"] } = {}
function Canvas(props: { paint?: boolean; children: JSX.Element }) {
  const { theme } = useTheme()
  probe.theme = theme
  return props.paint ? (
    <box backgroundColor={theme.background.default} width="100%" height="100%">
      {props.children}
    </box>
  ) : (
    props.children
  )
}

async function mount(
  input: {
    projects?: ProjectView[]
    error?: string
    width?: number
    height?: number
    members?: boolean
    project?: ProjectView
    compact?: boolean
    paneWidth?: number
    settings?: boolean
    mode?: "dark" | "light"
    service?: Partial<ProjectService>
    sessions?: ProjectSessionChoice[]
  } = {},
) {
  const calls: Array<[string, ...unknown[]]> = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  const service: ProjectService = {
    create: async (value) => {
      calls.push(["create", value])
      return "ses_new"
    },
    rename: record("rename"),
    setMaster: record("master"),
    setConcurrency: record("concurrency"),
    setDelegation: record("delegation"),
    addMember: record("add"),
    newMember: async (...args) => {
      calls.push(["new", ...args])
      return "ses_new"
    },
    removeMember: record("remove"),
    deleteMember: record("delete"),
    deleteProject: record("deleteProject"),
  }
  Object.assign(service, input.service)
  const [focused, focus] = createSignal(true)
  const sessions = () =>
    input.sessions ?? [
      { sessionID: "ses_lead", title: "Lead", directory: "/repo/api", updated: 1, projectName: "Release train" },
      { sessionID: "ses_spare", title: "Spare", directory: "/repo/docs", updated: 2 },
    ]
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <Keymap.Provider>
            <ThemeProvider mode={input.mode ?? "dark"} source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <Canvas paint={input.members}>
                    {input.members ? (
                      <box width={input.paneWidth ?? "100%"} height="100%">
                        <ProjectMembers
                          project={input.project ?? release}
                          currentSessionID="ses_lead"
                          focused={focused()}
                          onFocus={() => focus(true)}
                          onBack={() => focus(false)}
                          onOpen={(id) => calls.push(["open", id])}
                          onSettings={() => calls.push(["settings"])}
                          sessions={sessions}
                          service={service}
                          now={() => 60_000}
                          loadedAt={() => 57_000}
                          compact={input.compact ?? (input.width ?? 120) < 100}
                        />
                      </box>
                    ) : (
                      <ProjectsScreenContent
                        projects={() => input.projects}
                        error={() => input.error}
                        sessions={sessions}
                        service={service}
                        filter={() => ({ scope: "all" })}
                        globalDelegation={() => ({ enabled: true, categories: ["permission", "review"] })}
                        onFilterChange={(value) => {
                          calls.push(["filter", value])
                        }}
                        onOpen={(id) => calls.push(["open", id])}
                        onBack={() => calls.push(["back"])}
                        onRefresh={() => calls.push(["refresh"])}
                        initialSettings={input.settings ? release.id : undefined}
                        now={() => 60_000}
                        loadedAt={() => 57_000}
                      />
                    )}
                  </Canvas>
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 120, height: input.height ?? 40, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(input.members ? "MEMBERS 3" : "Projects"))
  return { app, calls, theme: probe.theme! }
}
type App = Awaited<ReturnType<typeof mount>>["app"]
async function key(app: App, name: string) {
  if (["DOWN", "UP", "LEFT", "RIGHT"].includes(name))
    app.mockInput.pressArrow(name.toLowerCase() as "down" | "up" | "left" | "right")
  else if (name === "SHIFT+D") app.mockInput.pressKey("d", { shift: true })
  else app.mockInput.pressKey(name)
  await app.renderOnce()
  await app.renderOnce()
}
async function focus(app: App, label: string) {
  await key(app, "HOME")
  for (let i = 0; i < 40; i++) {
    if (
      app
        .captureCharFrame()
        .split("\n")
        .some((line) => line.includes(`▸ ${label}`))
    )
      return
    await key(app, "DOWN")
  }
  throw new Error(`Missing row ${label}:\n${app.captureCharFrame()}`)
}
async function edit(app: App, text: string) {
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  for (let i = 0; i < 120; i++) app.mockInput.pressBackspace()
  await app.mockInput.typeText(text)
  app.mockInput.pressEnter()
  await app.renderOnce()
}

async function capturePicker(app: App, name: string) {
  if (!process.env.PROJECTS_CAPTURE_DIR) return
  await Bun.write(`${process.env.PROJECTS_CAPTURE_DIR}/${name}.txt`, app.captureCharFrame())
}

for (const [name, projects, error] of [
  ["loading", undefined, undefined],
  ["empty", [], undefined],
  ["error", undefined, "Offline"],
] as const) {
  test(`Projects ${name} keeps New project and contextual controls reachable`, async () => {
    const { app } = await mount({ projects: projects ? [...projects] : undefined, error })
    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain(name === "loading" ? "Loading projects…" : name === "empty" ? "No projects" : "Offline")
      expect(frame).toContain("[n] + New project")
      expect(frame).toContain("? keys")
      if (error) expect(frame).toContain("[r] Retry")
    } finally {
      app.renderer.destroy()
    }
  })
}
test("Projects list shows master preview, meter and opens the master", async () => {
  const { app, calls } = await mount({ projects: [release] })
  try {
    expect(app.captureCharFrame()).toContain("MASTER")
    expect(app.captureCharFrame()).toContain("Migration agent")
    expect(app.captureCharFrame()).toContain("1/2 members running")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(calls).toContainEqual(["open", "ses_lead"])
  } finally {
    app.renderer.destroy()
  }
})
test("narrow list omits preview and question mark opens contextual keys", async () => {
  const { app } = await mount({ projects: [release], width: 80 })
  try {
    expect(app.captureCharFrame()).not.toContain("preview")
    await key(app, "?")
    expect(app.captureCharFrame()).toContain("Project keys")
  } finally {
    app.renderer.destroy()
  }
})
test("create with existing master excludes occupied Sessions and opens after success", async () => {
  const { app, calls } = await mount({ projects: [release] })
  try {
    await key(app, "n")
    await edit(app, "Q4 planning")
    await focus(app, "Spare")
    app.mockInput.pressEnter()
    await app.renderOnce()
    await key(app, "c")
    await app.waitFor(() => calls.some(([name]) => name === "open"))
    expect(calls).toContainEqual(["create", { name: "Q4 planning", master: { sessionID: "ses_spare" } }])
    expect(calls).toContainEqual(["open", "ses_new"])
  } finally {
    app.renderer.destroy()
  }
})
test("create with new master accepts directory and title", async () => {
  const { app, calls } = await mount({ projects: [release] })
  try {
    await key(app, "n")
    await edit(app, "Q4 planning")
    await focus(app, "Master source")
    await key(app, "RIGHT")
    await focus(app, "Directory")
    app.mockInput.pressEnter()
    await edit(app, "/repo/new")
    await key(app, "c")
    await app.waitFor(() => calls.some(([name]) => name === "create"))
    expect(calls).toContainEqual(["create", { name: "Q4 planning", master: { directory: "/repo/new" } }])
  } finally {
    app.renderer.destroy()
  }
})
test("project deletion confirms retention of Session histories", async () => {
  const { app, calls } = await mount({ projects: [release] })
  try {
    await key(app, "SHIFT+D")
    expect(app.captureCharFrame()).toContain("Delete Release train?")
    expect(app.captureCharFrame()).toContain("keep their histories")
    expect(calls).toEqual([])
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(calls).toContainEqual(["deleteProject", release.id])
  } finally {
    app.renderer.destroy()
  }
})
test("Settings edits save on Enter and cancel without a write", async () => {
  const { app, calls } = await mount({ projects: [release], settings: true })
  try {
    await focus(app, "Concurrency")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await key(app, "ESCAPE")
    expect(calls).toEqual([])
    app.mockInput.pressEnter()
    await edit(app, "4")
    expect(calls).toContainEqual(["concurrency", release.id, 4])
    await focus(app, "Master")
    await key(app, "RIGHT")
    expect(calls).toContainEqual(["master", release.id, "ses_docs"])
    await key(app, "TAB")
    expect(app.captureCharFrame()).toContain("MEMBERS")
  } finally {
    app.renderer.destroy()
  }
})
test("members pin and protect MASTER; open a member and show contextual hints", async () => {
  const { app, calls } = await mount({ members: true })
  try {
    let frame = app.captureCharFrame()
    expect(frame.indexOf("Lead")).toBeLessThan(frame.indexOf("Docs worker"))
    expect(frame).toContain("(x) Remove")
    expect(frame).toContain("master: change it in Settings")
    await key(app, "x")
    expect(calls).toEqual([])
    await key(app, "DOWN")
    await key(app, "o")
    expect(calls).toContainEqual(["open", "ses_docs"])
    expect(app.captureCharFrame()).toContain("[x] Remove")
  } finally {
    app.renderer.destroy()
  }
})
test("remove and delete members have distinct confirmations and operations", async () => {
  const { app, calls } = await mount({ members: true })
  try {
    await key(app, "DOWN")
    await key(app, "x")
    expect(app.captureCharFrame()).toContain("keeps its history")
    await key(app, "ESCAPE")
    expect(calls).toEqual([])
    await key(app, "SHIFT+D")
    expect(app.captureCharFrame()).toContain("cannot be undone")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(calls).toContainEqual(["delete", release.id, "ses_docs"])
  } finally {
    app.renderer.destroy()
  }
})
test("member add and new flows stay in place", async () => {
  const { app, calls } = await mount({ members: true })
  try {
    await key(app, "a")
    await focus(app, "Spare")
    app.mockInput.pressEnter()
    await app.renderOnce()
    await app.waitFor(() => calls.some(([name]) => name === "add"))
    expect(calls).toContainEqual(["add", release.id, "ses_spare"])
    await key(app, "n")
    await edit(app, "/repo/new")
    await key(app, "c")
    await app.waitFor(() => calls.some(([name]) => name === "new"))
    expect(calls).toContainEqual(["new", release.id, "/repo/new", undefined])
  } finally {
    app.renderer.destroy()
  }
})
test("narrow members retain state and open actions, dropping directory below 80", async () => {
  const { app } = await mount({ members: true, width: 60 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("MEMBERS 3")
    expect(frame).toContain("MASTER")
    expect(frame).toContain("running")
    expect(frame).not.toContain("/repo/")
    await key(app, "DOWN")
    expect(app.captureCharFrame()).toContain("[o] Open")
  } finally {
    app.renderer.destroy()
  }
})

test("failed creation retains the name and the form for a safe retry", async () => {
  const { app } = await mount({
    projects: [release],
    service: {
      create: async () => {
        throw new Error("Write blocked")
      },
    },
  })
  try {
    await key(app, "n")
    await edit(app, "Delivery")
    await focus(app, "Spare")
    app.mockInput.pressEnter()
    await app.renderOnce()
    await key(app, "c")
    await app.waitForFrame((frame) => frame.includes("Failed to create project: Write blocked"))
    expect(app.captureCharFrame()).toContain("Delivery")
    expect(app.captureCharFrame()).toContain("NEW PROJECT")
  } finally {
    app.renderer.destroy()
  }
})

test("create validates the required master without using an occupied Session", async () => {
  const { app, calls } = await mount({ projects: [release] })
  try {
    await key(app, "n")
    await edit(app, "Delivery")
    await focus(app, "Lead")
    app.mockInput.pressEnter()
    await app.renderOnce()
    await key(app, "c")
    expect(app.captureCharFrame()).toContain("Choose a master Session")
    expect(calls).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("mouse member navigation and remove confirmation use the keyboard operations", async () => {
  const { app, calls } = await mount({ members: true })
  try {
    const rows = app.captureCharFrame().split("\n")
    const y = rows.findIndex((row) => row.includes("Docs worker"))
    const x = rows[y]!.indexOf("Docs worker")
    await app.mockMouse.click(x, y)
    await app.renderOnce()
    expect(calls).toContainEqual(["open", "ses_docs"])
    await key(app, "x")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(calls).toContainEqual(["remove", release.id, "ses_docs"])
  } finally {
    app.renderer.destroy()
  }
})

test("Settings exposes inheritance and notification scope as separate sections", async () => {
  const { app, calls } = await mount({ projects: [release], settings: true })
  try {
    await key(app, "TAB")
    await key(app, "TAB")
    expect(app.captureCharFrame()).toContain("inherit global (permission, review)")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(calls).toContainEqual(["delegation", release.id, { categories: ["permission", "review"] }])
    await key(app, "TAB")
    await key(app, "RIGHT")
    expect(calls).toContainEqual(["filter", { scope: "coordinators" }])
  } finally {
    app.renderer.destroy()
  }
})

for (const mode of ["dark", "light"] as const)
  for (const width of [60, 79, 80, 99, 100, 119, 120]) {
    test(`Project list fits ${width} columns in ${mode} mode`, async () => {
      const { app } = await mount({ projects: [release], width, mode })
      try {
        const frame = app.captureCharFrame()
        expect(frame).toContain("Release train")
        expect(frame.includes("preview")).toBe(width >= 120)
        expect(frame.split("\n").every((line) => line.length <= width)).toBe(true)
      } finally {
        app.renderer.destroy()
      }
    })
  }

const luminance = ([red, green, blue]: number[]) => {
  const channel = (value: number) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!)
}
const contrast = (first: number[], second: number[]) => {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (light! + 0.05) / (dark! + 0.05)
}
const lineOf = (frame: string, ...needles: string[]) =>
  frame.split("\n").find((line) => needles.every((needle) => line.includes(needle))) ?? ""

for (const width of [80, 100, 120]) {
  test(`list header cells sit over their row cells at ${width} columns`, async () => {
    const { app } = await mount({ projects: [release], width })
    try {
      const frame = app.captureCharFrame()
      const header = lineOf(frame, "PROJECT", "STATUS")
      const row = lineOf(frame, "Release train", "● active")
      expect(header.indexOf("STATUS")).toBe(row.indexOf("● active"))
      expect(header.indexOf("MASTER")).toBe(row.indexOf("Lead"))
      expect(header.indexOf("MEMBERS")).toBe(row.indexOf("Lead") + 9)
      expect(row.slice(header.indexOf("MEMBERS"), header.indexOf("LIVE")).trim()).toBe("3")
      expect(row.indexOf("●2")).toBe(header.indexOf("LIVE"))
    } finally {
      app.renderer.destroy()
    }
  })
}

test("member counts leave the Master out and name it separately", async () => {
  const { app } = await mount({ projects: [release] })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("MEMBERS 3 + MASTER")
    expect(frame).toContain("MEMBERS excludes the Master · LIVE includes it")
    expect(lineOf(frame, "Release train", "● active")).toContain("●2 ?1 ○1")
  } finally {
    app.renderer.destroy()
  }
})

test("the members pane counts members without the Master and labels the Master apart", async () => {
  const { app } = await mount({ members: true })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("MEMBERS 3 + MASTER")
    expect(frame).not.toContain("MEMBERS 4")
  } finally {
    app.renderer.destroy()
  }
})

test("the Name field draws typed text and its cursor with readable contrast", async () => {
  const { app } = await mount({ projects: [release] })
  try {
    await key(app, "n")
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("Q4 planning")
    await app.renderOnce()
    const span = app
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((item) => item.text.includes("Q4 planning"))!
    expect(contrast(span.fg.toInts(), span.bg.toInts())).toBeGreaterThanOrEqual(4.5)
    const editor = app.renderer.currentFocusedEditor as InputRenderable
    expect(contrast(editor.cursorColor.toInts(), span.bg.toInts())).toBeGreaterThanOrEqual(3)
  } finally {
    app.renderer.destroy()
  }
})

const paused: ProjectView = {
  id: "cgrp_docs",
  name: "Docs sprint",
  revision: 1,
  active: false,
  concurrency: null,
  created: 0,
  master: member("ses_docs_lead", "Scribe", "master", "idle"),
  members: [
    member("ses_docs_a", "Draft worker", "member", "failed"),
    member("ses_docs_b", "Review worker", "member", "waiting"),
  ],
}
const spansOf = (app: App, ...needles: string[]) =>
  app
    .captureSpans()
    .lines.map((line) => line.spans)
    .find((spans) =>
      needles.every((needle) =>
        spans
          .map((item) => item.text)
          .join("")
          .includes(needle),
      ),
    ) ?? []
const spanOf = (app: App, line: string[], needle: string) => {
  const found = spansOf(app, ...line).find((item) => item.text.includes(needle))
  if (!found) throw new Error(`Missing ${needle} on ${line.join(" ")}:\n${app.captureCharFrame()}`)
  return found
}
const readable = (item: { fg: { toInts(): number[] }; bg: { toInts(): number[] } }) =>
  contrast(item.fg.toInts(), item.bg.toInts())
const expectReadable = (item: { text: string; fg: { toInts(): number[] }; bg: { toInts(): number[] } }) =>
  /^[\s│┃─╭╮╰╯┌┐└┘├┤█░▌▐▀▄]+$/.test(item.text) ||
  expect({ text: item.text, readable: readable(item) >= 4.5 }).toEqual({ text: item.text, readable: true })
const colorIs = (item: { fg: { toInts(): number[] } }, color: { toInts(): number[] }) =>
  item.fg.toInts().join() === color.toInts().join()

for (const mode of ["dark", "light"] as const) {
  test(`Project list, legend and preview color each state with readable ink in ${mode} mode`, async () => {
    const { app, theme } = await mount({ projects: [release, paused], width: 160, mode })
    try {
      const semantic = {
        running: readableTint(theme.text.feedback.success.default, theme.background.default),
        waiting: readableTint(theme.text.feedback.warning.default, theme.background.default),
        failed: readableTint(theme.text.feedback.error.default, theme.background.default),
        idle: readableTint(theme.text.subdued, theme.background.default),
      }
      const other = ["Docs sprint", "○ paused"]
      expect(colorIs(spanOf(app, other, "○ paused"), semantic.idle)).toBe(true)
      expect(colorIs(spanOf(app, other, "?1"), semantic.waiting)).toBe(true)
      expect(colorIs(spanOf(app, other, "✗1"), semantic.failed)).toBe(true)
      expect(colorIs(spanOf(app, other, "○1"), semantic.idle)).toBe(true)
      expectReadable(spanOf(app, other, "›"))
      for (const item of app.captureSpans().lines.flatMap((line) => line.spans)) expectReadable(item)

      const selected = ["Release train", "● active"]
      const fill = theme.background.action.primary.focused.toInts().join()
      for (const item of spansOf(app, ...selected).filter(
        (item) => item.text.trim() && item.bg.toInts().join() === fill,
      ))
        expectReadable(item)
      expect(spanOf(app, selected, "● active").bg.toInts().join()).toBe(fill)
      for (const text of ["● active", "●2", "?1", "○"])
        expect(colorIs(spanOf(app, selected, text), theme.text.action.primary.focused)).toBe(true)

      const legendLive = ["LIVE", "running"]
      const legend = [
        colorIs(spanOf(app, legendLive, "● running"), semantic.running),
        colorIs(spanOf(app, legendLive, "○ idle"), semantic.idle),
        colorIs(spanOf(app, legendLive, "? waiting on you"), semantic.waiting),
        colorIs(spanOf(app, legendLive, "✗ failed"), semantic.failed),
        colorIs(spanOf(app, ["STATUS", "paused"], "● active"), semantic.running),
        colorIs(spanOf(app, ["STATUS", "paused"], "○ paused"), semantic.idle),
      ]
      expect(legend).toEqual([true, true, true, true, true, true])

      expect(colorIs(spanOf(app, ["Status", "active"], "● active"), semantic.running)).toBe(true)
      expect(colorIs(spanOf(app, ["MASTER", "Lead"], "running"), semantic.running)).toBe(true)
      expect(colorIs(spanOf(app, ["MEMBER", "waiting"], "waiting"), semantic.waiting)).toBe(true)
      expect(colorIs(spanOf(app, ["MEMBER", "idle"], "idle"), semantic.idle)).toBe(true)

      for (const title of ["PROJECTS 2", "LEGEND", "Release train · preview"])
        expectReadable(spanOf(app, [title], title))
    } finally {
      app.renderer.destroy()
    }
  })

  test(`Project members color each state and keep selected rows readable in ${mode} mode`, async () => {
    const { app, theme } = await mount({ members: true, mode })
    try {
      const semantic = {
        running: readableTint(theme.text.feedback.success.default, theme.background.default),
        waiting: readableTint(theme.text.feedback.warning.default, theme.background.default),
        idle: readableTint(theme.text.subdued, theme.background.default),
      }
      for (const [state] of [["running"], ["waiting"], ["idle"]] as const)
        expect(colorIs(spanOf(app, ["MEMBER", state], state), semantic[state])).toBe(true)
      expect(app.captureCharFrame()).not.toContain("›")
      for (const item of spansOf(app, "▸", "Lead").filter((item) => item.text.trim())) expectReadable(item)
      expectReadable(spanOf(app, ["MEMBERS 3"], "MEMBERS 3"))
    } finally {
      app.renderer.destroy()
    }
  })
}

const longTitles = [
  "Reconcile the quarterly billing exports with the ledger snapshots",
  "Migrate the notification preferences service to the new queue",
]
const longRoster: ProjectView = {
  ...release,
  master: member("ses_lead", "Lead", "master", "running"),
  members: [
    { ...member("ses_ledger", longTitles[0]!, "member"), directory: "/repo/services/finance/ledger-reconciliation" },
    { ...member("ses_queue", longTitles[1]!, "member", "waiting"), directory: "/repo/services/notifications" },
    member("ses_docs", "Docs worker", "member"),
  ],
}
const widest = (frame: string) => Math.max(...frame.split("\n").map((line) => line.trimEnd().length))

for (const compact of [true, false]) {
  test(`unselected members carry no trailing chevron in the ${compact ? "compact" : "docked"} roster`, async () => {
    const { app } = await mount({ members: true, project: longRoster, compact, width: compact ? 200 : 120 })
    try {
      expect(app.captureCharFrame()).not.toContain("›")
      expect(app.captureCharFrame()).toContain("[o] Open")
      await key(app, "DOWN")
      expect(app.captureCharFrame()).not.toContain("›")
      expect(lineOf(app.captureCharFrame(), "[o] Open")).toContain("▸")
    } finally {
      app.renderer.destroy()
    }
  })
}

test("a wide compact roster gives titles and directories the spare pane width and keeps roles apart", async () => {
  const { app } = await mount({ members: true, project: longRoster, compact: true, width: 200 })
  try {
    const frame = app.captureCharFrame()
    for (const title of longTitles) {
      const line = lineOf(frame, title)
      expect(line).not.toBe("")
      expect(line).toMatch(new RegExp(`${title}\\s{2,}MEMBER`))
    }
    expect(lineOf(frame, "Docs worker")).toMatch(/Docs worker\s{2,}MEMBER/)
    expect(lineOf(frame, longTitles[0]!)).toContain("/repo/services/finance/ledger-reconciliation")
    expect(frame).not.toContain("…")
  } finally {
    app.renderer.destroy()
  }
})

test("a narrow compact roster truncates long titles inside the pane and keeps role, state and Open", async () => {
  const { app } = await mount({ members: true, project: longRoster, compact: true, width: 80 })
  try {
    const frame = app.captureCharFrame()
    expect(widest(frame)).toBeLessThanOrEqual(80)
    const line = lineOf(frame, "Reconcile")
    expect(line).toContain("…")
    expect(line).toMatch(/…\s+MEMBER/)
    expect(lineOf(frame, "MEMBER", "waiting")).toContain("waiting")
    expect(lineOf(frame, "[o] Open")).toContain("▸")
  } finally {
    app.renderer.destroy()
  }
})

test("the docked roster fits its pane and reserves room for Open on the selected title", async () => {
  const { app } = await mount({ members: true, project: longRoster, compact: false, width: 120 })
  try {
    await key(app, "DOWN")
    const frame = app.captureCharFrame()
    const selected = lineOf(frame, "[o] Open")
    expect(selected).toContain("Reconcile")
    expect(selected).toMatch(/…\s+\[o\] Open/)
    expect(selected.trimEnd().length).toBeLessThanOrEqual(33)
  } finally {
    app.renderer.destroy()
  }
})

test("a roster docked narrower than the terminal sizes its columns to the pane, not the terminal", async () => {
  const { app } = await mount({ members: true, project: longRoster, compact: true, width: 200, paneWidth: 90 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const line = lineOf(frame, "Reconcile")
    expect(
      widest(
        frame
          .split("\n")
          .map((row) => row.slice(0, 90))
          .join("\n"),
      ),
    ).toBeLessThanOrEqual(90)
    expect(frame.split("\n").every((row) => row.slice(90).trim() === "")).toBe(true)
    expect(line).toContain("…")
    expect(line).toMatch(/…\s+MEMBER/)
    expect(lineOf(frame, "[o] Open").indexOf("[o] Open")).toBeLessThan(90)
  } finally {
    app.renderer.destroy()
  }
})

test("roster selection and opening follow the keyboard and mouse after the layout change", async () => {
  const { app, calls } = await mount({ members: true, project: longRoster, compact: true, width: 200 })
  try {
    await key(app, "DOWN")
    await key(app, "DOWN")
    expect(lineOf(app.captureCharFrame(), "▸", longTitles[1]!)).toContain(longTitles[1]!)
    app.mockInput.pressKey("o")
    await app.renderOnce()
    expect(calls).toContainEqual(["open", "ses_queue"])
  } finally {
    app.renderer.destroy()
  }
})

const ycodingDirectory = "/home/dev/Workspace/clients/acme-corp/services/platform/ycoding"
const otherDirectory = "/home/dev/Workspace/clients/acme-corp/services/platform/other-tool"
const longTitle = "Refactor the authentication middleware for the session gateway"
const pickerSessions: ProjectSessionChoice[] = [
  { sessionID: "ses_a", title: longTitle, directory: ycodingDirectory, updated: 200 },
  { sessionID: "ses_b", title: longTitle, directory: otherDirectory, updated: 199 },
  {
    sessionID: "ses_held",
    title: "Held elsewhere",
    directory: "/home/dev/held",
    updated: 198,
    projectName: "Release train",
  },
  ...Array.from({ length: 70 }, (_, index) => ({
    sessionID: `ses_n${index}`,
    title: `Task ${String(index).padStart(2, "0")}`,
    directory: `/repo/svc-${String(index).padStart(2, "0")}`,
    updated: index,
  })),
]

test("new Project picker narrows as the query is typed and keeps the path tail and full title", async () => {
  const { app } = await mount({ projects: [release], sessions: pickerSessions })
  try {
    await key(app, "n")
    await edit(app, "Q4 planning")
    await focus(app, "Find")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("ycoding")
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(lineOf(frame, "Find", "ycoding")).not.toBe("")
    expect(frame).not.toContain("Task 05")
    expect(frame).not.toContain("other-tool")
    expect(frame).not.toContain("Held elsewhere")
    const row = lineOf(frame, "Refactor the")
    expect(row).toContain(longTitle)
    expect(frame.split("\n")[frame.split("\n").indexOf(row) + 1]).toContain("platform/ycoding")
    app.mockInput.pressEnter()
    await app.renderOnce()
    await key(app, "DOWN")
    expect(app.captureCharFrame()).toContain(longTitle)
    expect(app.captureCharFrame()).toContain(ycodingDirectory)
  } finally {
    app.renderer.destroy()
  }
})

test("new Project picker bounds a long Session list and keeps the form actions reachable", async () => {
  const { app } = await mount({ projects: [release], sessions: pickerSessions })
  try {
    await key(app, "n")
    await edit(app, "Q4 planning")
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Task 60")
    expect(frame.split("\n").every((line) => line.length <= 120)).toBe(true)
    await key(app, "END")
    expect(app.captureCharFrame()).toContain("23 more · type to narrow")
    expect(app.captureCharFrame()).toContain("▸ [esc] Cancel")
  } finally {
    app.renderer.destroy()
  }
})

test("new Project picker names an empty result", async () => {
  const { app } = await mount({ projects: [release], sessions: pickerSessions })
  try {
    await key(app, "n")
    await edit(app, "Q4 planning")
    await focus(app, "Find")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("zzzz")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("No matching Sessions")
  } finally {
    app.renderer.destroy()
  }
})

test("add-member picker narrows as the query is typed and keeps the path tail and full title", async () => {
  const { app, calls } = await mount({ members: true, sessions: pickerSessions })
  try {
    await key(app, "a")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.mockInput.typeText("ycoding")
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(lineOf(frame, "Find", "ycoding")).not.toBe("")
    expect(frame).not.toContain("Task 05")
    expect(frame).not.toContain("other-tool")
    expect(frame).not.toContain("Held elsewhere")
    const row = lineOf(frame, "Refactor")
    expect(row).toContain("…")
    expect(frame.split("\n")[frame.split("\n").indexOf(row) + 1]).toContain("/ycoding")
    app.mockInput.pressEnter()
    await app.renderOnce()
    await key(app, "DOWN")
    expect(app.captureCharFrame()).toContain("authentication")
    expect(app.captureCharFrame()).toContain("gateway")
    app.mockInput.pressEnter()
    await app.waitFor(() => calls.some(([name]) => name === "add"))
    expect(calls).toContainEqual(["add", release.id, "ses_a"])
  } finally {
    app.renderer.destroy()
  }
})

test("add-member picker bounds a long Session list", async () => {
  const { app } = await mount({ members: true, sessions: pickerSessions })
  try {
    await key(app, "a")
    expect(app.captureCharFrame()).not.toContain("Task 60")
    await key(app, "END")
    expect(app.captureCharFrame()).toContain("22 more · type to narrow")
    expect(app.captureCharFrame()).toContain("▸ [esc] Cancel")
  } finally {
    app.renderer.destroy()
  }
})

for (const [width, height] of [
  [80, 24],
  [120, 36],
] as const) {
  for (const members of [false, true])
    for (const mode of ["dark", "light"] as const) {
      test(`Projects L02-L03 ${members ? "Add Session" : "New Project"} title, path and live Find at ${width}x${height} ${mode}`, async () => {
        const title = "Reconcile monthly ledger balances"
        const directory = "/home/dev/Workspace/client-projects/finance-ledger"
        const sessions = [
          { sessionID: "ses_ledger", title, directory, updated: 3 },
          {
            sessionID: "ses_queue",
            title: "Investigate queue delivery timeouts",
            directory: "/repo/message-queue",
            updated: 2,
          },
          {
            sessionID: "ses_assigned",
            title: "Inspect assigned worker",
            directory: "/repo/assigned-worker",
            updated: 1,
            projectName: "Delivery",
          },
        ]
        const { app, calls } = await mount({
          projects: [release],
          members,
          compact: true,
          width,
          height,
          sessions,
          mode,
        })
        try {
          await key(app, members ? "a" : "n")
          if (!members) await edit(app, "Ledger project")
          const frame = app.captureCharFrame()
          const rows = frame.split("\n")
          const at = rows.findIndex((row) => row.includes(title))
          expect(at).toBeGreaterThanOrEqual(0)
          expect(rows[at + 1]).toContain("finance-ledger")
          expect(rows[at + 1].indexOf("/home/dev")).toBe(rows[at].indexOf(title))
          if (!members) {
            const assigned = rows.findIndex((row) => row.includes("Inspect assigned worker"))
            expect(assigned).toBeGreaterThanOrEqual(0)
            expect(rows[assigned + 1]).toContain("assigned-worker")
            expect(frame).toContain("in Delivery")
          }
          await capturePicker(app, `${members ? "add" : "new-project"}-${width}x${height}-${mode}`)
          await focus(app, "Find")
          app.mockInput.pressEnter()
          await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
          await app.mockInput.typeText("ledger")
          await app.waitForFrame((value) => value.includes(title) && !value.includes("queue delivery"))
          expect(calls).toEqual([])
          for (let index = 0; index < 6; index++) app.mockInput.pressBackspace()
          await app.waitForFrame((value) => value.includes("queue delivery"))
          await app.mockInput.typeText("no-match-found")
          await app.waitForFrame((value) => value.includes("No matching Sessions"))
          app.mockInput.pressEscape()
          await app.waitForFrame((value) => value.includes("queue delivery"))
          app.mockInput.pressEnter()
          await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
          await app.mockInput.typeText("finance-ledger")
          app.mockInput.pressEnter()
          await key(app, "DOWN")
          expect(app.captureCharFrame()).toContain(title)
          expect(app.captureCharFrame()).toContain(directory)
          await capturePicker(app, `${members ? "add" : "new-project"}-${width}x${height}-${mode}-selected`)
          app.mockInput.pressEnter()
          await app.renderOnce()
          if (members) await app.waitFor(() => calls.some(([name]) => name === "add"))
          else {
            await key(app, "c")
            await app.waitFor(() => calls.some(([name]) => name === "create"))
          }
          expect(calls).toContainEqual(
            members
              ? ["add", release.id, "ses_ledger"]
              : ["create", { name: "Ledger project", master: { sessionID: "ses_ledger" } }],
          )
        } finally {
          app.renderer.destroy()
        }
      })
    }

  test(`Projects L05 directory guidance, recents and retained values at ${width}x${height}`, async () => {
    const { app, calls } = await mount({ projects: [release], width, height })
    try {
      await key(app, "n")
      await edit(app, "Directory project")
      await focus(app, "Master source")
      await key(app, "RIGHT")
      expect(app.captureCharFrame()).toContain("Enter to edit")
      expect(app.captureCharFrame()).toContain("recent directories")
      await key(app, "c")
      expect(app.captureCharFrame()).toContain("Choose a directory")
      await focus(app, "Directory")
      await key(app, "RIGHT")
      expect(app.captureCharFrame()).toContain("/repo/")
      app.mockInput.pressEnter()
      await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
      await app.mockInput.typeText("/discarded")
      app.mockInput.pressEscape()
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("discarded")
      expect(app.captureCharFrame()).toContain("Directory project")
      expect(calls).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })

  test(`Projects L02 New Project mouse choice preserves title, path and eligibility at ${width}x${height}`, async () => {
    const { app, calls } = await mount({
      projects: [release],
      width,
      height,
      sessions: [
        {
          sessionID: "ses_available",
          title: "Prepare quarterly release evidence",
          directory: "/repo/release-evidence",
          updated: 2,
        },
        {
          sessionID: "ses_occupied",
          title: "Inspect assigned delivery logs",
          directory: "/repo/delivery-logs",
          projectName: "Delivery",
          updated: 1,
        },
      ],
    })
    try {
      await key(app, "n")
      await edit(app, "Release evidence")
      const rows = app.captureCharFrame().split("\n")
      const y = rows.findIndex((row) => row.includes("Prepare quarterly release evidence"))
      expect(y).toBeGreaterThanOrEqual(0)
      await app.mockMouse.click(rows[y]!.indexOf("Prepare"), y)
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("/repo/release-evidence")
      await key(app, "c")
      await app.waitFor(() => calls.some(([name]) => name === "create"))
      expect(calls).toContainEqual(["create", { name: "Release evidence", master: { sessionID: "ses_available" } }])
    } finally {
      app.renderer.destroy()
    }
  })

  test(`Projects L04 local mouse Add returns to members with Escape at ${width}x${height}`, async () => {
    const { app } = await mount({ projects: [release], width, height })
    try {
      const rows = app.captureCharFrame().split("\n")
      const y = rows.findIndex((row) => row.includes("Add session"))
      await app.mockMouse.click(rows[y]!.indexOf("Add session"), y)
      await app.waitForFrame((frame) => frame.includes("ADD SESSION"))
      expect(app.renderer.getSelection()?.getSelectedText() ?? "").toBe("")
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("MEMBERS 3 + MASTER"))
    } finally {
      app.renderer.destroy()
    }
  })

  test(`Projects L06 pending creation cannot repeat or navigate after cancel at ${width}x${height}`, async () => {
    let finishGate!: () => void
    let settled = false
    let attempts = 0
    const gate = new Promise<void>((resolve) => {
      finishGate = resolve
    })
    const { app, calls } = await mount({
      projects: [release],
      width,
      height,
      service: {
        create: async () => {
          attempts++
          await gate
          settled = true
          return "ses_created"
        },
      },
    })
    try {
      await key(app, "n")
      await edit(app, "Pending project")
      await focus(app, "Spare")
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("● Spare"))
      await key(app, "c")
      await key(app, "c")
      expect(attempts).toBe(1)
      await key(app, "ESCAPE")
      finishGate()
      await app.waitFor(() => settled)
      await app.renderOnce()
      expect(calls.filter(([name]) => name === "open")).toEqual([])
      expect(app.captureCharFrame()).not.toContain("NEW PROJECT")
    } finally {
      finishGate()
      app.renderer.destroy()
    }
  })
}
