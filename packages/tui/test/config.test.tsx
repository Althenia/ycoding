/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { Schema } from "effect"
import { resolve, ConfigProvider, CoordinationNotifications, useConfig, type Interface } from "../src/config"

test("notification selections accept 128 master Sessions and reject larger selections", () => {
  const sessionIDs = Array.from({ length: 128 }, (_, index) => `ses_master_${index}`)
  expect(Schema.decodeUnknownSync(CoordinationNotifications)({ scope: "selected", sessionIDs }).sessionIDs).toHaveLength(128)
  expect(() => Schema.decodeUnknownSync(CoordinationNotifications)({ scope: "selected", sessionIDs: [...sessionIDs, "ses_extra"] })).toThrow()
})

test("coordination notification preferences preserve all-source defaults and explicit bounded selections", () => {
  expect(resolve({}, { terminalSuspend: true }).attention.coordination).toEqual({ scope: "all" })
  const coordination = { scope: "selected" as const, sessionIDs: ["ses_coordinator"], categories: ["question" as const, "failure" as const] }
  expect(resolve({ attention: { coordination } }, { terminalSuspend: true }).attention.coordination).toEqual(coordination)
})

test("resolves nested config and keybind defaults", () => {
  const config = resolve(
    {
      keybinds: { leader: "ctrl+o" },
      leader: { timeout: 500 },
      scroll: { speed: 2, acceleration: true },
      diffs: { view: "split" },
      debug: { devtools: true },
    },
    { terminalSuspend: true },
  )

  expect(config.leader.timeout).toBe(500)
  expect(config.keybinds.get("leader")?.[0]?.key).toBe("ctrl+o")
  expect(config.scroll).toEqual({ speed: 2, acceleration: true })
  expect(config.diffs).toEqual({ view: "split" })
  expect(config.debug).toEqual({ devtools: true })

  expect(resolve({}, { terminalSuspend: true }).attention.enabled).toBe(true)
  expect(resolve({ attention: { enabled: false } }, { terminalSuspend: true }).attention.enabled).toBe(false)
  expect(resolve({ terminal: { copy_on_select: true } }, { terminalSuspend: true }).terminal?.copy_on_select).toBe(true)
})

test("provides config and its host interface", async () => {
  const config = resolve({}, { terminalSuspend: true })
  let current = {}
  const service: Interface = {
    get: async () => current,
    update: async (update) => {
      const draft: Record<string, any> = { ...current }
      update(draft)
      current = draft
      return draft
    },
  }
  let context: ReturnType<typeof useConfig> | undefined

  function Consumer() {
    context = useConfig()
    return <text>{`${context.data.mouse ? "mouse" : "none"} ${context.data.keybinds.get("leader")?.[0]?.key}`}</text>
  }

  const app = await testRender(() => (
    <ConfigProvider config={config} service={service}>
      <Consumer />
    </ConfigProvider>
  ))
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("mouse ctrl+x")
    if (!context) throw new Error("Config context was not provided")
    await context.update((draft) => {
      draft.mouse = false
      draft.keybinds = { leader: "ctrl+o" }
    })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("none ctrl+o")
  } finally {
    app.renderer.destroy()
  }
})
