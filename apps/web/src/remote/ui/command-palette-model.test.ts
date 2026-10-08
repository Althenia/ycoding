import { describe, expect, test } from "bun:test"
import { filterPaletteActions, paletteActions, paletteSections, type PaletteContext } from "./command-palette-model"

const base: PaletteContext = {
  view: "/remote/session",
  connected: true,
  canCreateSession: true,
  canSelectModel: true,
  canConnectProvider: true,
  session: { id: "ses_a", running: false, managedChild: false, yolo: 0, goalActive: false },
  commands: [
    { name: "review", description: "Review the working tree" },
    { name: "compact" },
    { name: "goal" },
    { name: "cd" },
    { name: "editor" },
    { name: "skills" },
    { name: "btw" },
    { name: "btw-send" },
    { name: "daybreak" },
    { name: "move" },
  ],
  skills: [{ id: "tdd", name: "Test-driven development", description: "Write the test first" }],
  sessions: [
    { id: "ses_a", title: "Current", archived: false },
    { id: "ses_b", title: "Other", running: true, archived: false },
    { id: "ses_c", title: "Old", archived: true },
  ],
  devices: [
    { id: "dev_1", name: "Studio", online: true, active: true },
    { id: "dev_2", name: "Laptop", online: true, active: false },
    { id: "dev_3", name: "Offline box", online: false, active: false },
  ],
  activeDeviceID: "dev_1",
  workspaces: [{ id: "ws_1", label: "ycoding" }, { id: "ws_2", label: "docs" }],
  selectedWorkspaceID: "ws_1",
  theme: "system",
  scheme: "default",
  unreadNotifications: 0,
  canReconnect: false,
  hasTeam: true,
  signedIn: true,
}

const ids = (context: PaletteContext) => paletteActions(context).map((action) => action.id)

describe("palette availability", () => {
  test("provider actions expose the existing selection owner and the explicit connection flow", () => {
    expect(paletteActions(base).find((action) => action.id === "settings.model")?.intent).toEqual({ type: "model" })
    expect(paletteActions(base).find((action) => action.id === "settings.provider.connect")?.intent).toEqual({ type: "connectProvider" })
    expect(ids({ ...base, connected: false })).not.toContain("settings.model")
    expect(ids({ ...base, connected: false })).not.toContain("settings.provider.connect")
    expect(ids({ ...base, canSelectModel: false })).not.toContain("settings.model")
    expect(ids({ ...base, canConnectProvider: false })).not.toContain("settings.provider.connect")
    expect(ids({ ...base, session: { ...base.session!, managedChild: true } })).not.toContain("settings.model")
    expect(ids({ ...base, view: "/remote", session: { ...base.session!, managedChild: true } })).toContain("settings.model")
  })

  test("a connected idle Session offers compaction, goal, every other YOLO level, configured commands, and skills", () => {
    expect(ids(base)).toEqual(expect.arrayContaining([
      "session.compact",
      "session.goal",
      "session.yolo.1",
      "session.yolo.2",
      "session.yolo.3",
      "command.review",
      "skill.tdd",
    ]))
    expect(ids(base)).not.toContain("session.yolo.0")
    expect(ids(base)).not.toContain("session.interrupt")
    expect(ids(base)).not.toContain("session.goal.stop")
  })

  test("commands the composer already owns are not repeated as configured commands", () => {
    expect(ids(base)).not.toContain("command.compact")
    expect(ids(base)).not.toContain("command.goal")
  })

  test("slash actions unavailable in the web composer are omitted from Commands", () => {
    expect(ids(base)).not.toEqual(expect.arrayContaining([
      "command.cd",
      "command.editor",
      "command.skills",
      "command.btw",
      "command.btw-send",
      "command.daybreak",
      "command.move",
    ]))
  })

  test("a running Session offers interrupt and an active goal offers stop", () => {
    const running = ids({ ...base, session: { ...base.session!, running: true, goalActive: true, yolo: 3 } })
    expect(running).toEqual(expect.arrayContaining(["session.interrupt", "session.goal.stop", "session.yolo.0"]))
    expect(running).not.toContain("session.yolo.3")
  })

  test("a managed subagent view offers only interrupt among Session actions", () => {
    const child = paletteActions({ ...base, session: { ...base.session!, running: true, managedChild: true } })
    expect(child.filter((action) => ["Session", "Commands", "Skills"].includes(action.group)).map((action) => action.id)).toEqual(["session.interrupt"])
  })

  test("without a connection no Session action is offered, yet navigation and settings remain", () => {
    const offline = paletteActions({ ...base, connected: false, canCreateSession: false })
    expect(offline.some((action) => ["Session", "Commands", "Skills"].includes(action.group))).toBe(false)
    expect(offline.map((action) => action.id)).toEqual(expect.arrayContaining(["nav.sessions", "nav.usage", "nav.settings", "theme.dark"]))
    expect(offline.map((action) => action.id)).not.toContain("nav.new")
  })

  test("without a selected Session the Session, command, and skill groups are absent", () => {
    const none = paletteActions({ ...base, view: "/remote", session: undefined })
    expect(none.some((action) => ["Session", "Commands", "Skills"].includes(action.group))).toBe(false)
    expect(none.map((action) => action.id)).not.toContain("nav.session")
  })

  test("navigation omits the current view and links the open conversation from other views", () => {
    expect(ids(base)).not.toContain("nav.session")
    expect(ids({ ...base, view: "/remote/usage" })).toEqual(expect.arrayContaining(["nav.session", "nav.sessions", "nav.settings"]))
    expect(ids({ ...base, view: "/remote/usage" })).not.toContain("nav.usage")
    expect(ids({ ...base, view: "/remote" })).not.toContain("nav.new")
    expect(ids({ ...base, view: "/remote/settings" })).not.toContain("settings.machine")
    expect(ids({ ...base, view: "/remote/usage" })).toContain("settings.machine")
  })

  test("other sessions, online machines, and other workspaces are switch targets; the current and offline ones are not", () => {
    const result = ids(base)
    expect(result).toContain("session.open.ses_b")
    expect(result).not.toContain("session.open.ses_a")
    expect(result).not.toContain("session.open.ses_c")
    expect(result).toContain("device.switch.dev_2")
    expect(result).not.toContain("device.switch.dev_1")
    expect(result).not.toContain("device.switch.dev_3")
    expect(result).toContain("workspace.select.ws_2")
    expect(result).not.toContain("workspace.select.ws_1")
  })

  test("Team appears only when team controls exist", () => {
    expect(ids(base)).toContain("nav.team")
    expect(ids({ ...base, hasTeam: false })).not.toContain("nav.team")
  })

  test("settings offer the other theme choices, unread notification clearing, and account actions by state", () => {
    expect(ids(base)).toEqual(expect.arrayContaining(["theme.light", "theme.dark"]))
    expect(ids(base)).not.toContain("theme.system")
    expect(ids(base)).not.toContain("notifications.read")
    expect(ids({ ...base, unreadNotifications: 3 })).toContain("notifications.read")
    expect(ids(base)).not.toContain("account.reconnect")
    expect(ids({ ...base, canReconnect: true })).toContain("account.reconnect")
    expect(ids(base)).toContain("account.signout")
    expect(ids({ ...base, signedIn: false })).not.toContain("account.signout")
  })

  test("settings offer other named color schemes, including One Dark and high contrast", () => {
    expect(ids(base)).toEqual(expect.arrayContaining(["scheme.onedark", "scheme.onedark-pro", "scheme.high-contrast"]))
    expect(ids({ ...base, scheme: "onedark" })).not.toContain("scheme.onedark")
  })

  test("actions that need text prefill the composer and run nothing", () => {
    const actions = paletteActions(base)
    expect(actions.find((action) => action.id === "session.goal")?.intent).toEqual({ type: "draft", text: "/goal " })
    expect(actions.find((action) => action.id === "command.review")?.intent).toEqual({ type: "draft", text: "/review " })
  })
})

