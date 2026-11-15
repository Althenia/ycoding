import { expect, test } from "bun:test"
import { DESKTOP_BUILT_IN_SLASH_COMMANDS } from "../src/form-rules"
import {
  DESKTOP_SHORTCUTS,
  KEYBOARD_ACTIONS,
  applyKeyboardBinding,
  bindingFromEvent,
  desktopShortcut,
  keyboardBindings,
  parseKeyboardOverrides,
  shortcutLabel,
  type KeyboardBinding,
  type KeyboardOverrides,
} from "../src/keyboard"

type Flags = { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean }
const key = (value: string, flags: Flags = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...flags })
const page = { editable: false, modal: false, palette: false }
const editable = { ...page, editable: true }
const bind = (key: string, modifier: KeyboardBinding["modifier"]): KeyboardBinding => ({ key, modifier })
const applied = (value: KeyboardOverrides, action: string, binding: KeyboardBinding | null | undefined) => {
  const result = applyKeyboardBinding(value, action, binding)
  if ("error" in result) throw new Error(result.error)
  return result.value
}
const rejection = (value: KeyboardOverrides, action: string, binding: KeyboardBinding | null | undefined) => {
  const result = applyKeyboardBinding(value, action, binding)
  if (!("error" in result)) throw new Error("expected a rejection")
  return result.error
}

test("the catalog is the command palette plus every built-in Desktop slash command, without aliases", () => {
  const ids = KEYBOARD_ACTIONS.map((action) => action.id)
  expect(ids).toEqual(["palette", ...DESKTOP_BUILT_IN_SLASH_COMMANDS.map((command) => command.name)])
  expect(new Set(ids).size).toBe(ids.length)
  for (const alias of DESKTOP_BUILT_IN_SLASH_COMMANDS.flatMap((command) => command.aliases ?? [])) expect(ids).not.toContain(alias)
  for (const binding of DESKTOP_SHORTCUTS) expect(ids).toContain(binding.action)
  expect(KEYBOARD_ACTIONS.every((action) => action.label.trim().length > 0)).toBe(true)
})

test("empty overrides resolve exactly like the two-argument defaults", () => {
  const values = ["k", "K", "p", "n", ",", "f", "t", "b", "B", "j", "ArrowUp", "ArrowLeft", "ArrowRight", "c", "v", "z", "y", "l"]
  const flagSets: Flags[] = [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }, { ctrlKey: true, repeat: true }, { metaKey: true, isComposing: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, metaKey: true }, {}]
  const contexts = [page, editable, { ...page, modal: true }, { ...page, palette: true }, { ...page, modal: true, palette: true }]
  for (const value of values) for (const flags of flagSets) for (const context of contexts)
    expect(desktopShortcut(key(value, flags), context, {})).toBe(desktopShortcut(key(value, flags), context))
  expect(keyboardBindings({}).map((entry) => [entry.action, shortcutLabel(entry.binding, false)])).toEqual([
    ["palette", "Ctrl+K"], ["palette", "Ctrl+P"], ...DESKTOP_SHORTCUTS.filter((binding) => binding.action !== "palette").map((binding) => [binding.action, shortcutLabel(binding, false)]),
  ].sort((left, right) => KEYBOARD_ACTIONS.findIndex((action) => action.id === left[0]) - KEYBOARD_ACTIONS.findIndex((action) => action.id === right[0])))
})

test("remapping a default action moves it and keeps its context", () => {
  const value = applied({}, "variants", bind("G", "control"))
  expect(desktopShortcut(key("g", { ctrlKey: true }), page, value)).toBe("variants")
  expect(desktopShortcut(key("t", { ctrlKey: true }), page, value)).toBeUndefined()
  expect(desktopShortcut(key("g", { ctrlKey: true }), editable, value)).toBeUndefined()
  expect(desktopShortcut(key("g", { metaKey: true }), page, value)).toBeUndefined()
  const find = applied({}, "find", bind("G", "primary"))
  expect(desktopShortcut(key("g", { metaKey: true }), editable, find)).toBe("find")
  expect(desktopShortcut(key("f", { ctrlKey: true }), editable, find)).toBeUndefined()
})

