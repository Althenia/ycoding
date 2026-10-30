import { expect, test } from "bun:test"
import { declarationsWhere, parseStylesheet } from "../../styles/css-rules"

test("assistant transcript prose fills the column and user bubbles keep their cap", async () => {
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  const capped = sheet.rules.filter((rule) => rule.header.includes("transcript-md") && Object.values(rule.declarations).some((value) => value.includes("--yc-measure")))
  expect(capped).toEqual([])
  const user = declarationsWhere(sheet, (rule) => rule.header === ".transcript-message--user" && rule.conditions.length === 0)
  expect(user["max-inline-size"]).toBe("min(82%,48ch)")
  expect(user["justify-self"]).toBe("end")
  expect(declarationsWhere(sheet, (rule) => rule.header.includes(".transcript-message--user") && rule.conditions.some((condition) => condition.includes("max-width:767px")))["max-inline-size"]).toBe("90%")
  const receipt = declarationsWhere(sheet, (rule) => rule.header === ".transcript-message__receipt")
  expect(receipt.animation).toBeUndefined()
  expect(receipt.color).toBe("var(--yc-text-muted)")
})

const rulesFor = (sheet: ReturnType<typeof parseStylesheet>, header: string) => declarationsWhere(sheet, (rule) => rule.header === header && rule.conditions.length === 0)

test("a user directive is an unfilled 2px right rule that stays right aligned", async () => {
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  const bubble = rulesFor(sheet, ".transcript-message__bubble")
  expect(bubble["border-inline-end"]).toBe("2px solid var(--yc-green-strong)")
  expect(bubble.background).toBe("transparent")
  expect(bubble.border).toBe("0")
  expect(bubble["border-radius"]).toBe("0")
  expect(rulesFor(sheet, ".transcript-message--user")["justify-self"]).toBe("end")
  expect(rulesFor(sheet, ".transcript-message--user .transcript-message__head")["justify-content"]).toBe("flex-end")
})

test("folio heads use mono type steps and a green ordinal, and annotations stay inline in the one column", async () => {
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  expect(rulesFor(sheet, ".transcript-message__head").font).toBe("var(--yc-size-2xs)/var(--yc-leading-2xs) var(--yc-font-mono)")
  expect(rulesFor(sheet, ".transcript-message__ordinal").color).toBe("var(--yc-green-strong)")
  expect(rulesFor(sheet, ".transcript-message__role")["letter-spacing"]).toBe("var(--yc-tracking-wide)")
  const nav = parseStylesheet("transcript-nav.css", await Bun.file(new URL("./transcript-nav.css", import.meta.url)).text())
  expect(rulesFor(nav, ".transcript-navigation__item[data-entry]")["border-block-start"]).toBe("1px solid var(--yc-border)")
  expect(rulesFor(nav, '.transcript-navigation__item[data-entry][data-index="0"]')["border-block-start"]).toBe("0")
  for (const rule of [...sheet.rules, ...nav.rules]) {
    expect(rule.header).not.toMatch(/margin-column|side-column|__margin|el-margin/)
    expect(Object.keys(rule.declarations)).not.toContain("grid-template-columns:minmax(0,66ch)")
  }
  for (const header of [".transcript-reasoning__body", ".transcript-notice__excerpt", ".transcript-message__system"]) expect(rulesFor(sheet, header)["border-inline-start"]).toBe("1px solid var(--yc-border)")
})

test("request cards flatten to ledger rows while hard review keeps its danger outline and halo", async () => {
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  const flat = rulesFor(sheet, ".conversation-pane .request:not(.request--hard)")
  expect(flat["border-block-start"]).toBe("1px solid var(--yc-border)")
  expect(flat["border-radius"]).toBe("0")
  expect(sheet.rules.filter((rule) => rule.header.includes(".request--hard") && !rule.header.includes(":not(.request--hard)"))).toEqual([])
  const remote = parseStylesheet("remote.css", await Bun.file(new URL("../../styles/remote.css", import.meta.url)).text())
  const hard = rulesFor(remote, ".request--hard")
  expect(hard.border).toBe("2px solid var(--yc-danger)")
  expect(hard["box-shadow"]).toContain("var(--yc-danger)")
})

test("the folio adds no transition, animation, cursor, container query or screen-reader utility", async () => {
  for (const name of ["transcript.css", "transcript-nav.css", "todo-panel.css", "file-change-card.css"]) {
    const source = await Bun.file(new URL(`./${name}`, import.meta.url)).text()
    expect(source).not.toMatch(/@container|cursor:|\.sr-only/)
  }
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  for (const selector of [".transcript-message__head", ".transcript-message__ordinal", ".transcript-message__role", ".transcript-message__bubble"]) {
    expect(sheet.rules.filter((rule) => rule.header === selector && Object.keys(rule.declarations).some((property) => property.startsWith("transition") || property.startsWith("animation")))).toEqual([])
  }
})
