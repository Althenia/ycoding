import { expect, test } from "bun:test"
import { TuiKeybind } from "../src/config/keybind"

test("binds agent cycling only to tab by default", () => {
  expect(TuiKeybind.Definitions.agent_cycle.default).toBe("tab")
  expect(TuiKeybind.Definitions.agent_cycle_reverse.default).toBe("none")
})

test("binds supported maintainer shortcuts without leader collisions", () => {
  const definitions = TuiKeybind.Definitions as Record<string, { default: unknown }>

  expect(TuiKeybind.Definitions.variant_list.default).toBe("<leader>v")
  expect(definitions.session_autonomy_normal?.default).toBe("<leader>y")
  expect(TuiKeybind.Definitions.messages_copy.default).toBe("<leader>o")

  const leaderBindings = Object.entries(definitions).flatMap(([name, definition]) =>
    typeof definition.default === "string" && definition.default.startsWith("<leader>") ? [[name, definition.default]] : [],
  )
  const duplicates = leaderBindings.filter(([, binding], index) =>
    leaderBindings.findIndex(([, candidate]) => candidate === binding) !== index,
  )

  expect(duplicates).toEqual([])
  expect(leaderBindings).toEqual(
    expect.arrayContaining([
      ["variant_list", "<leader>v"],
      ["session_autonomy_normal", "<leader>y"],
      ["messages_copy", "<leader>o"],
    ]),
  )
})

test("new supported shortcuts remain configurable and render in help", async () => {
  expect(TuiKeybind.parse({ variant_list: "ctrl+v", session_autonomy_normal: "ctrl+d" })).toMatchObject({
    variant_list: "ctrl+v",
    session_autonomy_normal: "ctrl+d",
  })

  // The help dialog is a DialogSelect over commands, so a rebound keybinding must render from the
  // live keymap. Assert the displayed shortcut rather than the component source text.
  const { createComponent } = await import("solid-js")
  const { testRender } = await import("@opentui/solid")
  const [{ ConfigProvider }, { Keymap }, { ThemeProvider }, { DialogProvider }, { ToastProvider }, { DialogHelp }, { TestTuiContexts }, { createTuiResolvedConfig }] =
    await Promise.all([
      import("../src/config"),
      import("../src/context/keymap"),
      import("../src/context/theme"),
      import("../src/ui/dialog"),
      import("../src/ui/toast"),
      import("../src/ui/dialog-help"),
      import("./fixture/tui-environment"),
      import("./fixture/tui-runtime"),
    ])
  const config = createTuiResolvedConfig({ keybinds: { variant_cycle: "ctrl+k" } })
  function RegisterVariantCycle() {
    Keymap.createLayer(() => ({
      commands: [{ id: "variant.cycle", title: "Cycle variant", group: "Model", run: () => {} }],
    }))
    return null
  }
  const app = await testRender(
    () =>
      createComponent(TestTuiContexts, {
        get children() {
          return createComponent(ConfigProvider, {
            config,
            get children() {
              return createComponent(Keymap.Provider, {
                get children() {
                  return createComponent(ThemeProvider, {
                    mode: "dark",
                    source: { discover: () => Promise.resolve({}) },
                    get children() {
                      return createComponent(ToastProvider, {
                        get children() {
                          return createComponent(DialogProvider, {
                            get children() {
                              return [createComponent(RegisterVariantCycle, {}), createComponent(DialogHelp, {})]
                            },
                          })
                        },
                      })
                    },
                  })
                },
              })
            },
          })
        },
      }),
    { width: 100, height: 70 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Cycle variant"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Cycle variant")
    expect(frame).toContain("⌃k")
  } finally {
    app.renderer.destroy()
  }
})

test("binds shell output actions through configurable commands", () => {
  expect(TuiKeybind.Definitions.shell_output_back.default).toBe("escape")
  expect(TuiKeybind.Definitions.shell_output_kill.default).toBe("ctrl+d")
  expect(TuiKeybind.parse({ shell_output_back: "q", shell_output_kill: "ctrl+k" })).toMatchObject({
    shell_output_back: "q",
    shell_output_kill: "ctrl+k",
  })
})
