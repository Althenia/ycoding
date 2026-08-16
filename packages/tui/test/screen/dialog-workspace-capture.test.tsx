/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { YCodingClient } from "@ycoding-ai/client"
import { expect, test } from "bun:test"
import path from "path"
import { onMount, type JSX } from "solid-js"
import { CommandPaletteDialog } from "../../src/component/command-palette"
import { DialogProjectArtifacts } from "../../src/component/dialog-project-artifacts"
import { DialogSessionSkills } from "../../src/component/dialog-session-skills"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const viewports = [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE] as const

const sessionSkills = [
  skill({ id: "go-developer", name: "go-developer", state: "active" }),
  skill({ id: "writing-test", name: "writing-test", state: "active" }),
  skill({
    id: "go-review",
    name: "go-review",
    state: "active",
    conflicts: [{ type: "skill", id: "go-developer", name: "go-developer" }],
  }),
  skill({ id: "rust-developer", name: "rust-developer", state: "inactive" }),
  skill({ id: "python-developer", name: "python-developer", state: "inactive" }),
]

const skillInfo = [
  { id: "go-developer", name: "go-developer", content: "", location: "/repo/.ycoding/skills/go-developer/SKILL.md" },
  { id: "writing-test", name: "writing-test", content: "", location: "/tmp/ycoding/home/.agents/skills/writing-test/SKILL.md" },
]

const artifacts = [
  artifact({ kind: "skill", id: "go-developer", name: "go-developer", description: ".ycoding/skills" }),
  artifact({ kind: "command", id: "deploy", name: "deploy", description: ".ycoding/commands" }),
  artifact({ kind: "agent", id: "reviewer", name: "reviewer", description: ".ycoding/agents" }),
  artifact({ kind: "plugin", id: "agentmemory", name: "agentmemory", description: "draft", stage: "quarantine" }),
]

test("captures workspace dialogs at reference terminal dimensions", async () => {
  for (const viewport of viewports) {
    await capture(
      "command-palette",
      () => <CommandPaletteDialog />,
      commandPaletteClient(),
      viewport,
      "Switch model",
      true,
    )
    await capture(
      "session-skills",
      () => <DialogSessionSkills sessionID="ses_dialog_capture" location={{ directory: "/repo" }} />,
      sessionSkillsClient(),
      viewport,
      "python-developer",
    )
    await capture(
      "project-artifacts",
      () => <DialogProjectArtifacts location={{ directory: "/repo" }} />,
      artifactsClient(),
      viewport,
      "agentmemory",
    )
  }
}, 120_000)

