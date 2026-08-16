/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { YCodingClient } from "@ycoding-ai/client"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProjectArtifacts } from "../src/component/dialog-project-artifacts"
import { DialogSessionSkills } from "../src/component/dialog-session-skills"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("renders Active, Conflict, and Available skill sections with conflict treatment", async () => {
  const result = await renderDialog(
    () => <DialogSessionSkills sessionID="ses_1" />,
    sessionSkillsClient([
      skill({ id: "active", name: "Go developer", state: "active" }),
      skill({ id: "conflict", name: "Go review", state: "active", conflicts: [{ type: "skill", id: "go", name: "Go developer" }] }),
      skill({ id: "available", name: "Rust developer", state: "inactive" }),
    ]),
  )

  expect(result.frame).toContain("Active")
  expect(result.frame).toContain("Conflict")
  expect(result.frame).toContain("Available")
  expect(result.frame).toContain("Go review")
  expect(result.frame).toContain("Needs choice")
  expect(result.frame).not.toContain("global")
  expect(result.frame).not.toContain("project")
})

test("renders all artifact kind sections at once", async () => {
  const result = await renderDialog(
    () => <DialogProjectArtifacts />,
    artifactsClient([
      artifact({ kind: "skill", name: "Go developer" }),
      artifact({ kind: "command", name: "Deploy" }),
      artifact({ kind: "agent", name: "Reviewer" }),
      artifact({ kind: "plugin", name: "Agent memory", stage: "quarantine" }),
    ]),
  )

  expect(result.frame).toContain("Skills")
  expect(result.frame).toContain("Commands")
  expect(result.frame).toContain("Agents")
  expect(result.frame).toContain("Plugins")
})

test("renders project and global skill scopes from registered skill locations", async () => {
  const result = await renderDialog(
    () => <DialogSessionSkills sessionID="ses_1" />,
    sessionSkillsClient(
      [
        skill({ id: "project-skill", name: "Project skill", state: "active" }),
        skill({ id: "global-skill", name: "Global skill", state: "active" }),
      ],
      [
        skillInfo({ id: "project-skill", name: "Project skill", location: "/repo/.ycoding/skills/project-skill/SKILL.md" }),
        skillInfo({ id: "global-skill", name: "Global skill", location: "/tmp/ycoding/home/.agents/skills/global-skill/SKILL.md" }),
      ],
    ),
  )

  expect(result.frame).toContain("project")
  expect(result.frame).toContain("global")
})

test("renders no scope for a skill outside known project and global roots", async () => {
  const result = await renderDialog(
    () => <DialogSessionSkills sessionID="ses_1" />,
    sessionSkillsClient(
      [skill({ id: "external-skill", name: "External skill", state: "inactive" })],
      [skillInfo({ id: "external-skill", name: "External skill", location: "/opt/skills/external-skill/SKILL.md" })],
    ),
  )

  expect(result.frame).toContain("External skill")
  expect(result.frame).not.toContain("project")
  expect(result.frame).not.toContain("global")
})

test("renders artifact scope and stage-derived load status", async () => {
  const result = await renderDialog(
    () => <DialogProjectArtifacts />,
    artifactsClient([
      artifact({ kind: "skill", name: "Go developer", stage: "active" }),
      artifact({ kind: "plugin", name: "Agent memory", stage: "quarantine" }),
    ]),
  )

  expect(result.frame).toContain("Project · All")
  expect(result.frame).toContain("Loaded")
  expect(result.frame).toContain("○")
  expect(result.frame).toContain("Not loaded")
})

async function renderDialog(view: () => ReturnType<typeof DialogSessionSkills>, api: YCodingClient) {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => dialog.replace(view))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={api}>
                <ToastProvider>
                  <DialogProvider>
                    <DialogFixture />
                  </DialogProvider>
                </ToastProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Session skills") || frame.includes("Project artifacts"))

  try {
    return { frame: app.captureCharFrame() }
  } finally {
    app.renderer.destroy()
  }
}

function sessionSkillsClient(skills: ReturnType<typeof skill>[], skillInfos: ReturnType<typeof skillInfo>[] = []) {
  return {
    session: {
      skills: async () => skills,
    },
    skill: {
      list: async () => ({
        location: { directory: "/repo", project: { id: "project_1", directory: "/repo" } },
        data: skillInfos,
      }),
    },
    event: { subscribe: async function* () {} },
  } as unknown as YCodingClient
}

function artifactsClient(artifacts: ReturnType<typeof artifact>[]) {
  return {
    projectArtifact: {
      artifact: {
        list: async () => artifacts,
      },
    },
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
    activationMessageID: "msg_1",
    content: "",
    conflicts: input.conflicts ?? [],
    declarations: {},
    ...(input.state === "inactive" ? { inactiveReason: "compacted" as const } : {}),
  }
}

function skillInfo(input: { id: string; name: string; location: string }) {
  return {
    ...input,
    content: "",
  }
}

function artifact(input: {
  kind: "skill" | "command" | "agent" | "plugin"
  name: string
  stage?: "trial" | "active" | "degraded" | "disabled" | "quarantine"
}) {
  return {
    scope: { type: "project" as const, id: "scope_1" },
    kind: input.kind,
    id: input.name.toLowerCase().replaceAll(" ", "-"),
    name: input.name,
    description: "",
    stage: input.stage ?? "active",
    revision: 1,
    currentVersionID: "pav_1",
    currentDigest: "digest",
    timeUpdated: 0,
  }
}
