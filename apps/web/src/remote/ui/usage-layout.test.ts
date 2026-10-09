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

test("quota windows and legend entries carry no nested decorative borders", () => {
  expect(rule(".usage-window")).not.toContain("border: 1px")
  expect(rule(".usage-window")).not.toContain("background")
  expect(css).not.toMatch(/\.usage-distribution__legend li \{[^}]*border: 1px/)
})

test("cards do not stagger their entry", () => {
  expect(css).not.toContain("--usage-index")
  expect(css).not.toContain("animation-delay")
  expect(css).not.toContain("usage-card-enter")
})

test("responsive layout follows the content width beside the global rail", () => {
  expect(rule(".usage-page")).toContain("container-type: inline-size")
  expect(css).not.toMatch(/@media \((min|max)-width: (768|1023|1024|1280)px\)/)
  for (const query of ["@container (min-width: 768px)", "@container (min-width: 1024px)", "@container (min-width: 1280px)", "@container (max-width: 1023px)"]) expect(css).toContain(query)
})
