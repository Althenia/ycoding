import { expect, test } from "bun:test"
import { declarationsWhere, parseStylesheet } from "../../styles/css-rules"

const composer = await Bun.file(new URL("./composer.css", import.meta.url)).text().then((source) => parseStylesheet("composer.css", source))
const base = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.length === 0)

test("the expanded dock is a row above the field and the collapsed handle stays in flow", () => {
  expect(base(".composer")).toMatchObject({ display: "flex", "flex-direction": "column" })
  expect(base(".composer__dock")).toMatchObject({ position: "static", order: "-1", "align-self": "end" })
  expect(base(".composer__dock").position).not.toBe("absolute")
  expect(base(".composer--collapsed .composer__dock")).toMatchObject({
    position: "relative",
    order: "0",
    "align-self": "stretch",
    "min-block-size": "var(--yc-hit-min)",
  })
})

test("an open keyboard lifts the composer by the shell inset and drops the safe-area pad", () => {
  const lifted = declarationsWhere(composer, (rule) => rule.header === ":is(:root, .app)[data-keyboard-open] .composer")
  expect(lifted["margin-block-end"]).toBe("var(--yc-keyboard-inset, 0px)")
  expect(lifted["padding-block-end"]).toBe("var(--yc-space-1)")
  expect(lifted["padding-block-end"]).not.toContain("safe-area-inset-bottom")
})

const phone = "@media (max-width: 767px)"
const phoneRule = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.includes(phone))
const source = await Bun.file(new URL("./composer.tsx", import.meta.url)).text()

test("the agent and model summary lives inside the phone card and is hidden from tablet width up", () => {
  expect(base(".composer__mobile-trigger").display).toBe("none")
  expect(phoneRule(".composer__mobile-trigger")).toMatchObject({ display: "flex", "min-block-size": "var(--yc-hit-min)" })
  expect(base(".composer__summary").display).toBe("contents")
  expect(source).toContain("phoneSummary")
  expect(source).not.toContain("mobileMount")
  expect(composer.rules.some((rule) => rule.header.includes("composer__mobile-identity"))).toBe(false)
})

test("tablet and desktop controls wrap rather than clip", () => {
  expect(base(".composer .composer__controls")["flex-wrap"]).toBe("wrap")
  expect(composer.rules.some((rule) => rule.declarations["flex-wrap"] === "nowrap" && rule.header.includes("composer__controls"))).toBe(false)
})

test("below 768px the card stacks summary, draft and primary actions with no clipped strip", () => {
  expect(phoneRule(".composer--phone-summary .composer__controls")).toMatchObject({ display: "contents" })
  expect(phoneRule(".composer--phone-summary .composer__summary")).toMatchObject({ display: "flex", "flex-wrap": "wrap", order: "-1" })
  expect(phoneRule(".composer--phone-summary .composer__actions")).toMatchObject({ order: "1", "inline-size": "100%" })
  expect(phoneRule(".composer--phone-summary .composer__control-set > :is(.mini-picker, .model-control, .composer__context, .composer__speed, .composer__spacer)")).toMatchObject({ display: "none" })
  expect(phoneRule(".composer--phone-summary .composer__attach + .composer__delivery-toggle")["margin-inline-end"]).toBe("auto")
  expect(composer.rules.some((rule) => rule.conditions.some((condition) => condition.includes("479px")) && rule.header.includes(".mini-composer__mount"))).toBe(false)
})

test("tablet widths narrow the identity pickers so the action buttons stay on the first control line", () => {
  const band = "@media (min-width: 768px) and (max-width: 1199px)"
  const pick = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.includes(band))
  expect(pick(".mini-composer__mount .composer__controls .mini-picker__trigger")["max-inline-size"]).toBe("7rem")
  expect(pick(".mini-composer__mount .composer__controls .model-control__trigger")["max-inline-size"]).toBe("10rem")
})
