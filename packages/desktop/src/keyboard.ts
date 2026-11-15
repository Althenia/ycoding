import { DESKTOP_BUILT_IN_SLASH_COMMANDS, isStandardEditShortcut } from "./form-rules"

export const DESKTOP_SHORTCUTS = [
  { action: "palette", label: "Commands", key: "K", modifier: "primary", context: "global" },
  { action: "new", label: "New chat", key: "N", modifier: "primary", context: "global" },
  { action: "settings", label: "Settings", key: ",", modifier: "primary", context: "global" },
  { action: "find", label: "Find in conversation", key: "F", modifier: "primary", context: "session" },
  { action: "variants", label: "Cycle reasoning effort", key: "T", modifier: "control", context: "page" },
  { action: "parent", label: "Open parent Session", key: "ArrowUp", modifier: "control", context: "page" },
  { action: "next-child", label: "Next subagent", key: "ArrowRight", modifier: "control", context: "page" },
  { action: "previous-child", label: "Previous subagent", key: "ArrowLeft", modifier: "control", context: "page" },
  { action: "sidebar", label: "Toggle navigation rail", key: "B", modifier: "primary-shift", context: "page" },
  { action: "companion", label: "Toggle Session companion", key: "J", modifier: "primary-shift", context: "page" },
] as const

type DefaultAction = (typeof DESKTOP_SHORTCUTS)[number]["action"]
type KeyInput = { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; readonly repeat?: boolean; readonly isComposing?: boolean; readonly defaultPrevented?: boolean }
type Context = { readonly editable: boolean; readonly modal: boolean; readonly palette: boolean }

export type KeyboardModifier = "primary" | "primary-shift" | "control"
export type KeyboardBinding = { readonly key: string; readonly modifier: KeyboardModifier }
export type KeyboardOverrides = { readonly [action: string]: KeyboardBinding | null }
export type KeyboardAction = { readonly id: string; readonly label: string }
export type KeyboardEntry = { readonly action: string; readonly binding: KeyboardBinding; readonly context: "global" | "session" | "page" }

export const KEYBOARD_ACTIONS: readonly KeyboardAction[] = [
  { id: "palette", label: "Commands" },
  ...DESKTOP_BUILT_IN_SLASH_COMMANDS.map((command) => ({ id: command.name, label: DESKTOP_SHORTCUTS.find((binding) => binding.action === command.name)?.label ?? command.description })),
]

const DEFAULT_BINDINGS: readonly KeyboardEntry[] = [
  ...DESKTOP_SHORTCUTS.map((binding) => ({ action: binding.action, binding: { key: binding.key, modifier: binding.modifier }, context: binding.context })),
  { action: "palette", binding: { key: "P", modifier: "control" }, context: "page" },
]

const modifiers: readonly KeyboardModifier[] = ["primary", "primary-shift", "control"]
const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
const punctuation = [",", ".", "/", ";", "'", "[", "]", "\\", "`", "-", "="]
const menuChords: Readonly<Record<string, string | undefined>> = { q: undefined, w: undefined, h: undefined, m: undefined, n: "new", ",": "settings" }

const known = (action: string) => action === "palette" || DESKTOP_BUILT_IN_SLASH_COMMANDS.some((command) => command.name === action)
const label = (action: string) => {
  const name = KEYBOARD_ACTIONS.find((item) => item.id === action)?.label ?? action
  return action === "palette" ? name : `${name} (/${action})`
}
const chord = (binding: KeyboardBinding) => `${binding.key.toLowerCase()}|${binding.modifier === "primary-shift"}`
const contextFor = (action: string): KeyboardEntry["context"] => action === "palette" ? "global" : DESKTOP_SHORTCUTS.find((binding) => binding.action === action)?.context ?? "page"
const matches = (binding: KeyboardBinding, event: KeyInput) =>
  binding.key.toLowerCase() === event.key.toLowerCase() &&
  (binding.modifier === "control" ? event.ctrlKey && !event.shiftKey : (event.ctrlKey || event.metaKey) && event.shiftKey === (binding.modifier === "primary-shift"))

function bindingProblem(action: string, value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "This shortcut is not supported."
  const keys = Object.keys(value)
  const binding = value as Record<string, unknown>
  if (keys.length !== 2 || typeof binding.key !== "string" || !modifiers.includes(binding.modifier as KeyboardModifier)) return "This shortcut is not supported."
  const key = binding.key
  const letter = /^[A-Z]$/.test(key)
  if (!letter && !/^[0-9]$/.test(key) && !arrows.includes(key) && !punctuation.includes(key)) return "This key is not supported. Use a letter, digit, arrow or punctuation key."
  const shift = binding.modifier === "primary-shift"
  if (shift && !letter && !arrows.includes(key)) return "Shift changes this key on many keyboard layouts. Use Shift only with letters and arrows."
  const edit = { key, altKey: false, shiftKey: shift }
  if (isStandardEditShortcut({ ...edit, ctrlKey: true, metaKey: false }) || binding.modifier !== "control" && isStandardEditShortcut({ ...edit, ctrlKey: false, metaKey: true }))
    return "This shortcut is reserved for text editing."
  const menu = key.toLowerCase()
  if (!shift && Object.hasOwn(menuChords, menu) && menuChords[menu] !== action) return "This shortcut is reserved by the app menu."
  return undefined
}

