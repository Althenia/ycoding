import { expect, test } from "bun:test"
import { declarationsWhere, readStylesheet } from "../../styles/css-rules"
import { autonomyPhoneWord, goalControlExpanded } from "./status-bar"

const phone = "@media (max-width: 767px)"
const sheet = await readStylesheet("../remote/ui/status-bar.css")
const source = await Bun.file(new URL("./status-bar.tsx", import.meta.url)).text()
const phoneRule = (header: string) => declarationsWhere(sheet, (rule) => rule.header === header && rule.conditions.includes(phone))
const metadataRule = (header: string) => phoneRule(`:is(.composer__summary, .session-status--metadata) ${header}`)
const baseRule = (header: string) => declarationsWhere(sheet, (rule) => rule.header === header && rule.conditions.length === 0)

test("the phone autonomy word is the shared effective mode word, or Mixed when categories differ", () => {
  expect(autonomyPhoneWord({ permissions: "manual", guardrails: "manual", answers: "manual" })).toBe("Manual")
  expect(autonomyPhoneWord({ permissions: "yolo", guardrails: "yolo", answers: "yolo" })).toBe("YOLO")
  expect(autonomyPhoneWord({ permissions: "auto", guardrails: "auto", answers: "auto" })).toBe("Auto")
  expect(autonomyPhoneWord({ permissions: "auto", guardrails: "manual", answers: "manual" })).toBe("Mixed")
  expect(autonomyPhoneWord({ permissions: "manual", guardrails: "yolo", answers: "auto" })).toBe("Mixed")
})

test("no status control renders a category code or compact autonomy glyphs", () => {
  expect(source).not.toMatch(/mode-compact|autonomous-compact|summary\(\)\.compact|compact:/)
  expect(sheet.rules.some((rule) => /mode-compact|autonomous-compact/.test(rule.header))).toBe(false)
})

test("status chips and the autonomy and goal controls wrap at every width instead of clipping", () => {
  expect(baseRule(".session-status")["flex-wrap"]).toBe("wrap")
  expect(baseRule(".session-status__modes")["flex-wrap"]).toBe("wrap")
  expect(sheet.rules.some((rule) => rule.conditions.some((condition) => condition.includes("479px")) && /session-status__mode|autonomous-full/.test(rule.header))).toBe(false)
})

test("below 768px the autonomy control reads as an icon with one effective word and keeps a 44px target", () => {
  expect(baseRule(".session-status__autonomous-word")).toMatchObject({ display: "none" })
  expect(baseRule(".session-status__autonomous-icon")).toMatchObject({ display: "none" })
  expect(phoneRule(".session-status__autonomous-word")).toMatchObject({ display: "inline" })
  expect(phoneRule(".session-status__autonomous-icon")).toMatchObject({ display: "block" })
  expect(phoneRule(".session-status__autonomous-full")).toMatchObject({ display: "none" })
  const targets = declarationsWhere(sheet, (rule) => rule.conditions.includes(phone) && /session-status__autonomous-trigger/.test(rule.header) && /session-status__goal-trigger/.test(rule.header))
  expect(targets["min-block-size"]).toBe("var(--yc-hit-min)")
  expect(targets["min-inline-size"]).toBe("var(--yc-hit-min)")
})

test("below 768px mode, sleep and review chips and the active goal take full-width lines in readable words", () => {
  expect(phoneRule(".composer__summary > .session-status")).toMatchObject({ display: "contents" })
  expect(metadataRule(".session-status__modes")).toMatchObject({ flex: "1 1 auto", order: "2" })
  expect(metadataRule(".session-status__active-goal")).toMatchObject({ flex: "1 1 100%", order: "3", "max-inline-size": "none" })
  expect(metadataRule(".session-status__mode")["min-block-size"]).toBe("28px")
})

