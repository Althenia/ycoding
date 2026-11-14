import { expect, test } from "bun:test"
import { declarationsWhere, parseStylesheet } from "../../styles/css-rules"

const composer = await Bun.file(new URL("./composer.css", import.meta.url)).text().then((source) => parseStylesheet("composer.css", source))
const base = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.length === 0)
const wide = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.includes("@media (min-width: 768px)"))
const fine = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.includes("@media (min-width: 768px) and (pointer: fine)"))

test("explicit motion off stops reasoning sparkles", () => {
  expect(base(':root[data-motion="off"] .model-control__sparkles, :root[data-motion="off"] .model-control__sparkles i').animation).toBe("none")
})

test("the expanded dock follows the floating card at its end edge and the collapsed handle is a raised floating pill in flow", () => {
  expect(base(".composer")).toMatchObject({ display: "flex", "flex-direction": "column" })
  expect(base(".composer__dock")).toMatchObject({ position: "static", order: "1", "align-self": "end" })
  expect(base(".composer__dock").position).not.toBe("absolute")
  expect(base(".composer--collapsed .composer__dock")).toMatchObject({
    position: "relative",
    order: "0",
    "align-self": "stretch",
    "min-block-size": "var(--yc-hit-min)",
    border: "1px solid var(--yc-border-strong)",
    "border-radius": "var(--yc-radius-xl)",
    background: "var(--yc-surface-raised)",
    "box-shadow": "var(--yc-shadow-md)",
  })
  expect(base(".composer__dock-toggle")).toMatchObject({ "min-inline-size": "var(--yc-hit-min)", "min-block-size": "var(--yc-hit-min)" })
})

test("the composer is one flat rounded card whose borderless draft sits above a chip bar and whose border carries focus", () => {
  expect(base(".composer .composer__row")).toMatchObject({
    padding: "var(--yc-space-2) var(--yc-space-3)",
    border: "1px solid var(--yc-border-strong)",
    "border-radius": "var(--yc-radius-xl)",
    background: "var(--yc-surface)",
    "box-shadow": "none",
  })
  expect(composer.rules.some((rule) => rule.header.includes('[data-theme="dark"] .composer .composer__row'))).toBe(false)
  expect(base(".composer .composer__row:has(.composer__input:focus)")["border-color"]).toBe("var(--yc-signal)")
  expect(base(".mini-composer__input-wrap")).toMatchObject({ border: "0", "border-radius": "0", background: "transparent", padding: "0" })
  expect(composer.rules.some((rule) => rule.header.includes(".mini-composer__input-wrap:focus-within"))).toBe(false)
  expect(base(".composer__input, .composer__input:focus-visible")).toMatchObject({ border: "0", background: "transparent", "box-shadow": "none" })
  expect(wide(".composer .composer__row")).toMatchObject({ gap: "10px", padding: "var(--yc-space-3) 14px" })
  expect(wide(".composer .composer__controls")["padding-block-start"]).toBe("0")
})

test("the attachment disclosure stays available to assistive technology without showing inside the card, and composer controls carry no native tooltips", () => {
  expect(source).toContain('class="composer__attachment-disclosure visually-hidden"')
  expect(composer.rules.some((rule) => rule.header.includes("composer__attachment-disclosure"))).toBe(false)
  expect(source).toContain('aria-description="Attaches files chosen in this browser')
  expect(source).toContain('<Icon name="paperclip" size={16} />')
  expect(source).not.toMatch(/\stitle=/)
})

test("wide chip bar reads attach, agent, model and effort as six-pixel mono chips beside a brand send circle", () => {
  const chips = ".composer .composer__controls :is(.model-control__trigger, .mini-picker__trigger, .composer__effort)"
  expect(wide(chips)).toMatchObject({ "border-radius": "var(--yc-radius-sm)", border: "1px solid var(--yc-border)", background: "var(--yc-surface-sunken)", font: "var(--yc-weight-regular) var(--yc-size-2xs)/var(--yc-leading-2xs) var(--yc-font-mono)" })
  expect(fine(chips)).toMatchObject({ "block-size": "28px", "min-block-size": "28px" })
  expect(fine(".composer .composer__controls :is(.mini-composer__send, .mini-composer__interrupt)")).toMatchObject({ "inline-size": "28px", "block-size": "28px" })
  expect(fine(".composer .composer__controls :is(.composer__attach, .composer__delivery-toggle, .composer__context-trigger)")).toMatchObject({ "inline-size": "24px", "block-size": "24px" })
  expect(wide(".composer .composer__controls").gap).toBe("6px")
  expect(wide(chips)["padding-inline"]).toBe("6px")
  expect(wide(".composer .composer__controls .mini-picker__trigger > svg:first-child:not(:last-child)").display).toBe("none")
  expect(composer.rules.some((rule) => rule.header === ".composer .composer__row" && Object.keys(rule.declarations).some((property) => property.startsWith("transition")))).toBe(false)
  expect(base(".composer__attach")).toMatchObject({ background: "transparent", color: "var(--yc-text-muted)" })
  expect(base(".mini-composer__send")).toMatchObject({ background: "var(--yc-primary-bg)", color: "var(--yc-primary-fg)" })
  expect(base(".mini-composer__send:disabled").opacity).toBe(".45")
  expect(wide(".composer__spacer").flex).toBe("1 1 0")
  expect(base(".composer__effort-panel .reasoning-effort")["max-inline-size"]).toBe("20rem")
  const controls = source.slice(source.indexOf('class="composer__attach"'))
  const order = ['label="Agent"', "<ModelControl", 'class="composer__effort"', 'class="composer__context"'].map((marker) => controls.indexOf(marker))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect([...order].sort((left, right) => left - right)).toEqual(order)
})

