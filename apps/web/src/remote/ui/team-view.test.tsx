import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { RunningExecution } from "./team-view"
import type { TeamPanelData } from "./team-model"

const data: TeamPanelData = {
  rootID: "ses_root", status: "ready", pageLoading: false, shellStatus: "ready", sideChats: [], sideChatStatus: "ready", sideChatLoading: false,
  tasks: [{ sessionID: "ses_live", parentID: "ses_root", description: "Live review", state: "running", revision: 1, updatedAt: 1, modelLabel: "Fixture model" }, { sessionID: "ses_wait", parentID: "ses_root", description: "Waiting review", state: "waiting", revision: 1, updatedAt: 1 }],
  shells: [{ id: "sh_live", ownerID: "ses_root", command: "fixture live", status: "running", startedAt: 1 }, { id: "sh_done", ownerID: "ses_root", command: "fixture done", status: "exited", startedAt: 1 }],
}

test("Running presents subagents and shells separately without waiting or completed history", () => {
  const html = renderToString(() => <RunningExecution data={() => data} onOpen={() => {}} />)
  expect(html).toContain('aria-label="Running subagents"')
  expect(html).toContain('aria-label="Running shells"')
  expect(html).toContain('aria-label="Open Live review"')
  expect(html).toContain("fixture live")
  expect(html).not.toContain("Waiting review")
  expect(html).not.toContain("fixture done")
})

test("Running qualifies incomplete reads and never reports unavailable activity as empty", () => {
  const html = renderToString(() => <RunningExecution data={() => ({ ...data, tasks: [], shells: [], status: "loading", shellStatus: "error" })} onOpen={() => {}} />)
  expect(html).toContain("Subagents are loading.")
  expect(html).toContain("Running shells are unavailable.")
  expect(html).not.toContain("No running")
})
