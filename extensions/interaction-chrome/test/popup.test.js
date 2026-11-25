import { afterEach, describe, expect, test } from "bun:test"

const originalDocument = globalThis.document
const originalChrome = globalThis.chrome
const originalSetInterval = globalThis.setInterval

afterEach(() => {
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document")
  else globalThis.document = originalDocument
  if (originalChrome === undefined) Reflect.deleteProperty(globalThis, "chrome")
  else globalThis.chrome = originalChrome
  globalThis.setInterval = originalSetInterval
})

function element(tag = "div") {
  const node = {
    tagName: tag.toUpperCase(),
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    className: "",
    type: "",
    dataset: {},
    children: [],
    attributes: new Map(),
    listeners: new Map(),
    addEventListener(type, listener) {
      this.listeners.set(type, listener)
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value))
    },
    removeAttribute(name) {
      this.attributes.delete(name)
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null
    },
    append(...items) {
      this.children.push(...items)
    },
    replaceChildren(...items) {
      this.children = [...items]
    },
  }
  return node
}

function findButtons(root) {
  const out = []
  for (const child of root.children ?? []) {
    if (child.tagName === "BUTTON") out.push(child)
    out.push(...findButtons(child))
  }
  return out
}

function collectText(root) {
  const parts = []
  if (root.textContent) parts.push(root.textContent)
  for (const child of root.children ?? []) parts.push(collectText(child))
  return parts.join(" ").trim()
}

async function mountPopup(initial, next) {
  const nodes = new Map()
  const calls = []
  const intervals = []
  const statuses = Array.isArray(initial) ? [...initial] : [initial]
  const selectors = [
    "#deck-body",
    "#connection",
    "#status",
    "#match-code",
    "#connect",
    "input[name=address]",
    "#forget",
    "#open-panel",
    "#feedback",
    "#requests",
    "#active",
  ]
  for (const selector of selectors) nodes.set(selector, element())
  nodes.get("input[name=address]").value = "http://127.0.0.1:42188"
  nodes.get("#match-code").hidden = true
  nodes.get("#connect").hidden = true
  nodes.get("#forget").hidden = true
  nodes.get("#open-panel").hidden = true
  nodes.get("#feedback").hidden = true
  nodes.get("#requests").hidden = true
  nodes.get("#active").hidden = true

  globalThis.document = {
    querySelector: (selector) => nodes.get(selector) ?? null,
    createElement: (tag) => element(tag),
  }
  globalThis.setInterval = (callback) => {
    intervals.push(callback)
    return intervals.length
  }
  globalThis.chrome = {
    windows: {
      getCurrent: async () => ({ id: 7 }),
    },
    runtime: {
      sendMessage: async (message) => {
        calls.push(message)
        if (message.type === "status") {
          const item = statuses.length > 1 ? statuses.shift() : statuses[0]
          if (item instanceof Error) throw item
          return item
        }
        if (typeof next === "function") return next(message)
        if (next instanceof Error) throw next
        return next ?? { ok: true, status: "connected" }
      },
    },
  }

  await import(`../popup.js?popup-test=${crypto.randomUUID()}`)
  await Bun.sleep(10)

  return {
    nodes,
    calls,
    click: async (target, trusted = true) => {
      const el = typeof target === "string" ? nodes.get(target) : target
      const handler = el.listeners.get("click")
      if (handler) await handler({ isTrusted: trusted })
      await Bun.sleep(10)
    },
    tick: async () => {
      expect(intervals).toHaveLength(1)
      await intervals[0]()
      await Bun.sleep(10)
    },
  }
}

