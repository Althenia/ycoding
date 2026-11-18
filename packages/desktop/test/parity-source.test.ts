import { expect, test } from "bun:test"

const tui = (path: string) => Bun.file(new URL(`../../tui/src/${path}`, import.meta.url)).text()
const desktop = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text()
const compact = (text: string) => text.replace(/\s+/g, "")

const workflows = [
  {
    name: "permissions, typed forms and Family Review use their owning decision APIs",
    sources: ["routes/session/permission.tsx", "routes/session/form.tsx", "routes/session/index.tsx", "routes/session/guardrail.tsx"],
    calls: ["permission.reply(", "form.reply(", "form.cancel(", "review.decide(", "guardrail.request.reply("],
  },
  {
    name: "goals and independent autonomy modes use canonical read and write operations",
    sources: ["component/dialog-session-goal.tsx", "component/prompt/index.tsx"],
    calls: ["session.autonomy.get(", "session.autonomy.set("],
  },
  {
    name: "active-agent selection reaches submission rather than inserting an agent mention",
    sources: ["prompt/submission.ts"],
    calls: ["session.switchAgent("],
  },
  {
    name: "model, profile and effort changes use Session model selection",
    sources: ["prompt/submission.ts"],
    calls: ["session.switchModel("],
  },
  {
    name: "paged history has a canonical snapshot and does not depend on a whole-history message read",
    sources: ["context/data.tsx"],
    calls: ["session.snapshot("],
  },
  {
    name: "fork and staged, cleared and committed reverts use canonical Session boundaries",
    sources: ["routes/session/dialog-fork.tsx", "routes/session/index.tsx", "prompt/submission.ts"],
    calls: ["session.fork(", "session.revert.stage(", "session.revert.clear(", "session.revert.commit("],
  },
  {
    name: "background and interrupt retain distinct operations",
    sources: ["component/prompt/index.tsx"],
    calls: ["session.background(", "session.interrupt("],
  },
  {
    name: "subagent answers retain parent, child and current question identity",
    sources: ["routes/session/subagent-blocked.tsx"],
    calls: ["session.subagent.answer("],
  },
  {
    name: "subagent lists and cancellation use parent-scoped operations",
    sources: ["context/data.tsx", "routes/session/composer/subagents-tab.tsx"],
    calls: ["session.subagent.list(", "session.subagent.cancel("],
  },
  {
    name: "prediction and prompt generation have distinct canonical operations",
    sources: ["context/data.tsx"],
    calls: ["session.prediction(", "session.promptGenerate("],
  },
  {
    name: "skill selection activates the skill rather than sending its command label as text",
    sources: ["prompt/submission.ts"],
    calls: ["session.skill("],
  },
  {
    name: "session shell mode submits a shell command rather than an ordinary prompt",
    sources: ["component/prompt/index.tsx"],
    calls: ["session.shell("],
  },
  {
    name: "queued inputs are read durably rather than reconstructed from a local draft",
    sources: ["context/data.tsx"],
    calls: ["session.pending.list("],
  },
  {
    name: "Session terminal inspection has Session-scoped PTY list and get operations",
    sources: ["component/dialog-session-terminals.tsx", "routes/terminal-inspector.tsx"],
    calls: ["pty.list(", "pty.get("],
  },
  {
    name: "Dots access and attach or detach are distinct from remote relay opt-in",
    sources: ["dots-connection.ts"],
    calls: ["dots.set(", "dots.attach(", "dots.detach("],
  },
  {
    name: "artifact details, metrics, history, trash and preview-confirm mutations go beyond enable and disable",
    sources: ["component/dialog-project-artifacts.tsx"],
    calls: ["projectArtifact.artifact.get(", "projectArtifact.artifact.metrics(", "projectArtifact.artifact.revert(", "projectArtifact.artifact.remove(", "projectArtifact.artifact.restore(", "projectArtifact.artifact.promotion.preview(", "projectArtifact.artifact.promotion.confirm(", "projectArtifact.artifact.fork.preview(", "projectArtifact.artifact.fork.confirm(", "projectArtifact.artifact.shadow.preview(", "projectArtifact.artifact.shadow.confirm("],
  },
  {
    name: "isolated browser pause and resume remain distinct from stopping its instance",
    sources: ["component/dialog-session-browser.tsx"],
    calls: ["isolatedBrowser.control("],
  },
  {
    name: "MCP connection actions use canonical connect and disconnect operations",
    sources: ["component/dialog-mcp.tsx"],
    calls: ["mcp.connect(", "mcp.disconnect("],
  },
  {
    name: "workspace refresh and forget preserve project and directory identity",
    sources: ["component/dialog-move-session.tsx", "routes/workspaces.tsx"],
    calls: ["projectCopy.refresh(", "project.forget("],
  },
  {
    name: "Project changes retain coordination ownership and revision",
    sources: ["context/coordination.tsx"],
    calls: ["coordination.create(", "coordination.update(", "coordination.delete("],
  },
  {
    name: "Session todos and context diagnostics are read from their authoritative projections",
    sources: ["context/data.tsx"],
    calls: ["session.todo.list(", "session.diagnostics(", "session.usage("],
  },
  {
    name: "recursive subagent costs retain the canonical task-cost read",
    sources: ["context/data.tsx"],
    calls: ["session.taskCosts("],
  },
  {
    name: "credential refresh is available separately from reconnecting or replacing a key",
    sources: ["component/dialog-integration.tsx"],
    calls: ["credential.refresh("],
  },
] as const

