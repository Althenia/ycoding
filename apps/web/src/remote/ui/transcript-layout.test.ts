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