async function capture(
  name: string,
  view: () => JSX.Element,
  api: YCodingClient,
  viewport: (typeof viewports)[number],
  settle: string,
  commands = false,
) {
  function Commands() {
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        { id: "test.model", bind: "ctrl+x m", title: "Switch model", group: "Suggested", palette: true, suggested: true, run: () => {} },
        { id: "test.session", bind: "ctrl+x 1", title: "Switch session", group: "Suggested", palette: true, suggested: true, run: () => {} },
        { id: "test.settings", title: "Open settings", group: "Suggested", palette: true, run: () => {} },
        { id: "test.new", bind: "ctrl+x n", title: "New session", group: "Session", palette: true, run: () => {} },
        { id: "test.editor", bind: "ctrl+x e", title: "Open editor", group: "Session", palette: true, run: () => {} },
        { id: "test.move", bind: "ctrl+x l", title: "Move session", group: "Session", palette: true, run: () => {} },
        { id: "test.agent", bind: "ctrl+x a", title: "Switch agent", group: "Agent", palette: true, run: () => {} },
        { id: "test.variant", bind: "ctrl+x t", title: "Variant cycle", group: "Agent", palette: true, run: () => {} },
        { id: "test.status", bind: "ctrl+x s", title: "View status", group: "System", palette: true, run: () => {} },
      ],
    }))
    return null
  }

  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => dialog.replace(view))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ClientProvider api={api}>
              <Keymap.Provider>
                {commands && <Commands />}
                <ToastProvider>
                  <DialogProvider>
                    <DialogFixture />
                  </DialogProvider>
                </ToastProvider>
              </Keymap.Provider>
            </ClientProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(settle))

  try {
    const frame = app.captureCharFrame()
    const rows = (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n")
    expect(rows).toHaveLength(viewport.height)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)

    // --- Focused assertions for open TOON differences ---

    if (name === "session-skills") {
      // difference:workspace-session-skills-conflict-glyph
      // Expected: one ! marker before go-review, not !!
      const goReviewRow = rows.find((r) => r.includes("go-review"))
      expect(goReviewRow).toBeDefined()
      expect(goReviewRow!.includes("!!")).toBe(false)
      expect(goReviewRow!.includes("! ")).toBe(true)
    }

    if (name === "project-artifacts") {
      // difference:workspace-project-artifacts-scope-tabs
      // Expected: title row contains "Project artifacts" and "esc" but no scope tabs
      const titleRow = rows.find((r) => r.includes("Project artifacts"))
      expect(titleRow).toBeDefined()
      expect(titleRow!.includes("Project")).toBe(true)
      expect(titleRow!.includes("esc")).toBe(true)
      expect(titleRow!.includes("Global")).toBe(false)
      expect(titleRow!.includes("Trash")).toBe(false)

      // difference:workspace-project-artifacts-row-metadata
      // Expected: artifact rows show their repository paths, not "project" for every row
      const goDeveloperRow = rows.find((r) => r.includes("go-developer"))
      expect(goDeveloperRow).toBeDefined()
      expect(goDeveloperRow!.includes(".ycoding/skills")).toBe(true)
      expect(goDeveloperRow!.includes("project")).toBe(false)

      const deployRow = rows.find((r) => r.includes("deploy"))
      expect(deployRow).toBeDefined()
      expect(deployRow!.includes(".ycoding/commands")).toBe(true)

      const reviewerRow = rows.find((r) => r.includes("reviewer"))
      expect(reviewerRow).toBeDefined()
      expect(reviewerRow!.includes(".ycoding/agents")).toBe(true)

      const agentmemoryRow = rows.find((r) => r.includes("agentmemory"))
      expect(agentmemoryRow).toBeDefined()
      expect(agentmemoryRow!.includes("draft")).toBe(true)
    }

    // --- End focused assertions ---

    await Bun.write(path.join(renders, `dialog-workspace-${name}-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
  } finally {
    app.renderer.destroy()
  }
}

function commandPaletteClient() {
  return { event: { subscribe: async function* () {} } } as unknown as YCodingClient
}

function sessionSkillsClient() {
  return {
    session: { skills: async () => sessionSkills },
    skill: {
      list: async () => ({
        location: { directory: "/repo", project: { id: "proj_dialog_capture", directory: "/repo" } },
        data: skillInfo,
      }),
    },
    event: { subscribe: async function* () {} },
  } as unknown as YCodingClient
}

function artifactsClient() {
  return {
    projectArtifact: { artifact: { list: async () => artifacts } },
    event: { subscribe: async function* () {} },
  } as unknown as YCodingClient
}

function skill(input: {
  id: string
  name: string
  state: "active" | "inactive"
  conflicts?: { type: "skill"; id: string; name: string }[]
}) {
  return {
    ...input,
    activatedBy: "tool" as const,
    activationMessageID: "msg_dialog_capture",
    content: "",
    conflicts: input.conflicts ?? [],
    declarations: {},
    ...(input.state === "inactive" ? { inactiveReason: "compacted" as const } : {}),
  }
}

function artifact(input: {
  kind: "skill" | "command" | "agent" | "plugin"
  id: string
  name: string
  description: string
  stage?: "trial" | "active" | "degraded" | "disabled" | "quarantine"
}) {
  return {
    scope: { type: "project" as const, id: "scope_dialog_capture" },
    ...input,
    stage: input.stage ?? "active",
    revision: 1,
    currentVersionID: "pav_dialog_capture",
    currentDigest: "dialog-capture",
    timeUpdated: 0,
  }
}
