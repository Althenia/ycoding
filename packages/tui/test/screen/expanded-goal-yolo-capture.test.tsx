/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { json, type FetchHandler } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const directory = `${process.env.HOME}/Workspace/Personal/YCoding`
const location = { directory, project: { id: "proj_expanded_goal_yolo", directory } }
const sessionID = "ses_0085fc701x"
const now = Date.now()
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "proj_expanded_goal_yolo",
  location: { directory },
  agent: "goal",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}
const childSessions = [
  { ...session, id: "ses_docs", parentID: sessionID, title: "Docs sync", agent: "docs-sync", cost: 0 },
  { ...session, id: "ses_test_triage", parentID: sessionID, title: "Test triage", agent: "test-triage", cost: 0 },
]

const route: FetchHandler = (url) => {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session, ...childSessions], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (childSessions.some((child) => url.pathname === `/api/session/${child.id}`))
    return json({ data: childSessions.find((child) => url.pathname === `/api/session/${child.id}`) })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "goal",
          model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" },
          content: [{ type: "text", text: "All rail sections expanded. The rail scrolls independently of the transcript." }],
          time: { created: 2, completed: 3 },
        },
      ],
      cursor: {},
    })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/guardrail/request`].includes(url.pathname))
    return json({ data: [] })
  if (/^\/api\/session\/[^/]+\/(permission|form)$/.test(url.pathname)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/autonomy`)
    return json({
      data: {
        mode: "yolo",
        goal: { text: "Fix provider cache accounting", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 },
      },
    })
  if (url.pathname === `/api/session/${sessionID}/todo`)
    return json({
      data: [
        { content: "Verify baseline", status: "completed", priority: "high" },
        { content: "Add failing test", status: "completed", priority: "high" },
        { content: "Run verification · bun test provider", status: "in_progress", priority: "high" },
      ],
    })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({
      data: [
        {
          sessionID: "ses_docs",
          parentID: sessionID,
          description: "docs-sync",
          agent: "docs-sync",
          model: { providerID: "anthropic", id: "claude-opus-5" },
          background: true,
          state: "running",
          revision: 1,
          time: { created: now - 134_000, updated: now },
        },
        {
          sessionID: "ses_test_triage",
          parentID: sessionID,
          description: "test-triage",
          agent: "test-triage",
          model: { providerID: "anthropic", id: "claude-opus-5" },
          background: true,
          state: "waiting",
          revision: 1,
          question: { text: "awaiting" },
          time: { created: now - 60_000, updated: now },
        },
      ],
    })
  if (url.pathname === `/api/session/${sessionID}/skills`)
    return json({
      data: [
        {
          id: "go-developer",
          name: "go-developer",
          activatedBy: "tool",
          activationMessageID: "msg_skill",
          content: "",
          conflicts: [],
          declarations: {},
          state: "active",
          scope: "project",
        },
        {
          id: "typescript-developer",
          name: "typescript-developer",
          activatedBy: "tool",
          activationMessageID: "msg_skill_typescript",
          content: "",
          conflicts: [],
          declarations: {},
          state: "active",
        },
      ],
    })
  if (url.pathname === "/api/shell")
    return json({
      location,
      data: [
        { id: "sh_main_test", status: "running", command: "bun test provider", cwd: directory, shell: "/bin/sh", file: "/tmp/sh-main-test", metadata: { sessionID }, time: { started: now - 134_000 } },
        { id: "sh_main_dev", status: "running", command: "bun run dev", cwd: directory, shell: "/bin/sh", file: "/tmp/sh-main-dev", metadata: { sessionID }, time: { started: now - 60_000 } },
        { id: "sh_docs", status: "running", command: "git diff --check", cwd: directory, shell: "/bin/sh", file: "/tmp/sh-docs", metadata: { sessionID: "ses_docs" }, time: { started: now - 30_000 } },
      ],
    })
  if (url.pathname === "/api/mcp")
    return json({ location, data: [{ name: "context7", status: { status: "connected" } }, { name: "firecrawl", status: { status: "connected" } }] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: { providerID: "anthropic", id: "claude-opus-5" },
        context: { total: 1_464, percent: 56 },
        tokens: { reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
        cache: { eligible: 220_672, hitRatio: 0.71, mechanism: "anthropic-cache-control", readReported: false, writeReported: false },
        requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } } },
      },
    })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model")
    return json({ location, data: [{ id: "claude-opus-5", modelID: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "max" }], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 } }] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude", package: "@ai-sdk/anthropic" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        { id: "goal", name: "Goal", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
        { id: "docs-sync", name: "docs-sync", request: { headers: {}, body: {} }, mode: "subagent", hidden: false, permissions: [] },
        { id: "test-triage", name: "test-triage", request: { headers: {}, body: {} }, mode: "subagent", hidden: false, permissions: [] },
      ],
    })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/permission/request" || url.pathname === "/api/form/request") return json({ location, data: [] })
  return undefined
}

