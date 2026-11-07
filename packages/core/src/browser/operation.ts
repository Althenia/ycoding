export * as BrowserOperation from "./operation"

import { Browser } from "@ycoding-ai/schema/browser"
import { Hash } from "../util/hash"

export type Element = Browser.Element & { readonly identity: string }
export type Identity = { readonly digest: string; readonly reusable: boolean }
export type PermissionClass = "browser_read" | "browser_interact" | "browser_navigate" | "browser_control"
export interface Classification {
  readonly permission: PermissionClass
  readonly mutation: boolean
  readonly target: "element" | "none"
}

export const ELEMENT_ACTIONS: ReadonlySet<Browser.Action["type"]> = new Set([
  "click", "type", "upload", "fill", "select", "check", "hover",
])
const READ_ACTIONS: ReadonlySet<Browser.Action["type"]> = new Set([
  "scroll", "capture", "wait", "clipboard_read", "download", "logs", "export", "webmcp_list",
])
const DEFAULT_WAIT_MS = 5_000
const DEFAULT_DOWNLOAD_MS = 30_000
const LOCATOR = /^role=([^[\]|]{1,64})\[name=("(?:[^"\\]|\\.)*")\](?:\|nth=([1-9][0-9]{0,3}))?$/
const STATE_FIELDS = ["checked", "pressed", "expanded", "selected", "value", "sensitive"] as const

export function classify(action: Browser.Action): Classification {
  if (action.type === "navigate") return { permission: "browser_navigate", mutation: true, target: "none" }
  if (action.type === "group" || action.type === "ungroup")
    return { permission: "browser_control", mutation: true, target: "none" }
  if (action.type === "dialog")
    return { permission: action.accept === undefined ? "browser_read" : "browser_interact", mutation: true, target: "none" }
  if (READ_ACTIONS.has(action.type)) return { permission: "browser_read", mutation: false, target: "none" }
  return { permission: "browser_interact", mutation: true, target: isElementAction(action) ? "element" : "none" }
}

export type ElementAction = Extract<Browser.Action, { readonly type: "click" | "type" | "upload" | "fill" | "select" | "check" | "hover" }>

export function isElementAction(action: Browser.Action): action is ElementAction {
  return ELEMENT_ACTIONS.has(action.type)
}

export function parseLocator(locator: string) {
  const match = LOCATOR.exec(locator)
  if (!match) return undefined
  try {
    const name: unknown = JSON.parse(match[2])
    if (typeof name !== "string") return undefined
    return { role: match[1], name, nth: match[3] ? Number(match[3]) : 0 }
  } catch {
    return undefined
  }
}

export function locatorNameMatches(name: string, accessibleName: string) {
  return accessibleName.slice(0, 128) === name
}

export function sameElementState(a: Browser.Element, b: Browser.Element) {
  return STATE_FIELDS.every((field) => a[field] === b[field])
}

export function sanitizeControl(control: {
  readonly checked?: Browser.Tristate
  readonly value?: string
  readonly selected?: ReadonlyArray<{ readonly value?: string; readonly label: string; readonly index: number }>
  readonly sensitive?: true
} | undefined): Browser.ControlState | undefined {
  if (!control) return undefined
  if (control.sensitive) return { sensitive: true }
  const bound = (text: string) => text.slice(0, Browser.MAX_NAME_LENGTH)
  const selected = control.selected
    ?.filter((option) => Number.isSafeInteger(option.index) && option.index >= 0)
    .slice(0, Browser.MAX_SELECT_OPTIONS)
    .map((option) => ({
      ...(option.value === undefined ? {} : { value: bound(option.value) }),
      label: bound(option.label),
      index: option.index,
    }))
  return {
    ...(control.checked === undefined ? {} : { checked: control.checked }),
    ...(control.value === undefined ? {} : { value: bound(control.value) }),
    ...(selected === undefined ? {} : { selected }),
  }
}

export function waitBudgetMs(action: Browser.Action) {
  if (action.type === "wait") return action.timeoutMs ?? DEFAULT_WAIT_MS
  if (action.type === "download") return action.timeoutMs ?? DEFAULT_DOWNLOAD_MS
  return 0
}

export function makeLocator(element: Pick<Browser.Element, "role" | "name">, disambiguator?: number) {
  const base = `role=${element.role}[name=${JSON.stringify(element.name.slice(0, 128))}]`
  return disambiguator === undefined ? base : `${base}|nth=${disambiguator}`
}

export function resolveElement(
  elements: ReadonlyMap<string, Element>,
  input: { readonly ref?: string; readonly locator?: string },
) {
  if (input.ref) {
    const direct = elements.get(input.ref)
    if (direct) return direct
  }
  const locator = input.locator ?? input.ref
  if (!locator) return undefined
  return Array.from(elements.values()).find((element) => element.locator === locator)
}

export function elementIdentity(url: string, element: Browser.Element, destination?: string) {
  return Hash.json({ url, role: element.role, name: element.name, description: element.description ?? "",
    disabled: element.disabled ?? false, destination: destination ?? element.destination })
}

export function actionIdentity(tab: Pick<Browser.Tab, "id"> & { readonly pageIdentity: string; readonly mode?: Browser.Tab["mode"] | "isolated" }, action: Browser.Action, elements: ReadonlyMap<string, Element>): Identity | undefined {
  const target = targetPayload(action)
  if (target === undefined)
    return { reusable: true, digest: Hash.json({ tabID: tab.id, mode: tab.mode, page: tab.pageIdentity, action }) }
  const element = resolveElement(elements, target.element)
  if (!element || element.disabled) return undefined
  return { reusable: Array.from(elements.values()).filter((candidate) => candidate.identity === element.identity).length === 1,
    digest: Hash.json({ tabID: tab.id, mode: tab.mode, page: tab.pageIdentity,
      action: { type: action.type, ...target.payload, target: element.identity } }) }
}

function targetPayload(action: Browser.Action) {
  if (action.type === "click" || action.type === "hover") return { element: action, payload: {} }
  if (action.type === "type" || action.type === "fill") return { element: action, payload: { text: action.text } }
  if (action.type === "select")
    return { element: action, payload: { values: action.values, labels: action.labels, indexes: action.indexes } }
  if (action.type === "check") return { element: action, payload: { checked: action.checked } }
  return undefined
}