test("at fine-pointer desktop widths the expanded dock takes no row: the transparent hide control rests in the composer's top-end gutter and an empty prediction slot collapses", () => {
  const desk = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.includes("@media (min-width: 1024px) and (pointer: fine)"))
  const hidden = desk(".composer:not(.composer--collapsed) .composer__dock-toggle:not(:focus-visible), .app--conversation.app--selected .workspace__main > .composer-resident:not(.route-panel--idle) .composer:not(.composer--collapsed) .composer__dock-toggle:not(:focus-visible)")
  expect(hidden).toMatchObject({ position: "absolute", "inset-block-start": "0", "inset-inline-end": "0", "z-index": "3", "inline-size": "24px", "block-size": "24px", "min-inline-size": "24px", "min-block-size": "24px", opacity: "0", margin: "0", padding: "0", border: "0" })
  expect(hidden["pointer-events"]).toBeUndefined()
  expect(hidden["clip-path"]).toBeUndefined()
  expect(desk(".composer:not(.composer--collapsed) .composer__prediction-slot:not(:has(.composer__use-prediction))").display).toBe("none")
})

test("content-level light-mode pickers keep their strong outline while attach stays borderless", () => {
  const light = declarationsWhere(composer, (rule) => rule.header.includes(':root[data-theme="light"] .mini-picker__trigger'))
  expect(light["border-color"]).toBe("var(--yc-border-strong)")
  expect(composer.rules.some((rule) => rule.header.includes(':root[data-theme="light"] .composer__attach'))).toBe(false)
})

test("pickers, summary trigger and action buttons are pills", () => {
  for (const header of [".mini-picker__trigger,.model-control__trigger", ".composer__mobile-trigger", ".composer__attach,.composer__delivery-toggle,.mini-composer__send,.mini-composer__interrupt"]) {
    expect({ header, radius: base(header)["border-radius"] }).toEqual({ header, radius: "var(--yc-radius-pill)" })
  }
})

test("below 768px the floating card keeps an 8px inset from the scroller edges and the safe area", () => {
  expect(phoneRule(".composer")["padding"]).toBe("0 var(--yc-space-2) max(var(--yc-space-2), env(safe-area-inset-bottom))")
  expect(base(".composer__controls").padding).toBe("var(--yc-space-1) 0 0")
})

test("in a selected conversation the composer floats over the transcript, which scrolls beneath it to a measured reserve", () => {
  const floating = ".app--conversation.app--selected .workspace__main > .composer-resident:not(.route-panel--idle)"
  expect(base(floating)).toMatchObject({ "z-index": "2", "pointer-events": "none" })
  expect(base(".composer-resident .composer > *")["pointer-events"]).toBe("auto")
  expect(base(`${floating} .composer`).background).toBeUndefined()
  expect(base(`${floating} .composer:not(.composer--collapsed) .composer__dock-toggle`)).toMatchObject({ "border-radius": "var(--yc-radius-pill)", background: "var(--yc-surface-raised)" })
  expect(source).toContain("--yc-composer-reserve")
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

test("below 768px the card puts the summary on its own wrapping line above the draft, with attach and the end-aligned primary actions on one line below it", () => {
  expect(phoneRule(".composer--phone-summary .composer__row")).toMatchObject({ "flex-direction": "row", "flex-wrap": "wrap" })
  expect(phoneRule(".composer--phone-summary .composer__body")).toMatchObject({ flex: "1 1 100%", "min-inline-size": "0" })
  expect(phoneRule(".composer--phone-summary .composer__controls").display).toBe("contents")
  expect(phoneRule(".composer--phone-summary .composer__summary")).toMatchObject({ display: "flex", flex: "1 1 100%", "flex-wrap": "wrap", order: "-1", "min-inline-size": "0" })
  expect(phoneRule(".composer--phone-summary .composer__actions")["margin-inline-start"]).toBe("auto")
  expect(phoneRule(".composer--phone-summary .composer__control-set > :is(.mini-picker, .model-control, .composer__context, .composer__speed, .composer__spacer, .composer__effort)")).toMatchObject({ display: "none" })
  expect(composer.rules.some((rule) => rule.conditions.some((condition) => condition.includes("479px")) && rule.header.includes(".mini-composer__mount"))).toBe(false)
})

test("tablet widths narrow the identity pickers so the action buttons stay on the first control line", () => {
  const band = "@media (min-width: 768px) and (max-width: 1199px)"
  const pick = (header: string) => declarationsWhere(composer, (rule) => rule.header === header && rule.conditions.includes(band))
  expect(pick(".mini-composer__mount .composer__controls .mini-picker__trigger")["max-inline-size"]).toBe("7rem")
  expect(pick(".mini-composer__mount .composer__controls .model-control__trigger")["max-inline-size"]).toBe("10rem")
})
