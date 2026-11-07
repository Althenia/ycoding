export * as IsolatedPageSafety from "./isolated-page-safety"

export const SECRET_AUTOCOMPLETE: ReadonlyArray<string> = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]

export const SECRET_NAME =
  /pass(?:word|code|phrase)|one[\s_-]?time|verification[\s_-]?code|security[\s_-]?code|card[\s_-]?(?:number|no)|(?:^|[^a-z0-9])(?:otp|totp|mfa|2fa|pin|cvv|cvc|csc|ccnum)(?:$|[^a-z0-9])/i

const ACCESSIBLE_NAME_LENGTH = 256

export function isSensitiveAttributes(
  nodeName: string,
  attributes: ReadonlyMap<string, string>,
  accessibleName = "",
) {
  const tag = nodeName.toLowerCase()
  const editable = attributes.has("contenteditable") && attributes.get("contenteditable") !== "false"
  if (tag !== "input" && tag !== "textarea" && !editable) return false
  if (tag === "input" && (attributes.get("type") ?? "text").toLowerCase() === "password") return true
  if (
    (attributes.get("autocomplete") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .some((token) => SECRET_AUTOCOMPLETE.includes(token))
  )
    return true
  if (["name", "id", "aria-label", "placeholder"].some((key) => SECRET_NAME.test(attributes.get(key) ?? ""))) return true
  return SECRET_NAME.test(accessibleName.replace(/\s+/g, " ").trim().slice(0, ACCESSIBLE_NAME_LENGTH))
}

export interface FocusedLeaf {
  readonly sensitive: boolean
  readonly closedShadowRoot: boolean
  readonly unreachableFrame?: { readonly inspected: boolean }
}

export type KeyModifier = "Alt" | "Control" | "Meta" | "Shift"

export function isSafeNavigationKey(key: string, modifiers: ReadonlyArray<KeyModifier> | undefined) {
  const held = modifiers ?? []
  if (key === "Tab") return held.length === 0 || (held.length === 1 && held[0] === "Shift")
  return held.length === 0 && [
    "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  ].includes(key)
}

export function refusesEditingKey(leaf: unknown) {
  if (typeof leaf !== "object" || leaf === null || Array.isArray(leaf)) return true
  if (!("sensitive" in leaf) || leaf.sensitive !== false) return true
  if (!("closedShadowRoot" in leaf) || leaf.closedShadowRoot !== false) return true
  if (!("unreachableFrame" in leaf) || leaf.unreachableFrame === undefined) return false
  return !(
    typeof leaf.unreachableFrame === "object" &&
    leaf.unreachableFrame !== null &&
    "inspected" in leaf.unreachableFrame &&
    leaf.unreachableFrame.inspected === true
  )
}

export function globMatch(pattern: string, value: string) {
  let p = 0
  let v = 0
  let star = -1
  let mark = 0
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p++
      v++
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++
      mark = v
    } else if (star !== -1) {
      p = star + 1
      v = ++mark
    } else return false
  }
  while (p < pattern.length && pattern[p] === "*") p++
  return p === pattern.length
}

export interface NetworkIdleTracker {
  readonly onEvent: (sessionId: string, method: string, params?: Readonly<Record<string, unknown>>) => void
  readonly dropSession: (sessionId: string) => void
  readonly clear: () => void
  readonly pending: () => number
  readonly idleFor: (ms: number, since: number) => boolean
}

export function createNetworkIdleTracker(now: () => number = Date.now): NetworkIdleTracker {
  const inflight = new Map<string, Set<string>>()
  let quietSince = now()
  const pending = () => {
    let total = 0
    for (const requests of inflight.values()) total += requests.size
    return total
  }
  const settle = () => {
    if (pending() === 0) quietSince = now()
  }
  return {
    onEvent: (sessionId, method, params) => {
      const requestId = typeof params?.requestId === "string" && params.requestId.length > 0 ? params.requestId : undefined
      if (!requestId) return
      if (method === "Network.requestWillBeSent") {
        const requests = inflight.get(sessionId) ?? new Set<string>()
        requests.add(requestId)
        inflight.set(sessionId, requests)
        return
      }
      if (method !== "Network.loadingFinished" && method !== "Network.loadingFailed") return
      const requests = inflight.get(sessionId)
      if (!requests?.delete(requestId)) return
      if (requests.size === 0) inflight.delete(sessionId)
      settle()
    },
    dropSession: (sessionId) => {
      if (!inflight.delete(sessionId)) return
      settle()
    },
    clear: () => {
      inflight.clear()
      quietSince = now()
    },
    pending,
    idleFor: (ms, since) => pending() === 0 && now() - Math.max(quietSince, since) >= ms,
  }
}

