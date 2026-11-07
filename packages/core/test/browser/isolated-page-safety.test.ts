import { describe, expect, test } from "bun:test"
import {
  F_ACTIVE_ELEMENT,
  F_CONNECTED,
  F_CONTROL_STATE,
  F_FILL,
  F_FRAME_UNREACHABLE,
  F_REFUSE_FIELD,
  F_SELECT,
  F_TEXT_PRESENT,
  IS_SENSITIVE,
  SECRET_AUTOCOMPLETE,
  SECRET_NAME,
  createNetworkIdleTracker,
  globMatch,
  isSafeNavigationKey,
  isSensitiveAttributes,
  refusesEditingKey,
} from "@ycoding-ai/core/browser/isolated-page-safety"

const attributes = (entries: Record<string, string>) => new Map(Object.entries(entries))

function pageFunction(source: string) {
  const compiled: (this: unknown, ...args: unknown[]) => unknown = (0, eval)(`(${source})`)
  return compiled
}

function fakeField(input: Record<string, unknown> & { attributes?: Record<string, string> }) {
  const { attributes: attrs = {}, ...rest } = input
  const calls: string[] = []
  const element = {
    localName: "input",
    type: "text",
    value: "",
    isContentEditable: false,
    disabled: false,
    readOnly: false,
    labels: [] as Array<{ textContent: string }>,
    ownerDocument: { getElementById: (_id: string): { textContent: string } | null => null },
    getAttribute: (name: string) => attrs[name] ?? null,
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
    dispatchEvent: (event: Event) => calls.push(`dispatch:${event.type}`),
    ...rest,
  }
  return { element, calls }
}

