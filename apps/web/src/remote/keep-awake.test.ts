import { expect, test } from "bun:test"
import { keepAwakeView, readKeepAwakeStatus, type KeepAwakeState } from "./keep-awake"

const ready = (state: "off" | "on" | "unsupported" | "error", message?: string): KeepAwakeState => ({
  read: "ready",
  status: { state, ...(message === undefined ? {} : { message }) },
})

test("reports foreign lid ownership separately from local idle and sleep holds", () => {
  const status = readKeepAwakeStatus({ data: { state: "on", lid: "held", sleepHold: true } })
  expect(status?.lid).toBe("held")
  expect(keepAwakeView({ reachable: true, keepAwake: { read: "ready", status } }).detail).toContain("lid held by another YCoding process")
})

test("reads only the closed status shape and bounds the machine's message", () => {
  expect(readKeepAwakeStatus({ data: { state: "on" } })).toEqual({ state: "on" })
  expect(readKeepAwakeStatus({ data: { state: "on", lid: "on", sleepHold: true } })).toEqual({
    state: "on",
    lid: "on",
    sleepHold: true,
  })
  expect(readKeepAwakeStatus({ data: { state: "on", lid: "bogus", sleepHold: "yes" } })).toEqual({ state: "on" })
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

test("sleep-held effective On keeps a manual-Off switch and exposes both parts and lid failures", () => {
  const status = { state: "on", manual: false, sleepHold: true, lid: "error" } as const
  expect(readKeepAwakeStatus({ data: status })).toEqual(status)
  const view = keepAwakeView({ reachable: true, keepAwake: { read: "ready", status } })
  expect(view.checked).toBe(false)
  expect(view.label).toBe("On")
  expect(view.detail).toContain("Idle on; lid error")
  expect(view.detail).toContain("sleeping session")
  expect(view.detail).toContain("Closing the lid may sleep")
  expect(view.caveat).toContain("heat")
})

test("machine status reserves reported-part geometry and owns error tones", async () => {
  const css = await Bun.file(new URL("../styles/remote.css", import.meta.url)).text()
  expect(css).toMatch(/\.machine-awake__status\s*\{[^}]*min-block-size:\s*calc\(var\(--yc-leading-xs\) \* 6\)/)
  expect(css).toMatch(/\.machine-awake__status\[data-tone="danger"\]\s*\{[^}]*color:\s*var\(--yc-danger\)/)
  expect(css).toMatch(/\.machine-awake__status\[data-tone="attention"\]\s*\{[^}]*color:\s*var\(--yc-yellow-strong\)/)
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

test("a ready machine reports its own state with the idle and lid caveat and enables the switch", () => {
  const off = keepAwakeView({ keepAwake: ready("off"), reachable: true })
  expect(off).toMatchObject({ checked: false, disabled: false, busy: false, label: "Off", tone: "neutral" })
  expect(off.caveat).toMatch(/idle sleep/i)
  expect(off.caveat).toMatch(/lid/i)
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
      expect(view.caveat).toMatch(/idle sleep and lid-closed sleep/)
      expect(view.caveat).toMatch(/battery/)
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

test("a sleep-held machine explains that turning off only sets the manual preference", () => {
  const view = keepAwakeView({
    keepAwake: { read: "ready", status: { state: "on", lid: "on", sleepHold: true } },
    reachable: true,
  })
  expect(view).toMatchObject({ checked: true, disabled: false, label: "On", tone: "attention" })
  expect(view.detail).toMatch(/sleeping session/)
  expect(view.detail).toMatch(/manual preference/)
  expect(view.caveat).toMatch(/battery/)
  expect(view.caveat).toMatch(/heat/)
})

test("a lid error stays visible while idle keep-awake is on", () => {
  const view = keepAwakeView({
    keepAwake: { read: "ready", status: { state: "on", lid: "error", sleepHold: false } },
    reachable: true,
  })
  expect(view).toMatchObject({ checked: true, label: "On", tone: "attention", alert: true })
  expect(view.detail).toMatch(/lid-closed keep-awake could not be armed/)
})

test("an older connector status without lid or sleepHold still reads as on", () => {
  const view = keepAwakeView({ keepAwake: ready("on"), reachable: true })
  expect(view).toMatchObject({ checked: true, disabled: false, label: "On", tone: "neutral" })
  expect(view.detail).toContain("being kept awake")
})

test("system sleep control is read for each value, ignored when unknown, and absent for older connectors", () => {
  for (const system of ["off", "on", "held", "setup", "unsupported", "error"] as const)
    expect(readKeepAwakeStatus({ data: { state: "on", system } })).toEqual({ state: "on", system })
  expect(readKeepAwakeStatus({ data: { state: "on", system: "bogus" } })).toEqual({ state: "on" })
  const absent = keepAwakeView({ reachable: true, keepAwake: { read: "ready", status: { state: "on" } } })
  expect(absent.detail).not.toMatch(/System sleep/)
})

test("system sleep control is explained in the detail and an error needs attention", () => {
  const view = (system: "off" | "on" | "held" | "setup" | "unsupported" | "error", state: "on" | "off" = "on") =>
    keepAwakeView({ reachable: true, keepAwake: { read: "ready", status: { state, system } } })
  expect(view("on").detail).toContain("closed lid on battery stays awake until the battery dies")
  expect(view("on").detail).toContain("Sleep does not sleep")
  expect(view("on").tone).toBe("neutral")
  expect(view("setup", "off").detail).toContain("ycoding keep-awake setup")
  expect(view("held").detail).toContain("held by another YCoding process")
  expect(view("off").detail).toContain("System sleep control off")
  expect(view("unsupported").detail).toContain("unsupported")
  const error = view("error")
  expect(error.tone).toBe("attention")
  expect(error.alert).toBe(true)
  expect(error.detail).toContain("could not be applied or restored")
  expect(keepAwakeView({ reachable: true, keepAwake: { read: "ready", status: { state: "on", sleepHold: true, system: "on" } } }).detail).toContain("System sleep disabled")
  expect(view("on").caveat).toMatch(/system sleep is On/)
})
