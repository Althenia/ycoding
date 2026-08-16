import { describe, expect, test } from "bun:test"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { directory as defaultDirectory, json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_0085fc701"
const directory = `${process.env.HOME}/Workspace/Personal/YCoding`
const location = { directory, project: { id: "project", directory } }
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}

describe("active session screen", () => {
  test("renders the canonical header, transcript bubble, context rail, and section set", async () => {
    const screen = await renderScreen({
      ...DESIGN_VIEWPORT,
      args: { sessionID },
      settle: "Claude Opus 5",
      route: (url) => {
        if (url.pathname === "/api/fs/list") return json({ location, data: [] })
        if (url.pathname === "/api/location") return json(location)
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
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
              {
                id: "msg_user",
                type: "user",
                text: "Where is provider cache telemetry recorded?",
                time: { created: 1 },
              },
            ],
            cursor: {},
          })
        if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
        if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [] })
        if (url.pathname === `/api/session/${sessionID}/subagent`) return json({ data: [] })
        if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
        if (url.pathname === `/api/session/${sessionID}/skills`) return json({ data: [] })
        if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ data: [] })
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
        if (url.pathname === `/api/session/${sessionID}/diagnostics`)
          return json({
            data: {
              model: { providerID: "anthropic", id: "claude-opus-5" },
              context: { total: 1_464, percent: 56 },
              tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
              cache: {
                eligible: 220_672,
                hitRatio: 0.71,
                mechanism: "anthropic-cache-control",
                readReported: true,
                writeReported: true,
              },
              requests: {
                logical: 1,
                physical: 1,
                helpers: 0,
                continued: 0,
                fallback: 0,
                tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
                latestInvalidation: "stable-hit",
              },
            },
          })
        if (url.pathname === `/api/session/${sessionID}/usage`)
          return json({
            data: {
              logical: 1,
              physical: 1,
              helpers: 0,
              continued: 0,
              fallback: 0,
              cost: session.cost,
              tokens: session.tokens,
            },
          })
        if (url.pathname === "/api/vcs/branch")
          return json({ location, data: { current: "main", default: "main" } })
        if (url.pathname === "/api/model")
          return json({
            location,
            data: [
              {
                id: "claude-opus-5",
                modelID: "claude-opus-5",
                providerID: "anthropic",
                name: "Claude Opus 5",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                variants: [{ id: "max" }],
                time: { released: 0 },
                cost: [],
                status: "active",
                enabled: true,
                limit: { context: 200_000, output: 32_000 },
              },
            ],
          })
        if (url.pathname === "/api/provider")
          return json({ location, data: [{ id: "anthropic", name: "Claude", package: "@ai-sdk/anthropic" }] })
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
        if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
          return json({ location, data: [] })
        if (url.pathname === "/api/mcp") return json({ location, data: [] })
        if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
        if (url.pathname === "/api/shell") return json({ location, data: [] })
        if (url.pathname === "/api/permission/request") return json({ location, data: [] })
        if (url.pathname === "/api/form/request") return json({ location, data: [] })
        if (url.pathname === "/path")
          return json({ home: process.env.HOME, state: "", config: "", worktree: defaultDirectory, directory })
        return undefined
      },
    })
    const frame = screen.frame()
    const userLine = screen.lines().find((line) => line.includes("Where is provider cache telemetry recorded?"))
    const assistantLine = screen.lines().findIndex((line) => line.includes("Two places record it."))
    const assistantIdentityLine = screen.lines().findIndex((line) => line.includes("YCODING"))
    const userLineIndex = screen.lines().findIndex((line) => line.includes("Where is provider cache telemetry recorded?"))
    const sessionHeader = screen.lines().find((line) => line.includes("SESSION"))
    const composerFooter = screen.lines().findLast((line) => line.includes("commands"))
    const headerRow = screen.lines().findIndex((line) => line.includes("y. ycoding") && line.includes("main"))

    expect(frame).toContain("~/Workspace/Personal/YCoding")
    expect(frame).toContain("main")
    expect(frame).toContain("Build")
    expect(frame).toContain("Claude Opus 5")
    expect(frame).toContain("max")
    expect(frame).toContain("Message YCoding…")
    // The composer no longer carries a hint row, and the rail footer that printed the connection
    // state is gone. The build version now sits beside the header brand instead.
    expect(frame).not.toContain("Enter send")
    expect(frame).toContain("subagents")
    expect(frame).toContain(InstallationVersion)
    expect(composerFooter?.trimEnd()).toEndWith("commands")
    expect(frame).not.toContain("Claude Opus 5 Claude")
    expect(frame).not.toContain("┃")
    expect(headerRow).toBe(1)
    expect(userLine?.indexOf("Where is provider cache telemetry recorded?")).toBeGreaterThan(60)
    expect(userLineIndex).toBeLessThan(assistantLine)
    expect(assistantIdentityLine).toBeGreaterThan(userLineIndex)
    expect(assistantIdentityLine).toBeLessThan(assistantLine)
    expect(userLine).not.toContain("┃")
    expect(sessionHeader).not.toContain("Provider cache audit")
    // Spend is now a SPEND subgroup with per-model rows and a total, not a single `Spent` row.
    for (const label of ["Input", "Output", "Used", "SPEND", "Total", "CACHE", "Hit ratio", "Reads", "Writes"])
      expect(frame).toContain(label)
    expect(frame).not.toContain("Prefix")
    expect(frame).not.toContain("prefix stable")
    expect(frame).not.toContain("GUARDRAIL")
    expect(frame).not.toContain("LSP")
    expect(frame).not.toContain("AUTONOMY")
    expect(frame).not.toContain("SUBAGENTS")

    await screen.dispose()
  }, 60_000)
})
