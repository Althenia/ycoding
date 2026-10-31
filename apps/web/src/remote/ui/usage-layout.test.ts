import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { UsageHeading } from "./usage-sections"

const css = await Bun.file(new URL("./usage.css", import.meta.url)).text()

function rule(selector: string) {
  return css.split(/\n(?=\S)/).filter((block) => block.startsWith(`${selector} {`)).join("\n")
}

test("summary metrics share one borderless tonal plane separated by space", () => {
  const strip = rule(".usage-tiles")
  expect(strip).toContain("background: var(--yc-surface)")
  expect(strip).toContain("border-radius: var(--yc-radius-xl)")
  expect(strip).toContain("gap: var(--yc-space-5)")
  expect(strip).not.toContain("border-block")
  expect(strip).not.toContain("border:")
  const tile = rule(".usage-tile")
  expect(tile).not.toContain("border")
  expect(tile).not.toContain("background")
  expect(tile).not.toContain("animation")
  expect(css).not.toContain(".usage-tile + .usage-tile")
  expect(css).not.toContain("border-inline-start: 1px")
})

test("the phone tonal plane leaves each stacked tile at least 260px wide at 320px (288px content minus 2 x --yc-space-3)", () => {
  const phone = css.match(/@container \(max-width: 767px\) \{([\s\S]*?)\n\}\n@keyframes/)?.[1] ?? ""
  expect(phone).toContain(".usage-tiles { padding: var(--yc-space-4) var(--yc-space-3); }")
  expect(288 - 2 * 12).toBeGreaterThanOrEqual(260)
})

