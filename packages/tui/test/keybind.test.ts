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

test("new supported shortcuts remain configurable and appear in help", async () => {
  expect(TuiKeybind.parse({ variant_list: "ctrl+v", session_autonomy_normal: "ctrl+d" })).toMatchObject({
    variant_list: "ctrl+v",
    session_autonomy_normal: "ctrl+d",
  })

  const help = await Bun.file("src/ui/dialog-help.tsx").text()
  expect(help).toContain('shortcuts.get("variant.list")')
  expect(help).toContain('shortcuts.get("session.autonomy.normal")')
})

test("binds shell output actions through configurable commands", () => {
  expect(TuiKeybind.Definitions.shell_output_back.default).toBe("escape")
  expect(TuiKeybind.Definitions.shell_output_kill.default).toBe("ctrl+d")
  expect(TuiKeybind.parse({ shell_output_back: "q", shell_output_kill: "ctrl+k" })).toMatchObject({
    shell_output_back: "q",
    shell_output_kill: "ctrl+k",
  })
})
