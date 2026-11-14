import { expect, test } from "bun:test"
import { groupID, leadID } from "../fixture/coordination-backend"
import { mountCoordination, waitForFrame } from "../fixture/coordination-screen"

for (const cancel of ["escape", "selection"] as const) {
  test(`Project delete ${cancel} cancellation preserves metadata and Sessions`, async () => {
    const view = await mountCoordination({ width: 80, height: 24 })
    try {
      view.router().navigate({ type: "projects", sessionID: leadID })
      await waitForFrame(view.screen, "[D] Delete")
      const before = structuredClone({ projects: view.server.state.projects, sessions: view.server.state.sessions })
      view.screen.input.pressKey("d", { shift: true })
      await waitForFrame(view.screen, "Delete Release train?")
      if (cancel === "escape") view.screen.input.pressEscape()
      else {
        view.screen.input.pressArrow("up")
        view.screen.input.pressEnter()
      }
      await waitForFrame(view.screen, "[D] Delete")
      expect(view.server.state.projects).toEqual(before.projects)
      expect(view.server.state.sessions).toEqual(before.sessions)
      expect(view.server.state.writes).toEqual([])
    } finally {
      await view.screen.dispose()
    }
  }, 30_000)
}

test("Project delete confirmation removes only selected active metadata and leaves Sessions and files untouched", async () => {
  const view = await mountCoordination({ width: 80, height: 24 })
  try {
    view.router().navigate({ type: "projects", sessionID: leadID })
    await waitForFrame(view.screen, "[D] Delete")
    const sessions = structuredClone(view.server.state.sessions)
    const retained = structuredClone(view.server.state.projects[1])
    expect(view.server.state.projects[0]?.active).toBe(true)
    view.screen.input.pressKey("d", { shift: true })
    await waitForFrame(view.screen, "Delete Release train?")
    expect(view.screen.frame()).toContain("keep their histories")
    view.screen.input.pressEnter()
    await waitForFrame(view.screen, "PROJECTS 1")
    expect(view.server.state.projects).toEqual([retained])
    expect(view.server.state.sessions).toEqual(sessions)
    expect(view.server.state.writes).toEqual([{ method: "DELETE", path: `/api/coordination/${groupID}`, body: {} }])
    expect(view.requests.filter((request) => !request.startsWith("GET ") && !request.startsWith("POST /api/event"))).toEqual([
      `DELETE /api/coordination/${groupID}`,
    ])
  } finally {
    await view.screen.dispose()
  }
}, 30_000)

test("Project delete does nothing on the New project row or an empty list", async () => {
  for (const empty of [false, true]) {
    const view = await mountCoordination({ backend: empty ? { projects: [] } : undefined })
    try {
      view.router().navigate({ type: "projects", sessionID: leadID })
      await waitForFrame(view.screen, "[n] + New project")
      view.screen.input.pressKey("end")
      view.screen.input.pressKey("d", { shift: true })
      await view.screen.renderOnce()
      expect(view.screen.frame()).not.toContain("Delete Release train?")
      expect(view.server.state.writes).toEqual([])
    } finally {
      await view.screen.dispose()
    }
  }
}, 30_000)
