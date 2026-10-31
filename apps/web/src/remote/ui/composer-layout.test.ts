import { expect, test } from "bun:test"
import { declarationsWhere, parseStylesheet } from "../../styles/css-rules"

const composer = await Bun.file(new URL("./composer.css", import.meta.url)).text().then((source) => parseStylesheet("composer.css", source))
const base = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.length === 0)

test("the expanded dock follows the capsule at its end edge and the collapsed handle stays in flow", () => {
  expect(base(".composer")).toMatchObject({ display: "flex", "flex-direction": "column" })
  expect(base(".composer__dock")).toMatchObject({ position: "static", order: "1", "align-self": "end" })
  expect(base(".composer__dock").position).not.toBe("absolute")
  expect(base(".composer--collapsed .composer__dock")).toMatchObject({
    position: "relative",
    order: "0",
    "align-self": "stretch",
    "min-block-size": "var(--yc-hit-min)",
    border: "0",
    background: "var(--yc-surface)",
  })
  expect(base(".composer__dock-toggle")).toMatchObject({ "min-inline-size": "var(--yc-hit-min)", "min-block-size": "var(--yc-hit-min)" })
})

test("the composer is one raised capsule whose field is borderless and transparent", () => {
  expect(base(".composer .composer__row")).toMatchObject({
    padding: "var(--yc-space-2)",
    border: "1px solid var(--yc-border-strong)",
    "border-radius": "var(--yc-radius-xl)",
    background: "var(--yc-surface-raised)",
    "box-shadow": "var(--yc-shadow-md)",
  })
  expect(base('[data-theme="dark"] .composer .composer__row')["border-color"]).toBe("var(--yc-border)")
  expect(base(".composer__input, .composer__input:hover, .composer__input:focus-visible")).toMatchObject({ border: "0", background: "transparent" })
  expect(base(".composer .composer__row:focus-within")["border-color"]).toBe("var(--yc-focus)")
})

test("content-level light-mode pickers and attach keep their strong outline", () => {
  const light = declarationsWhere(composer, (rule) => rule.header.includes(':root[data-theme="light"] .mini-picker__trigger'))
  expect(light["border-color"]).toBe("var(--yc-border-strong)")
  const attach = declarationsWhere(composer, (rule) => rule.header.includes(':root[data-theme="light"] .composer__attach'))
  expect(attach.border).toBe("var(--yc-border-width) solid var(--yc-border-strong)")
})

test("pickers, summary trigger and action buttons are pills", () => {
  for (const header of [".mini-picker__trigger,.model-control__trigger", ".composer__mobile-trigger", ".composer__attach,.composer__delivery-toggle,.mini-composer__send,.mini-composer__interrupt"]) {
    expect({ header, radius: base(header)["border-radius"] }).toEqual({ header, radius: "var(--yc-radius-pill)" })
  }
})

test("below 768px the capsule carries no padding of its own and the dock keeps a 4px side inset so the compact budget holds", () => {
  expect(phoneRule(".composer")["padding"]).toBe("0 var(--yc-space-1) max(var(--yc-space-1), env(safe-area-inset-bottom))")
  expect(phoneRule(".composer .composer__row").padding).toBe("0")
  expect(base(".composer__controls").padding).toBe("var(--yc-space-2) 0")
})

const landscape = "@media (max-height: 599px) and (pointer: coarse) and (orientation: landscape)"
const landscapeRule = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.includes(landscape))

test("a coarse landscape phone puts the capsule and the dock toggle on one row and drops the extra dock chrome", () => {
  expect(landscapeRule(".composer:not(.composer--collapsed)")).toMatchObject({ display: "grid", "grid-template-columns": "minmax(0,1fr) auto" })
  expect(landscapeRule(".composer:not(.composer--collapsed) .composer__row")).toMatchObject({ "flex-direction": "row", "grid-column": "1" })
  expect(landscapeRule(".composer:not(.composer--collapsed) .composer__dock")).toMatchObject({ "grid-column": "2", order: "0" })
  expect(landscapeRule(".composer:not(.composer--collapsed) .composer__prediction-slot, .composer:not(.composer--collapsed) .composer__speed").display).toBe("none")
  expect(landscapeRule(".composer:not(.composer--collapsed) .composer__dock-toggle > span").display).toBe("none")
  expect(landscapeRule(".composer:not(.composer--collapsed) .composer__input")["max-block-size"]).toBe("25dvh")
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
