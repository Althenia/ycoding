/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { AgentInfo, SkillInfo } from "@ycoding-ai/client"
import { createEffect } from "solid-js"
import { Autocomplete, type AutocompleteRef } from "../../src/component/prompt/autocomplete"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { LocationProvider, useLocation } from "../../src/context/location"
import { ThemeProvider } from "../../src/context/theme"
import { Keymap } from "../../src/context/keymap"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { createApi, createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

function frame(app: Awaited<ReturnType<typeof testRender>>) {
  return app.captureCharFrame().split("\n").map((line) => line.trimEnd()).join("\n")
}

function SyncLocation() {
  const data = useData()
  const location = useLocation()
  createEffect(() => location.set(data.location.default()))
  return null
}

async function renderAutocomplete(input: { agents: AgentInfo[]; skills: SkillInfo[]; height?: number }) {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/agent")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: input.agents })
    if (url.pathname === "/api/skill")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: input.skills })
    return undefined
  }, events)
  let textarea!: TextareaRenderable
  let anchor!: BoxRenderable
  let autocomplete!: AutocompleteRef

  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ClientProvider api={createApi(calls.fetch)}>
              <DataProvider>
                <LocationProvider>
                  <SyncLocation />
                  <EditorContextProvider>
                    <FrecencyProvider>
                      <Keymap.Provider>
                        <box width={80} height={input.height ?? 6} flexDirection="column">
                          <box flexGrow={1} />
                          <box ref={(value: BoxRenderable) => (anchor = value)} height={1}>
                            <textarea ref={(value: TextareaRenderable) => (textarea = value)} width="100%" />
                          </box>
                          <text>footer</text>
                          <Autocomplete
                            value="#"
                            anchor={() => anchor}
                            input={() => textarea}
                            ref={(value) => (autocomplete = value)}
                            setPrompt={() => {}}
                            setExtmark={() => {}}
                            fileStyleId={0}
                            agentStyleId={0}
                            skillStyleId={0}
                            promptPartTypeId={() => 0}
                          />
                        </box>
                      </Keymap.Provider>
                    </FrecencyProvider>
                  </EditorContextProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: input.height ?? 6 },
  )
  app.renderer.start()
  await app.waitForFrame((value) => value.includes("footer"))
  textarea.insertText("#")
  autocomplete.onInput("#")
  await app.waitForFrame((value) => value.includes(input.skills[0]?.name ?? "footer"))
  return app
}

function skill(id: string, conflicts = false): SkillInfo {
  return {
    id,
    name: id,
    description: `${id} description`,
    conflicts: conflicts ? { skills: ["other-skill"], instructions: [] } : undefined,
    location: directory,
    content: "",
  }
}

function agent(id: string, name = id): AgentInfo {
  return {
    id,
    name,
    request: { headers: {}, body: {} },
    mode: "subagent",
    hidden: false,
    permissions: [],
  }
}

describe("prompt # autocomplete", () => {
  test("renders skills and agents with inline conflict markers above the footer at 80 columns", async () => {
    const app = await renderAutocomplete({ agents: [agent("reviewer", "Reviewer Agent")], skills: [skill("danger", true)] })

    try {
      const output = frame(app)
      expect(output).toContain("danger · conflict")
      expect(output).toContain("Reviewer Agent")
      expect(output.split("\n").at(-2)).toBe("footer")
    } finally {
      app.renderer.destroy()
    }
  })

  test("caps # autocomplete at eight rows", async () => {
    const app = await renderAutocomplete({
      agents: [],
      skills: Array.from({ length: 9 }, (_, index) => skill(`skill-${index}`)),
      height: 12,
    })

    try {
      const output = frame(app)
      expect(output).toContain("skill-7")
      expect(output).not.toContain("skill-8")
    } finally {
      app.renderer.destroy()
    }
  })
})
