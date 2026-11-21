/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { capturedGroup, json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_canonical_changes"
const location = {
  directory: "/tmp/ycoding/canonical-changes",
  project: { id: "proj_changes", directory: "/tmp/ycoding/canonical-changes" },
}
const model = { providerID: "openai", id: "fixture" }
const session = {
  id: sessionID,
  title: "Canonical changes",
  projectID: location.project.id,
  location,
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const patch = (name: string) => `--- a/src/${name}.ts\n+++ b/src/${name}.ts\n@@ -1 +1 @@\n-old\n+new`

function fixture() {
  const requests: string[] = []
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const failures = new Set<string>()
  const groups = [
    capturedGroup("msg_reply", "src/root.ts", patch("root")),
    capturedGroup("msg_reply", "src/child.ts", patch("child")),
  ]
  return {
    requests,
    gates,
    failures,
    groups,
    route: async (url: URL) => {
      requests.push(url.pathname + url.search)
      if (url.pathname.endsWith("/captured-changes")) {
        const page = url.searchParams.get("cursor") ?? "first"
        await gates.get(page)?.promise
        if (failures.has(page))
          return json({ code: "internal_error", message: "Family snapshot unavailable" }, { status: 500 })
        return json({
          data: page === "first" ? groups.slice(0, 1) : groups.slice(1),
          cursor: page === "first" ? { next: "opaque-next" } : undefined,
        })
      }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/snapshot`)
        return sessionSnapshot(
          sessionID,
          [
            { id: "msg_user", type: "user", text: "Inspect the result", time: { created: 1 } },
            {
              id: "msg_reply",
              type: "assistant",
              agent: "build",
              model,
              content: [{ type: "text", text: "The backend captured these edits." }],
              finish: "stop",
              time: { created: 2, completed: 2 },
            },
          ],
          { session },
        )
      if (url.pathname === `/api/session/${sessionID}/subagent`)
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (
        ["todo", "permission", "guardrail/request"].some(
          (resource) => url.pathname === `/api/session/${sessionID}/${resource}`,
        )
      )
        return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/guardrail`)
        return json({
          data: {
            rootSessionID: sessionID,
            profile: "standard",
            customRules: 0,
            approvals: 0,
            blocked: 0,
            counters: [],
            invalidFiles: [],
          },
        })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [
            {
              id: "build",
              name: "Build",
              request: { headers: {}, body: {} },
              mode: "primary",
              hidden: false,
              permissions: [],
            },
          ],
        })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              ...model,
              modelID: model.id,
              name: "Fixture",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: 0 },
              cost: [],
              status: "active",
              enabled: true,
              limit: { context: 200000, output: 32000 },
            },
          ],
        })
      return undefined
    },
  }
}

async function text(screen: Awaited<ReturnType<typeof renderScreen>>, value: string) {
  if (screen.frame().includes(value)) return
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (screen.frame().includes(value)) {
        clearTimeout(timeout)
        screen.renderer.off("frame", check)
        resolve()
      }
    }
    const timeout = setTimeout(() => {
      screen.renderer.off("frame", check)
      reject(new Error(`Missing ${value}:\n${screen.frame()}`))
    }, 5000)
    screen.renderer.on("frame", check)
    screen.renderer.requestRender()
  })
}

test("renders complete cursor-paged canonical changes without reading child transcripts or fetching on expansion", async () => {
  const state = fixture()
  const gate = Promise.withResolvers<void>()
  state.gates.set("opaque-next", gate)
  const screen = await renderScreen({
    width: 140,
    height: 50,
    args: { sessionID },
    route: state.route,
    settle: "The backend captured these edits.",
  })
  try {
    expect(screen.frame()).not.toContain("Captured changes 1 file")
    gate.resolve()
    await text(screen, "Captured changes 2 files")
    const before = state.requests.length
    await screen.mouse.click(
      12,
      screen.lines().findIndex((line) => line.includes("Captured changes 2 files")),
    )
    await text(screen, "src/child.ts")
    expect(screen.frame()).toContain("src/root.ts")
    expect(state.requests.slice(before)).toEqual([])
    expect(state.requests.filter((url) => url.includes("captured-changes"))).toContain(
      `/api/session/${sessionID}/captured-changes?cursor=opaque-next`,
    )
    expect(state.requests.filter((url) => /\/ses_(root|child)\//.test(url))).toEqual([])
    expect(state.requests.some((url) => url.includes("/file-change"))).toBe(false)
  } finally {
    gate.resolve()
    await screen.dispose()
  }
}, 30000)

test.each([80, 140])(
  "failed canonical pages show an unavailable state and retry the complete snapshot at %i columns",
  async (width) => {
    const state = fixture()
    state.failures.add("opaque-next")
    const screen = await renderScreen({
      width,
      height: 50,
      args: { sessionID },
      route: state.route,
      settle: "Captured changes unavailable",
    })
    try {
      expect(screen.frame()).toContain("Family snapshot unavailable")
      expect(screen.frame()).not.toContain("Captured changes 1 file")
      state.failures.clear()
      if (width === 80) {
        screen.input.pressKey("p", { ctrl: true })
        await text(screen, "Commands")
        await screen.input.typeText("Retry captured changes")
        screen.input.pressEnter()
      } else
        await screen.mouse.click(
          12,
          screen.lines().findIndex((line) => line.includes("Retry captured changes")),
        )
      await text(screen, "Captured changes 2 files")
      expect(screen.frame()).not.toContain("Captured changes unavailable")
      expect(state.requests.filter((url) => url === `/api/session/${sessionID}/captured-changes`)).toHaveLength(2)
    } finally {
      await screen.dispose()
    }
  },
  30000,
)

test("renders unavailable canonical patches without inventing a diff or dropping the file", async () => {
  const state = fixture()
  state.groups.splice(0, state.groups.length, {
    ...capturedGroup("msg_reply", "src/large.ts", "", 0, 0),
    files: [{ path: "src/large.ts", diff: "", additions: 0, deletions: 0, status: "modified", unavailable: true }],
  })
  const screen = await renderScreen({
    width: 140,
    height: 50,
    args: { sessionID },
    route: state.route,
    settle: "Captured changes 1 file",
  })
  try {
    await screen.mouse.click(
      12,
      screen.lines().findIndex((line) => line.includes("Captured changes 1 file")),
    )
    await text(screen, "src/large.ts")
    await screen.mouse.click(
      12,
      screen.lines().findIndex((line) => line.includes("src/large.ts")),
    )
    await text(screen, "Patch unavailable")
    expect(screen.frame()).not.toContain("+new")
  } finally {
    await screen.dispose()
  }
}, 30000)