test("any catalog command can be bound, and new bindings never fire while typing", () => {
  const value = applied({}, "help", bind("L", "primary-shift"))
  expect(desktopShortcut(key("L", { metaKey: true, shiftKey: true }), page, value)).toBe("help")
  expect(desktopShortcut(key("L", { ctrlKey: true, shiftKey: true }), page, value)).toBe("help")
  expect(desktopShortcut(key("L", { metaKey: true, shiftKey: true }), editable, value)).toBeUndefined()
  expect(desktopShortcut(key("l", { metaKey: true }), page, value)).toBeUndefined()
  expect(shortcutLabel(bind("L", "primary-shift"), true)).toBe("⌘+Shift+L")
  expect(shortcutLabel(bind("G", "control"), true)).toBe("Ctrl+G")
})

test("a remapped palette keeps palette ownership and drops both default chords", () => {
  const value = applied({}, "palette", bind("O", "primary"))
  expect(desktopShortcut(key("o", { metaKey: true }), { ...page, modal: true, palette: true }, value)).toBe("palette")
  expect(desktopShortcut(key("o", { ctrlKey: true }), editable, value)).toBe("palette")
  expect(desktopShortcut(key("k", { metaKey: true }), page, value)).toBeUndefined()
  expect(desktopShortcut(key("p", { ctrlKey: true }), page, value)).toBeUndefined()
  expect(desktopShortcut(key("n", { metaKey: true }), { ...page, palette: true }, value)).toBeUndefined()
})

test("unbinding removes the chord and resetting restores the defaults", () => {
  const unbound = applied({}, "find", null)
  expect(unbound).toEqual({ find: null })
  expect(desktopShortcut(key("f", { ctrlKey: true }), page, unbound)).toBeUndefined()
  expect(keyboardBindings(unbound).some((entry) => entry.action === "find")).toBe(false)
  const reset = applied(unbound, "find", undefined)
  expect(reset).toEqual({})
  expect(desktopShortcut(key("f", { ctrlKey: true }), page, reset)).toBe("find")
  const reused = applied(unbound, "help", bind("F", "primary"))
  expect(desktopShortcut(key("f", { metaKey: true }), page, reused)).toBe("help")
  expect(rejection(reused, "find", undefined)).toContain("/help")
})

test("invalid, reserved and unregistered bindings are rejected with a visible reason", () => {
  expect(rejection({}, "launch-missiles", bind("L", "primary"))).toContain("not a Desktop command")
  expect(rejection({}, "__proto__", null)).toContain("not a Desktop command")
  for (const binding of [bind("C", "primary"), bind("V", "primary"), bind("X", "primary"), bind("A", "primary"), bind("Z", "primary"), bind("Z", "primary-shift"), bind("Y", "control"), bind("Y", "primary"), bind("V", "control")])
    expect(rejection({}, "help", binding)).toContain("text editing")
  for (const letter of ["Q", "W", "H", "M"]) expect(rejection({}, "help", bind(letter, "primary"))).toContain("app menu")
  expect(rejection({}, "help", bind("N", "primary"))).toContain("app menu")
  expect(rejection({}, "help", bind(",", "primary"))).toContain("app menu")
  expect(applied({}, "new", bind("N", "primary"))).toEqual({ new: bind("N", "primary") })
  expect(rejection({}, "help", bind("1", "primary-shift"))).toContain("Shift")
  expect(rejection({}, "help", bind("Escape", "primary"))).toContain("not supported")
  expect(rejection({}, "help", bind("k", "primary"))).toContain("not supported")
  expect(rejection({}, "help", { key: "L", modifier: "alt" } as unknown as KeyboardBinding)).toContain("not supported")
})

test("a chord already in use is reported instead of being taken over", () => {
  expect(rejection({}, "help", bind("F", "primary"))).toContain("Find in conversation")
  expect(rejection({}, "help", bind("F", "control"))).toContain("Find in conversation")
  expect(rejection({}, "help", bind("P", "primary"))).toContain("Commands")
  expect(rejection({}, "help", bind("B", "primary-shift"))).toContain("Toggle navigation rail")
  expect(applied({}, "help", bind("B", "primary"))).toEqual({ help: bind("B", "primary") })
  const first = applied({}, "help", bind("L", "primary"))
  expect(rejection(first, "usage", bind("L", "control"))).toContain("/help")
  expect(applied(first, "help", bind("L", "primary"))).toEqual(first)
})

