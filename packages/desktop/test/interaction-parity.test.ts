import { expect, test } from "bun:test"
import { composerSlash, desktopSlashCommand, mentionPayload, restoredPrompt } from "../src/form-rules"
import { DESKTOP_SHORTCUTS, desktopShortcut, shortcutLabel } from "../src/keyboard"

const key = (value: string, flags: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean } = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...flags })
const page = { editable: false, modal: false, palette: false }

test("Session lifecycle commands stay local rather than becoming model prompts", () => {
  for (const kind of ["archive", "unarchive", "delete", "share", "unshare"] as const) expect(desktopSlashCommand(`/${kind}`, [])).toEqual({ kind })
})

test("TUI composition and application commands stay local and retain their arguments", async () => {
  for (const kind of ["editor", "docs", "exit", "restart", "sleep", "wake", "processes", "background"] as const) expect(desktopSlashCommand(`/${kind}`, [kind])).toEqual({ kind })
  for (const kind of ["btw", "btw-send", "suggest", "prompt", "cd"] as const) {
    expect(desktopSlashCommand(`/${kind} synthetic input`, [kind])).toEqual({ kind, argument: "synthetic input" })
    expect(desktopSlashCommand(`/${kind}`, [])).toEqual({ kind })
    expect(composerSlash(`/${kind} synthetic input`, [kind])).toEqual({ kind: "local", name: kind, args: "synthetic input" })
  }
  expect(desktopSlashCommand("/quit", [])).toEqual({ kind: "exit" })
  expect(desktopSlashCommand("/q", [])).toEqual({ kind: "exit" })
})

test("appearance commands preserve an explicit theme and keybinds opens shortcut help", () => {
  expect(desktopSlashCommand("/themes dark", [])).toEqual({ kind: "themes", argument: "dark" })
  expect(desktopSlashCommand("/keybinds", [])).toEqual({ kind: "help" })
})

test("the keyboard catalog resolves each advertised binding on both platforms", () => {
  for (const binding of DESKTOP_SHORTCUTS) {
    const flags = { ctrlKey: true, shiftKey: binding.modifier === "primary-shift" }
    expect(desktopShortcut(key(binding.key, flags), page)).toBe(binding.action)
    if (binding.modifier !== "control") expect(desktopShortcut(key(binding.key, { metaKey: true, shiftKey: flags.shiftKey }), page)).toBe(binding.action)
    expect(shortcutLabel(binding, false)).toContain("Ctrl")
    expect(shortcutLabel(binding, true)).toContain(binding.modifier === "control" ? "Ctrl" : "⌘")
  }
})

test("page shortcuts preserve editing, while command search and conversation find remain reachable", () => {
  const editable = { ...page, editable: true }
  for (const value of ["t", "p", "ArrowUp", "ArrowLeft", "ArrowRight", "a", "c", "v", "x", "z", "y"]) expect(desktopShortcut(key(value, { ctrlKey: true }), editable)).toBeUndefined()
  expect(desktopShortcut(key("b", { ctrlKey: true, shiftKey: true }), editable)).toBeUndefined()
  expect(desktopShortcut(key("k", { metaKey: true }), editable)).toBe("palette")
  expect(desktopShortcut(key("f", { ctrlKey: true }), editable)).toBe("find")
})

test("modal and palette ownership prevent background commands", () => {
  for (const value of ["n", "f", "t", "k", ","]) expect(desktopShortcut(key(value, { ctrlKey: true }), { ...page, modal: true })).toBeUndefined()
  expect(desktopShortcut(key("n", { ctrlKey: true }), { ...page, modal: true, palette: true })).toBeUndefined()
  expect(desktopShortcut(key("k", { ctrlKey: true }), { ...page, modal: true, palette: true })).toBe("palette")
})

test("composing, repeating and consumed events never become commands", () => {
  for (const flags of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true }, { altKey: true }, { metaKey: true }]) expect(desktopShortcut(key("k", { ctrlKey: true, ...flags }), page)).toBeUndefined()
  expect(desktopShortcut(key("ArrowRight", { metaKey: true }), page)).toBeUndefined()
  expect(desktopShortcut(key("p", { ctrlKey: true }), page)).toBe("palette")
})

test("undo restores managed files and agent mentions without losing metadata or binding offsets to the old draft", () => {
  const digest = "a".repeat(64)
  const content = { type: "managed" as const, digest, bytes: 4, path: `attachments/sha256/aa/${digest}` }
  const restored = restoredPrompt({ text: "@notes @helper", files: [{ content, mime: "text/plain", name: "notes.txt", description: "Retained description", mention: { start: 0, end: 6, text: "@notes" } }, { content, mime: "text/plain", name: "plain.txt" }], agents: [{ name: "helper", mention: { start: 7, end: 14, text: "@helper" } }, { name: "reviewer" }] })
  expect(restored.files).toEqual([{ uri: `ycoding-attachment://sha256/${digest}`, name: "plain.txt" }])
  expect(restored.agents).toEqual([{ name: "reviewer" }])
  const input = mentionPayload(`Read ${restored.text}`, restored.picks)
  expect(input.files).toEqual([{ uri: `ycoding-attachment://sha256/${digest}`, name: "notes.txt", description: "Retained description", mention: { start: 5, end: 11, text: "@notes" } }])
  expect(input.agents).toEqual([{ name: "helper", mention: { start: 12, end: 19, text: "@helper" } }])
  expect(restoredPrompt({ text: "Text only" })).toEqual({ text: "Text only", files: [], agents: [], picks: [] })
})