test("the phone Goal control opens a focus-contained sheet while wider widths keep the anchored popover", () => {
  expect(source).toContain("<Modal")
  expect(source).toContain("session-status__goal-sheet")
  expect(source).toContain("session-status__goal-popover")
  expect(source).toContain("(max-width: 767px)")
  expect(declarationsWhere(sheet, (rule) => rule.header.includes(".session-status__goal-sheet") && rule.header.includes("input"))["min-block-size"]).toBe("var(--yc-hit-min)")
})

test("the Goal control reports expanded while either its popover or its phone sheet is open", () => {
  expect(goalControlExpanded({ popover: false, leaving: false, sheet: false })).toBe(false)
  expect(goalControlExpanded({ popover: true, leaving: false, sheet: false })).toBe(true)
  expect(goalControlExpanded({ popover: true, leaving: true, sheet: false })).toBe(false)
  expect(goalControlExpanded({ popover: false, leaving: false, sheet: true })).toBe(true)
  expect(source).toContain("aria-expanded={goalControlExpanded(")
})

test("the status group sits inline in the composer chip row", () => {
  expect(baseRule(".composer__controls .session-status")).toMatchObject({ flex: "0 1 auto", order: "0", "padding-block-start": "0" })
  expect(baseRule(".session-status")).toMatchObject({ flex: "0 1 auto", "min-inline-size": "0" })
  expect(baseRule(".composer__controls .session-status__active-goal")).toMatchObject({ flex: "1 1 16ch", "max-inline-size": "48ch" })
  expect(sheet.rules.some((rule) => rule.header.includes(".composer__dock .session-status"))).toBe(false)
})

test("the phone Goal control keeps one width whether or not it shows an iteration count", () => {
  expect(phoneRule(".session-status__goal-trigger")["min-inline-size"]).toBe("4rem")
  expect(baseRule(".session-status__autonomous-trigger,.session-status__goal-trigger")["padding-inline"]).toBe("var(--yc-space-2)")
})

test("the status group carries no transient status slot and an in-flight goal shows its progress inside the Goal control", () => {
  expect(source).not.toMatch(/session-status__slot|goal-setting/)
  expect(sheet.rules.some((rule) => /session-status__slot|goal-setting/.test(rule.header))).toBe(false)
  expect(baseRule('.session-status__goal-trigger[aria-busy="true"] > :not(.session-status__goal-progress)')).toMatchObject({ visibility: "hidden" })
  expect(baseRule(".session-status__goal-progress")).toMatchObject({ position: "absolute", inset: "0" })
})

test("metadata relocated into the conversation retains full wrapping words without another scroller", () => {
  expect(baseRule(".session-status--metadata :is(.session-status__mode,.session-status__mode-full,.session-status__active-goal)")).toMatchObject({ "min-inline-size":"0", overflow:"visible", "overflow-wrap":"anywhere", "white-space":"normal" })
  expect(baseRule(".session-status--metadata .session-status__active-goal")).toMatchObject({ flex:"1 1 100%", "max-inline-size":"none" })
})

test("the Autonomous and Goal controls are pills without an inline-start bar or inner rule", () => {
  expect(baseRule(".session-status__autonomous-trigger,.session-status__goal-trigger")).toMatchObject({ border: "0", "border-radius": "var(--yc-radius-pill)" })
  expect(sheet.rules.some((rule) => Object.keys(rule.declarations).some((property) => property === "border-inline-start" || property === "border-inline-start-color"))).toBe(false)
  expect(baseRule(".composer__controls .session-status")["border-block-start"]).toBeUndefined()
})

test("the Autonomous control is a neutral tonal pill and an active or setting Goal reads as live signal", () => {
  expect(baseRule(".session-status__autonomous-trigger,.session-status__goal-trigger")).toMatchObject({ background: "var(--yc-surface-sunken)", color: "var(--yc-text)" })
  expect(baseRule(".session-status__goal-trigger--active")).toMatchObject({ background: "var(--yc-surface-sunken)", color: "var(--yc-signal)" })
  expect(baseRule(":is(.session-status__goal-popover,.session-status__goal-sheet) button")).toBeDefined()
})