export const IS_SENSITIVE = `const isSensitive = (el) => {
  const tag = el.localName
  if (tag !== "input" && tag !== "textarea" && !el.isContentEditable) return false
  if (tag === "input" && el.type === "password") return true
  if ((el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).some((token) => ${JSON.stringify(SECRET_AUTOCOMPLETE)}.includes(token))) return true
  if (["name", "id", "aria-label", "placeholder"].some((key) => ${SECRET_NAME}.test(el.getAttribute(key) || ""))) return true
  const labels = [...(el.labels || [])]
  for (const id of (el.getAttribute("aria-labelledby") || "").split(/\\s+/)) {
    const referenced = id ? el.ownerDocument.getElementById(id) : null
    if (referenced) labels.push(referenced)
  }
  return labels.some((label) => ${SECRET_NAME}.test(String(label.textContent).replace(/\\s+/g, " ").trim().slice(0, ${ACCESSIBLE_NAME_LENGTH})))
}`

export const F_CONTROL_STATE = `function () { ${IS_SENSITIVE}
  const el = this
  if (isSensitive(el)) return { sensitive: true }
  if (el.localName === "select") return { selected: [...el.selectedOptions].slice(0, 32).map((o) => ({ value: o.value.slice(0, 1024), label: (o.label || o.text).trim().slice(0, 1024), index: o.index })) }
  if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) return { checked: el.indeterminate ? "mixed" : el.checked }
  if (el.localName === "input" || el.localName === "textarea") return { value: String(el.value).slice(0, 1024) }
  if (el.isContentEditable) return { value: String(el.innerText).slice(0, 1024) }
  return {}
}`

export const F_FILL = `function (text, apply) { ${IS_SENSITIVE}
  const el = this
  if (isSensitive(el)) return { error: "Sensitive fields cannot be filled" }
  const setTypes = ["color", "date", "datetime-local", "month", "range", "time", "week"]
  const textTypes = ["email", "number", "search", "tel", "text", "url"]
  const input = el.localName === "input", area = el.localName === "textarea"
  if ((input || area) && (el.disabled || el.readOnly)) return { error: "Field is not editable" }
  const kind = input ? (setTypes.includes(el.type) ? "set" : textTypes.includes(el.type) ? "insert" : undefined) : area || el.isContentEditable ? "insert" : undefined
  if (!kind) return { error: "Element cannot be filled" }
  if (!apply) return { kind }
  el.focus()
  if (kind === "set") {
    el.value = text
    if (el.value !== text) return { error: "Field rejected the value" }
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return { kind }
  }
  if (input || area) el.select()
  else { const range = el.ownerDocument.createRange(); range.selectNodeContents(el); const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range) }
  return { kind }
}`

export const F_SELECT = `function (criteria, apply) {
  const el = this
  if (el.localName !== "select") return { error: "Element is not a select" }
  if (el.disabled) return { error: "Select is disabled" }
  const options = [...el.options], picked = []
  const lists = [["value", criteria.values], ["label", criteria.labels], ["index", criteria.indexes]]
  for (const [kind, list] of lists) for (const wanted of list || []) {
    const option = options.find((candidate) => kind === "value" ? candidate.value === wanted : kind === "label" ? (candidate.label || candidate.text).trim() === String(wanted).trim() : candidate.index === wanted)
    if (!option) return { error: "Option not found" }
    if (option.disabled) return { error: "Option is disabled" }
    if (!picked.includes(option)) picked.push(option)
  }
  if (picked.length > 1 && !el.multiple) return { error: "Select accepts one option" }
  if (!apply) return { ok: true }
  for (const option of options) option.selected = picked.includes(option)
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { ok: true }
}`

export const F_ACTIVE_ELEMENT = `function () {
  let el = document.activeElement
  while (el) {
    if (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
    else if (el.contentDocument && el.contentDocument.activeElement) el = el.contentDocument.activeElement
    else break
  }
  return el
}`

export const F_REFUSE_FIELD = `function () { ${IS_SENSITIVE}
  const el = this
  return (el.localName === "input" && el.type === "file") || isSensitive(el)
}`

export const F_FRAME_UNREACHABLE = `function () {
  const el = this
  return ["iframe", "frame", "object", "embed"].includes(el.localName)
}`

export const F_CONNECTED = `function () { return this.isConnected }`

export const F_READY = `function () { return document.readyState }`

export const F_TEXT_PRESENT = `function (needle) {
  const normalize = (value) => String(value).replace(/\\s+/g, " ").trim()
  return normalize(document.body ? document.body.innerText : "").includes(normalize(needle))
}`