describe("interaction-chrome popup states and contracts", () => {
  test("removes the blank body strip and enclosing dividers when there is no status content", async () => {
    const { nodes } = await mountPopup({
      ok: true,
      status: "",
      address: "http://127.0.0.1:42188",
      authorized: false,
      groupingUnavailable: false,
      pending: [],
      active: [],
    })
    expect(nodes.get("#status").textContent).toBe("")
    expect(nodes.get("#status").hidden).toBe(true)
    expect(nodes.get("#connection").hidden).toBe(true)
    expect(nodes.get("#deck-body").hidden).toBe(true)
    expect(nodes.get("#requests").hidden).toBe(true)
    expect(nodes.get("#active").hidden).toBe(true)
    expect(nodes.get("#feedback").hidden).toBe(true)
    expect(nodes.get("#connect").hidden).toBe(true)
    expect(nodes.get("#match-code").hidden).toBe(true)

    const css = await Bun.file(new URL("../popup.css", import.meta.url)).text()
    expect(css).toMatch(/\.deck-body\[hidden\][\s\S]*border-bottom:\s*0/)
    expect(css).toMatch(/\.deck-body\[hidden\][\s\S]*border-top:\s*0/)
  })

  test("connected idle shows primary Connected status with zero empty list or alert strips", async () => {
    const { nodes } = await mountPopup({
      ok: true,
      status: "connected",
      address: "http://127.0.0.1:42188",
      authorized: true,
      groupingUnavailable: false,
      pending: [],
      active: [],
    })
    expect(nodes.get("#deck-body").hidden).toBe(false)
    expect(nodes.get("#connection").hidden).toBe(false)
    expect(nodes.get("#status").hidden).toBe(false)
    expect(nodes.get("#status").textContent).toBe("Connected")
    expect(nodes.get("#status").dataset.state).toBe("connected")
    expect(nodes.get("#connect").hidden).toBe(true)
    expect(nodes.get("#match-code").hidden).toBe(true)
    expect(nodes.get("#requests").hidden).toBe(true)
    expect(nodes.get("#active").hidden).toBe(true)
    expect(nodes.get("#feedback").hidden).toBe(true)
    expect(nodes.get("#forget").hidden).toBe(false)
    expect(nodes.get("#open-panel").hidden).toBe(true)
  })

  test("disconnected idle shows primary Not connected status and Connect action, preserving message payload", async () => {
    const { nodes, calls, click } = await mountPopup(
      [
        {
          ok: true,
          status: "idle",
          address: "http://127.0.0.1:42188",
          authorized: false,
          groupingUnavailable: false,
          pending: [],
          active: [],
        },
        {
          ok: true,
          status: "enrolling",
          matchCode: "JC4E-V103",
          address: "http://127.0.0.1:42188",
          authorized: false,
          groupingUnavailable: false,
          pending: [],
          active: [],
        },
      ],
      { ok: true, status: "enrolling" },
    )
    expect(nodes.get("#status").textContent).toBe("Not connected")
    expect(nodes.get("#status").dataset.state).toBe("disconnected")
    expect(nodes.get("#connect").hidden).toBe(false)
    expect(nodes.get("#forget").hidden).toBe(true)

    await click("#connect", false)
    expect(calls.filter((call) => call.type === "connect")).toHaveLength(0)

    await click("#connect", true)
    expect(calls.filter((call) => call.type === "connect")).toEqual([
      { type: "connect", address: "http://127.0.0.1:42188", windowId: 7 },
    ])
    expect(nodes.get("#status").textContent).toBe("Confirm on your Mac")
    expect(nodes.get("#status").dataset.state).toBe("waiting")
    expect(nodes.get("#match-code").hidden).toBe(false)
    expect(nodes.get("#match-code").textContent).toBe("JC4E-V103")
    expect(nodes.get("#connect").hidden).toBe(true)
  })

  test.each([
    { state: "connecting", expected: "Connecting…" },
    { state: "reconnecting", expected: "Reconnecting…" },
    { state: "forgetting", expected: "Forgetting this profile…" },
  ])("loading state $state sets waiting state and hides Connect and empty sections", async ({ state, expected }) => {
    const { nodes } = await mountPopup({
      ok: true,
      status: state,
      address: "http://127.0.0.1:42188",
      authorized: true,
      groupingUnavailable: false,
      pending: [],
      active: [],
    })
    expect(nodes.get("#status").textContent).toBe(expected)
    expect(nodes.get("#status").dataset.state).toBe("waiting")
    expect(nodes.get("#connect").hidden).toBe(true)
    expect(nodes.get("#match-code").hidden).toBe(true)
    expect(nodes.get("#requests").hidden).toBe(true)
    expect(nodes.get("#active").hidden).toBe(true)
    expect(nodes.get("#feedback").hidden).toBe(true)
  })

  test.each([
    { state: "denied", expected: "This Mac did not allow the connection" },
    { state: "rejected", expected: "This Chrome profile is no longer allowed. Connect to ask again." },
    { state: "busy", expected: "Another Chrome profile is connected" },
    { state: "offline", expected: "YCoding is not reachable. Retrying…" },
  ])("error state $state sets error state, preserves full text, and offers Connect", async ({ state, expected }) => {
    const { nodes } = await mountPopup({
      ok: true,
      status: state,
      address: "http://127.0.0.1:42188",
      authorized: state === "offline",
      groupingUnavailable: false,
      pending: [],
      active: [],
    })
    expect(nodes.get("#status").textContent).toBe(expected)
    expect(nodes.get("#status").dataset.state).toBe("error")
    expect(nodes.get("#connect").hidden).toBe(false)
  })

  test("connected pending, active, paused, and action error preserve all controls and payloads", async () => {
    const { nodes, calls, click, tick } = await mountPopup(
      [
        {
          ok: true,
          status: "connected",
          address: "http://127.0.0.1:42188",
          authorized: true,
          groupingUnavailable: false,
          pending: [
            {
              candidateID: "cand-1",
              sessionID: "sess-1",
              sessionLabel: "Fix popup",
              targetID: "targ-1",
              purpose: "attach",
              grouping: "move",
              url: "http://127.0.0.1:42188/page",
              target: { label: "Selected Chrome tab", origin: "http://127.0.0.1:42188", pathname: "/page" },
            },
          ],
          active: [],
        },
        {
          ok: true,
          status: "connected",
          address: "http://127.0.0.1:42188",
          authorized: true,
          groupingUnavailable: false,
          pending: [],
          active: [
            {
              sessionID: "sess-1",
              sessionLabel: "Fix popup",
              leaseID: "lease-1",
              epoch: 2,
              label: "Selected Chrome tab",
            },
          ],
        },
        {
          ok: true,
          status: "connected",
          address: "http://127.0.0.1:42188",
          authorized: true,
          groupingUnavailable: false,
          pending: [],
          active: [
            {
              sessionID: "sess-1",
              sessionLabel: "Fix popup",
              leaseID: "lease-1",
              epoch: 2,
              label: "Selected Chrome tab",
              paused: "user_takeover",
            },
          ],
        },
      ],
      (msg) => (msg.type === "stop" ? { ok: false, code: "cleanup" } : { ok: true, status: "connected" }),
    )

    expect(nodes.get("#requests").hidden).toBe(false)
    expect(nodes.get("#active").hidden).toBe(true)
    const pendingButtons = findButtons(nodes.get("#requests"))
    expect(pendingButtons.map((b) => [b.dataset.kind, b.textContent])).toEqual([
      ["approve", "Approve and group"],
      ["reject", "Reject"],
    ])
    await click(pendingButtons[0], true)
    expect(calls.find((c) => c.type === "approve")).toEqual({
      type: "approve",
      candidateID: "cand-1",
      sessionID: "sess-1",
      targetID: "targ-1",
      grouping: "move",
      windowId: 7,
    })

    expect(nodes.get("#status").textContent).toBe("Control active")
    expect(nodes.get("#status").dataset.state).toBe("active")
    expect(nodes.get("#requests").hidden).toBe(true)
    expect(nodes.get("#active").hidden).toBe(false)
    expect(nodes.get("#open-panel").hidden).toBe(false)
    const activeButtons = findButtons(nodes.get("#active"))
    expect(activeButtons.map((b) => [b.dataset.kind, b.textContent])).toEqual([
      ["takeover", "Take over"],
      ["stop", "Stop control"],
    ])

    await tick()
    expect(nodes.get("#status").textContent).toBe("Paused")
    expect(nodes.get("#status").dataset.state).toBe("paused")
    expect(collectText(nodes.get("#active"))).toContain("You took over this tab.")
    const pausedButtons = findButtons(nodes.get("#active"))
    expect(pausedButtons.map((b) => [b.dataset.kind, b.textContent])).toEqual([
      ["resume", "Resume"],
      ["stop", "Stop control"],
    ])

    await click(pausedButtons[1], true)
    expect(nodes.get("#feedback").hidden).toBe(false)
    expect(nodes.get("#feedback").textContent).toBe("Control stopped. Chrome cleanup was not confirmed.")
  })

  test("markup, CSS, and manifest keep full unwrapped status, collapsed Advanced, logical order, and embedded fonts", async () => {
    const html = await Bun.file(new URL("../popup.html", import.meta.url)).text()
    const css = await Bun.file(new URL("../popup.css", import.meta.url)).text()
    const manifest = await Bun.file(new URL("../manifest.json", import.meta.url)).json()

    expect(html).toContain('id="deck-body"')
    expect(html).toContain('id="connection"')
    expect(html).toContain('id="status"')
    expect(html).toContain('role="status"')
    expect(html).toContain('id="feedback"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('<details id="advanced">')
    expect(html).not.toMatch(/<details id="advanced"[^>]*\bopen\b/)
    expect(html.indexOf('id="status"')).toBeGreaterThan(html.indexOf('id="deck-body"'))
    expect(html.indexOf('id="connect"')).toBeLessThan(html.indexOf('id="advanced"'))

    const styleRules = css.split("/* generated:fonts begin")[0]
    expect(styleRules).not.toMatch(/\.status-(?:pill|value)\s*\{[^}]*text-overflow:\s*ellipsis/)
    expect(styleRules).not.toMatch(/\.status-(?:pill|value)\s*\{[^}]*max-width:\s*150px/)
    expect(styleRules).not.toMatch(/details#advanced\[open\]\s*\{[^}]*order:\s*2/)
    expect(styleRules).toContain(":focus-visible")
    expect(styleRules).toContain("prefers-color-scheme: dark")
    expect(styleRules).toContain("prefers-reduced-motion: reduce")
    expect(styleRules).toContain("forced-colors: active")
    expect(styleRules).toContain("pointer: coarse")

    const code = css.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(code.match(/@font-face/g)).toHaveLength(2)
    expect(code.match(/url\(([^)]+)\)/g).every((ref) => ref.startsWith('url("data:font/woff2;base64,'))).toBe(true)
    expect(code).not.toMatch(/https?:\/\//)

    expect(manifest.permissions).toEqual(["alarms", "debugger", "storage", "tabs", "tabGroups"])
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"])
    expect(manifest.content_security_policy.extension_pages).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src data:; connect-src ws://127.0.0.1:*; object-src 'none'",
    )
  })
})
