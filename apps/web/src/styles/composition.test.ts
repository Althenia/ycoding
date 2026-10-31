import { describe, expect, test } from "bun:test"
import { declarationsWhere, readStylesheet, widthThreshold, type Stylesheet } from "./css-rules"

/**
 * Shared responsive and motion invariants. Rendered browser suites under `verify`
 * independently verify the displayed screen compositions.
 *
 * What responds is composition: how many columns a surface has, which rails exist,
 * the inline gutter step, and the display type step. Control height, hit area, body
 * type, the header rows, the measure, and the content max-width are invariants.
 * Breakpoints are absolute steps derived from the minimum usable width of the tracks
 * they hold, so no surface file may invent its own width.
 */

const BREAKPOINTS = [360, 480, 640, 768, 1024, 1280, 1600] as const
const PHONE_LAYOUT_QUERY = "@media (max-width: 767px), (max-height: 599px) and (pointer: coarse)"
const COARSE_LANDSCAPE_QUERY = "@media (max-height: 599px) and (pointer: coarse) and (orientation: landscape)"

const SURFACE_FILES = ["base.css", "site.css", "docs.css", "remote.css"] as const

const STYLESHEETS = [...SURFACE_FILES, "tokens.css"] as const

describe("responsive contract", () => {
  test("uses pill navigation with a soft current state and no bottom rule", async () => {
    const sheet = await readStylesheet("base.css")
    expect(base(sheet, ".nav__link")).toMatchObject({
      "border-radius": "var(--yc-radius-pill)",
      "border-block-end": "0",
    })
    expect(base(sheet, ".nav__link:hover").background).toBe("var(--yc-surface)")
    expect(base(sheet, ".nav__link--active")).toMatchObject({
      background: "var(--yc-green-soft)",
      color: "var(--yc-green-strong)",
      "font-weight": "var(--yc-weight-semibold)",
    })
  })

  test("assigns Spatial Canvas radii: controls medium, tonal planes large, trust strip extra large, nav pills", async () => {
    const site = await readStylesheet("site.css")
    const docs = await readStylesheet("docs.css")
    const radii: readonly (readonly [Stylesheet, string, string])[] = [
      [site, ".marketing .button", "md"],
      [site, ".marketing .code-block", "md"],
      [site, ".marketing .input", "md"],
      [site, ".marketing .card", "lg"],
      [site, ".marketing .callout-bar", "lg"],
      [site, ".marketing .feature", "lg"],
      [site, ".marketing .trust__item", "xl"],
      [docs, ".docs-bar__nav-toggle", "pill"],
      [docs, ".docs-search-trigger", "pill"],
      [docs, ".docs--index .doc-section", "md"],
      [docs, ".docs--index .card", "lg"],
      [docs, ".docs--article .code-block", "md"],
      [docs, ".releases--timeline .release", "lg"],
    ]
    for (const [sheet, selector, step] of radii) {
      expect({ selector, radius: declarationsWhere(sheet, (rule) => rule.header.includes(selector))["border-radius"] }).toEqual({ selector, radius: `var(--yc-radius-${step})` })
    }
  })

  test("de-boxes public content: borderless tonal planes and open feature columns", async () => {
    const base_ = await readStylesheet("base.css")
    const site = await readStylesheet("site.css")
    const docs = await readStylesheet("docs.css")
    const frameless = (sheet: Stylesheet, selector: string) => {
      const merged = declarationsWhere(sheet, (rule) => rule.header === selector && rule.conditions.length === 0)
      expect({ selector, border: merged.border ?? "0" }).toEqual({ selector, border: "0" })
      return merged
    }
    expect(base(base_, ".card").border).toBeUndefined()
    expect(base(base_, ".card").background).toBe("var(--yc-surface)")
    expect(base(base_, ".status-strip")["border-block-end"]).toBeUndefined()
    expect(base(base_, ".status-strip")["border-radius"]).toBe("var(--yc-radius-lg)")
    expect(base(base_, ".app-header")["border-block-end"]).toBeUndefined()
    expect(frameless(site, ".feature").background).toBe("transparent")
    expect(frameless(site, ".feature__icon")).toMatchObject({ background: "var(--yc-green-soft)", color: "var(--yc-green-strong)" })
    expect(frameless(site, ".trust__item").background).toBe("var(--yc-surface)")
    expect(base(site, ".callout-bar").border).toBeUndefined()
    expect(frameless(docs, ".releases--timeline .release").background).toBe("var(--yc-surface)")
    expect(base(docs, ".docs-bar")).toMatchObject({ background: "var(--yc-bg)", "border-block-end": "0" })
    expect(base(docs, ".docs-shell__nav")["border-inline-end"]).toBeUndefined()
    expect(docs.rules.filter((rule) => rule.header === ".docs-shell__nav" && rule.declarations["border-inline-end"] !== undefined)).toEqual([])
    expect(base(docs, ".doc-section")["border-block-start"]).toBe("0")
    expect(base(docs, ".inline-code").border).toBeUndefined()
    expect(base(docs, ".docs-nav__link")["border-radius"]).toBe("var(--yc-radius-pill)")
    expect(base(docs, ".card-grid > .card").background).toBe("var(--yc-surface)")
    expect(base(docs, ".card-grid > .card:hover").background).toBe("var(--yc-surface-sunken)")
  })

  test("makes the public header translucent at 92% with opaque fallbacks", async () => {
    const site = await readStylesheet("site.css")
    expect(base(site, ".marketing .app-header")).toMatchObject({
      background: "color-mix(in srgb, var(--yc-bg) 92%, transparent)",
      "backdrop-filter": "saturate(140%) blur(16px)",
    })
    for (const condition of ["@supports not (backdrop-filter: blur(1px))", "@media (prefers-reduced-transparency: reduce)", "@media (forced-colors: active)"]) {
      expect({ condition, background: declarationsWhere(site, (rule) => rule.header === ".marketing .app-header" && rule.conditions.includes(condition)).background }).toEqual({ condition, background: "var(--yc-bg)" })
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
          if (condition === PHONE_LAYOUT_QUERY || condition === COARSE_LANDSCAPE_QUERY || condition === "@media (max-width: 767px) and (max-height: 480px)" || condition === "@media (max-height: 599px)") {
            expect(name).toBe("remote.css")
            continue
          }
          for (const feature of condition.replace(/^@media\s+/, "").split(" and ")) {
            if (feature.startsWith("(pointer:") || feature.startsWith("(prefers-") || feature.startsWith("(forced-colors:")) continue
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

  test("leaves Office visibility to the shell's phone-layout flag, not heading-only CSS", async () => {
    const remote = await readStylesheet("remote.css")
    expect(remote.rules.some((rule) => rule.header === ":root" && rule.conditions.includes(PHONE_LAYOUT_QUERY) && rule.declarations["--yc-phone-layout"] === "1")).toBe(true)
    expect(remote.rules.some((rule) => rule.header === "#office-settings" && rule.conditions.includes(PHONE_LAYOUT_QUERY) && rule.declarations.display === "none")).toBe(false)
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
    // The footer is a brand block beside titled link columns, never one wrapped link row.
    expect(columnSteps(site, ".footer")).toEqual([{ min: 768, tracks: 2 }])
    expect(base(site, ".footer__columns")["grid-template-columns"]).toBe("repeat(2, minmax(0, 1fr))")
    expect(columnSteps(site, ".footer__columns")).toEqual([{ min: 640, tracks: 3 }])
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

  test("adds one shared workspace rail at 768 and keeps each screen in the remaining column", async () => {
    const remote = await readStylesheet("remote.css")
    expect(columnSteps(remote, ".workspace")).toEqual([])
    expect(columnSteps(remote, ".app")).toEqual([{ min: 768, tracks: 2 }])
    const landscape = declarationsWhere(remote, (rule) => rule.header === ".app" && rule.conditions.includes(COARSE_LANDSCAPE_QUERY))
    expect(landscape["grid-template-columns"]).toBe("var(--yc-bottom-nav-h) minmax(0, 1fr)")
    expect(shownFrom(remote, ".workspace__rail", 768)).toBe(true)
    expect(base(remote, ".workspace__rail-body")).toMatchObject({ "overflow-y": "auto", "overflow-anchor": "none", "min-block-size": "0" })
    for (const screen of ["sessions", "settings", "empty"]) {
      expect(declarationsWhere(remote, (rule) =>
        rule.header.split(",").map((selector) => selector.trim()).includes(`.app--${screen} .workspace__main`),
      )["grid-column"]).toBe("1 / -1")
    }
    expect(shownFrom(remote, ".bottom-nav", 0)).toBe(true)
    expect(hiddenAbove(remote, ".bottom-nav", 768)).toBe(true)
    expect(columnSteps(remote, ".defs__row")).toEqual([{ min: 1024, tracks: 2 }])
  })

  test("widens the Sessions, Usage, Settings, and Session detail columns at 1600 while assistant prose fills the column", async () => {
    const remote = await readStylesheet("remote.css")
    const listed = (selector: string, min?: number) =>
      declarationsWhere(remote, (rule) =>
        rule.header.split(",").map((part) => part.trim()).includes(selector) &&
        (min === undefined
          ? rule.conditions.length === 0
          : rule.conditions.some((condition) => widthThreshold(condition)?.min === min)),
      )
    for (const screen of ["sessions", "usage"]) {
      expect(listed(`.app--${screen} .workspace__scroll > .route-panel`)["max-inline-size"]).toBe("var(--yc-content-max)")
      expect(listed(`.app--${screen} .workspace__scroll > .route-panel`, 1600)["max-inline-size"]).toBe("var(--yc-content-max-wide)")
    }
    for (const block of [".app--settings .page-head", ".app--settings .pane"]) {
      expect(listed(block)["inline-size"]).toBe("min(100%, var(--yc-content-max))")
      expect(listed(block, 1600)["inline-size"]).toBe("min(100%, var(--yc-content-max-wide))")
    }
    expect(listed(".app--conversation.app--selected")["--remote-column"]).toBe("var(--yc-measure-wide)")
    expect(listed(".app--conversation.app--selected", 1600)).toEqual({})
    const transcript = await readStylesheet("../remote/ui/transcript.css")
    expect(transcript.rules.filter((rule) => rule.header.includes(".transcript-md") && rule.declarations["max-inline-size"]?.includes("--yc-measure"))).toEqual([])
  })

  test("reserves the command palette's scrollbar gutter beside the workspace scroller", async () => {
    const remote = await readStylesheet("remote.css")
    const gutter = declarationsWhere(remote, (rule) =>
      rule.header.split(",").map((part) => part.trim()).includes(".command-palette__list") &&
      rule.conditions.some((condition) => condition.startsWith("@supports (scrollbar-gutter: stable)")),
    )
    expect(gutter["scrollbar-gutter"]).toBe("stable")
  })

  test("keeps compact navigation to one row of three labeled targets above the bottom safe area", async () => {
    const remote = await readStylesheet("remote.css")
    const nav = base(remote, ".bottom-nav")
    const item = base(remote, ".bottom-nav__item")
    expect(nav).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      "padding-block-end": "env(safe-area-inset-bottom)",
    })
    expect(item).toMatchObject({
      display: "grid",
      "place-items": "center",
      "min-height": "var(--yc-bottom-nav-h)",
    })
    expect(base(remote, ".bottom-nav__label").display).toBe("block")
  })

  test("keeps the header connection label readable to assistive technology when the row has no room for it", async () => {
    const remote = await readStylesheet("remote.css")
    const label = base(remote, ".remote-connection-label")
    expect(label.display).not.toBe("none")
    expect(label).toMatchObject({ position: "absolute", "clip-path": "inset(50%)" })
  })

  test("floats the jump controls in a zero-height slot at every width", async () => {
    const remote = await readStylesheet("remote.css")
    const nav = await readStylesheet("../remote/ui/transcript-nav.css")
    const slot = declarationsWhere(remote, (rule) => rule.header.includes(".conversation-jump-slot") && rule.header.includes(":not(") && rule.conditions.length === 0)
    expect(slot).toMatchObject({ position: "relative", display: "block", "block-size": "0" })
    expect(base(nav, ".transcript-navigation__controls")).toMatchObject({ position: "absolute" })
    expect(nav.rules.some((rule) => rule.header.includes("transcript-navigation__controls") && rule.declarations.display === "none")).toBe(false)
    expect(nav.rules.some((rule) => rule.header.includes("desktop-controls") || rule.header.includes("mobile-controls"))).toBe(false)
    expect(declarationsWhere(remote, (rule) => rule.header === ".app--conversation.app--selected:not(.app--office, .app--new-session) .workspace__scroll" && rule.conditions.length === 0)["padding-block-end"]).toBe("var(--yc-space-20)")
  })

  test("gives Sessions the same zero-height jump slot with bottom clearance and no second pill style", async () => {
    const remote = await readStylesheet("remote.css")
    const nav = await readStylesheet("../remote/ui/transcript-nav.css")
    expect(declarationsWhere(remote, (rule) => rule.header === ".app--sessions .conversation-jump-slot" && rule.conditions.length === 0)).toMatchObject({ position: "relative", display: "block", "block-size": "0" })
    expect(declarationsWhere(remote, (rule) => rule.header === ".app--sessions .workspace__scroll" && rule.conditions.length === 0)["padding-block-end"]).toBe("var(--yc-space-20)")
    expect(nav.rules.some((rule) => rule.header.includes("sessions"))).toBe(false)
  })

  test("anchors suggestions inside the composer and bounds them by the measured viewport space", async () => {
    const composer = await readStylesheet("../remote/ui/composer.css")
    expect(composer.rules.some((rule) => rule.header.includes(".mini-composer__autocomplete") && rule.declarations.position === "fixed")).toBe(false)
    const panel = base(composer, ".mini-composer__suggestions")
    expect(panel).toMatchObject({ position: "absolute", display: "flex", overflow: "hidden" })
    expect(panel["max-block-size"]).toContain("--composer-suggest-max")
    expect(base(composer, ".mini-composer__autocomplete")).toMatchObject({ overflow: "auto", "min-block-size": "0" })
  })

  test("sizes phone picker sheets to their content up to the visual viewport while the list scrolls", async () => {
    const composer = await readStylesheet("../remote/ui/composer.css")
    const phone = (rule: { readonly header: string; readonly conditions: readonly string[] }, header: string) => rule.header === header && rule.conditions.includes("@media (max-width: 767px)")
    const cap = "calc(var(--composer-sheet-height, 100dvh) - env(safe-area-inset-top) - env(safe-area-inset-bottom))"
    const anchor = "max(env(safe-area-inset-bottom), calc(100dvh - (var(--composer-sheet-top, 0px) + var(--composer-sheet-height, 100dvh))))"
    const picker = declarationsWhere(composer, (rule) => phone(rule, ".mini-picker__surface.mini-picker__surface--sheet"))
    expect(picker).toMatchObject({ "inset-inline": "0", "inset-block-start": "auto", "inset-block-end": anchor, "block-size": "auto", "max-block-size": cap, "border-radius": "0", overflow: "hidden" })
    expect(picker["padding-block"]).toBe("env(safe-area-inset-top) env(safe-area-inset-bottom)")
    expect(declarationsWhere(composer, (rule) => phone(rule, ".mini-picker__surface--sheet > :not(.mini-picker__list)"))).toMatchObject({ flex: "none" })
    expect(declarationsWhere(composer, (rule) => phone(rule, ".mini-picker__surface--sheet .mini-picker__list"))).toMatchObject({ display: "grid", flex: "0 1 auto", "align-content": "start", "min-block-size": "0", "overscroll-behavior": "contain" })
    expect(declarationsWhere(composer, (rule) => phone(rule, ".mini-picker__surface--sheet .mini-picker__option"))["min-block-size"]).toBe("var(--yc-hit-min)")
    const selection = base(composer, ".composer__selection-sheet")
    expect(selection).toMatchObject({ position: "fixed", "inset-block-start": "auto", "inset-block-end": anchor, "block-size": "auto", "max-block-size": cap, overflow: "hidden", "border-radius": "0" })
    expect(base(composer, ".composer__selection-options")).toMatchObject({ flex: "0 1 auto", "align-content": "start", "min-block-size": "0", overflow: "auto" })
  })

  test("keeps keyboard focus off the sheet outline and never sizes a phone sheet with 100vh", async () => {
    const composer = await readStylesheet("../remote/ui/composer.css")
    expect(composer.rules.some((rule) => Object.values(rule.declarations).some((value) => /\d+vh\b/.test(value) && rule.header.includes("sheet")))).toBe(false)
    expect(declarationsWhere(composer, (rule) => rule.header.includes(".mini-picker__surface--sheet:focus-visible"))).toMatchObject({ outline: "none" })
  })

  test("keeps the header Team control visible in the compact header end group", async () => {
    const remote = await readStylesheet("remote.css")
    const hidden = remote.rules.filter((rule) => rule.header.includes(".app-header__end > :not("))
    expect(hidden.length).toBeGreaterThan(0)
    for (const rule of hidden) expect(rule.header).toContain(".app-header__team")
  })

  test("collapses the phone navigation row while the keyboard is open without shrinking the shell", async () => {
    const remote = await readStylesheet("remote.css")
    const phone = "@media (max-width: 767px)"
    expect(base(remote, ".app")["block-size"]).toBe("100dvh")
    expect(declarationsWhere(remote, (rule) => rule.header === ".app[data-keyboard-open] > .bottom-nav" && rule.conditions.length === 0).display).toBe("none")
    expect(declarationsWhere(remote, (rule) => rule.header === ".app[data-keyboard-open]" && rule.conditions.includes(phone))["grid-template-rows"]).toBe("auto minmax(0, 1fr) 0px")
    expect(declarationsWhere(remote, (rule) => rule.header === ".app[data-keyboard-open]:has(> .status-strip)" && rule.conditions.includes(phone))["grid-template-rows"]).toBe("auto auto minmax(0, 1fr) 0px")
    expect(remote.rules.some((rule) => rule.header === ".app[data-keyboard-open]" && rule.declarations["block-size"] !== undefined)).toBe(false)
  })

  test("bounds the application shell column to the viewport", async () => {
    const remote = await readStylesheet("remote.css")
    const app = declarationsWhere(remote, (rule) => rule.header === ".app" && rule.conditions.length === 0)
    expect(app["grid-template-columns"]).toBe("minmax(0, 1fr)")
  })

  test("gives Focus shared geometry, Sans navigation and Mono metadata", async () => {
    const remote = await readStylesheet("remote.css")
    for (const token of ["--yc-radius-sm", "--yc-radius-md", "--yc-radius-lg", "--yc-radius-xl", "--yc-radius-pill"]) {
      expect({ token, override: remote.rules.some((rule) => token in rule.declarations) }).toEqual({ token, override: false })
    }
    for (const selector of [".app .pane__title", ".app .chip", ".request__header"]) {
      expect({ selector, font: base(remote, selector)["font-family"] }).toEqual({ selector, font: "var(--yc-font-mono)" })
    }
    expect(base(remote, ".remote-nav__link")["font-family"]).toBe("var(--yc-font-sans)")
    expect(base(remote, ".app .pane__title")["text-transform"]).toBe("uppercase")
    expect(base(remote, ".session-row--active")).toMatchObject({ background: "var(--yc-green-soft)", "border-radius": "var(--yc-radius-lg)" })
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

  test("runs the content entrance only with the JS motion gate and accepted preference", async () => {
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
      expect(rule.header).toContain(':root[data-motion="on"]')
    }
  })

  test("fades and rises content into place", async () => {
    const base = await readStylesheet("base.css")
    const step = base.rules.filter((rule) => rule.header === "from" && rule.conditions.includes("@keyframes yc-enter"))
    expect(step.map((rule) => Object.keys(rule.declarations))).toEqual([["opacity", "translate", "filter", "scale"]])
  })

  test("gates hidden reveal states and keeps interactive motion on composited properties", async () => {
    const site = await readStylesheet("site.css")
    const docs = await readStylesheet("docs.css")
    const publicRules = [...site.rules, ...docs.rules]
    const hidden = publicRules.filter((rule) => rule.declarations.opacity === "0" && rule.header.includes(".motion-reveal"))
    expect(hidden.length).toBeGreaterThan(0)
    for (const rule of hidden) {
      expect(rule.header).toContain(':root[data-motion="on"]')
      expect(rule.header).toContain(":not(.motion-reveal--visible)")
      expect(rule.conditions).toContain("@media (prefers-reduced-motion: no-preference)")
    }
    expect(publicRules.some((rule) => rule.header.includes(".motion-reveal--visible") && rule.conditions.includes("@media (prefers-reduced-motion: no-preference)") && rule.declarations["animation"]?.includes("yc-enter"))).toBe(true)
    expect(publicRules.some((rule) => rule.declarations["transition"]?.includes("transform") || rule.declarations["transition"]?.includes("translate"))).toBe(true)
  })

  test("never hides content without the motion gate", async () => {
    const overlayFades = ["@keyframes yc-fade-in", "@keyframes yc-dialog-in", "@keyframes yc-sheet-out", "@keyframes yc-fade-out", "@keyframes yc-slide-out", "@keyframes yc-dialog-out"]
    for (const name of SURFACE_FILES) {
      const sheet = await readStylesheet(name)
      const zeroOpacity = sheet.rules
        .filter(
          (rule) =>
            rule.declarations["opacity"] === "0" &&
            !rule.conditions.some((condition) => overlayFades.includes(condition)) &&
            !rule.conditions.includes("@keyframes yc-enter") &&
            !rule.header.includes(':root[data-motion="on"]') &&
            rule.header !== ".docs-toc__list::before",
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
        // The single-column base and the phone-layout refinements are not min-width steps.
        rule.conditions.some((condition) => widthThreshold(condition)?.min !== undefined),
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
