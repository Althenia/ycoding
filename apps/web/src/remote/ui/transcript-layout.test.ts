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

test("a user prompt is a borderless green-soft capsule with a small end-bottom corner that stays right aligned", async () => {
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  const bubble = rulesFor(sheet, ".transcript-message__bubble")
  expect(bubble.border).toBe("0")
  expect(bubble["border-inline-end"]).toBeUndefined()
  expect(bubble["border-radius"]).toBe("var(--yc-radius-xl) var(--yc-radius-xl) var(--yc-radius-sm) var(--yc-radius-xl)")
  expect(bubble.background).toBe("var(--yc-green-soft)")
  expect(bubble.color).toBe("var(--yc-text)")
  expect(bubble.padding).toBe("var(--yc-space-3) var(--yc-space-4)")
  expect(rulesFor(sheet, ".transcript-message--user")["justify-self"]).toBe("end")
  expect(rulesFor(sheet, ".transcript-message__receipt").background).toBe("var(--yc-bg)")
})

test("turn heads use a mono type step with a fixed mark, no ordinal, and annotations stay inline in the one column", async () => {
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  expect(rulesFor(sheet, ".transcript-message__head").font).toBe("var(--yc-size-2xs)/var(--yc-leading-2xs) var(--yc-font-mono)")
  expect(rulesFor(sheet, ".transcript-message__mark")["inline-size"]).toBe("16px")
  expect(sheet.rules.some((rule) => /__ordinal|__role/.test(rule.header))).toBe(false)
  const nav = parseStylesheet("transcript-nav.css", await Bun.file(new URL("./transcript-nav.css", import.meta.url)).text())
  expect(nav.rules.some((rule) => rule.header.includes("data-entry"))).toBe(false)
  for (const rule of [...sheet.rules, ...nav.rules]) {
    expect(rule.header).not.toMatch(/margin-column|side-column|__margin|el-margin/)
    expect(Object.keys(rule.declarations)).not.toContain("grid-template-columns:minmax(0,66ch)")
  }
})

test("tool, reasoning, notice, observation and system annotations are borderless tonal planes and no part keeps a block rule", async () => {
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  for (const header of [".transcript-reasoning, .transcript-tool", ".transcript-notice", ".transcript-message__observation", ".transcript-message__system"]) {
    const plane = rulesFor(sheet, header)
    expect(plane.border).toBe("0")
    expect(plane.background).toBe("var(--yc-surface)")
    expect(plane["border-radius"]).toBe("var(--yc-radius-lg)")
  }
  for (const name of ["transcript.css", "transcript-nav.css", "file-change-card.css", "todo-panel.css", "subagent-bar.css"]) {
    const parsed = parseStylesheet(name, await Bun.file(new URL(`./${name}`, import.meta.url)).text())
    const ruled = parsed.rules.filter((rule) => Object.entries(rule.declarations).some(([property, value]) => /^border-block-(start|end)$/.test(property) && value !== "0" && value !== "none"))
    expect(ruled.map((rule) => rule.header)).toEqual([])
  }
  const card = parseStylesheet("file-change-card.css", await Bun.file(new URL("./file-change-card.css", import.meta.url)).text())
  expect(rulesFor(card, ".file-change-card")).toMatchObject({ border: "0", background: "var(--yc-surface)", "border-radius": "var(--yc-radius-lg)" })
})

test("the todo panel and subagent bar are borderless tonal planes", async () => {
  const todo = parseStylesheet("todo-panel.css", await Bun.file(new URL("./todo-panel.css", import.meta.url)).text())
  expect(rulesFor(todo, ".todo-panel__inner")).toMatchObject({ border: "0", background: "var(--yc-surface)", "border-radius": "var(--yc-radius-lg)" })
  const bar = parseStylesheet("subagent-bar.css", await Bun.file(new URL("./subagent-bar.css", import.meta.url)).text())
  expect(rulesFor(bar, ".subagent-bar")).toMatchObject({ border: "0", background: "var(--yc-surface)", "border-radius": "var(--yc-radius-lg)" })
})

test("pending requests float as raised planes while hard review keeps its danger outline and halo", async () => {
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  const plane = rulesFor(sheet, ".conversation-pane .request:not(.request--hard)")
  expect(plane).toMatchObject({ background: "var(--yc-surface-raised)", border: "1px solid var(--yc-border)", "border-radius": "var(--yc-radius-lg)", "box-shadow": "var(--yc-shadow-sm)", padding: "var(--yc-space-4)" })
  const recorded = rulesFor(sheet, ".conversation-pane .transcript .request:not(.request--hard)")
  expect(recorded).toMatchObject({ border: "0", "box-shadow": "none", background: "var(--yc-surface)", "border-radius": "var(--yc-radius-lg)" })
  expect(plane.border).toBe("1px solid var(--yc-border)")
  expect(plane["box-shadow"]).toBe("var(--yc-shadow-sm)")
  expect(sheet.rules.filter((rule) => rule.header.includes(".request--hard") && !rule.header.includes(":not(.request--hard)"))).toEqual([])
  const remote = parseStylesheet("remote.css", await Bun.file(new URL("../../styles/remote.css", import.meta.url)).text())
  const hard = rulesFor(remote, ".request--hard")
  expect(hard.border).toBe("2px solid var(--yc-danger)")
  expect(hard["box-shadow"]).toContain("var(--yc-danger)")
})

test("the transcript adds no cursor, container query or screen-reader utility and its head, mark and bubble add no motion", async () => {
  for (const name of ["transcript.css", "transcript-nav.css", "todo-panel.css", "file-change-card.css"]) {
    const source = await Bun.file(new URL(`./${name}`, import.meta.url)).text()
    expect(source).not.toMatch(/@container|cursor:|\.sr-only/)
  }
  const sheet = parseStylesheet("transcript.css", await Bun.file(new URL("./transcript.css", import.meta.url)).text())
  for (const selector of [".transcript-message__head", ".transcript-message__mark", ".transcript-message__bubble"]) {
    expect(sheet.rules.filter((rule) => rule.header === selector && Object.keys(rule.declarations).some((property) => property.startsWith("transition") || property.startsWith("animation")))).toEqual([])
  }
})