test("captures the expanded goal and YOLO session with populated rail fixtures", async () => {
  const output = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
  await mkdir(output, { recursive: true })

  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT]) {
    const screen = await renderScreen({
      ...viewport,
      route,
      args: { sessionID },
      pluginStatus: [{ id: "audit-tools", source: "file", spec: "audit-tools", target: "audit-tools", enabled: true, active: true }],
      settle: "Claude Opus 5",
    })
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (screen.frame().includes("Message YCoding…") && screen.frame().includes("subagents 2")) break
        await Bun.sleep(20)
      }
      const lines = screen.frame().split("\n").slice(0, viewport.height)
      expect(lines).toHaveLength(viewport.height)
      expect(lines.join("\n")).toContain("Message YCoding…")
      if (viewport.width !== NARROW_VIEWPORT.width) {
        // The design positions these as independent footer segments (board 11 row 68 puts
        // `subagents 2` at c49 and `shells 3` at c62), so they are no longer one joined literal.
        const footer = lines.find((line) => line.includes("subagents 2"))
        expect(footer).toContain("subagents 2")
        expect(footer).toContain("shells 3")
        expect(lines.findIndex((line) => line.includes("─"))).toBe(57)
        expect(lines.findIndex((line) => line.includes("Message YCoding…"))).toBe(59)
        expect(lines.findIndex((line) => line.includes("Enter send"))).toBe(61)
        expect(screen.colorOf("─")).toEqual([239, 125, 132, 255])
        const yoloBand = screen.spans().lines[3]?.spans ?? []
        expect(yoloBand).not.toHaveLength(0)
        expect(yoloBand.every((span) => span.bg.toInts().every((value, index) => value === [239, 125, 132, 255][index]))).toBe(
          true,
        )
        // Verify rail section order: SESSION, GOAL, AUTONOMY, CONTEXT, SUBAGENTS, SHELLS, SKILLS
        const rail = lines.join("\n")
        const sectionHeaders = ["SESSION", "GOAL", "AUTONOMY", "CONTEXT", "SUBAGENTS", "SHELLS", "SKILLS"]
        const indexes = sectionHeaders.map((header) => rail.indexOf(header))
        expect(indexes.every((index) => index >= 0)).toBe(true)
        expect(indexes).toEqual([...indexes].toSorted((left, right) => left - right))
        expect(rail).toContain("3 / 5")
        expect(rail).toContain("auto")
      }
      if (viewport.width === DESIGN_VIEWPORT.width) {
        expect(lines[5]).toContain("YCODING")
        expect(lines[7]).toContain("All rail sections expanded. The rail scrolls independently of the transcript.")
        expect(lines[12]?.slice(2, 4)).toBe("ok")
        expect(lines[12]?.slice(9, 24)).toBe("Verify baseline")
        expect(lines[12]?.indexOf("done")).toBe(133)
        expect(lines[15]?.slice(2, 4)).toBe("ok")
        expect(lines[15]?.slice(9, 25)).toBe("Add failing test")
        expect(lines[15]?.indexOf("done")).toBe(133)
        expect(lines[18]?.slice(2, 4)).toBe("..")
        expect(lines[18]?.slice(9, 25)).toBe("Run verification")
        expect(lines[18]?.indexOf("active")).toBe(131)
        expect(lines[22]?.indexOf("−")).toBe(146)
        expect(lines[22]?.indexOf("AUTONOMY")).toBe(149)
        expect(lines[25]?.indexOf("Approvals")).toBe(146)
        expect(lines[27]?.indexOf("Guardrails")).toBe(146)
        expect(lines[31]?.indexOf("−")).toBe(146)
        expect(lines[31]?.indexOf("CONTEXT")).toBe(149)
        expect(lines[41]?.indexOf("−")).toBe(146)
        expect(lines[41]?.indexOf("SUBAGENTS")).toBe(149)
        const shellRow = lines.findIndex((line) => line.includes("SHELLS"))
        expect(shellRow).toBe(50)
        expect(lines[shellRow]?.indexOf("−")).toBe(146)
        expect(lines[shellRow]?.indexOf("SHELLS")).toBe(149)
        expect(lines[58]?.indexOf("−")).toBe(146)
        expect(lines[58]?.indexOf("SKILLS")).toBe(149)
        expect(lines[61]?.indexOf("go-developer")).toBe(146)
      }
      expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(viewport.width)
      if (viewport.width !== NARROW_VIEWPORT.width)
        await Bun.write(path.join(output, `expanded-goal-yolo-${viewport.width}x${viewport.height}.txt`), lines.join("\n"))
    } finally {
      await screen.dispose()
    }
  }
}, 120_000)