describe("palette sections", () => {
  test("a Session view leads with the Session group and other views lead with Navigation", () => {
    expect(paletteSections(paletteActions(base), "/remote/session", false).map((section) => section.group)).toEqual([
      "Session",
      "Commands",
      "Skills",
      "Navigation",
      "Settings",
      "Account",
    ])
    expect(paletteSections(paletteActions({ ...base, view: "/remote/usage" }), "/remote/usage", false)[0]?.group).toBe("Navigation")
  })

  test("a query result is one ungrouped relevance list and no match yields no section", () => {
    const ranked = filterPaletteActions(paletteActions(base), "session")
    expect(paletteSections(ranked, "/remote/session", true)).toEqual([{ group: undefined, actions: ranked }])
    expect(paletteSections([], "/remote/session", true)).toEqual([])
  })
})

describe("palette search", () => {
  const actions = paletteActions({ ...base, unreadNotifications: 2 })
  const titles = (query: string) => filterPaletteActions(actions, query).map((action) => action.title)

  test("an empty query keeps every action in display order", () => {
    expect(filterPaletteActions(actions, "  ")).toBe(actions)
  })

  test("a slash name or alias finds its action", () => {
    expect(titles("/compact")[0]).toBe("Compact session")
    expect(titles("/summarize")).toEqual(["Compact session"])
    expect(titles("/goal")[0]).toBe("Set goal…")
    expect(titles("/yolo")).toEqual(expect.arrayContaining(["YOLO level 1", "YOLO level 3"]))
    expect(titles("/review")[0]).toBe("/review")
  })

  test("a dollar prefix finds a skill by id", () => {
    expect(titles("$tdd")).toEqual(["Activate skill: Test-driven development"])
  })

  test("provider, model, profile and connect searches expose supported controls", () => {
    expect(titles("/models")).toContain("Select provider and model…")
    expect(titles("profile")).toContain("Select provider and model…")
    expect(titles("/connect")[0]).toBe("Connect provider…")
  })

  test("title matches outrank keyword and description matches", () => {
    const result = titles("theme")
    expect(result.slice(0, 2)).toEqual(["Theme: Light", "Theme: Dark"])
  })

  test("every term must match and unmatched queries are empty", () => {
    expect(titles("yolo 2")).toEqual(["YOLO level 2"])
    expect(titles("compact zzzz")).toEqual([])
    expect(titles("qqqq")).toEqual([])
  })

  test("a session title is searchable", () => {
    expect(titles("other")).toContain("Open session: Other")
  })

  test("a subsequence of the title matches as the weakest signal", () => {
    expect(titles("cpts")).toContain("Compact session")
  })

  test("equal scores keep display order", () => {
    const result = filterPaletteActions(actions, "yolo level")
    expect(result.map((action) => action.title)).toEqual(["YOLO level 1", "YOLO level 2", "YOLO level 3"])
  })
})
