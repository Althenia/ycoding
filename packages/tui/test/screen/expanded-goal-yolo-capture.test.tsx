/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { json, type FetchHandler } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const directory = "/tmp/ycoding/expanded-goal-yolo"
const location = { directory, project: { id: "proj_expanded_goal_yolo", directory } }
const sessionID = "ses_0085fc701"
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "proj_expanded_goal_yolo",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}
const childSession = { ...session, id: "ses_docs", parentID: sessionID, title: "Docs sync" }

const route: FetchHandler = (url) => {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session, childSession], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${childSession.id}`) return json({ data: childSession })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" },
          content: [{ type: "text", text: "Two places record it." }],
          time: { created: 2, completed: 3 },
        },
        { id: "msg_user", type: "user", text: "Where is provider cache telemetry recorded?", time: { created: 1 } },
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
      data: [{ content: "Run verification", status: "in_progress", priority: "high" }],
    })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({
      data: [
        {
          sessionID: "ses_docs",
          parentID: sessionID,
          description: "docs-sync",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-opus-5" },
          background: true,
          state: "running",
          revision: 1,
          time: { created: 1, updated: 4 },
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
        },
      ],
    })
  if (url.pathname === "/api/shell")
    return json({
      location,
      data: [
        { id: "sh_main", status: "running", command: "bun test", cwd: directory, shell: "/bin/sh", file: "/tmp/sh-main", metadata: { sessionID }, time: { started: 1 } },
      ],
    })
  if (url.pathname === "/api/mcp") return json({ location, data: [{ name: "context7", status: { status: "connected" } }] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: { providerID: "anthropic", id: "claude-opus-5" },
        context: { total: 1_464, percent: 56 },
        tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
        cache: { eligible: 220_672, hitRatio: 0.71, mechanism: "anthropic-cache-control", readReported: true, writeReported: true },
        requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } }, latestInvalidation: "stable-hit" },
      },
    })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model")
    return json({ location, data: [{ id: "claude-opus-5", modelID: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "max" }], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 } }] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude", package: "@ai-sdk/anthropic" }] })
  if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", name: "Goal", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }] })
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
        if (screen.frame().includes("Message YCoding…")) break
        await Bun.sleep(20)
      }
      const lines = screen.frame().split("\n").slice(0, viewport.height)
      expect(lines).toHaveLength(viewport.height)
      expect(lines.join("\n")).toContain("Message YCoding…")
      if (viewport.width !== NARROW_VIEWPORT.width) {
        expect(lines.find((line) => line.includes("subagents 1 · shells"))).toContain("subagents 1 · shells 1")
        expect(lines.findIndex((line) => line.includes("─"))).toBe(57)
        expect(lines.findIndex((line) => line.includes("Message YCoding…"))).toBe(59)
        expect(lines.findIndex((line) => line.includes("Enter send"))).toBe(62)
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
      expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(viewport.width)
      if (viewport.width !== NARROW_VIEWPORT.width)
        await Bun.write(path.join(output, `expanded-goal-yolo-${viewport.width}x${viewport.height}.txt`), lines.join("\n"))
    } finally {
      await screen.dispose()
    }
  }
}, 120_000)