for (const workflow of workflows) {
  test(`source prerequisite: ${workflow.name}`, async () => {
    const reference = compact((await Promise.all(workflow.sources.map(tui))).join("\n"))
    const implementation = compact(await desktop("backend-controller.ts"))
    expect(workflow.calls.filter((call) => !reference.includes(call)), "TUI source anchors").toEqual([])
    expect(workflow.calls.filter((call) => !implementation.includes(call)), "Desktop canonical call gaps; source presence is necessary, not behavioral proof").toEqual([])
  })
}

test("source prerequisite: transcript export offers both structured and Markdown output, not only the latest assistant reply", async () => {
  const reference = await tui("routes/session/index.tsx")
  expect(reference).toContain("DialogExportOptions.show")
  expect(reference).toContain("JSON.stringify({ info: sessionData, messages }")
  const renderer = await desktop("renderer.tsx")
  expect(renderer).toContain("api.exportSession(input)")
  expect(renderer).toContain("api.saveExportSession(input)")
  const controller = await desktop("backend-controller.ts")
  expect(controller).toContain('request.format === "json"')
  expect(controller).toContain("JSON.stringify(request.debug ? { info, events: messages } : { info, messages }")
  expect(controller).toContain("sessionMarkdown(info, messages")
})

test("source prerequisite: copy transcript does not silently copy only the latest assistant response", async () => {
  const reference = await tui("routes/session/index.tsx")
  expect(reference).toContain("formatSessionTranscript(sessionData, await client.api.message.list(")
  const renderer = await desktop("renderer.tsx")
  const copy = renderer.slice(renderer.indexOf('case "copy":'), renderer.indexOf('case "export":'))
  expect(copy).not.toContain("latestAssistantText(")
})

test("source prerequisite: BTW creation and reviewed parent steering retain the side-chat agent and delivery intent", async () => {
  const reference = compact(await tui("util/session.ts"))
  expect(reference).toContain('agent:"btw"')
  expect(reference).toContain('delivery:"steer"')
  const controller = compact(await desktop("backend-controller.ts"))
  expect(controller.includes('agent:"btw"'), "side-chat agent on creation").toBe(true)
  expect(controller.includes('delivery:"steer"'), "reviewed text steers its parent").toBe(true)
})

test("source prerequisite: editor context has a synthetic input boundary instead of becoming operator text", async () => {
  const reference = compact(await tui("prompt/submission.ts"))
  expect(reference).toContain("session.synthetic(")
  expect(reference).toContain("resume:false")
  expect(compact(await desktop("backend-controller.ts")).includes("session.synthetic("), "synthetic editor-context submission").toBe(true)
})

test("source prerequisite: durable admitted-pending inputs are reconciled on re-entry", async () => {
  const reference = compact(await tui("context/data.tsx"))
  expect(reference).toContain("session.pending.list(")
  const controller = compact(await desktop("backend-controller.ts"))
  expect(controller.includes("session.pending.list("), "durable pending inputs on re-entry").toBe(true)
  expect(controller.includes("session.snapshot("), "durable history snapshot").toBe(true)
})

test("source prerequisite: Project members have reachable create, remove and delete controls", async () => {
  const reference = await tui("routes/session/project-members.tsx")
  expect(reference).toContain('title: "New Session"')
  expect(reference).toContain('title: "Remove member"')
  expect(reference).toContain('title: "Delete member"')
  const renderer = await desktop("renderer.tsx")
  expect(renderer).toContain("<DesktopProjectMembers")
  const members = await desktop("project-members.tsx")
  for (const label of ["Create member Session", "Add member", "Remove ${member.title} from project", "Delete member Session ${member.title}"]) expect(members).toContain(label)
  for (const id of ["project-member-new", "project-member-add", "project-member-remove", "project-member-delete"]) expect(members).toContain(`data-action-id="${id}"`)
  expect(members).toMatch(/kind:\s*"new-member"/)
  expect(members).toMatch(/kind:\s*"delete-member"/)
  expect(members).toMatch(/kind:\s*"attach-member"/)
  expect(members).toMatch(/kind:\s*"detach-member"/)
  expect(members).not.toContain("memberSessionIDs")
})

test("source contract: stopped subagent continuation uses its recovery review, not a fabricated resume route", async () => {
  const reference = compact(await tui("routes/session/composer/subagents-tab.tsx"))
  expect(reference).toContain('review.decide({sessionID:entry.sessionID,itemID,decision:{kind:"recovery",choice:"continue"}})')
  const renderer = compact(await desktop("renderer.tsx"))
  expect(renderer).toContain('kind:"recovery",choice:"continue"')
  expect(await desktop("backend-controller.ts")).toContain("api.review.decide(")
})

test("source contract: read-only status and unavailable TUI actions are not behavioral parity evidence", async () => {
  const reference = await tui("routes/session/index.tsx")
  expect(reference).toContain('run: () => unavailable("Unsharing")')
  const renderer = await desktop("renderer.tsx")
  expect(renderer).toContain('props.item.payload.type === "question"')
  expect(renderer).toContain('props.item.payload.type === "form"')
  expect(renderer).toContain('kind: "review"')
})
