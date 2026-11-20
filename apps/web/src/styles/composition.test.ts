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

const SURFACE_FILES = ["base.css", "../ui/button.css", "../ui/modal.css", "site.css", "docs.css", "remote.css"] as const

const STYLESHEETS = [...SURFACE_FILES, "tokens.css"] as const

describe("responsive contract", () => {
  test("owns documentation search result button borders", async () => {
    const sheet = await readStylesheet("docs.css")
    expect(base(sheet, ".search__result").border).toBe("0")
  })

  test("uses open public text navigation with a quiet current state and no bottom rule", async () => {
    const sheet = await readStylesheet("base.css")
    expect(base(sheet, ".nav__link")).toMatchObject({
      "border-radius": "0",
      "border-block-end": "0",
      background: "transparent",
    })
    expect(hover(sheet, ".nav__link:hover").background).toBe("transparent")
    expect(base(sheet, ".nav__link--active")).toMatchObject({
      background: "transparent",
      color: "var(--yc-ink)",
      "font-weight": "var(--yc-weight-semibold)",
    })
  })

  test("assigns compact public control radii and retains owned navigation and article shapes", async () => {
    const site = await readStylesheet("site.css")
    const docs = await readStylesheet("docs.css")
    const radii: readonly (readonly [Stylesheet, string, string])[] = [
      [site, ".marketing .button", "control"],
      [site, ".marketing .code-block", "control"],
      [site, ".marketing .input", "control"],
      [site, ".marketing .card", "card"],
      [site, ".marketing .callout-bar", "card"],
      [site, ".marketing .feature", "card"],
      [site, ".marketing .trust__item", "composer"],
      [docs, ".docs-bar__nav-toggle", "pill"],
      [docs, ".docs-search-trigger", "pill"],
      [docs, ".docs--index .card-grid > .card", "control"],
      [docs, ".docs--article .code-block", "card"],
    ]
    for (const [sheet, selector, step] of radii) {
      expect({ selector, radius: declarationsWhere(sheet, (rule) => rule.header.includes(selector))["border-radius"] }).toEqual({ selector, radius: `var(--yc-radius-${step})` })
    }
    expect(base(docs, ".releases--timeline .release")["border-radius"]).toBe("0")
    expect(base(docs, ".docs--index .doc-section")["border-radius"]).toBe("0")
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
    expect(base(base_, ".card").background).toBe("var(--yc-plane-raised)")
    expect(base(base_, ".status-strip")["border-block-end"]).toBeUndefined()
    expect(base(base_, ".status-strip")["border-radius"]).toBe("var(--yc-radius-card)")
    expect(base(base_, ".app-header")["border-block-end"]).toBeUndefined()
    expect(frameless(site, ".feature").background).toBe("transparent")
    expect(frameless(site, ".feature__icon")).toMatchObject({ background: "var(--yc-cobalt-tonal)", color: "var(--yc-cobalt-ink)" })
    expect(frameless(site, ".trust__item").background).toBe("var(--yc-plane-raised)")
    expect(base(site, ".callout-bar").border).toBeUndefined()
    expect(frameless(docs, ".releases--timeline .release").background).toBe("transparent")
    expect(base(docs, ".releases--timeline .release")["border-block-end"]).toBe("1px solid var(--yc-line-subtle)")
    expect(docs.rules.some(rule => rule.header === ".docs-bar")).toBe(false)
    expect(base(site, ".marketing .app-header")["border-block-end"]).toBe("1px solid var(--yc-line-subtle)")
    expect(base(docs, ".docs-shell__nav")["border-inline-end"]).toBeUndefined()
    expect(docs.rules.filter((rule) => rule.header === ".docs-shell__nav" && rule.declarations["border-inline-end"] !== undefined)).toEqual([])
    expect(base(docs, ".doc-section")["border-block-start"]).toBe("0")
    expect(base(docs, ".inline-code").border).toBeUndefined()
    expect(base(docs, ".docs-nav__link")["border-radius"]).toBe("var(--yc-radius-control)")
    expect(base(docs, ".card-grid > .card").background).toBe("var(--yc-plane-raised)")
    expect(hover(docs, ".card-grid > .card:hover").background).toBe("var(--yc-plane-hover)")
  })

  test("makes the public header translucent at 94% with opaque fallbacks", async () => {
    const site = await readStylesheet("site.css")
    expect(base(site, ".marketing .app-header")).toMatchObject({
      background: "var(--yc-plane-canvas)",
      "backdrop-filter": "none",
    })
    expect(declarationsWhere(site, (rule) => rule.header === ".marketing .app-header" && rule.conditions.includes("@supports (backdrop-filter: blur(1px))"))).toMatchObject({
      background: "color-mix(in srgb, var(--yc-plane-canvas) 94%, transparent)",
      "backdrop-filter": "blur(12px)",
    })
    for (const condition of ["@media (prefers-reduced-transparency: reduce)", "@media (forced-colors: active)"]) {
      expect(declarationsWhere(site, (rule) => rule.header === ".marketing .app-header" && rule.conditions.includes(condition))).toMatchObject({ background: "var(--yc-plane-canvas)", "backdrop-filter": "none" })
    }
  })

  test("uses only the declared breakpoints in every stylesheet", async () => {
    for (const name of [...STYLESHEETS, "../remote/ui/composer.css"]) {
      const sheet = await readStylesheet(name)
      for (const rule of sheet.rules) {
        for (const condition of rule.conditions) {
          // A keyframes prelude is not a condition on width; only media queries carry
          // a breakpoint that must be declared.
          if (!condition.startsWith("@media")) continue
          if (condition === PHONE_LAYOUT_QUERY) {
            expect(["remote.css", "site.css", "../ui/modal.css"]).toContain(name)
            continue
          }
          if (condition === COARSE_LANDSCAPE_QUERY || condition === "@media (max-width: 767px) and (max-height: 480px)" || condition === "@media (max-height: 599px)") {
            expect(["remote.css", "../remote/ui/composer.css"]).toContain(name)
            continue
          }
          for (const feature of condition.replace(/^@media\s+/, "").split(/,\s*| and /)) {
            if (feature.startsWith("(pointer:") || feature.startsWith("(hover:") || feature.startsWith("(prefers-") || feature.startsWith("(forced-colors:")) continue
            const width = feature.match(/^\((min|max)-width:\s*(\d+)px\)$/)
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

  test("owns scrollbars unconditionally through the shared foundation", async () => {
    const sheet = await readStylesheet("base.css")
    expect(base(sheet, "*")).toMatchObject({ "scrollbar-width": "thin", "scrollbar-color": "var(--yc-line-field) transparent" })
    expect(base(sheet, "::-webkit-scrollbar")).toMatchObject({ width: "var(--yc-scrollbar-size)", height: "var(--yc-scrollbar-size)" })
    expect(base(sheet, "::-webkit-scrollbar-thumb")).toMatchObject({ "background-color": "var(--yc-line-field)", "border-radius": "var(--yc-radius-pill)" })
    expect(declarationsWhere(sheet, rule => rule.conditions.includes("@media (forced-colors: active)") && rule.header === "*")).toMatchObject({ "scrollbar-color": "CanvasText Canvas", "scrollbar-width": "auto" })
  })

  test("owns native primitive resets and an opaque header fallback", async () => {
    const sheet = await readStylesheet("base.css")
    expect(declarationsWhere(sheet, rule => rule.conditions.length === 0 && rule.header.split(",").some(selector => selector.trim() === "select")).appearance).toBe("base-select")
    expect(base(sheet, "select::picker(select)")).toMatchObject({ background: "var(--yc-plane-raised)", color: "var(--yc-ink)", border: "1px solid var(--yc-line-field)" })
    expect(base(sheet, '.check input[type="radio"]').appearance).toBe("none")
    expect(base(sheet, "progress")).toMatchObject({ appearance: "none", border: "0" })
    for (const part of ["::-webkit-progress-bar", "::-webkit-progress-value", "::-moz-progress-bar"]) expect(base(sheet, `progress${part}`).background).toMatch(/^var\(--yc-/)
    expect(base(sheet, ".app-header")).toMatchObject({ background: "var(--yc-plane-canvas)", "backdrop-filter": "none" })
  })

  test("uses semantic frame planes, aligned headers and a coarse action floor", async () => {
    const remote = await readStylesheet("remote.css")
    const foundation = await readStylesheet("base.css")
    expect(base(remote, ".workspace__rail").background).toBe("var(--yc-plane-chrome)")
    expect(base(remote, ".workspace__rail-head")["block-size"]).toBe("var(--yc-header-public-h)")
    expect(base(remote, ".workspace__topbar").background).toBe("var(--yc-plane-canvas)")
    expect(declarationsWhere(foundation, rule => rule.header.startsWith(":root :is(button,") && rule.conditions.includes("@media (pointer: coarse)"))).toMatchObject({ "min-inline-size": "var(--yc-hit-min)", "min-block-size": "var(--yc-hit-min)" })
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
    expect(docs.rules.some(rule => rule.header === ".docs-bar__crumbs" || rule.header === ".docs-bar__title")).toBe(false)
  })

  test("adds the activity bar and one shared workspace rail at 768 and keeps each screen in the remaining column", async () => {
    const remote = await readStylesheet("remote.css")
    expect(columnSteps(remote, ".workspace")).toEqual([])
    expect(columnSteps(remote, ".app")).toEqual([{ min: 768, tracks: 3 }])
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

  test("keeps Session and Settings tracks centered while directory columns retain their start edge", async () => {
    const remote = await readStylesheet("remote.css")
    const listed = (selector: string, min?: number) =>
      declarationsWhere(remote, (rule) =>
        (rule.header === selector || rule.header.split(",").map((part) => part.trim()).includes(selector)) &&
        (min === undefined
          ? rule.conditions.length === 0
          : rule.conditions.some((condition) => widthThreshold(condition)?.min === min)),
      )
    for (const screen of ["sessions", "usage"]) {
      expect(listed(`.app--${screen} .workspace__scroll > .route-panel`)["max-inline-size"]).toBe("var(--yc-content-max)")
      expect(listed(`.app--${screen} .workspace__scroll > .route-panel`)["margin-inline"]).toBe("0")
      expect(listed(`.app--${screen} .workspace__scroll > .route-panel`, 1600)["max-inline-size"]).toBe("var(--yc-content-max-wide)")
    }
    for (const block of [".app--settings .page-head", ".app--settings .pane"]) {
      expect(listed(block)["inline-size"]).toBe("min(100%, 64rem)")
      expect(listed(block)["margin-inline"]).toBe("auto")
      expect(listed(block, 1600)["inline-size"]).toBeUndefined()
    }
    expect(listed(".app--settings .workspace__scroll", 1024).padding).toBe("var(--yc-space-12) var(--yc-space-16)")
    expect(listed(".app")["--remote-column"]).toBe("720px")
    const conversation = ".app--conversation.app--selected:not(.app--office, .app--new-session, .app--selected-loading)"
    expect(listed(conversation)["--remote-column"]).toBe("64rem")
    expect(listed(conversation, 1024)["--conversation-inset"]).toBe("var(--yc-space-10)")
    expect(listed(`${conversation} .conversation-jump-slot`)["margin-inline"]).toBe("auto")
    expect(remote.rules.filter(rule => rule.header.includes(`${conversation} .workspace__scroll > *`) && rule.declarations["margin-inline"] === "0")).toEqual([])
    expect(listed(".app--conversation.app--selected", 1600)).toEqual({})
    const transcript = await readStylesheet("../remote/ui/transcript.css")
    expect(transcript.rules.filter((rule) => rule.header.includes(".transcript-md") && rule.declarations["max-inline-size"] === "var(--yc-measure)")).toEqual([])
    const settings = await readStylesheet("../remote/ui/settings.css")
    expect(declarationsWhere(settings, rule => rule.header === ".app--settings .pane p")["max-inline-size"]).toBe("var(--yc-measure)")
  })

  test("reserves the command palette's scrollbar gutter beside the workspace scroller", async () => {
    const remote = await readStylesheet("remote.css")
    const gutter = declarationsWhere(remote, (rule) =>
      rule.header.split(",").map((part) => part.trim()).includes(".command-palette__list") &&
      rule.conditions.some((condition) => condition.startsWith("@supports (scrollbar-gutter: stable)")),
    )
    expect(gutter["scrollbar-gutter"]).toBe("stable")
  })

  test("keeps compact navigation to one row of five labeled targets above the bottom safe area", async () => {
    const remote = await readStylesheet("remote.css")
    const nav = base(remote, ".bottom-nav")
    const item = base(remote, ".bottom-nav__item")
    expect(nav).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(5, minmax(0, 1fr))",
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

  test("reserves phone space for jump controls and floats them on wider screens", async () => {
    const remote = await readStylesheet("remote.css")
    const nav = await readStylesheet("../remote/ui/transcript-nav.css")
    const slot = declarationsWhere(remote, (rule) => rule.header.includes(".conversation-jump-slot") && rule.header.includes(":not(") && rule.conditions.length === 0)
    expect(slot).toMatchObject({ position: "relative", display: "block", "block-size": "0" })
    expect(remote.rules.some((rule) => rule.header.includes(".conversation-jump-slot") && rule.conditions.some((condition) => condition.includes("max-width: 767px")) && rule.declarations["block-size"] === "var(--yc-space-16)")).toBe(true)
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
    const modal = await readStylesheet("../ui/modal.css")
    const phone = (rule: { readonly header: string; readonly conditions: readonly string[] }, header: string) => rule.header === header && rule.conditions.includes("@media (max-width: 767px)")
    const cap = "calc(var(--overlay-viewport-height, 100dvh) - env(safe-area-inset-top) - env(safe-area-inset-bottom))"
    const anchor = "calc(100dvh - (var(--overlay-viewport-top, 0px) + var(--overlay-viewport-height, 100dvh)))"
    const sheet = base(modal, ".overlay--sheet .overlay__surface")
    expect(sheet).toMatchObject({ "inset-inline": "0", "inset-block-start": "auto", "inset-block-end": anchor, "block-size": "auto", "max-block-size": cap, overflow: "hidden" })
    expect(base(modal, ".overlay__body")["overscroll-behavior"]).toBe("contain")
    expect(base(composer, ".overlay--composer-picker .mini-picker__surface")).toMatchObject({ position:"static", "min-block-size":"0", "max-block-size":"none" })
    expect(declarationsWhere(composer, (rule) => phone(rule, ".mini-picker__surface--sheet > :not(.mini-picker__list)"))).toMatchObject({ flex: "none" })
    expect(declarationsWhere(composer, (rule) => phone(rule, ".mini-picker__surface--sheet .mini-picker__list"))).toMatchObject({ display: "grid", flex: "0 1 auto", "align-content": "start", "min-block-size": "0", "overscroll-behavior": "contain" })
    expect(declarationsWhere(composer, (rule) => phone(rule, ".mini-picker__surface--sheet .mini-picker__option"))["min-block-size"]).toBe("var(--yc-hit-min)")
    const selection = base(composer, ".composer__selection-sheet")
    expect(selection).toMatchObject({ display:"flex", "min-block-size":"0", overflow:"hidden" })
    expect(selection.position).not.toBe("fixed")
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
    for (const token of ["--yc-radius-control", "--yc-radius-card", "--yc-radius-card", "--yc-radius-composer", "--yc-radius-pill"]) {
      expect({ token, override: remote.rules.some((rule) => token in rule.declarations) }).toEqual({ token, override: false })
    }
    for (const selector of [".app .pane__title", ".app .chip", ".request__header"]) {
      expect({ selector, font: base(remote, selector)["font-family"] }).toEqual({ selector, font: "var(--yc-font-mono)" })
    }
    expect(base(await readStylesheet("workspace-shell.css"), ".activity-bar__label").font).toBe("var(--yc-weight-medium) var(--yc-size-2xs)/var(--yc-leading-2xs) var(--yc-font-sans)")
    expect(base(remote, ".app .pane__title")["text-transform"]).toBe("uppercase")
    expect(base(remote, ".session-row--active")).toMatchObject({ background: "var(--yc-plane-selected)", "border-radius": "var(--yc-radius-control)" })
  })
})

test("documentation topic groups use two columns from the tablet breakpoint", async () => {
  const docs = await readStylesheet("docs.css")
  const tablet = declarationsWhere(docs, (rule) => rule.header === ".docs-topic-index" && rule.conditions.includes("@media (min-width: 640px)"))
  expect(tablet["grid-template-columns"]).toBe("repeat(2,minmax(0,1fr))")
})

describe("motion contract", () => {
  test("collapses animation and transition in one reduced-motion equivalent that exempts the token-governed primitives", async () => {
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
    const stateAlternatives = reduceBlocks.filter((entry) => entry.file !== "base.css")
    for (const { file, rule } of stateAlternatives) {
      const motion = Object.keys(rule.declarations).filter((property) => /^(animation|transition)/.test(property))
      expect({ file, header: rule.header, motion }).toEqual({ file, header: rule.header, motion: [] })
    }
    expect(reduceBlocks.filter((entry) => entry.file === "base.css").map((entry) => entry.file)).toEqual(["base.css"])
    // The equivalent is declared on the universal selector, so it is the *lowest*
    // specificity rule in the cascade; without `!important` a class rule's
    // `transition: …` shorthand wins and a visible control keeps its duration.
    expect(reduceBlocks.find((entry) => entry.file === "base.css")!.rule.declarations).toEqual({
      "animation-name": "none !important",
      "animation-duration": "0s !important",
      "transition-duration": "0s !important",
    })
    const exempt = ":not(.collapsible, .motion-enter)"
    expect(reduceBlocks.find((entry) => entry.file === "base.css")!.rule.header.replace(/\s+/g, " ")).toBe(`*${exempt}, *${exempt}::before, *${exempt}::after`)
  })

  test("builds the shared disclosure and entrance primitives from the motion tokens only", async () => {
    const base = await readStylesheet("base.css")
    expect(declarationsWhere(base, (rule) => rule.header === ".collapsible")).toEqual({
      display: "grid",
      "grid-template-rows": "0fr",
      opacity: "0",
      transition:
        "grid-template-rows var(--yc-motion-spatial-dur) var(--yc-motion-ease), opacity var(--yc-motion-effect-dur) var(--yc-motion-ease)",
    })
    expect(declarationsWhere(base, (rule) => rule.header === ".collapsible[data-open]")).toEqual({
      "grid-template-rows": "1fr",
      opacity: "1",
    })
    const inner = declarationsWhere(base, (rule) => rule.header === ".collapsible__inner")
    expect(inner).toMatchObject({ "min-block-size": "0", overflow: "clip" })
    expect(inner["overflow-clip-margin"]).toBeDefined()
    const enter = declarationsWhere(base, (rule) => rule.header === ".motion-enter")
    expect(enter["animation"]).toBe(
      "yc-motion-fade var(--yc-motion-effect-dur) var(--yc-motion-ease) both, yc-motion-rise var(--yc-motion-spatial-dur) var(--yc-motion-ease) both",
    )
    const rise = base.rules.find((rule) => rule.header === "from" && rule.conditions.includes("@keyframes yc-motion-rise"))
    expect(rise?.declarations).toEqual({ translate: "0 var(--yc-space-2)" })
    const fade = base.rules.find((rule) => rule.header === "from" && rule.conditions.includes("@keyframes yc-motion-fade"))
    expect(fade?.declarations).toEqual({ opacity: "0" })
    const consumers = base.rules.filter((rule) => rule.header === ".collapsible" || rule.header === ".motion-enter")
    for (const rule of consumers) {
      expect({ header: rule.header, conditions: rule.conditions }).toEqual({ header: rule.header, conditions: [] })
      expect(Object.values(rule.declarations).join(" ")).not.toMatch(/\d+m?s\b(?!\))/)
    }
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
            rule.header !== ".collapsible" &&
            !rule.conditions.includes("@keyframes yc-motion-fade") &&
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

function hover(sheet: Stylesheet, selector: string) {
  return declarationsWhere(sheet, (rule) => rule.header === selector && rule.conditions.length === 1 && rule.conditions[0] === "@media (hover: hover)")
}

function stepped(sheet: Stylesheet, selector: string, min: number) {
  return declarationsWhere(
    sheet,
    (rule) =>
      rule.header === selector && rule.conditions.some((condition) => widthThreshold(condition)?.min === min),
  )
}

describe("modal primitive stylesheet ownership", () => {
  const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()
  const EXTRACTED_KEYFRAMES = ["yc-fade-in", "yc-sheet-in", "yc-sheet-out", "yc-fade-out", "yc-slide-in", "yc-slide-out", "yc-dialog-in", "yc-dialog-out"]

  test("the modal primitive imports its stylesheets and the web base entry delivers them", async () => {
    const modal = await read("../ui/modal.tsx")
    expect(modal).toContain('import "./button.css"')
    expect(modal).toContain('import "./modal.css"')
    const base = await read("base.css")
    expect(base).toContain('@import "../ui/button.css";')
    expect(base).toContain('@import "../ui/modal.css";')
  })

  test("the button family and overlay primitive live once in their primitive stylesheets", async () => {
    const base = await readStylesheet("base.css")
    const leftover = base.rules.filter(
      (rule) =>
        /^\.(button|overlay)/.test(rule.header) ||
        rule.conditions.some((condition) => EXTRACTED_KEYFRAMES.some((name) => condition === `@keyframes ${name}`)) ||
        (rule.header.startsWith(".overlay") && rule.conditions.length > 0),
    )
    expect(leftover.map((rule) => rule.header)).toEqual([])
    const button = await readStylesheet("../ui/button.css")
    const solid = (selector: string) => declarationsWhere(button, (rule) => rule.header === selector && rule.conditions.length === 0)
    expect(solid(".button")).toMatchObject({ display: "inline-flex", "min-block-size": "var(--yc-control-h)", background: "var(--button-bg)" })
    expect(solid(".button--primary")).toBeDefined()
    expect(solid(".button--secondary")["--button-bg"]).toBe("var(--yc-plane-raised)")
    expect(solid(".button--ghost")).toMatchObject({ "--button-bg": "transparent", "--button-border": "transparent" })
    expect(solid(".button--icon")).toMatchObject({ "inline-size": "var(--yc-control-h)", padding: "0" })
    expect(Number(solid(".button[disabled]").opacity)).toBeLessThan(1)
  })

  test("the overlay stylesheet owns the reset, surface, sheet geometry, and gated motion", async () => {
    const modal = await readStylesheet("../ui/modal.css")
    const base = (selector: string) => declarationsWhere(modal, (rule) => rule.header === selector && rule.conditions.length === 0)
    expect(base(".overlay")).toMatchObject({ border: "0", padding: "0", background: "transparent" })
    expect(base(".overlay::backdrop").background).toBe("var(--yc-scrim)")
    expect(base(".overlay__surface")).toMatchObject({ position: "fixed", background: "var(--yc-plane-raised)" })
    expect(base(".overlay--sheet .overlay__surface")).toMatchObject({ "inset-inline": "0", "inset-block-end": "calc(100dvh - (var(--overlay-viewport-top, 0px) + var(--overlay-viewport-height, 100dvh)))", "inline-size": "100%", "block-size":"auto" })
    for (const part of [".overlay__head", ".overlay__title", ".overlay__close", ".overlay__body"]) expect(Object.keys(base(part)).length).toBeGreaterThan(0)
    const keyframes = new Set(modal.rules.flatMap((rule) => rule.conditions.filter((condition) => condition.startsWith("@keyframes "))))
    for (const name of EXTRACTED_KEYFRAMES) expect(keyframes.has(`@keyframes ${name}`)).toBe(true)
    const animated = modal.rules.filter((rule) => rule.declarations["animation"] !== undefined || rule.declarations["animation-name"] !== undefined)
    expect(animated.length).toBeGreaterThan(0)
    for (const rule of animated) expect({ header: rule.header, gated: rule.conditions.includes("@media (prefers-reduced-motion: no-preference)") }).toEqual({ header: rule.header, gated: true })
  })

  test("every modal and picker class resolves to an owned rule", async () => {
    const owned = [...(await readStylesheet("../ui/button.css")).rules, ...(await readStylesheet("../ui/modal.css")).rules].map((rule) => rule.header).join(" ")
    const modal = await read("../ui/modal.tsx")
    const select = await read("../ui/custom-select.tsx")
    for (const name of ["overlay", "overlay__surface", "overlay__head", "overlay__title", "overlay__close", "overlay__body", "overlay--sheet"]) {
      expect(modal + select).toContain(name)
      expect(owned).toContain(`.${name}`)
    }
    for (const name of ["button", "button--ghost", "button--icon", "button--secondary"]) expect(owned).toContain(`.${name}`)
  })
})
