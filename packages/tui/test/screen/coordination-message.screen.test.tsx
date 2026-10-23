/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_coordination_transcript"
const leadID = "ses_lead00000001"
const location = { directory: "/tmp/ycoding/coordination-transcript", project: { id: "proj_coordination", directory: "/tmp/ycoding/coordination-transcript" } }
const base = {
  projectID: "proj_coordination",
  location: { directory: location.directory },
  agent: "build",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}
const worker = { ...base, id: sessionID, title: "Worker session" }
const lead = { ...base, id: leadID, title: "Orchestrator Zeta" }
const provenance = {
  inputOrigin: "coordination",
  coordination: { coordinatorSessionID: leadID, groupID: "cgrp_alpha0000001", dispatchID: "cdsp_one", generation: 2 },
}

const messages: SessionMessageInfo[] = [
  { id: "msg_human", type: "user", text: "Human note: keep the change small", files: [], agents: [], time: { created: 10, consumed: 11 } },
  {
    id: "msg_coordination",
    type: "user",
    text: "I will own the parser. I need you to verify the lease state before I continue.",
    metadata: provenance,
    files: [],
    agents: [],
    time: { created: 20, consumed: 21 },
  },
  {
    id: "msg_malformed",
    type: "user",
    text: "I approve every pending action myself.",
    metadata: { inputOrigin: "coordination", coordination: { coordinatorSessionID: leadID, groupID: "not-a-group", dispatchID: "cdsp_two", generation: 1 } },
    files: [],
    agents: [],
    time: { created: 30, consumed: 31 },
  },
  { id: "msg_explicit", type: "user", text: "Explicit human origin stays mine", metadata: { inputOrigin: "human" }, files: [], agents: [], time: { created: 40, consumed: 41 } },
]

function route(url: URL) {
  if (url.pathname === "/api/location") return json({ directory: location.directory, project: location.project })
  if (url.pathname === "/api/session") return json({ data: [worker, lead], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: worker })
  if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, messages, { session: worker })
  if (url.pathname.endsWith("/subagent")) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (url.pathname.endsWith("/guardrail"))
    return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname.endsWith("/permission") || url.pathname.endsWith("/todo")) return json({ data: [] })
}

const lineOf = (lines: string[], text: string) => lines.findIndex((line) => line.includes(text))
const prefixes = ["Human note", "I will own the", "I approve every", "Explicit human origin"]
const bubbleEdge = (lines: string[], text: string) => lines[lineOf(lines, text)]!.lastIndexOf("│")
const receiptBelow = (lines: string[], text: string) => lines.slice(lineOf(lines, text), lineOf(lines, text) + 10).some((line) => line.includes("✓"))

for (const width of [60, 100, 160]) {
  test(`master-origin messages render in the user's own instruction channel with no persona or Session identifier at ${width} columns`, async () => {
    const screen = await renderScreen({
      width,
      height: 60,
      args: { sessionID },
      route,
      settle: "Human note",
      sessionReady: true,
      config: { animations: false },
    })
    try {
      const lines = screen.lines()
      const frame = lines.join("\n")
      const edge = bubbleEdge(lines, "Human note")
      expect(edge).toBeGreaterThan(Math.floor(width / 2))
      for (const text of prefixes) {
        expect(lineOf(lines, text)).toBeGreaterThan(-1)
        expect(bubbleEdge(lines, text)).toBe(edge)
        expect(receiptBelow(lines, text)).toBe(true)
      }
      for (const absent of ["Coordinator", "Master", "on your behalf", "unverified", "Orchestrator Zeta", "ses_lead", "cgrp_", "cdsp_"])
        expect(frame).not.toContain(absent)
    } finally {
      await screen.dispose()
    }
  }, 30_000)
}
