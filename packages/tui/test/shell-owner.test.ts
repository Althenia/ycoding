import { expect, test } from "bun:test"
import type { SessionInfo, ShellInfo } from "@ycoding-ai/client"

const util = await import("../src/util/session")
const groupSessionShellsCandidate: unknown = Reflect.get(util, "groupSessionShells")

type SessionShellGroup = {
  owner: { label: string }
  shells: ShellInfo[]
}

type GroupSessionShells = (
  shells: readonly ShellInfo[],
  sessions: readonly SessionInfo[],
  currentSessionID: string,
  options?: { includeSettled?: boolean },
) => SessionShellGroup[]

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

function shell(id: string, sessionID?: string, status: ShellInfo["status"] = "running"): ShellInfo {
  return {
    id,
    status,
    command: `command ${id}`,
    cwd: "/workspace",
    shell: "bash",
    file: `/tmp/${id}`,
    metadata: sessionID ? { sessionID } : {},
    time: { started: 0 },
  }
}

test("groups current and child shells by their labelled owners", () => {
  expect(typeof groupSessionShellsCandidate).toBe("function")
  if (typeof groupSessionShellsCandidate !== "function") return
  const groupSessionShells = groupSessionShellsCandidate as GroupSessionShells

  const groups = groupSessionShells(
    [shell("child", "ses_child"), shell("main", "ses_main")],
    [
      session("ses_main", { title: "Main session" }),
      session("ses_child", { parentID: "ses_main", agent: "reviewer", title: "Check the TUI implementation" }),
    ],
    "ses_main",
  )

  expect(groups).toEqual([
    { owner: { label: "Main chat" }, shells: [shell("main", "ses_main")] },
    {
      owner: { label: "reviewer · Check the TUI implementation" },
      shells: [shell("child", "ses_child")],
    },
  ])
})

test("excludes shells owned by sessions outside the current subtree", () => {
  expect(typeof groupSessionShellsCandidate).toBe("function")
  if (typeof groupSessionShellsCandidate !== "function") return
  const groupSessionShells = groupSessionShellsCandidate as GroupSessionShells

  const groups = groupSessionShells(
    [shell("child", "ses_child"), shell("external", "ses_external")],
    [
      session("ses_main"),
      session("ses_child", { parentID: "ses_main", agent: "reviewer", title: "Review" }),
      session("ses_external", { agent: "builder", title: "Outside" }),
    ],
    "ses_main",
  )

  expect(groups.flatMap((group) => group.shells.map((item) => item.id))).toEqual(["child"])
})

test("excludes unknown and unattributed shells instead of grouping them under an unknown owner", () => {
  expect(typeof groupSessionShellsCandidate).toBe("function")
  if (typeof groupSessionShellsCandidate !== "function") return
  const groupSessionShells = groupSessionShellsCandidate as GroupSessionShells

  const groups = groupSessionShells(
    [shell("unknown", "ses_missing"), shell("unattributed"), shell("main", "ses_main")],
    [session("ses_main")],
    "ses_main",
  )

  expect(groups).toEqual([{ owner: { label: "Main chat" }, shells: [shell("main", "ses_main")] }])
})

test("groups shells of completed descendants and grandchildren under their owners", () => {
  expect(typeof groupSessionShellsCandidate).toBe("function")
  if (typeof groupSessionShellsCandidate !== "function") return
  const groupSessionShells = groupSessionShellsCandidate as GroupSessionShells

  const groups = groupSessionShells(
    [shell("grandchild", "ses_grandchild"), shell("child", "ses_child")],
    [
      session("ses_main"),
      session("ses_child", { parentID: "ses_main", agent: "builder", title: "Finished child" }),
      session("ses_grandchild", { parentID: "ses_child", agent: "reviewer", title: "Nested review" }),
    ],
    "ses_main",
  )

  expect(groups).toEqual([
    { owner: { label: "builder · Finished child" }, shells: [shell("child", "ses_child")] },
    { owner: { label: "reviewer · Nested review" }, shells: [shell("grandchild", "ses_grandchild")] },
  ])
})

test("resolves the family root when the current session is a child", () => {
  expect(typeof groupSessionShellsCandidate).toBe("function")
  if (typeof groupSessionShellsCandidate !== "function") return
  const groupSessionShells = groupSessionShellsCandidate as GroupSessionShells

  const groups = groupSessionShells(
    [shell("main", "ses_main"), shell("sibling", "ses_sibling"), shell("external", "ses_external")],
    [
      session("ses_main"),
      session("ses_child", { parentID: "ses_main", agent: "builder", title: "Current child" }),
      session("ses_sibling", { parentID: "ses_main", agent: "reviewer", title: "Sibling" }),
      session("ses_external", { agent: "builder", title: "Outside" }),
    ],
    "ses_child",
  )

  expect(groups.flatMap((group) => group.shells.map((item) => item.id))).toEqual(["main", "sibling"])
  expect(groups[0]?.owner.label).toBe("Main chat")
})

test("includeSettled keeps exited family shells and still excludes foreign shells", () => {
  expect(typeof groupSessionShellsCandidate).toBe("function")
  if (typeof groupSessionShellsCandidate !== "function") return
  const groupSessionShells = groupSessionShellsCandidate as GroupSessionShells

  const groups = groupSessionShells(
    [shell("child-exited", "ses_child", "exited"), shell("external-exited", "ses_external", "exited")],
    [
      session("ses_main"),
      session("ses_child", { parentID: "ses_main", agent: "reviewer", title: "Review" }),
      session("ses_external", { agent: "builder", title: "Outside" }),
    ],
    "ses_main",
    { includeSettled: true },
  )

  expect(groups.flatMap((group) => group.shells.map((item) => item.id))).toEqual(["child-exited"])
})

test("returns only running rows so the badge count equals the tab row count", () => {
  expect(typeof groupSessionShellsCandidate).toBe("function")
  if (typeof groupSessionShellsCandidate !== "function") return
  const groupSessionShells = groupSessionShellsCandidate as GroupSessionShells

  const groups = groupSessionShells(
    [shell("child", "ses_child"), shell("main-exited", "ses_main", "exited"), shell("main", "ses_main")],
    [
      session("ses_main"),
      session("ses_child", { parentID: "ses_main", agent: "reviewer", title: "Review" }),
    ],
    "ses_main",
  )
  const rows = groups.flatMap((group) => group.shells)

  expect(rows.map((item) => item.id)).toEqual(["main", "child"])
  expect(rows).toHaveLength(2)
})
