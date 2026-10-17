/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionInfo, ShellInfo } from "@ycoding-ai/client"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { ShellRows, formatShellElapsed } from "../src/routes/session/composer/shell-tab"
import { groupSessionShells } from "../src/util/session"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

function session(id: string, input: Partial<Pick<SessionInfo, "parentID" | "agent" | "title">> = {}): SessionInfo {
  return {
    id,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/workspace" },
    title: "Session",
    ...input,
  }
}

function shell(
  id: string,
  sessionID: string | undefined,
  status: ShellInfo["status"],
  time: ShellInfo["time"],
): ShellInfo {
  return {
    id,
    status,
    command: `command ${id}`,
    cwd: "/workspace",
    shell: "bash",
    file: `/tmp/${id}`,
    pid: 100 + id.length,
    metadata: sessionID ? { sessionID } : {},
    time,
  }
}

test("renders family shells in ordered state sections with inline owners and derived elapsed durations", async () => {
  const main = shell("main", "ses_main", "running", { started: 10_000 })
  const child = shell("child", "ses_child", "exited", { started: 10_000, completed: 30_000 })
  const timedOut = shell("timeout", "ses_child", "timeout", { started: 10_000, completed: 40_000 })
  const orphan = shell("orphan", undefined, "killed", { started: 10_000, completed: 50_000 })
  const external = shell("external", "ses_external", "running", { started: 10_000 })
  const unresolved = shell("unresolved", "ses_missing", "running", { started: 10_000 })
  const recentChild = shell("recent-child", "ses_child", "running", { started: 20_000 })
  const killed = shell("killed", "ses_main", "killed", { started: 45_000, completed: 50_000 })
  const memory = shell("memory", "ses_child", "memory-limit", { started: 5_000, completed: 45_000 })
  const tied = shell("a-tie", "ses_child", "exited", { started: 1_000, completed: 40_000 })
  const noCompletion = shell("no-completion", "ses_main", "killed", { started: 35_000 })
  const sessions = [
    session("ses_main", { title: "Main session" }),
    session("ses_child", { parentID: "ses_main", agent: "reviewer", title: "Check shell ownership" }),
    session("ses_external", { agent: "builder", title: "Outside lane" }),
  ]
  const grouped = groupSessionShells([main, child, timedOut, orphan, external, unresolved, recentChild, killed, memory, tied, noCompletion], sessions, "ses_main", { includeSettled: true })

  expect(grouped.map((group) => group.owner.label)).toEqual([
    "Main chat",
    "reviewer · Check shell ownership",
  ])
  expect(grouped.flatMap((group) => group.shells.map((item) => item.id))).toEqual(["main", "killed", "no-completion", "child", "timeout", "recent-child", "memory", "a-tie"])
  expect(formatShellElapsed(main, 75_000)).toBe("1m05s")
  expect(formatShellElapsed(child, 75_000)).toBe("20s")

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ShellRows groups={grouped} now={75_000} selected="main" onSelect={() => {}} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 30 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("command no-completion"))

  try {
    const frame = app.captureCharFrame()
    const lines = frame.split("\n").map((line) => line.trim()).filter(Boolean)
    expect(lines.filter((line) => /^(Running|Archived)$/.test(line))).toEqual(["Running", "Archived"])
    expect(lines.filter((line) => line.includes("command ")).map((line) => line.match(/command ([\w-]+)/)?.[1])).toEqual(["recent-child", "main", "killed", "memory", "a-tie", "timeout", "no-completion", "child"])
    expect(lines.find((line) => line.includes("command main"))).toContain("Main chat")
    expect(lines.find((line) => line.includes("command recent-child"))).toContain("reviewer · Check")
    expect(frame).not.toContain("UNKNOWN SESSION")
    expect(frame).not.toContain("command orphan")
    expect(frame).not.toContain("command external")
    expect(frame).not.toContain("command unresolved")
    expect(frame).toContain("running")
    expect(frame).toContain("exited")
    expect(frame).toContain("timeout")
    expect(frame).not.toContain("/workspace")
    expect(frame).not.toContain("pid 104")
    expect(frame).toContain("1m05s")
    expect(frame).toContain("20s")
  } finally {
    app.renderer.destroy()
  }
})
