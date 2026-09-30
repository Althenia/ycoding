import { expect, test } from "bun:test"
import { declarationsOf, declarationsWhere, readStylesheet } from "./css-rules"

test("Geist variable normal and italic faces reuse canonical same-origin font bytes with readable swap fallback", async () => {
  const faces = [...(await Bun.file(new URL("tokens.css", import.meta.url)).text()).matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => declarationsOf(match[1]!))
  expect(faces.map((face) => ({ family: face["font-family"], style: face["font-style"], weight: face["font-weight"], display: face["font-display"] }))).toEqual([
    { family: '"Geist"', style: "normal", weight: "100 900", display: "swap" },
    { family: '"Geist"', style: "italic", weight: "100 900", display: "swap" },
    { family: '"Geist Mono"', style: "normal", weight: "100 900", display: "swap" },
    { family: '"Geist Mono"', style: "italic", weight: "100 900", display: "swap" },
  ])
  expect(faces.map((face) => face.src)).toEqual(["Geist", "Geist-Italic", "GeistMono", "GeistMono-Italic"].map((name) => `url("../../../../assets/brand/fonts/${name}.woff2") format("woff2")`))
  for (const name of ["Geist", "Geist-Italic", "GeistMono", "GeistMono-Italic"]) {
    expect(new TextDecoder().decode((await Bun.file(new URL(`../../../../assets/brand/fonts/${name}.woff2`, import.meta.url)).arrayBuffer()).slice(0, 4))).toBe("wOF2")
  }
})

test("prose and compact code metadata select Geist first while preserving the owned platform fallbacks", async () => {
  const root = declarationsWhere(await readStylesheet("tokens.css"), (rule) => rule.header === ":root")
  expect(root["--yc-font-sans"]).toBe('"Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif')
  expect(root["--yc-font-mono"]).toBe('"Geist Mono", ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, monospace')
})

test("all four canonical font faces enter the existing HTML resource-discovery contract", async () => {
  const html = await Bun.file(new URL("../../index.html", import.meta.url)).text()
  const links = [...html.matchAll(/<link\b[^>]*\bas="font"[^>]*>/g)].map((match) => match[0])
  expect(links).toHaveLength(4)
  for (const name of ["Geist", "GeistMono"]) expect(links.some((link) => link.includes('rel="preload"') && link.includes(`/${name}.woff2`))).toBe(true)
  for (const name of ["Geist-Italic", "GeistMono-Italic"]) expect(links.some((link) => link.includes('rel="prefetch"') && link.includes(`/${name}.woff2`))).toBe(true)
  expect(links.every((link) => link.includes('type="font/woff2"') && link.includes("crossorigin") && link.includes('href="../../assets/brand/fonts/'))).toBe(true)
})
