import { expect, test } from "bun:test"
import { keepAwakeView, readKeepAwakeStatus, type KeepAwakeState } from "./keep-awake"

const ready = (state: "off" | "on" | "unsupported" | "error", message?: string): KeepAwakeState => ({
  read: "ready",
  status: { state, ...(message === undefined ? {} : { message }) },
})

test("reads only the closed status shape and bounds the machine's message", () => {
  expect(readKeepAwakeStatus({ data: { state: "on" } })).toEqual({ state: "on" })
  expect(readKeepAwakeStatus({ data: { state: "error", message: "caffeinate exited" } })).toEqual({
    state: "error",
    message: "caffeinate exited",
  })
  expect(readKeepAwakeStatus({ data: { state: "off", message: "x".repeat(200) } })?.message).toHaveLength(200)
  for (const value of [
    undefined,
    null,
    {},
    { data: null },
    { data: { state: "sleeping" } },
    { data: { state: "on", message: 3 } },
    { data: { state: "on", message: "x".repeat(201) } },
    { state: "on" },
  ])
    expect(readKeepAwakeStatus(value)).toBeUndefined()
})

test("a machine that is not reachable or not read yet never shows Off", () => {
  const idle = keepAwakeView({ keepAwake: { read: "idle" }, reachable: false })
  expect(idle).toMatchObject({ checked: false, disabled: true, busy: false, label: "Unavailable" })
  expect(idle.detail).toContain("online machine")
  expect(keepAwakeView({ keepAwake: { read: "idle" }, reachable: true })).toMatchObject({
    disabled: true,
    busy: true,
    label: "Checking",
  })
  expect(keepAwakeView({ keepAwake: { read: "loading" }, reachable: true })).toMatchObject({
    disabled: true,
    busy: true,
    label: "Checking",
  })
  expect(keepAwakeView({ keepAwake: ready("on"), reachable: false })).toMatchObject({
    checked: false,
    disabled: true,
    label: "Unavailable",
  })
})

test("a ready machine reports its own state with the idle-sleep caveat and enables the switch", () => {
  const off = keepAwakeView({ keepAwake: ready("off"), reachable: true })
  expect(off).toMatchObject({ checked: false, disabled: false, busy: false, label: "Off", tone: "neutral" })
  expect(off.caveat).toMatch(/idle sleep/i)
  expect(off.caveat).toMatch(/manual sleep|lid/i)
  expect(off.caveat).toMatch(/restart/i)
  expect(keepAwakeView({ keepAwake: ready("on"), reachable: true })).toMatchObject({
    checked: true,
    disabled: false,
    label: "On",
  })
})

test("unsupported and machine errors stay visible, and an error can still be retried by the switch", () => {
  const unsupported = keepAwakeView({ keepAwake: ready("unsupported", "Only macOS can hold this."), reachable: true })
  expect(unsupported).toMatchObject({ checked: false, disabled: true, label: "Unsupported" })
  expect(unsupported.detail).toContain("Only macOS can hold this.")
  const failed = keepAwakeView({ keepAwake: ready("error", "caffeinate exited"), reachable: true })
  expect(failed).toMatchObject({ checked: false, disabled: false, label: "Error", tone: "danger", alert: true })
  expect(failed.detail).toContain("caffeinate exited")
})

test("every machine state keeps the macOS and lifetime caveats visible", () => {
  for (const keepAwake of [
    { read: "idle" },
    { read: "loading" },
    { read: "outdated" },
    { read: "unanswered" },
    { read: "error" },
    ready("unsupported"),
    ready("error"),
    ready("off"),
    ready("on"),
  ] as const) {
    for (const reachable of [false, true]) {
      const view = keepAwakeView({ keepAwake, reachable })
      expect(view.caveat).toMatch(/macOS/)
      expect(view.caveat).toMatch(/idle sleep only/)
      expect(view.caveat).toMatch(/manual sleep or closing the lid/)
      expect(view.caveat).toMatch(/stops or restarts/)
    }
  }
})

test("an older or silent machine is asked to update instead of showing Off, and an outright failure offers Retry", () => {
  const outdated = keepAwakeView({ keepAwake: { read: "outdated" }, reachable: true })
  expect(outdated).toMatchObject({ checked: false, disabled: true, retry: false })
  expect(outdated.detail).toMatch(/update YCoding on this machine/i)
  const silent = keepAwakeView({ keepAwake: { read: "unanswered" }, reachable: true })
  expect(silent).toMatchObject({ disabled: true, retry: true })
  expect(silent.detail).toMatch(/did not answer/i)
  expect(silent.detail).toMatch(/update YCoding on this machine/i)
  const broken = keepAwakeView({
    keepAwake: { read: "error", message: "Keep machine awake: internal failure" },
    reachable: true,
  })
  expect(broken).toMatchObject({ disabled: true, retry: true, alert: true })
  expect(broken.detail).toContain("internal failure")
})

test("a change in flight disables the switch, and a failed or unknown change keeps the machine's reported state", () => {
  const sending = keepAwakeView({
    keepAwake: { ...ready("off"), change: { state: "sending", enabled: true } },
    reachable: true,
  })
  expect(sending).toMatchObject({ checked: false, disabled: true, busy: true })
  expect(sending.detail).toMatch(/turning on/i)
  expect(
    keepAwakeView({ keepAwake: { ...ready("on"), change: { state: "sending", enabled: false } }, reachable: true })
      .detail,
  ).toMatch(/turning off/i)
  const failed = keepAwakeView({
    keepAwake: { ...ready("off"), change: { state: "failed", enabled: true, message: "Keep machine awake: denied" } },
    reachable: true,
  })
  expect(failed).toMatchObject({ checked: false, disabled: false, alert: true })
  expect(failed.detail).toContain("denied")
  const unknown = keepAwakeView({
    keepAwake: {
      ...ready("on"),
      change: { state: "unknown", enabled: true, message: "The result of turning it on is unconfirmed." },
    },
    reachable: true,
  })
  expect(unknown).toMatchObject({ checked: true, disabled: false, tone: "attention", alert: true })
  expect(unknown.detail).toContain("unconfirmed")
  expect(unknown.detail).not.toMatch(/turned on|is now on|confirmed on/i)
})
