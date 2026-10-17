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
  expect(css).toContain(".usage-consumption__row > .usage-details-trigger { grid-column: 2; grid-row: 1 / 4; }")
})

test("disclosure details wrap long values and add no animation", () => {
  expect(cost).toContain("overflow-wrap: anywhere")
  expect(cost).not.toContain("animation")
  expect(cost).not.toContain("transition")
})
