/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { Schema } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import {
  DialogDotsBindings,
  type DotsBindingTarget,
  type DotsBindingsChoice,
} from "../src/component/dialog-dots-delegation"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { ClipboardProvider } from "../src/context/clipboard"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const principal = {
  ownerID: "owner_fixture",
  deviceID: "device_fixture",
  clientID: "client_fixture",
  epoch: "epoch_fixture",
  grantID: "oauth_grant_fixture",
}
const secondPrincipal = { ...principal, clientID: "client_second", grantID: "oauth_grant_second" }
const source = { sourceExchangeID: "exchange_fixture", principal }
const targets: readonly DotsBindingTarget[] = [
  { sessionID: "ses_alpha", title: "Alpha work", sources: [source], grants: [] },
  { sessionID: "ses_beta", title: "Beta work", sources: [source], grants: [] },
  { sessionID: "ses_gamma", title: "Gamma work", sources: [], grants: [] },
  {
    sessionID: "ses_delta",
    title: "Delta work",
    sources: [source, { sourceExchangeID: "exchange_second", principal: secondPrincipal }],
    grants: [
      Schema.decodeUnknownSync(Dots.DelegationInfo)({
        basis: "session",
        id: "grant_session_delta",
        revision: 2,
        sourceExchangeID: "exchange_fixture",
        targetSessionID: "ses_delta",
        principal,
        scope: { operations: ["task"] },
        expiresAt: Date.now() + 900000,
        active: true,
      }),
      Schema.decodeUnknownSync(Dots.DelegationInfo)({
        id: "grant_routine_delta",
        revision: 5,
        sourceExchangeID: "exchange_fixture",
        targetSessionID: "ses_delta",
        taskInputID: "msg_native_task",
        principal,
        scope: { operations: ["continue"] },
        expiresAt: Date.now() + 900000,
        active: true,
      }),
    ],
  },
]

async function fixture(options: {
  width?: number
  height?: number
  locked?: "pending" | "unknown"
  load?: () => Promise<readonly DotsBindingTarget[]>
} = {}) {
  const completed: (DotsBindingsChoice | null)[] = []
  function Open() {
    const dialog = useDialog()
    onMount(() => {
      void DialogDotsBindings.show(dialog, {
        load: async () => (options.load ? options.load() : targets),
        locked: () => options.locked,
      }).then((value) => completed.push(value))
    })
    return <text>Session surface</text>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClipboardProvider value={{}}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <ToastProvider>
                  <DialogProvider>
                    <Open />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    ),
    { width: options.width ?? 120, height: options.height ?? 80, kittyKeyboard: true },
  )
  app.renderer.start()
  const click = async (text: string) => {
    await app.waitForFrame((frame) => frame.includes(text))
    const lines = app.captureCharFrame().split("\n")
    const exact = lines.findIndex((line) => line.trim() === text)
    const row = exact >= 0 ? exact : lines.findIndex((line) => line.includes(text))
    if (row < 0) throw new Error(`Row not found: ${text}`)
    await app.mockMouse.click(lines[row].indexOf(text) + 2, row)
  }
  return { ...app, completed, click }
}

