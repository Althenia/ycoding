import { expect, test } from "bun:test"

const css = await Bun.file(new URL("./usage.css", import.meta.url)).text()

function rule(selector: string) {
  return css.split(/\n(?=\S)/).filter((block) => block.startsWith(`${selector} {`)).join("\n")
}

test("summary metrics are a flat divided strip", () => {
  const strip = rule(".usage-tiles")
  expect(strip).toContain("border-block")
  expect(strip).not.toContain("gap: var(--yc-space-5)")
  const tile = rule(".usage-tile")
  expect(tile).not.toContain("border: 1px")
  expect(tile).not.toContain("background")
  expect(tile).not.toContain("animation")
  expect(rule(".usage-tile + .usage-tile")).toContain("border-inline-start")
})

test("summary values reserve two current line heights without clipping pricing coverage", () => {
  const value = rule(".usage-tile strong")
  expect(value).toContain("min-block-size: 2lh")
  expect(value).toContain("var(--yc-leading-2xl)")
  expect(css).toMatch(/@container \(max-width: 767px\) \{[^@]*\.usage-tile strong \{[^}]*line-height: var\(--yc-leading-xl\)/)
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
  expect(visuals).toContain("border-radius: var(--yc-radius-sm)")
  expect(visuals).toContain("padding: var(--yc-space-5)")
  expect(visuals).not.toContain("border:")
  const chart = rule(".usage-distribution, .usage-chart")
  for (const property of ["background:", "border:", "border-radius:"]) expect(chart).not.toContain(property)
})

test("accounting sections and phone records remain flat", async () => {
  const incidents = await Bun.file(new URL("./model-incidents.css", import.meta.url)).text()
  expect(rule(".usage-breakdown-section")).toContain("border-top: 1px solid var(--yc-border)")
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

test("quota group headings reuse the divider and mono text roles without a nested surface", () => {
  const heading = rule(".usage-window-group")
  expect(heading).toContain("border-top: 1px solid var(--yc-border)")
  expect(heading).toContain("color: var(--yc-text)")
  for (const property of ["background", "border-radius", "animation"]) expect(heading).not.toContain(property)
})
