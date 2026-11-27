/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { V5Client } from "@ycoding-ai/client/v5"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
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
  const inactive = result.frame.split("\n").find((line) => line.includes("Rust developer"))
  expect(inactive).toContain("Inactive")
  expect(inactive).toContain("○")
  expect(result.frame).not.toContain("global")
  expect(result.frame).not.toContain("project")
})

async function renderDialog(view: () => ReturnType<typeof DialogSessionSkills>, api: V5Client) {
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
  await app.waitForFrame((frame) => frame.includes("Session skills"))

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
    transport: { close() {}, reconnect: async () => {} },
  } as unknown as V5Client
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
