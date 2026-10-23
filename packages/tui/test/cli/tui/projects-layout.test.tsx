/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { ProjectsScreenContent } from "../../../src/routes/session/projects"
import { ProjectMembers } from "../../../src/routes/session/project-members"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import type { ProjectView, ProjectService } from "../../../src/util/coordination"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const member = (
  id: string,
  title: string,
  role: "master" | "member",
  state: "running" | "idle" | "waiting" = "idle",
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

async function mount(
  input: {
    projects?: ProjectView[]
    error?: string
    width?: number
    members?: boolean
    settings?: boolean
    mode?: "dark" | "light"
    service?: Partial<ProjectService>
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
  const sessions = () => [
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
                  {input.members ? (
                    <ProjectMembers
                      project={release}
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
                      compact={(input.width ?? 120) < 100}
                    />
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
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 120, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(input.members ? "MEMBERS 4" : "Projects"))
  return { app, calls }
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
    expect(app.captureCharFrame()).toContain("1/2 running")
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
    expect(frame).toContain("MEMBERS 4")
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
