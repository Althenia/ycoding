import { describe, expect, test } from "bun:test"
import { projectOffice } from "./model"
import { defaultOfficePreferences } from "./preferences"
import type { OfficeInput, TeamMember } from "./types"

const base: OfficeInput = {
  ownerID: "user_1",
  deviceID: "dev_1",
  connection: "ready",
  activeSessionID: "ses_root",
  sessions: [{ id: "ses_root", title: "Plan the release", agent: "build", archived: false, running: true }],
}

function rooms(input: Partial<OfficeInput>) {
  const snapshot = projectOffice({ ...base, ...input }, defaultOfficePreferences)
  return Object.fromEntries(snapshot.actors.map((actor) => [actor.sessionID, actor.homeRoom]))
}

function task(sessionID: string, description: string, agent?: string): TeamMember {
  return { sessionID, parentID: "ses_root", description, state: "running", ...(agent === undefined ? {} : { agent }) }
}

describe("office responsibility rooms", () => {
  test("only the family root, including a placeholder parent, works in the Developer room", () => {
    expect(rooms({
      sessions: [
        { id: "ses_root", title: "Plan the release", agent: "build", archived: false, running: true },
        { id: "ses_review", title: "Review the parser", agent: "reviewer", archived: false, running: false },
      ],
    })).toEqual({ ses_root: "developer" })
    expect(rooms({
      sessions: [],
      activeSessionID: "ses_worker",
      team: { rootID: "ses_root", status: "ready", more: false, cues: [], members: [task("ses_worker", "Fix the parser")] },
    })).toEqual({ ses_root: "developer", ses_worker: "developer" })
  })

  test("only reported child tasks work where their agent name places them", () => {
    expect(rooms({
      team: { rootID: "ses_root", status: "ready", more: false, cues: [], members: [
        task("ses_qa", "Tidy the parser", "code-reviewer"), task("ses_research", "Tidy the parser", "explore"),
        task("ses_dev", "Tidy the parser", "zeus"), task("ses_titled", "Investigate relay drops"),
      ] },
    })).toEqual({ ses_root: "developer", ses_qa: "qa", ses_research: "research", ses_dev: "developer", ses_titled: "research" })
  })

  test("subagent tasks use their agent name first, then the leading words of their task", () => {
    expect(rooms({
      team: {
        rootID: "ses_root", status: "ready", more: false, cues: [],
        members: [
          task("ses_agent_wins", "Investigate relay drops", "qa-bot"),
          task("ses_review", "Read-only review of reconnect failures", "general"),
          task("ses_investigate", "Investigate why the relay drops", "general"),
          task("ses_analyze", "Analyze bundle size", "zeus"),
          task("ses_late_keyword", "Web office renderer: Phaser engine and engine verification", "zeus"),
          task("ses_unnamed", "Fix the parser"),
          task("ses_first_match", "Explore and test the importer", "general"),
        ],
      },
    })).toEqual({
      ses_root: "developer",
      ses_agent_wins: "qa",
      ses_review: "qa",
      ses_investigate: "research",
      ses_analyze: "research",
      ses_late_keyword: "developer",
      ses_unnamed: "developer",
      ses_first_match: "research",
    })
  })
})
