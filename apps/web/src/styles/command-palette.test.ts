import { describe, expect, test } from "bun:test"
import { declarationsWhere, parseStylesheet, readStylesheet, type Stylesheet } from "./css-rules"

const BREAKPOINTS = [360, 480, 640, 768, 1024, 1280, 1600] as const
const PHONE_LAYOUT_QUERY = "@media (max-width: 767px), (max-height: 599px) and (pointer: coarse)"

async function readPalette(): Promise<{ readonly sheet: Stylesheet; readonly source: string }> {
  const source = await Bun.file(new URL("../remote/ui/command-palette.css", import.meta.url)).text()
  return { sheet: parseStylesheet("command-palette.css", source), source }
}

const inCondition = (sheet: Stylesheet, selector: string, condition: string) =>
  declarationsWhere(sheet, (rule) => rule.header === selector && rule.conditions.includes(condition))
const base = (sheet: Stylesheet, selector: string) =>
  declarationsWhere(sheet, (rule) => rule.header === selector && rule.conditions.length === 0)

describe("command palette stylesheet", () => {
  test("rows are at least the touch hit area and the active row pairs the green fill with its edge", async () => {
    const { sheet } = await readPalette()
    expect(base(sheet, ".command-palette__option")["min-block-size"]).toBe("var(--yc-hit-min)")
    expect(base(sheet, ".command-palette__search")["min-block-size"]).toBe("var(--yc-hit-min)")
    expect(base(sheet, ".command-palette__option[data-active]")).toMatchObject({
      background: "var(--yc-green-soft)",
      "border-inline-start-color": "var(--yc-green-strong)",
    })
  })

  test("the list is the only scroller and the search field stays above it", async () => {
    const { sheet } = await readPalette()
    expect(base(sheet, ".command-palette")).toMatchObject({ display: "grid", "grid-template-rows": "auto minmax(0, 1fr)", overflow: "hidden" })
    expect(base(sheet, ".command-palette__list")).toMatchObject({ "overflow-y": "auto", "overscroll-behavior": "contain", "min-block-size": "0" })
  })

  test("from 768px the palette is a bounded dialog with a fixed height", async () => {
    const { sheet } = await readPalette()
    const dialog = inCondition(sheet, ".overlay--command-palette .overlay__surface", "@media (min-width: 768px)")
    expect(dialog["inline-size"]).toBe("min(640px, calc(100vw - 2 * var(--yc-gutter)))")
    expect(dialog["block-size"]).toBe("min(520px, 80vh)")
  })

  test("on the phone layout the palette is a full-viewport sheet that follows the visual viewport", async () => {
    const { sheet } = await readPalette()
    const surface = inCondition(sheet, ".overlay--command-palette .overlay__surface", PHONE_LAYOUT_QUERY)
    expect(surface).toMatchObject({
      "inset-block-start": "var(--command-palette-top, 0px)",
      "inset-block-end": "auto",
      "inset-inline": "0",
      translate: "none",
      "inline-size": "100%",
      "block-size": "var(--command-palette-height, 100dvh)",
      "max-block-size": "none",
      "border-radius": "0",
    })
    expect(surface["block-size"]).not.toContain("100vh")
    expect(inCondition(sheet, ".command-palette__description", PHONE_LAYOUT_QUERY)).toMatchObject({ "flex-basis": "100%", "white-space": "normal" })
  })

  test("the header trigger outranks the narrow-phone rule that hides secondary header controls", async () => {
    const { sheet } = await readPalette()
    const remote = await readStylesheet("remote.css")
    const hides = remote.rules.find((rule) => rule.header === ".app .app-header__end > :not(.yc-notification-center, .app-header__team)" && rule.conditions.includes("@media (max-width: 479px)"))
    expect(hides?.declarations.display).toBe("none")
    expect(inCondition(sheet, ".app .app-header__end > button.app-header__palette", "@media (max-width: 479px)").display).toBe("inline-flex")
  })

  test("only declared breakpoints, and colors come from tokens", async () => {
    const { sheet, source } = await readPalette()
    for (const rule of sheet.rules) {
      for (const condition of rule.conditions) {
        if (condition === PHONE_LAYOUT_QUERY) continue
        const width = condition.match(/^@media \((min|max)-width: (\d+)px\)$/)
        expect({ condition, parsed: width !== null }).toEqual({ condition, parsed: true })
        const value = width![1] === "min" ? Number(width![2]) : Number(width![2]) + 1
        expect({ condition, declared: (BREAKPOINTS as readonly number[]).includes(value) }).toEqual({ condition, declared: true })
      }
    }
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })
})
