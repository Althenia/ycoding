import { describe, expect, test } from "bun:test"
import { declarationsWhere, readStylesheet, widthThreshold, type Stylesheet } from "./css-rules"

/**
 * Shared responsive and motion invariants. Source-matched browser comparisons
 * independently verify the displayed Stitch screen compositions.
 *
 * What responds is composition: how many columns a surface has, which rails exist,
 * the inline gutter step, and the display type step. Control height, hit area, body
 * type, the header rows, the measure, and the content max-width are invariants.
 * Breakpoints are absolute steps derived from the minimum usable width of the tracks
 * they hold, so no surface file may invent its own width.
 */

const BREAKPOINTS = [360, 480, 640, 768, 1024, 1280, 1600] as const

const SURFACE_FILES = ["base.css", "site.css", "docs.css", "remote.css"] as const

const STYLESHEETS = [...SURFACE_FILES, "tokens.css"] as const

describe("responsive contract", () => {
  test("uses compact underlined navigation instead of filled rounded tabs", async () => {
    const sheet = await readStylesheet("base.css")
    expect(base(sheet, ".nav__link")).toMatchObject({
      "border-radius": "0",
      "border-block-end": "2px solid transparent",
    })
    expect(base(sheet, ".nav__link--active")).toMatchObject({
      background: "transparent",
      "border-block-end-color": "var(--yc-green-strong)",
    })
  })

  test("uses the shared medium radius for public interactive and raised surfaces", async () => {
    const site = await readStylesheet("site.css")
    const docs = await readStylesheet("docs.css")
    for (const selector of [".marketing .button", ".marketing .card", ".marketing .code-block", ".marketing .input"]) {
      expect(declarationsWhere(site, (rule) => rule.header.includes(selector))["border-radius"]).toBe("var(--yc-radius-md)")
    }
    for (const selector of [
      ".docs-bar__nav-toggle",
      ".docs-search-trigger",
      ".docs--index .doc-section",
      ".docs--index .card",
      ".docs--article .code-block",
      ".releases--timeline .release",
    ]) {
      expect(declarationsWhere(docs, (rule) => rule.header.includes(selector))["border-radius"]).toBe("var(--yc-radius-md)")
    }
  })

  test("uses only the declared breakpoints in every stylesheet", async () => {
    for (const name of STYLESHEETS) {
      const sheet = await readStylesheet(name)
      for (const rule of sheet.rules) {
        for (const condition of rule.conditions) {
          // A keyframes prelude is not a condition on width; only media queries carry
          // a breakpoint that must be declared.
          if (!condition.startsWith("@media")) continue
          for (const feature of condition.replace(/^@media\s+/, "").split(" and ")) {
            if (feature.startsWith("(pointer:") || feature.startsWith("(prefers-")) continue
            const width = feature.match(/^\((min|max)-width: (\d+)px\)$/)
            expect({ name, condition, unrecognized: width === null ? feature : undefined }).toEqual({
              name,
              condition,
              unrecognized: undefined,
            })
            const value = width![1] === "min" ? Number(width![2]) : Number(width![2]) + 1
            expect({ name, condition, feature, declared: (BREAKPOINTS as readonly number[]).includes(value) }).toEqual({
              name,
              condition,
              feature,
              declared: true,
            })
          }
        }
      }
    }
  })

  test("declares the inline gutter step in one place", async () => {
    for (const name of STYLESHEETS) {
      const declaresGutter = Object.keys(declarationsWhere(await readStylesheet(name), () => true)).includes("--yc-gutter")
      expect({ file: name, declaresGutter }).toEqual({ file: name, declaresGutter: name === "tokens.css" })
    }
  })

  test("declares the public column steps at their derived breakpoints", async () => {
    const site = await readStylesheet("site.css")
    expect(columnSteps(site, ".hero__grid")).toEqual([])
    expect(columnSteps(site, ".features__grid")).toEqual([
      { min: 640, tracks: 2 },
      { min: 1280, tracks: 4 },
    ])
    expect(site.rules.filter((rule) => rule.header.includes(".footer__grid"))).toEqual([])
    expect(base(site, ".footer__compact")).toMatchObject({ display: "flex", "flex-wrap": "wrap" })
    expect(columnSteps(site, ".install")).toEqual([{ min: 1024, tracks: 2 }])
  })

  test("keeps the marketing header able to drop its controls, in cost order", async () => {
    const base = await readStylesheet("base.css")
    expect(shownFrom(base, ".nav", 768)).toBe(true)
    expect(hiddenAbove(base, ".app-header__menu", 768)).toBe(true)
    expect(hiddenBelow(base, ".app-header__theme", 480)).toBe(true)
    expect(hiddenBelow(base, ".app-header__cta", 360)).toBe(true)
  })

  test("returns the documentation rail at 1024 and the on-this-page rail at 1280", async () => {
    const docs = await readStylesheet("docs.css")
    expect(columnSteps(docs, ".docs-shell")).toEqual([
      { min: 1024, tracks: 2 },
      { min: 1280, tracks: 3 },
    ])
    expect(shownFrom(docs, ".docs-shell__nav", 1024)).toBe(true)
    expect(shownFrom(docs, ".docs-shell__toc", 1280)).toBe(true)
    expect(hiddenAbove(docs, ".docs-bar__nav-toggle", 1024)).toBe(true)
    expect(hiddenAbove(docs, ".docs-bar__crumbs", 1024)).toBe(true)
    expect(hiddenBelow(docs, ".docs-bar__title", 1024)).toBe(true)
  })

  test("adds only the selected conversation rail at 768 and keeps other screens full-width", async () => {
    const remote = await readStylesheet("remote.css")
    expect(columnSteps(remote, ".workspace")).toEqual([])
    expect(columnSteps(remote, ".app--conversation.app--selected .workspace")).toEqual([{ min: 768, tracks: 2 }])
    expect(shownFrom(remote, ".app--conversation.app--selected .workspace__rail", 768)).toBe(true)
    for (const screen of ["sessions", "activity", "settings", "empty"]) {
      expect(declarationsWhere(remote, (rule) =>
        rule.header.split(",").map((selector) => selector.trim()).includes(`.app--${screen} .workspace__main`),
      )["grid-column"]).toBe("1 / -1")
    }
    expect(shownFrom(remote, ".bottom-nav", 0)).toBe(true)
    expect(hiddenAbove(remote, ".bottom-nav", 768)).toBe(true)
    expect(columnSteps(remote, ".defs__row")).toEqual([{ min: 1024, tracks: 2 }])
  })

  test("keeps compact navigation as the approved grid with item padding and a bottom safe area", async () => {
    const remote = await readStylesheet("remote.css")
    const nav = base(remote, ".bottom-nav")
    const item = base(remote, ".bottom-nav__item")
    expect(nav).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(4, 1fr)",
      "padding-block-end": "env(safe-area-inset-bottom)",
    })
    expect(item).toMatchObject({
      display: "grid",
      "justify-items": "center",
      "min-height": "var(--yc-bottom-nav-h)",
      "padding-block": "8px",
    })
  })

  test("bounds the application shell column to the viewport", async () => {
    const remote = await readStylesheet("remote.css")
    const app = declarationsWhere(remote, (rule) => rule.header === ".app" && rule.conditions.length === 0)
    expect(app["grid-template-columns"]).toBe("minmax(0, 1fr)")
  })
})

