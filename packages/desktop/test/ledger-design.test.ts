import { expect, test } from "bun:test"
import path from "node:path"

const read = (file: string) => Bun.file(path.join(import.meta.dir, "..", file)).text()

test("Desktop approved Stitch typography and semantic palette replace inherited presentation values", async () => {
  const [css, design, mapping] = await Promise.all([read("src/tokens.css"), read("DESIGN.md"), read("../../.stitch/DESIGN.md")])
  expect(css).toContain('font-family: "JetBrains Mono"')
  expect(css).toContain('--yc-font-mono: "JetBrains Mono", monospace')
  for (const value of ["--yc-border: #263039", "--yc-text-muted: #99A2AD", "--yc-surface-sunken: #0E151A", "--yc-info-strong: #79B8FF"]) expect(css).toContain(value)
  expect(design).toContain("5038403086787961002")
  expect(design).toContain("JetBrains Mono")
  expect(design).not.toContain("Review Home")
  expect(mapping).not.toContain("15933380309160575156")
  expect(mapping).not.toContain("specimen values")
})

test("Desktop design tokens and every owned theme declaration agree in both directions", async () => {
  const [css, design, inherited] = await Promise.all([read("src/tokens.css"), read("DESIGN.md"), read("../../apps/web/src/styles/tokens.css")])
  const spec = Bun.YAML.parse(design.split("---")[1]!) as { colors: Record<string, string>; themes: Record<string, { colors: Record<string, string> }>; typography: Record<string, { fontFamily: string; fontSize: string; lineHeight: string }>; rounded: Record<string, string>; layout: Record<string, string> }
  const block = (source: string, selector: string) => Object.fromEntries([...(source.split(`${selector} {`)[1]?.split("}")[0] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]))
  const selectors = [":root", ':root[data-theme="dark"]', ':root[data-theme="dark"]:not([data-scheme])', ':root[data-theme="light"][data-scheme="high-contrast"]', ':root[data-theme="dark"][data-scheme="high-contrast"]']
  const owned = new Set(selectors.flatMap(selector => Object.entries(block(css, selector)).filter(([, value]) => /^#[\da-f]{6}$/i.test(value)).map(([key]) => key)))
  const palette = (values: Record<string, string>) => Object.fromEntries([...owned].map(key => {
    let value = values[key]!
    while (value?.startsWith("var(")) value = values[value.slice(4, -1)]!
    return [key === "--yc-green-strong" ? "primary" : key.slice(5), value?.toUpperCase()]
  }))
  const light = { ...block(inherited, ":root"), ...block(css, ":root") }
  const dark = { ...light, ...block(css, selectors[1]!), ...block(css, selectors[2]!) }
  expect(palette(dark)).toEqual(spec.colors)
  expect(palette(light)).toEqual(spec.themes.light!.colors)
  for (const [selector, theme] of [[selectors[3]!, "high-contrast-light"], [selectors[4]!, "high-contrast-dark"]]) {
    expect(Object.fromEntries(Object.entries(block(css, selector!)).filter(([, value]) => /^#[\da-f]{6}$/i.test(value)).map(([key, value]) => [key.slice(5), value.toUpperCase()]))).toEqual(spec.themes[theme!]!.colors)
  }
  const root = block(css, ":root")
  expect(root["--yc-font-mono"]).toBe(`"${spec.typography.mono!.fontFamily}", monospace`)
  expect(root["--yc-size-sm"]).toBe(spec.typography.body!.fontSize)
  expect(root["--yc-leading-sm"]).toBe(spec.typography.body!.lineHeight)
  for (const [name, value] of Object.entries(spec.rounded)) expect(root[`--yc-radius-${name}`]).toBe(value)
  for (const [name, value] of Object.entries(spec.layout)) expect(root[`--rl-${name}`]).toBe(value)
  expect({ ...palette(dark), page: "#000000" }).not.toEqual(spec.colors)
  expect(palette(dark)).not.toEqual({ ...spec.colors, extra: "#000000" })
  expect(palette(light)).not.toEqual({ ...spec.themes.light!.colors, primary: "#000000" })
})

test("Desktop ships the real owned font weights and their redistribution license", async () => {
  const css = await read("src/tokens.css")
  for (const [weight, name] of [[400, "Regular"], [500, "Medium"], [600, "SemiBold"]] as const) {
    expect(css).toContain(`font-weight: ${weight};`)
    expect(css).toContain(`url("./fonts/JetBrainsMono-${name}.woff2")`)
    const bytes = await Bun.file(path.join(import.meta.dir, "../src/fonts", `JetBrainsMono-${name}.woff2`)).arrayBuffer()
    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe("wOF2")
  }
  expect(await read("public/JetBrainsMono-OFL.txt")).toContain("SIL OPEN FONT LICENSE Version 1.1")
})

test("Desktop palette loads after shared tokens and before component styles", async () => {
  const renderer = await read("src/renderer.tsx")
  expect(renderer.indexOf('import "./tokens.css"')).toBeGreaterThan(renderer.indexOf('import "../../../apps/web/src/styles/tokens.css"'))
  expect(renderer.indexOf('import "./style.css"')).toBeGreaterThan(renderer.indexOf('import "./tokens.css"'))
})

test("Desktop source conflicts retain the unapproved shared-chrome decision", async () => {
  const design = await read("DESIGN.md")
  expect(design).toContain("Leave override unapproved")
  expect(design).toContain("unwaived")
  expect(design).not.toContain("takes precedence")
  expect(design).not.toContain("Approval: explicit shared-chrome design decision")
  expect(design).not.toContain("approved Conversation Idle shared-chrome selection")
  const mapping = await read("../../.stitch/DESIGN.md")
  expect(mapping).toContain("surface: web")
  expect(mapping).toContain("10627183425669399580")
})

test("Desktop component chrome has distinct toolbar and inspector tokens", async () => {
  const css = await read("src/tokens.css")
  for (const [name, value] of Object.entries({ header: 40, "workspace-inspector": 420, "project-inspector": 400, "diff-files": 340, "diff-header": 57, "team-inspector": 320, "session-toolbar": 40, "team-toolbar": 40, "project-toolbar": 44, "workspace-toolbar": 48, "coordination-toolbar": 56, "dialog-header": 40, "system-header": 48 })) expect(css).toContain(`--rl-${name}: ${value}px;`)
})

test("Desktop component styles consume owned palette roles without raw colors", async () => {
  for (const file of ["src/style.css", "src/diff-view.css"]) {
    const css = await read(file)
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/gi)
  }
})

test("Desktop coordination, workspace targets and retained decision history have owned layout and capability rules", async () => {
  const [design, styles] = await Promise.all([read("DESIGN.md"), read("src/style.css")])
  for (const rule of ["D25", "D26", "D27", "D28", "D29", "D30"]) expect(design).toContain(`| ${rule} | approved |`)
  for (const surface of [".desktop-team", ".desktop-selected-inspector", ".desktop-target-columns", ".desktop-coordination-table", ".desktop-guardrail-history", ".desktop-channel-activity", ".desktop-transient-activity"]) expect(styles).toContain(surface)
  expect(styles).toContain('.conversation[data-team-open="true"] > .conversation__scroll { display: none; }')
})

test("Ledger ink, metadata, primary action and focus exceed their contrast floors", () => {
  const luminance = (hex: string) => hex.match(/[\da-f]{2}/gi)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0)
  const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
  for (const surface of ["0B1115", "11181D", "151E24", "1B1E23"]) {
    expect(contrast("F4F7F6", surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast("99A2AD", surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast("67D7A4", surface)).toBeGreaterThanOrEqual(3)
  }
  expect(contrast("0B1115", "67D7A4")).toBeGreaterThanOrEqual(4.5)
})