test("session-basis Bind needs no native task and carries explicit scope, expiry and principals for every selected Session", async () => {
  const app = await fixture()
  try {
    await app.waitForFrame((frame) => frame.includes("Coordinator bindings"))
    expect(app.captureCharFrame()).not.toContain("Bind")
    await app.click("[ ] Alpha work")
    await app.click("[ ] Beta work")
    await app.click("Tasks [off]")
    await app.click("Ordinary decisions [off]")
    await app.click("Expiry · not selected")
    await app.click("30 minutes")
    await app.click("Review binding")
    await app.waitForFrame((frame) => frame.includes("Bind coordinator"))
    expect(app.captureCharFrame()).toContain("client_fixture")
    expect(app.captureCharFrame()).toContain("ses_alpha")
    expect(app.captureCharFrame()).toContain("ses_beta")
    expect(app.captureCharFrame()).toContain("not human instructions")
    await app.click("Bind")
    await app.waitForFrame(() => app.completed.length === 1)
    expect(app.completed).toEqual([
      {
        kind: "bind",
        targets: [
          { sessionID: "ses_alpha", sourceExchangeID: "exchange_fixture", principal },
          { sessionID: "ses_beta", sourceExchangeID: "exchange_fixture", principal },
        ],
        operations: ["task", "decision"],
        minutes: 30,
      },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("no Session, scope or expiry is preselected and an ineligible Session shows its reason", async () => {
  const app = await fixture()
  try {
    await app.waitForFrame((frame) => frame.includes("Coordinator bindings"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("[ ] Alpha work")
    expect(frame).toContain("Tasks [off]")
    expect(frame).toContain("Ordinary decisions [off]")
    expect(frame).toContain("Expiry · not selected")
    expect(frame).toContain("No authenticated source exchange")
    expect(frame).not.toContain("Review binding")
    expect(app.completed).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("a Session with multiple principals binds only through the explicitly chosen source", async () => {
  const app = await fixture({
    load: async () => [
      {
        sessionID: "ses_delta",
        title: "Delta work",
        sources: [source, { sourceExchangeID: "exchange_second", principal: secondPrincipal }],
        grants: [],
      },
    ],
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Coordinator bindings"))
    await app.click("Choose source exchange")
    await app.click("client_second")
    await app.click("[ ] Delta work")
    await app.click("Tasks [off]")
    await app.click("Expiry · not selected")
    await app.click("15 minutes")
    await app.click("Review binding")
    await app.click("Bind")
    await app.waitForFrame(() => app.completed.length === 1)
    expect(app.completed).toEqual([
      {
        kind: "bind",
        targets: [{ sessionID: "ses_delta", sourceExchangeID: "exchange_second", principal: secondPrincipal }],
        operations: ["task"],
        minutes: 15,
      },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("Unbind targets exactly the displayed grant and leaves other grants to their own rows", async () => {
  const app = await fixture()
  try {
    await app.waitForFrame((frame) => frame.includes("grant_routine_delta"))
    expect(app.captureCharFrame()).toContain("grant_session_delta")
    await app.click("grant_routine_delta")
    await app.waitForFrame(() => app.completed.length === 1)
    expect(app.completed[0]?.kind).toBe("unbind")
    if (app.completed[0]?.kind !== "unbind") throw new Error("Expected an unbind choice")
    expect(app.completed[0].grant.id).toBe("grant_routine_delta")
    expect(app.completed[0].grant.revision).toBe(5)
  } finally {
    app.renderer.destroy()
  }
})

test("decision-only authority cannot Bind because the grant could never admit its own task", async () => {
  const app = await fixture()
  try {
    await app.waitForFrame((frame) => frame.includes("Coordinator bindings"))
    await app.click("[ ] Alpha work")
    await app.click("Ordinary decisions [off]")
    await app.click("Expiry · not selected")
    await app.click("15 minutes")
    await app.waitForFrame((frame) => frame.includes("decision-only grant can never"))
    expect(app.captureCharFrame()).toContain("Ordinary decisions require Tasks")
    expect(app.captureCharFrame()).not.toContain("Review binding")
    expect(app.completed).toEqual([])
    await app.click("Tasks [off]")
    await app.waitForFrame((frame) => frame.includes("Review binding"))
    expect(app.completed).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

function expiringTargets(expiry: number, longExpiry: number): readonly DotsBindingTarget[] {
  return [
    {
      sessionID: "ses_delta",
      title: "Delta work",
      sources: [source],
      grants: [
        Schema.decodeUnknownSync(Dots.DelegationInfo)({
          id: "grant_expiring",
          revision: 1,
          sourceExchangeID: "exchange_fixture",
          targetSessionID: "ses_delta",
          taskInputID: "msg_native_task",
          principal,
          scope: { operations: ["continue"] },
          expiresAt: expiry,
          active: true,
        }),
        Schema.decodeUnknownSync(Dots.DelegationInfo)({
          id: "grant_long_lived",
          revision: 4,
          sourceExchangeID: "exchange_fixture",
          targetSessionID: "ses_delta",
          taskInputID: "msg_native_task",
          principal,
          scope: { operations: ["continue"] },
          expiresAt: longExpiry,
          active: true,
        }),
      ],
    },
  ]
}

test("Unbind resolves the displayed grant by identity after an earlier grant expires", async () => {
  let now = 1_800_000_000_000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  let app: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    app = await fixture({ load: async () => expiringTargets(now + 60_000, now + 900_000) })
    const mounted = app
    await mounted.waitForFrame((frame) => frame.includes("grant_long_lived"))
    expect(mounted.captureCharFrame()).toContain("grant_expiring")
    now += 120_000
    await mounted.click("Grant: grant_long_lived")
    await mounted.waitForFrame(() => mounted.completed.length === 1)
    expect(mounted.completed[0]?.kind).toBe("unbind")
    if (mounted.completed[0]?.kind !== "unbind") throw new Error("Expected an unbind choice")
    expect(mounted.completed[0].grant.id).toBe("grant_long_lived")
    expect(mounted.completed[0].grant.revision).toBe(4)
  } finally {
    app?.renderer.destroy()
    clock.mockRestore()
  }
})

test("selecting an expired grant row never resolves to another active grant", async () => {
  let now = 1_800_000_000_000
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  let app: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    app = await fixture({ load: async () => expiringTargets(now + 60_000, now + 900_000) })
    const mounted = app
    await mounted.waitForFrame((frame) => frame.includes("grant_expiring"))
    expect(mounted.captureCharFrame()).toContain("grant_long_lived")
    now += 120_000
    await mounted.click("Grant: grant_expiring")
    await mounted.waitForFrame(() => mounted.completed.length === 1)
    expect(mounted.completed[0]?.kind).toBe("unbind")
    if (mounted.completed[0]?.kind !== "unbind") throw new Error("Expected an unbind choice")
    expect(mounted.completed[0].grant.id).toBe("grant_expiring")
    expect(mounted.completed[0].grant.revision).toBe(1)
  } finally {
    app?.renderer.destroy()
    clock.mockRestore()
  }
})

test("an unknown mutation outcome locks Bind and Unbind to read-only refresh", async () => {
  const app = await fixture({ locked: "unknown" })
  try {
    await app.waitForFrame((frame) => frame.includes("outcome unknown"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Refresh status")
    expect(frame).not.toContain("Unbind")
    expect(frame).not.toContain("[ ] Alpha work")
    expect(app.completed).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