export function keyboardBindings(overrides: KeyboardOverrides): KeyboardEntry[] {
  return KEYBOARD_ACTIONS.flatMap(({ id }) => {
    if (!Object.hasOwn(overrides, id)) return DEFAULT_BINDINGS.filter((entry) => entry.action === id)
    const binding = overrides[id]
    return binding ? [{ action: id, binding, context: contextFor(id) }] : []
  })
}

function conflicts(overrides: KeyboardOverrides): Set<string> {
  const owners = new Map<string, string[]>()
  for (const entry of keyboardBindings(overrides)) owners.set(chord(entry.binding), [...owners.get(chord(entry.binding)) ?? [], entry.action])
  return new Set([...owners.values()].filter((actions) => new Set(actions).size > 1).flat())
}

export function parseKeyboardOverrides(raw: string | null): KeyboardOverrides {
  if (raw === null || raw.length > 65_536) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
  let value: Record<string, KeyboardBinding | null> = {}
  for (const [action, binding] of Object.entries(parsed)) {
    if (action === "__proto__" || !known(action)) continue
    if (binding === null) value[action] = null
    else if (!bindingProblem(action, binding)) value[action] = { key: (binding as KeyboardBinding).key, modifier: (binding as KeyboardBinding).modifier }
  }
  for (let clash = conflicts(value); clash.size > 0; clash = conflicts(value))
    value = Object.fromEntries(Object.entries(value).filter(([action]) => !clash.has(action)))
  return value
}

export function applyKeyboardBinding(value: KeyboardOverrides, action: string, binding: KeyboardBinding | null | undefined): { readonly value: KeyboardOverrides } | { readonly error: string } {
  if (action === "__proto__" || !known(action)) return { error: `"${action}" is not a Desktop command.` }
  const problem = binding ? bindingProblem(action, binding) : undefined
  if (problem) return { error: problem }
  const next: Record<string, KeyboardBinding | null> = Object.fromEntries(Object.entries(value).filter(([id]) => id !== action))
  if (binding !== undefined) next[action] = binding && { key: binding.key, modifier: binding.modifier }
  const mine = keyboardBindings(next).filter((entry) => entry.action === action).map((entry) => chord(entry.binding))
  const taken = keyboardBindings(next).find((entry) => entry.action !== action && mine.includes(chord(entry.binding)))
  if (taken) return { error: `This shortcut is already assigned to ${label(taken.action)}. Change or unbind it first.` }
  return { value: next }
}

export function bindingFromEvent(event: KeyInput, mac: boolean): { readonly binding: KeyboardBinding } | { readonly error: string } | undefined {
  if (["Meta", "Control", "Shift", "Alt", "OS", "AltGraph"].includes(event.key)) return undefined
  if (event.altKey) return { error: mac ? "Option shortcuts are not supported." : "Alt shortcuts are not supported." }
  if (event.ctrlKey && event.metaKey) return { error: "Use either ⌘ or Ctrl, not both." }
  if (!event.ctrlKey && !event.metaKey) return { error: mac ? "Shortcuts need ⌘ or Ctrl." : "Shortcuts need Ctrl." }
  if (mac && event.ctrlKey && event.shiftKey) return { error: "Use ⌘+Shift, or Ctrl without Shift." }
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  if (!/^[A-Z0-9]$/.test(key) && !arrows.includes(key) && !punctuation.includes(key)) return { error: "This key is not supported. Use a letter, digit, arrow or punctuation key." }
  const modifier: KeyboardModifier = mac && event.ctrlKey ? "control" : event.shiftKey ? "primary-shift" : "primary"
  return { binding: { key, modifier } }
}

export function desktopShortcut(event: KeyInput, context: Context): DefaultAction | undefined
export function desktopShortcut(event: KeyInput, context: Context, overrides: KeyboardOverrides): string | undefined
export function desktopShortcut(event: KeyInput, context: Context, overrides: KeyboardOverrides = {}): string | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey && event.metaKey || context.modal && !context.palette) return undefined
  const bindings = keyboardBindings(overrides)
  if (bindings.some((entry) => entry.action === "palette" && entry.context === "global" && matches(entry.binding, event))) return "palette"
  if (context.palette) return undefined
  return bindings.find((entry) => (entry.context !== "page" || !context.editable) && matches(entry.binding, event))?.action
}

export function shortcutLabel(binding: { readonly key: string; readonly modifier: KeyboardModifier }, mac: boolean): string {
  return `${binding.modifier === "control" ? "Ctrl" : mac ? "⌘" : "Ctrl"}${binding.modifier === "primary-shift" ? "+Shift" : ""}+${binding.key}`
}
