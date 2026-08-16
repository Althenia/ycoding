/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { YCodingClient } from "@ycoding-ai/client"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { SkillsRailContent } from "../src/feature-plugins/sidebar/skills"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import type { SessionSkill } from "../src/util/session-skills"
import { TestTuiContexts } from "./fixture/tui-environment"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "./viewport"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const conflict: SessionSkill[] = [
  {
    id: "winner",
    name: "Winner",
    activatedBy: "tool",
    activationMessageID: "msg_winner",
    content: "",
    conflicts: [{ type: "skill", id: "loser", name: "Loser" }],
    declarations: {},
    state: "active",
  },
  {
    id: "loser",
    name: "Loser",
    activatedBy: "tool",
    activationMessageID: "msg_loser",
    content: "",
    conflicts: [],
    declarations: {},
    state: "active",
  },
]

const viewports = [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT]

for (const viewport of viewports) {
  test(`renders the real conflict affordance at ${viewport.width} columns`, async () => {
    const app = await mount(viewport, conflict)

    try {
      expect(app.captureCharFrame()).toContain("! 1 conflict · ⌃x i")
      const separator = app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("·"))
      expect(separator?.fg.toInts()).toEqual(app.separator().toInts())
    } finally {
      app.renderer.destroy()
    }
  })
}

for (const viewport of viewports) {
  test(`omits the conflict row at ${viewport.width} columns when no active skill conflict exists`, async () => {
    const app = await mount(viewport, [
      { ...conflict[0], conflicts: [] },
      conflict[1],
    ])

    try {
      expect(app.captureCharFrame()).not.toContain("conflict")
      expect(app.captureCharFrame()).not.toContain("!")
    } finally {
      app.renderer.destroy()
    }
  })
}

test("renders a rebound live shortcut instead of the default hint", async () => {
  const app = await mount(DESIGN_VIEWPORT, conflict, { session_skill_conflict_resolve: "ctrl+k" })

  try {
    expect(app.captureCharFrame()).toContain("⌃k")
    expect(app.captureCharFrame()).not.toContain("⌃x i")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the conflict row without a dead shortcut when the command is unbound", async () => {
  const app = await mount(DESIGN_VIEWPORT, conflict, { session_skill_conflict_resolve: "none" })

  try {
    expect(app.captureCharFrame()).toContain("! 1 conflict ·")
    expect(app.captureCharFrame()).not.toContain("⌃")
  } finally {
    app.renderer.destroy()
  }
})

test("resolves the selected skill winner", async () => {
  const calls: Array<{ winner: string; loser: string }> = []
  const app = await mount(DESIGN_VIEWPORT, conflict, {}, {
    resolve: async (input) => {
      calls.push({ winner: input.winner, loser: input.loser })
    },
  })

  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("i")
    await app.waitForFrame((frame) => frame.includes("Choose a skill to keep"))
    await Bun.sleep(10)
    app.mockInput.pressArrow("down")
    await Bun.sleep(10)
    app.mockInput.pressEnter()
    await app.waitForFrame(() => calls.length === 1)
    expect(calls).toEqual([{ winner: "loser", loser: "winner" }])
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes the server-derived skills after a conflict is already resolved", async () => {
  const app = await mount(DESIGN_VIEWPORT, conflict, {}, {
    resolve: async () => Promise.reject({ _tag: "SkillConflictNotFoundError" }),
    afterResolve: [
      { ...conflict[0], conflicts: [] },
      conflict[1],
    ],
  })

  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("i")
    await app.waitForFrame((frame) => frame.includes("Choose a skill to keep"))
    await Bun.sleep(10)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => !frame.includes("1 conflict"))
    expect(app.captureCharFrame()).not.toContain("1 conflict")
  } finally {
    app.renderer.destroy()
  }
})

async function mount(
  viewport: { width: number; height: number },
  initial: SessionSkill[],
  keybinds: { session_skill_conflict_resolve?: "ctrl+k" | "none" } = {},
  behavior: {
    resolve?: (input: { winner: string; loser: string }) => Promise<unknown>
    afterResolve?: SessionSkill[]
  } = {},
) {
  let skills = initial
  let separator: ReturnType<typeof useTheme>["themeV2"]["text"]["separator"]
  const api = {
    session: {
      skills: async (_input: { sessionID: string }) => skills,
      resolveSkillConflict: async (input: { winner: string; loser: string }) => {
        if (behavior.afterResolve) skills = behavior.afterResolve
        return behavior.resolve?.(input)
      },
    },
    event: { subscribe: async function* () {} },
  } as unknown as YCodingClient

  function Rail() {
    separator = useTheme().themeV2.text.separator
    const [loaded, setLoaded] = createSignal(initial)
    const refetch = async () => setLoaded(await api.session.skills({ sessionID: "ses_1" }))
    return <SkillsRailContent skills={loaded()} sessionID="ses_1" refetch={refetch} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ keybinds })}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={api}>
                <ToastProvider>
                  <DialogProvider>
                    <Rail />
                  </DialogProvider>
                </ToastProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { ...viewport, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("SKILLS"))
  return Object.assign(app, { separator: () => separator })
}