describe("motion contract", () => {
  test("collapses animation and transition in one reduced-motion equivalent", async () => {
    const reduceBlocks = (
      await Promise.all(
        SURFACE_FILES.map(async (name) => {
          const sheet = await readStylesheet(name)
          return sheet.rules
            .filter((rule) => rule.conditions.includes("@media (prefers-reduced-motion: reduce)"))
            .map((rule) => ({ file: name, rule }))
        }),
      )
    ).flat()
    expect(reduceBlocks.map((entry) => entry.file)).toEqual(["base.css"])
    // The equivalent is declared on the universal selector, so it is the *lowest*
    // specificity rule in the cascade; without `!important` a class rule's
    // `transition: …` shorthand wins and a visible control keeps its duration.
    expect(reduceBlocks[0]!.rule.declarations).toEqual({
      "animation-name": "none !important",
      "animation-duration": "0s !important",
      "transition-duration": "0s !important",
    })
  })

  test("runs the content entrance only after the first paint and only when motion is accepted", async () => {
    const base = await readStylesheet("base.css")
    const entrances = base.rules.filter(
      (rule) => rule.header.includes(".enter") && rule.declarations["animation"] !== undefined,
    )
    expect(entrances.length).toBeGreaterThan(0)
    for (const rule of entrances) {
      expect({ header: rule.header, conditions: rule.conditions }).toEqual({
        header: rule.header,
        conditions: ["@media (prefers-reduced-motion: no-preference)"],
      })
      expect(rule.header).toContain(':root[data-hydrated="true"]')
    }
  })

  test("moves content in without fading it", async () => {
    const base = await readStylesheet("base.css")
    const step = base.rules.filter((rule) => rule.header === "from" && rule.conditions.includes("@keyframes yc-enter"))
    expect(step.map((rule) => Object.keys(rule.declarations))).toEqual([["translate"]])
  })

  test("never hides content to prepare an animation", async () => {
    // Only an open overlay and its scrim may fade, because an open overlay creates a
    // layer that did not exist before the interaction.
    const overlayFades = ["@keyframes yc-fade-in", "@keyframes yc-dialog-in"]
    for (const name of SURFACE_FILES) {
      const sheet = await readStylesheet(name)
      const zeroOpacity = sheet.rules
        .filter(
          (rule) =>
            rule.declarations["opacity"] === "0" &&
            !rule.conditions.some((condition) => overlayFades.includes(condition)),
        )
        .map((rule) => `${name} ${rule.header}`)
      expect(zeroOpacity).toEqual([])
      const hidden = sheet.rules
        .filter((rule) => rule.declarations["visibility"] === "hidden")
        .map((rule) => `${name} ${rule.header}`)
      // The visually-hidden pattern uses clipping, not visibility, so no rule hides
      // content from assistive technology either.
      expect(hidden).toEqual([])
    }
  })
})

