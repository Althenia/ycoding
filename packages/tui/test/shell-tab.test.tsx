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

test("renders owner groups, supported statuses, and derived elapsed durations", async () => {
  const main = shell("main", "ses_main", "running", { started: 10_000 })
  const child = shell("child", "ses_child", "exited", { started: 10_000, completed: 30_000 })
  const timedOut = shell("timeout", "ses_child", "timeout", { started: 10_000, completed: 40_000 })
  const orphan = shell("orphan", undefined, "killed", { started: 10_000, completed: 50_000 })
  const grouped = groupSessionShells(
    [main, shell("child-running", "ses_child", "running", { started: 10_000 }), shell("missing", undefined, "running", { started: 10_000 })],
    [
      session("ses_main", { title: "Main session" }),
      session("ses_child", { parentID: "ses_main", agent: "reviewer", title: "Check shell ownership" }),
    ],
    "ses_main",
  )

  expect(grouped.map((group) => group.owner.label)).toEqual([
    "Main chat",
    "reviewer · Check shell ownership",
    "Unknown session",
  ])
  expect(formatShellElapsed(main, 75_000)).toBe("1m 5s")
  expect(formatShellElapsed(child, 75_000)).toBe("20s")

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ShellRows
              groups={[
                { owner: { label: "Main chat" }, shells: [main] },
                { owner: { label: "reviewer · Check shell ownership" }, shells: [child, timedOut] },
                { owner: { label: "Unknown session" }, shells: [orphan] },
              ]}
              now={75_000}
              selected="sh_main"
              onSelect={() => {}}
            />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 30 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Unknown session"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Main chat")
    expect(frame).toContain("reviewer · Check shell ownership")
    expect(frame).toContain("Unknown session")
    expect(frame).toContain("running")
    expect(frame).toContain("exited")
    expect(frame).toContain("timeout")
    expect(frame).toContain("killed")
    expect(frame).toContain("/workspace")
    expect(frame).toContain("pid 104")
    expect(frame).toContain("1m 5s")
    expect(frame).toContain("20s")
  } finally {
    app.renderer.destroy()
  }
})
