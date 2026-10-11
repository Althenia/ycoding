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