/** Every `min-width` step at which a selector changes its track count, in order. */
function columnSteps(sheet: Stylesheet, selector: string): readonly { readonly min: number; readonly tracks: number }[] {
  return sheet.rules
    .filter(
      (rule) =>
        rule.header === selector &&
        rule.declarations["grid-template-columns"] !== undefined &&
        // The single-column base is the default, not a step.
        rule.conditions.some((condition) => widthThreshold(condition) !== undefined),
    )
    .map((rule) => {
      const min = rule.conditions.map((condition) => widthThreshold(condition)?.min).find((value) => value !== undefined)
      if (min === undefined) throw new Error(`${sheet.name} ${selector} declares tracks outside a width step`)
      return { min, tracks: countTracks(rule.declarations["grid-template-columns"]!) }
    })
}

/** Counts grid tracks, expanding `repeat(n, ...)`. */
function countTracks(value: string): number {
  let index = 0
  let tracks = 0
  while (index < value.length) {
    if (value[index] === " ") {
      index += 1
      continue
    }
    const token = readToken(value, index)
    tracks += token.startsWith("repeat(") ? Number(token.slice("repeat(".length).split(",")[0]) : 1
    index += token.length
  }
  return tracks
}

function readToken(value: string, start: number): string {
  let depth = 0
  let index = start
  while (index < value.length) {
    const character = value[index]!
    if (character === "(") depth += 1
    else if (character === ")") depth -= 1
    else if (character === " " && depth === 0) break
    index += 1
  }
  return value.slice(start, index)
}

function shownFrom(sheet: Stylesheet, selector: string, min: number): boolean {
  const declarations = min === 0 ? base(sheet, selector) : stepped(sheet, selector, min)
  return declarations["display"] !== undefined && declarations["display"] !== "none"
}

function hiddenBelow(sheet: Stylesheet, selector: string, max: number): boolean {
  const declarations = declarationsWhere(
    sheet,
    (rule) =>
      rule.header === selector &&
      rule.conditions.some((condition) => widthThreshold(condition)?.max === max - 1) &&
      rule.declarations["display"] !== undefined,
  )
  return declarations["display"] === "none"
}

function hiddenAbove(sheet: Stylesheet, selector: string, min: number): boolean {
  return stepped(sheet, selector, min)["display"] === "none"
}

function base(sheet: Stylesheet, selector: string) {
  return declarationsWhere(sheet, (rule) => rule.header === selector && rule.conditions.length === 0)
}

function stepped(sheet: Stylesheet, selector: string, min: number) {
  return declarationsWhere(
    sheet,
    (rule) =>
      rule.header === selector && rule.conditions.some((condition) => widthThreshold(condition)?.min === min),
  )
}