test("stored overrides parse safely and drop entries that would conflict", () => {
  for (const raw of [null, "", "not json", "[]", "null", "42", JSON.stringify({ help: "Ctrl+L" }), "x".repeat(70_000)]) expect(parseKeyboardOverrides(raw)).toEqual({})
  const stored = JSON.stringify({ help: bind("L", "primary"), find: null, unknown: bind("U", "primary"), usage: bind("C", "primary"), sessions: { key: "S", modifier: "primary", extra: true } })
  const parsed = parseKeyboardOverrides(`{"__proto__":{"key":"L","modifier":"primary"},${stored.slice(1)}`)
  expect(parsed).toEqual({ help: bind("L", "primary"), find: null })
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  expect(parseKeyboardOverrides(JSON.stringify({ help: bind("F", "primary") }))).toEqual({})
  expect(parseKeyboardOverrides(JSON.stringify({ help: bind("F", "primary"), find: bind("G", "primary") }))).toEqual({ help: bind("F", "primary"), find: bind("G", "primary") })
  expect(parseKeyboardOverrides(JSON.stringify({ help: bind("L", "primary"), usage: bind("L", "control"), sessions: bind("S", "primary") }))).toEqual({ sessions: bind("S", "primary") })
  expect(parseKeyboardOverrides(JSON.stringify({ palette: bind("K", "primary-shift"), help: bind("K", "primary") }))).toEqual({ palette: bind("K", "primary-shift"), help: bind("K", "primary") })
})

test("modal, palette, repeat and composition ownership still applies to custom bindings", () => {
  const value = applied({}, "help", bind("L", "primary"))
  expect(desktopShortcut(key("l", { metaKey: true }), { ...page, modal: true }, value)).toBeUndefined()
  expect(desktopShortcut(key("l", { metaKey: true }), { ...page, palette: true }, value)).toBeUndefined()
  for (const flags of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true }, { altKey: true }, { ctrlKey: true }]) expect(desktopShortcut(key("l", { metaKey: true, ...flags }), page, value)).toBeUndefined()
})

test("captured key presses become canonical bindings for the current platform", () => {
  expect(bindingFromEvent(key("k", { metaKey: true }), true)).toEqual({ binding: bind("K", "primary") })
  expect(bindingFromEvent(key("K", { metaKey: true, shiftKey: true }), true)).toEqual({ binding: bind("K", "primary-shift") })
  expect(bindingFromEvent(key("t", { ctrlKey: true }), true)).toEqual({ binding: bind("T", "control") })
  expect(bindingFromEvent(key("t", { ctrlKey: true }), false)).toEqual({ binding: bind("T", "primary") })
  expect(bindingFromEvent(key("T", { ctrlKey: true, shiftKey: true }), false)).toEqual({ binding: bind("T", "primary-shift") })
  expect(bindingFromEvent(key("ArrowUp", { ctrlKey: true }), true)).toEqual({ binding: bind("ArrowUp", "control") })
  expect(bindingFromEvent(key(",", { metaKey: true }), true)).toEqual({ binding: bind(",", "primary") })
  for (const modifier of ["Meta", "Control", "Shift", "Alt"]) expect(bindingFromEvent(key(modifier, { metaKey: true }), true)).toBeUndefined()
  expect(bindingFromEvent(key("T", { ctrlKey: true, shiftKey: true }), true)).toHaveProperty("error")
  expect(bindingFromEvent(key("l", { metaKey: true, altKey: true }), true)).toHaveProperty("error")
  expect(bindingFromEvent(key("l", { metaKey: true, ctrlKey: true }), true)).toHaveProperty("error")
  expect(bindingFromEvent(key("l"), true)).toHaveProperty("error")
  expect(bindingFromEvent(key("F5", { metaKey: true }), true)).toHaveProperty("error")
})