describe("isolated page safety", () => {
  test("isSensitiveAttributes keeps password, secret autocomplete and secret name signals", () => {
    expect(isSensitiveAttributes("INPUT", attributes({ type: "password" }), "")).toBe(true)
    for (const token of SECRET_AUTOCOMPLETE)
      expect(isSensitiveAttributes("input", attributes({ autocomplete: `section-x ${token}` }), "")).toBe(true)
    for (const [key, value] of [
      ["name", "user_password"],
      ["id", "otp"],
      ["aria-label", "Verification code"],
      ["placeholder", "Card number"],
      ["name", "pin"],
      ["id", "cvv"],
    ] as const)
      expect(isSensitiveAttributes("input", attributes({ [key]: value }), ""), `${key}=${value}`).toBe(true)
    expect(isSensitiveAttributes("textarea", attributes({ name: "passphrase" }), "")).toBe(true)
    expect(isSensitiveAttributes("div", attributes({ contenteditable: "", "aria-label": "Password" }), "")).toBe(true)
    expect(isSensitiveAttributes("input", attributes({ type: "text", name: "email", autocomplete: "email" }), "Email")).toBe(false)
    expect(isSensitiveAttributes("input", attributes({ name: "spinning" }), "")).toBe(false)
    expect(SECRET_NAME.test("shipping address")).toBe(false)
  })

  test("isSensitiveAttributes flags an editable field whose accessible name is Password or One-time code", () => {
    expect(isSensitiveAttributes("input", attributes({ type: "text" }), "Password")).toBe(true)
    expect(isSensitiveAttributes("input", attributes({ type: "text" }), "One-time code")).toBe(true)
    expect(isSensitiveAttributes("input", attributes({ type: "text" }), "Verification \n  code")).toBe(true)
    expect(isSensitiveAttributes("textarea", attributes({}), "Enter your password")).toBe(true)
    expect(isSensitiveAttributes("div", attributes({ contenteditable: "true" }), "Security code")).toBe(true)
    expect(isSensitiveAttributes("input", attributes({ type: "text" }), "Email address")).toBe(false)
    expect(isSensitiveAttributes("input", attributes({ type: "text" }), `${"x".repeat(256)} password`)).toBe(false)
  })

  test("isSensitiveAttributes ignores non-editable elements", () => {
    expect(isSensitiveAttributes("button", attributes({ "aria-label": "Password" }), "Password")).toBe(false)
    expect(isSensitiveAttributes("a", attributes({ name: "otp" }), "One-time code")).toBe(false)
    expect(isSensitiveAttributes("div", attributes({ contenteditable: "false", "aria-label": "Password" }), "Password")).toBe(false)
    expect(isSensitiveAttributes("div", attributes({ role: "textbox" }), "Password")).toBe(false)
  })

  test("page-side sensitivity matches attribute, label and aria-labelledby signals and refuses before any write", () => {
    const labelled = fakeField({ labels: [{ textContent: "  Verification\n   code " }] })
    expect(pageFunction(F_CONTROL_STATE).call(labelled.element)).toEqual({ sensitive: true })
    expect(pageFunction(F_FILL).call(labelled.element, "secret", false)).toEqual({ error: "Sensitive fields cannot be filled" })
    expect(pageFunction(F_FILL).call(labelled.element, "secret", true)).toEqual({ error: "Sensitive fields cannot be filled" })
    expect(labelled.calls).toEqual([])

    const byId = fakeField({ attributes: { "aria-labelledby": "missing code" } })
    byId.element.ownerDocument.getElementById = (id) => (id === "code" ? { textContent: "One-time code" } : null)
    expect(pageFunction(F_CONTROL_STATE).call(byId.element)).toEqual({ sensitive: true })
    expect(pageFunction(F_FILL).call(byId.element, "123456", true)).toEqual({ error: "Sensitive fields cannot be filled" })
    expect(byId.calls).toEqual([])

    const attribute = fakeField({ attributes: { autocomplete: "one-time-code" }, value: "private-value" })
    expect(pageFunction(F_CONTROL_STATE).call(attribute.element)).toEqual({ sensitive: true })

    const ordinary = fakeField({ value: "hello", labels: [{ textContent: "Email" }] })
    expect(pageFunction(F_CONTROL_STATE).call(ordinary.element)).toEqual({ value: "hello" })
    expect(pageFunction(F_FILL).call(ordinary.element, "x", false)).toEqual({ kind: "insert" })
    expect(ordinary.calls).toEqual([])
    expect(pageFunction(F_FILL).call(ordinary.element, "x", true)).toEqual({ kind: "insert" })
    expect(ordinary.calls).toEqual(["focus", "select"])
  })

  test("fixed page functions embed the sensitivity check and never carry model input", () => {
    for (const source of [F_CONTROL_STATE, F_FILL]) expect(source).toContain(IS_SENSITIVE)
    expect(F_SELECT).not.toContain(IS_SENSITIVE)
    expect(IS_SENSITIVE).toContain(String(SECRET_NAME))
    expect(IS_SENSITIVE).toContain(JSON.stringify(SECRET_AUTOCOMPLETE))
    expect(pageFunction(F_CONNECTED).call({ isConnected: false })).toBe(false)
    expect(pageFunction(F_CONNECTED).call({ isConnected: true })).toBe(true)
    const date = fakeField({ type: "date" })
    const marker = "model-text-marker\"'`${x}"
    expect(pageFunction(F_FILL).call(date.element, marker, true)).toEqual({ kind: "set" })
    expect(date.element.value).toBe(marker)
    expect(F_FILL).not.toContain("model-text-marker")
    expect(F_TEXT_PRESENT).not.toContain("model-text-marker")
  })

  test("the focused element resolver follows open shadow roots and same-origin frames and stops at closed or cross-origin hosts", () => {
    const resolve = (activeElement: unknown) => {
      Object.assign(globalThis, { document: { activeElement } })
      try {
        return pageFunction(F_ACTIVE_ELEMENT).call(undefined)
      } finally {
        Reflect.deleteProperty(globalThis, "document")
      }
    }
    const inner = { localName: "input", id: "inner" }
    const body = { localName: "body" }
    expect(resolve(null)).toBeNull()
    expect(resolve(inner)).toBe(inner)
    expect(resolve({ localName: "div", shadowRoot: { activeElement: inner } })).toBe(inner)
    expect(resolve({ localName: "div", shadowRoot: { activeElement: null } })).toMatchObject({ localName: "div" })
    expect(resolve({ localName: "iframe", contentDocument: { activeElement: inner } })).toBe(inner)
    expect(resolve({ localName: "iframe", contentDocument: { activeElement: body } })).toBe(body)
    const nested = { localName: "iframe", contentDocument: { activeElement: { localName: "div", shadowRoot: { activeElement: inner } } } }
    expect(resolve(nested)).toBe(inner)
    const crossOrigin = { localName: "iframe", contentDocument: null }
    expect(resolve(crossOrigin)).toBe(crossOrigin)
    const closedHost = { localName: "div", shadowRoot: null }
    expect(resolve(closedHost)).toBe(closedHost)
  })

  test("only plain navigation and Shift+Tab bypass focused-target inspection", () => {
    const navigation = ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]
    for (const key of navigation) {
      expect(isSafeNavigationKey(key, undefined), key).toBe(true)
      expect(isSafeNavigationKey(key, []), key).toBe(true)
      for (const modifier of ["Control", "Meta", "Alt", "Shift"] as const)
        expect(isSafeNavigationKey(key, [modifier]), `${modifier}+${key}`).toBe(key === "Tab" && modifier === "Shift")
      expect(isSafeNavigationKey(key, ["Control", "Shift"]), `Control+Shift+${key}`).toBe(false)
    }
    for (const key of ["a", "V", "7", "é", "-", " ", "Space", "Enter", "Backspace", "Delete", "Insert", "tab", "Unknown"]) {
      expect(isSafeNavigationKey(key, []), key).toBe(false)
      for (const modifiers of [["Shift"], ["Alt"], ["Control"], ["Meta"], ["Control", "Meta"]] as const)
        expect(isSafeNavigationKey(key, modifiers), `${modifiers.join("+")}+${key}`).toBe(false)
    }
  })

  test("the key guard refuses file inputs and sensitive fields and nothing else", () => {
    const refuse = (field: ReturnType<typeof fakeField>) => pageFunction(F_REFUSE_FIELD).call(field.element)
    expect(refuse(fakeField({ type: "file" }))).toBe(true)
    expect(refuse(fakeField({ type: "password" }))).toBe(true)
    expect(refuse(fakeField({ attributes: { autocomplete: "one-time-code" } }))).toBe(true)
    expect(refuse(fakeField({ labels: [{ textContent: "Password" }] }))).toBe(true)
    expect(refuse(fakeField({ isContentEditable: true, localName: "div", attributes: { "aria-label": "Security code" } }))).toBe(true)
    expect(refuse(fakeField({ labels: [{ textContent: "Email" }] }))).toBe(false)
    expect(refuse(fakeField({ localName: "button", attributes: { "aria-label": "Password" } }))).toBe(false)
    expect(refuse(fakeField({ localName: "body" }))).toBe(false)
  })

  test("the focus decision refuses sensitive leaves, closed shadow hosts, and frames that were not inspected", () => {
    expect(refusesEditingKey({ sensitive: false, closedShadowRoot: false })).toBe(false)
    expect(refusesEditingKey({ sensitive: true, closedShadowRoot: false })).toBe(true)
    expect(refusesEditingKey({ sensitive: false, closedShadowRoot: true })).toBe(true)
    expect(refusesEditingKey({ sensitive: false, closedShadowRoot: false, unreachableFrame: { inspected: false } })).toBe(true)
    expect(refusesEditingKey({ sensitive: false, closedShadowRoot: false, unreachableFrame: { inspected: true } })).toBe(false)
    expect(refusesEditingKey({ sensitive: true, closedShadowRoot: false, unreachableFrame: { inspected: true } })).toBe(true)
  })

  test("missing or ambiguous focus inspection never authorizes editing", () => {
    for (const leaf of [
      undefined,
      null,
      false,
      {},
      { sensitive: false },
      { closedShadowRoot: false },
      { sensitive: undefined, closedShadowRoot: false },
      { sensitive: "false", closedShadowRoot: false },
      { sensitive: false, closedShadowRoot: "false" },
      { sensitive: false, closedShadowRoot: false, unreachableFrame: null },
      { sensitive: false, closedShadowRoot: false, unreachableFrame: {} },
      { sensitive: false, closedShadowRoot: false, unreachableFrame: { inspected: "true" } },
    ])
      expect(refusesEditingKey(leaf), JSON.stringify(leaf)).toBe(true)
  })

  test("a retained frame host is not a verified focused leaf even when its document exists", () => {
    const probe = (element: Record<string, unknown>) => pageFunction(F_FRAME_UNREACHABLE).call(element)
    expect(probe({ localName: "iframe", contentDocument: null })).toBe(true)
    expect(probe({ localName: "frame", contentDocument: null })).toBe(true)
    expect(probe({ localName: "object", contentDocument: null })).toBe(true)
    expect(probe({ localName: "embed", contentDocument: undefined })).toBe(true)
    expect(probe({ localName: "iframe", contentDocument: { activeElement: null } })).toBe(true)
    expect(probe({ localName: "iframe", contentDocument: { activeElement: { localName: "body" } } })).toBe(true)
    expect(probe({ localName: "input", contentDocument: null })).toBe(false)
    expect(probe({ localName: "div" })).toBe(false)
  })

  test("select validates before applying and rejects missing, disabled and surplus options", () => {
    const options = [
      { value: "a", label: "Alpha", text: "Alpha", index: 0, disabled: false, selected: false },
      { value: "b", label: "", text: " Beta ", index: 1, disabled: false, selected: false },
      { value: "c", label: "Gamma", text: "Gamma", index: 2, disabled: true, selected: false },
    ]
    const events: string[] = []
    const select = {
      localName: "select",
      disabled: false,
      multiple: false,
      options,
      dispatchEvent: (event: { type: string }) => events.push(event.type),
    }
    const run = (criteria: Record<string, unknown>, apply: boolean) => pageFunction(F_SELECT).call(select, criteria, apply)
    expect(run({ values: ["z"] }, false)).toEqual({ error: "Option not found" })
    expect(run({ labels: ["Gamma"] }, false)).toEqual({ error: "Option is disabled" })
    expect(run({ values: ["a", "b"] }, false)).toEqual({ error: "Select accepts one option" })
    expect(run({ labels: ["Beta"] }, false)).toEqual({ ok: true })
    expect(options.map((option) => option.selected)).toEqual([false, false, false])
    expect(events).toEqual([])
    expect(run({ indexes: [1] }, true)).toEqual({ ok: true })
    expect(options.map((option) => option.selected)).toEqual([false, true, false])
    expect(events).toEqual(["input", "change"])
    expect(pageFunction(F_SELECT).call({ ...select, localName: "div" }, { values: ["a"] }, false)).toEqual({
      error: "Element is not a select",
    })
  })

  test("globMatch anchors the pattern, treats * as any run and stays linear", () => {
    expect(globMatch("http://x.test/done", "http://x.test/done")).toBe(true)
    expect(globMatch("http://x.test/done", "http://x.test/done/more")).toBe(false)
    expect(globMatch("http://x.test/*", "http://x.test/a/b")).toBe(true)
    expect(globMatch("*/done", "http://x.test/done")).toBe(true)
    expect(globMatch("http://x.test/a*c*e", "http://x.test/abcde")).toBe(true)
    expect(globMatch("http://x.test/a*c*e", "http://x.test/abcd")).toBe(false)
    expect(globMatch("*", "")).toBe(true)
    const started = performance.now()
    expect(globMatch(`${"a*".repeat(200)}b`, "a".repeat(5000))).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("the network idle tracker counts a request once across redirects and clears on finish, failure and session drop", () => {
    const tracker = createNetworkIdleTracker(() => 0)
    tracker.onEvent("s1", "Network.requestWillBeSent", { requestId: "r1" })
    tracker.onEvent("s1", "Network.requestWillBeSent", { requestId: "r1", redirectResponse: { status: 302 } })
    expect(tracker.pending()).toBe(1)
    tracker.onEvent("s1", "Network.loadingFinished", { requestId: "r1" })
    expect(tracker.pending()).toBe(0)
    tracker.onEvent("s1", "Network.requestWillBeSent", { requestId: "r2" })
    tracker.onEvent("s1", "Network.loadingFailed", { requestId: "r2" })
    expect(tracker.pending()).toBe(0)
    tracker.onEvent("s1", "Network.requestWillBeSent", { requestId: "r3" })
    tracker.onEvent("s2", "Network.requestWillBeSent", { requestId: "r4" })
    expect(tracker.pending()).toBe(2)
    tracker.dropSession("s2")
    expect(tracker.pending()).toBe(1)
    tracker.onEvent("s1", "Network.loadingFinished", { requestId: "unknown" })
    tracker.onEvent("s1", "Network.requestWillBeSent", {})
    tracker.onEvent("s1", "Network.dataReceived", { requestId: "r3" })
    expect(tracker.pending()).toBe(1)
    tracker.clear()
    expect(tracker.pending()).toBe(0)
  })

  test("the network idle tracker reports idle only after 500 quiet ms that start at or after the wait", () => {
    let now = 1000
    const tracker = createNetworkIdleTracker(() => now)
    expect(tracker.idleFor(500, 1000)).toBe(false)
    now = 1499
    expect(tracker.idleFor(500, 1000)).toBe(false)
    now = 1500
    expect(tracker.idleFor(500, 1000)).toBe(true)
    expect(tracker.idleFor(500, 1400)).toBe(false)
    now = 1900
    expect(tracker.idleFor(500, 1400)).toBe(true)

    tracker.onEvent("s1", "Network.requestWillBeSent", { requestId: "late" })
    now = 5000
    expect(tracker.idleFor(500, 1400)).toBe(false)
    tracker.onEvent("s1", "Network.loadingFinished", { requestId: "late" })
    now = 5499
    expect(tracker.idleFor(500, 1400)).toBe(false)
    now = 5500
    expect(tracker.idleFor(500, 1400)).toBe(true)

    tracker.onEvent("s1", "Network.requestWillBeSent", { requestId: "failing" })
    now = 6000
    tracker.onEvent("s1", "Network.loadingFailed", { requestId: "failing" })
    now = 6499
    expect(tracker.idleFor(500, 0)).toBe(false)
    now = 6500
    expect(tracker.idleFor(500, 0)).toBe(true)

    tracker.onEvent("s1", "Network.requestWillBeSent", { requestId: "gone" })
    now = 7000
    tracker.dropSession("s1")
    now = 7499
    expect(tracker.idleFor(500, 0)).toBe(false)
    now = 7500
    expect(tracker.idleFor(500, 0)).toBe(true)
  })

  test("the network idle tracker exposes only a count", () => {
    const tracker = createNetworkIdleTracker(() => 0)
    tracker.onEvent("s1", "Network.requestWillBeSent", {
      requestId: "secret-request-id",
      request: { url: "https://private.test/path?token=abc", method: "POST", headers: { authorization: "Bearer abc" } },
      initiator: { type: "script" },
      type: "Fetch",
    })
    expect(Object.keys(tracker).sort()).toEqual(["clear", "dropSession", "idleFor", "onEvent", "pending"])
    expect(typeof tracker.pending()).toBe("number")
    const surface = JSON.stringify([tracker.pending(), tracker.idleFor(500, 0), tracker])
    expect(surface).not.toContain("private.test")
    expect(surface).not.toContain("token")
    expect(surface).not.toContain("Bearer")
    expect(surface).not.toContain("secret-request-id")
  })
})