test("summary values reserve two current line heights without clipping pricing coverage", () => {
  const value = rule(".usage-tile strong")
  expect(value).toContain("min-block-size: 2lh")
  expect(value).toContain("var(--yc-leading-3xl)")
  expect(css).toMatch(/@container \(max-width: 1023px\) \{[^@]*\.usage-tile strong \{[^}]*font-size: var\(--yc-size-2xl\); line-height: var\(--yc-leading-2xl\)/)
  expect(css).toMatch(/@container \(max-width: 767px\) \{[^@]*\.usage-tile strong \{ margin: 0; \}/)
  expect(value).not.toMatch(/(?:^|[;{])\s*(?:height|block-size|overflow|text-overflow|white-space|line-clamp)\s*:/)
  expect(css).not.toMatch(/\.usage-tile(?: strong)?::(?:before|after)\s*\{[^}]*content\s*:/)
})

test("quota windows and legend entries carry no nested decorative borders", () => {
  expect(rule(".usage-window")).not.toContain("border: 1px")
  expect(rule(".usage-window")).not.toContain("background")
  expect(css).not.toMatch(/\.usage-distribution__legend li \{[^}]*border: 1px/)
})

test("quota providers use inline dividers and the chart pair owns one quiet surface", () => {
  const provider = rule(".usage-provider")
  expect(provider).toContain("border-inline-start: 2px solid var(--yc-border)")
  expect(provider).toContain("padding-inline-start: var(--yc-space-4)")
  for (const property of ["background:", "border:", "border-radius:"]) expect(provider).not.toContain(property)
  const visuals = rule(".usage-visuals")
  expect(visuals).toContain("background: var(--yc-surface)")
  expect(visuals).toContain("border-radius: var(--yc-radius-lg)")
  expect(visuals).toContain("padding: var(--yc-space-5)")
  expect(visuals).not.toContain("border:")
  const chart = rule(".usage-distribution, .usage-chart")
  for (const property of ["background:", "border:", "border-radius:"]) expect(chart).not.toContain(property)
})

test("accounting sections and phone records remain flat", async () => {
  const incidents = await Bun.file(new URL("./model-incidents.css", import.meta.url)).text()
  expect(rule(".usage-breakdown-section")).not.toContain("border")
  expect(rule(".usage-breakdown-section")).toContain("padding-block: var(--yc-space-6)")
  expect(rule(".usage-breakdown-section")).not.toContain("background:")
  expect(css).not.toMatch(/\.usage-mobile-row \{[^}]*border: 1px/)
  expect(incidents).not.toMatch(/\.incidents(?:__panel)? \{[^}]*border: 1px/)
  expect(incidents).not.toMatch(/\.incidents__table tbody tr \{[^}]*border: 1px/)
})

test("incident table scrolling owns positioned labels without masking page overflow", async () => {
  const incidents = await Bun.file(new URL("./model-incidents.css", import.meta.url)).text()
  const wrapper = incidents.match(/\.incidents__table-wrap \{([^}]+)\}/)?.[1]
  expect(wrapper).toContain("position: relative")
  expect(wrapper).toContain("max-inline-size: 100%")
  expect(wrapper).toContain("overflow: auto")
  expect(incidents).not.toMatch(/\.incidents(?:__panel)? \{[^}]*(?:overflow|overflow-x|overflow-inline): (?:hidden|clip)/)
})

test("cards do not stagger their entry", () => {
  expect(css).not.toContain("--usage-index")
  expect(css).not.toContain("animation-delay")
  expect(css).not.toContain("usage-card-enter")
})

test("chart geometry does not resize the owned heading and control icons", () => {
  expect(rule(".usage-chart > svg")).toContain("height: 180px")
  expect(rule(".usage-chart svg")).toBe("")
})

test("responsive layout follows the content width beside the global rail", () => {
  expect(rule(".usage-page")).toContain("container-type: inline-size")
  expect(css).not.toMatch(/@media \((min|max)-width: (768|1023|1024|1280)px\)/)
  for (const query of ["@container (min-width: 768px)", "@container (min-width: 1024px)", "@container (min-width: 1280px)", "@container (max-width: 1023px)"]) expect(css).toContain(query)
})

test("quota refresh keeps a square target and a reduced-motion busy indicator", () => {
  expect(rule(".usage-refresh")).toContain("inline-size: var(--yc-hit-min)")
  expect(rule(".usage-refresh")).toContain("block-size: var(--yc-hit-min)")
  expect(rule(".usage-refresh")).not.toContain("width: 100%")
  expect(css).toContain(".usage-refresh[aria-busy=\"true\"] svg")
  expect(css).toContain("animation: usage-refresh-spin var(--yc-dur-slow) linear infinite")
  expect(css).toContain(".usage-refresh[aria-busy=\"true\"] { border-color: var(--yc-green-strong); background: var(--yc-green-soft); }")
  expect(css).toContain(".usage-refresh[aria-busy=\"true\"] svg { animation: none; }")
})

const cost = await Bun.file(new URL("./usage-cost.css", import.meta.url)).text()

test("an exhausted window takes the danger role on its meter, figures and pill without extra motion", () => {
  expect(css).toContain(".usage-window--exhausted .usage-meter > span { background: var(--yc-danger); }")
  expect(css).toContain(".usage-window--exhausted .usage-window__top b { color: var(--yc-danger); }")
  expect(rule(".usage-pace--exhausted")).toContain("var(--yc-danger)")
  expect(rule(".usage-pace--exhausted")).toContain("var(--yc-danger-soft)")
})

test("recorded consumption rows share aligned tracks on wide layouts and stack on narrow ones without clipping", () => {
  expect(rule(".usage-consumption__list")).toContain("grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto")
  expect(rule(".usage-consumption__row")).toContain("grid-template-columns: subgrid")
  expect(rule(".usage-consumption__row")).not.toContain("white-space: nowrap")
  expect(css).toMatch(/@container \(max-width: 767px\) \{[^@]*\.usage-consumption__list \{ grid-template-columns: minmax\(0, 1fr\) auto; \}/)
  expect(css).toContain("grid-column: 2; grid-row: 1 / 3; align-self: center; position: relative; inline-size: var(--yc-hit-min)")
})

test("phone consumption rows put identity above one wrapping rate line and fold Details into a 44px named icon", () => {
  const phone = css.match(/@container \(max-width: 767px\) \{([\s\S]*?)\n\}\n@keyframes/)?.[1] ?? ""
  expect(phone).toContain(".usage-consumption__rates { display: flex; flex-wrap: wrap;")
  expect(phone).toContain(".usage-consumption__profile { display: none; }")
  expect(phone).toContain(".usage-consumption__row[data-needs-profile] .usage-consumption__profile { display: inline; }")
  expect(phone).toContain(".usage-consumption__row .usage-details-trigger__label { position: absolute;")
  expect(rule(".usage-action-label")).toContain("clip-path: inset(50%)")
  expect(rule(".usage-pagination button")).toContain("inline-size: var(--yc-hit-min)")
  expect(rule(".usage-consumption__rates")).toContain("display: contents")
})

test("the phone filter sheet owns visual-viewport geometry, a sticky action bar and labelled range choices", async () => {
  const filters = await Bun.file(new URL("./usage-filters.css", import.meta.url)).text()
  expect(filters).toMatch(/\.usage-filter-sheet__actions \{[^}]*position: sticky/)
  expect(filters).toMatch(/\.usage-filter-sheet__range \{[^}]*min-block-size: var\(--yc-hit-min\)/)
  expect(filters).toContain(".usage-filter-sheet__range[aria-pressed=\"true\"] > svg { visibility: visible; }")
  expect(filters).toMatch(/@media \(max-width: 767px\) \{\s*\.overlay--usage-filters \.overlay__surface \{[^}]*--usage-filters-height[^}]*\}/)
  expect(filters).not.toMatch(/animation|transition/)
})

test("phone incident rows are compact flex summaries with a 44px icon Details and no label/value cards", async () => {
  const incidents = await Bun.file(new URL("./model-incidents.css", import.meta.url)).text()
  const phone = incidents.slice(incidents.indexOf("@container (max-width: 767px)"))
  expect(phone).toContain("tr[data-incident-row] { display: flex; flex-wrap: wrap;")
  expect(incidents).toContain(".incidents__details, .incidents__pagination button { position: relative; inline-size: var(--yc-hit-min); padding: 0; }")
  expect(phone).toContain("flex: 1 1 calc(100% - var(--yc-hit-min) - var(--yc-space-3) - 1px)")
  expect(phone).not.toContain("grid-template-columns: repeat(2")
  expect(phone).not.toMatch(/\[data-label\]::before \{ content: attr\(data-label\); display: block/)
  expect(phone).toContain("text-transform: lowercase")
  expect(incidents).toContain(".incidents__details[aria-expanded=\"true\"] > svg { rotate: 90deg; }")
  expect(incidents).toContain(".incidents .incidents__detail-row > td { display: block; padding: 0; border: 0; text-align: start; white-space: normal; }")
  expect(incidents).not.toMatch(/animation|transition/)
})

test("disclosure details wrap long values and add no animation", () => {
  expect(cost).toContain("overflow-wrap: anywhere")
  expect(cost).not.toContain("animation")
  expect(cost).not.toContain("transition")
})

test("quota group headings reuse the mono text role without a rule or a nested surface", () => {
  const heading = rule(".usage-window-group")
  expect(heading).toContain("color: var(--yc-text)")
  for (const property of ["border", "background", "border-radius", "animation"]) expect(heading).not.toContain(property)
})

test("usage headings carry no section ordinal or counter and keep their owned icon children (W85)", async () => {
  for (const level of [2, 3] as const) {
    const html = renderToString(() => UsageHeading({ level, id: "usage-allowances", children: "Provider quotas" }))
    expect(html).toMatch(new RegExp(`^<h${level}[^>]*id="usage-allowances"[^>]*>Provider quotas</h${level}>$`))
    expect(html).not.toContain("§")
  }
  const sources = await Promise.all(["usage.tsx", "usage-speed.tsx", "model-incidents.tsx", "usage-sections.tsx"].map((name) => Bun.file(new URL(`./${name}`, import.meta.url)).text()))
  for (const source of sources) expect(source).not.toMatch(/ordinal|usageSectionNumbers|numbers\(\)|§/)
  expect(css).not.toMatch(/\.usage-ordinal|\.usage-title/)
  const page = sources[0]!
  expect(page).not.toMatch(/<h2/)
  expect(page).toContain('<UsageHeading level={2} id="usage-allowances"><Icon name="usage" />Provider quotas</UsageHeading>')
  expect(page).toContain('<UsageHeading level={2} id="usage-breakdown-title"><Icon name="sessions" />Breakdown</UsageHeading>')
  expect(page).toContain("<UsageGroupControl")
  expect(sources[2]).toContain('<UsageHeading level={2} id="incidents-title"><Icon name="shield" />Model incidents</UsageHeading>')
})

test("figures are sans tabular steps and labels are uppercase at wide tracking (W81, W87)", async () => {
  const speed = await Bun.file(new URL("./usage-speed.css", import.meta.url)).text()
  const speedRule = (selector: string) => speed.split(/\n(?=\S)/).filter((block) => block.startsWith(`${selector} {`)).join("\n")
  for (const block of [rule(".usage-tile h3"), speedRule(".usage-figure dt"), rule(".usage-page thead th, .usage-page thead th button")]) {
    expect(block).toContain("text-transform: uppercase")
    expect(block).toContain("letter-spacing: var(--yc-tracking-wide)")
  }
  for (const block of [rule(".usage-tile strong"), speedRule(".usage-figure__value"), rule(".usage-donut__total")]) {
    expect(block).toContain("var(--yc-font-sans)")
    expect(block).toContain("tabular-nums")
    expect(block).not.toMatch(/font-size: \d|\d+px\/|\/\d+px/)
  }
  expect(speedRule(".usage-figure__value")).toContain("var(--yc-size-2xl)/var(--yc-leading-2xl)")
  expect(rule(".usage-tile__meta")).toContain("var(--yc-font-mono)")
  expect(speedRule(".usage-figure__note")).toContain("var(--yc-font-mono)")
})

test("messages, status text and chips are flat text rather than enclosing rectangles (W83)", async () => {
  const incidents = await Bun.file(new URL("./model-incidents.css", import.meta.url)).text()
  const speed = await Bun.file(new URL("./usage-speed.css", import.meta.url)).text()
  for (const selector of [".usage-message", ".usage-provider-chip", ".usage-chart__today", ".usage-provider__plan, .usage-provider__state"]) {
    const block = rule(selector)
    expect(block).not.toBe("")
    for (const property of ["border:", "border-radius:", "background:", "padding: var(--yc-space-1)"]) expect(block).not.toContain(property)
  }
  expect(incidents).not.toMatch(/\.incidents__indicator(?:\[[^\]]*\])? \{[^}]*border/)
  for (const sheet of [css, incidents, speed]) expect(sheet).not.toContain("dashed")
})

test("Usage record rows keep a titled grid with mono metadata and open hover planes (W84)", () => {
  expect(css).toMatch(/\.usage-mobile-row__top strong \{[^}]*var\(--yc-font-sans\)/)
  expect(css).toMatch(/\.usage-mobile-row p \{[^}]*var\(--yc-font-mono\)/)
  expect(rule(".usage-breakdown tbody th")).toContain("var(--yc-font-sans)")
  expect(rule(".usage-page th, .usage-page td")).not.toContain("border")
  expect(rule(".usage-consumption__row")).not.toContain("border-top")
  expect(rule(".usage-consumption__row")).toContain("border-radius: var(--yc-radius-md)")
  expect(rule(".usage-consumption__row:hover")).toContain("background: var(--yc-surface)")
  expect(css).toMatch(/\.usage-mobile-row \{[^}]*border-radius: var\(--yc-radius-md\)/)
  expect(css).not.toMatch(/\.usage-mobile-row \{[^}]*border-top/)
  expect(css).not.toMatch(/border-(?:top|bottom|block-start|block-end): 1px/)
})
