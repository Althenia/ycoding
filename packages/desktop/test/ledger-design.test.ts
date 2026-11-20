import { expect, test } from "bun:test"
import path from "node:path"
import { SCHEMES, SCHEME_IDS, schemeTokens } from "../../../apps/web/src/theme/schemes"

const read = (file: string) => Bun.file(path.join(import.meta.dir, "..", file)).text()

const block = (source: string, selector: string) => Object.fromEntries([...(source.split(`${selector} {`)[1]?.split("}")[0] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]))
const colorValue = /^(#[\da-f]{6}|rgba\([^)]*\))$/i
const colorsOf = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([, value]) => colorValue.test(value)).map(([key, value]) => [key.slice(5), value.toLowerCase()]))
const documented = (colors: Record<string, string>) => Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, value.toLowerCase()]))
const designSpec = async () => Bun.YAML.parse((await read("DESIGN.md")).split("---")[1]!) as { colors: Record<string, string>; themes: Record<string, { colors: Record<string, string> }>; typography: Record<string, { fontFamily: string; fontSize: string; lineHeight: string }>; rounded: Record<string, string>; layout: Record<string, string> }

test("Desktop owns its typography and brand tokens and no palette role overrides", async () => {
  const [css, design] = await Promise.all([read("src/tokens.css"), read("DESIGN.md")])
  expect(css).toContain('font-family: "JetBrains Mono"')
  expect(css).toContain('--yc-font-mono: "JetBrains Mono", monospace')
  expect(Object.keys(colorsOf(block(css, ":root")))).toEqual(["brand-trace", "brand-frost", "brand-attention", "brand-tile", "brand-rule"])
  expect(css).not.toMatch(/--yc-(plane|ink|line|cobalt|mint|violet|teal|sky|amber|coral|focus|radius)-?[\w-]*:/)
  expect(design).toContain("JetBrains Mono")
})

test("Desktop documents every painted theme palette and its owned tokens in both directions", async () => {
  const [css, inherited, spec] = await Promise.all([read("src/tokens.css"), read("../../apps/web/src/styles/tokens.css"), designSpec()])
  const owned = colorsOf(block(css, ":root"))
  const light = { ...colorsOf(block(inherited, ":root")), ...owned }
  const dark = { ...light, ...colorsOf(block(inherited, '[data-theme="dark"]')), ...owned }
  expect(documented(spec.colors)).toEqual(dark)
  expect(documented(spec.themes.light!.colors)).toEqual(light)
  const schemes = SCHEME_IDS.flatMap(scheme => (["light", "dark"] as const).flatMap(mode => {
    const palette = SCHEMES[scheme].palettes[mode]
    return palette ? [[`${scheme}-${mode}`, { ...Object.fromEntries(Object.entries(schemeTokens(palette)).map(([key, value]) => [key.slice(5), value.toLowerCase()])), ...owned }] as const] : []
  }))
  expect(Object.keys(spec.themes).sort()).toEqual(["light", ...schemes.map(([name]) => name)].sort())
  for (const [name, palette] of schemes) expect(documented(spec.themes[name]!.colors)).toEqual(palette)
  const root = { ...block(inherited, ":root"), ...block(css, ":root") }
  expect(root["--yc-font-mono"]).toBe(`"${spec.typography.mono!.fontFamily}", monospace`)
  expect(root["--yc-size-sm"]).toBe(spec.typography.body!.fontSize)
  expect(root["--yc-leading-sm"]).toBe(spec.typography.body!.lineHeight)
  expect(Object.keys(spec.rounded).sort()).toEqual(Object.keys(root).filter(key => key.startsWith("--yc-radius-")).map(key => key.slice(12)).sort())
  for (const [name, value] of Object.entries(spec.rounded)) expect(root[`--yc-radius-${name}`]).toBe(value)
  expect(Object.keys(spec.layout).sort()).toEqual(Object.keys(block(css, ":root")).filter(key => key.startsWith("--rl-")).map(key => key.slice(5)).sort())
  for (const [name, value] of Object.entries(spec.layout)) expect(root[`--rl-${name}`]).toBe(value)
  expect(documented(spec.colors)).not.toEqual({ ...dark, "plane-canvas": "#000000" })
  expect(documented(spec.colors)).not.toEqual({ ...dark, extra: "#000000" })
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

test("Desktop documents the icon-led conversation and Companion as binding rules", async () => {
  const design = await read("DESIGN.md")
  for (const [id, terms] of [
    ["D9", ["14px", "16px", "20px", "plane-raised", "plane-chrome", "elevation-float", "pending decisions", "destructive"]],
    ["D34", ["trailing edge", "78%", "42rem", "author label"]],
    ["D35", ["subagent_notification", "started", "progress", "parent answers", "goal steers"]],
    ["D36", ["full inner width", "scrollWidth <= clientWidth", "Diagnostics", "Compaction history"]],
    ["D37", ["Working", "360°", "reduced motion"]],
    ["D38", ["session title", "connection status", "trailing"]],
    ["D39", ["600 models", "focus return"]],
    ["D40", ["Markdown", "language", "Copy", "native clipboard"]],
    ["D27", ["leading edge", "neutral ink", ":focus-visible", "2px offset"]],
    ["D51", ["80px", "72×56px", "Chat", "Team", "Projects", "Workspaces", "Usage", "Settings", "aria-current"]],
    ["D52", ["280px", "256px", "232px", "360px", "separator", "8px steps", "Home/End"]],
    ["D53", ["28px", "running count", "token readout", "D32"]],
    ["D54", ["2px mint trace", "aria-hidden", "child task started", "static 50%"]],
    ["D55", ["Needs action", "Running", "Pinned", "Recent", "workspace name"]],
  ] as const) {
    const rule = design.split("\n").find(line => line.startsWith(`| ${id} | approved |`))
    expect(rule).toBeDefined()
    for (const term of terms) expect(rule).toContain(term)
  }
})

test("Desktop component chrome has distinct toolbar and inspector tokens", async () => {
  const [css, design] = await Promise.all([read("src/tokens.css"), read("DESIGN.md")])
  for (const [name, value] of Object.entries({ header: 40, "workspace-inspector": 420, "project-inspector": 400, "diff-files": 340, "diff-header": 57, "team-inspector": 320, "session-toolbar": 40, "team-toolbar": 40, "project-toolbar": 44, "workspace-toolbar": 48, "coordination-toolbar": 56, "dialog-header": 40, "system-header": 48, "window-min-width": 1000, "window-min-height": 600 })) expect(css).toContain(`--rl-${name}: ${value}px;`)
  expect(design).toContain("| D49 | approved |")
})

test("Desktop owns no width rules below its 1000px native floor", async () => {
  const design = await read("DESIGN.md")
  const sources = await Promise.all(["src/style.css", "src/compact.css", "src/diff-view.css", "src/renderer.tsx", "src/responsive-layer.tsx", "src/diff-view.tsx"].map(read))
  const floor = Bun.YAML.parse(design.split("---")[1]!) as { layout: Record<string, string> }
  expect(floor.layout["window-min-width"]).toBe("1000px")
  expect(floor.layout["window-min-height"]).toBe("600px")
  const widths = sources.flatMap(source => [...source.matchAll(/(max|min)-width:\s*(\d+)px\)/g)].filter(match => !source.slice(Math.max(0, match.index - 40), match.index).includes("@container")).map(match => `${match[1]}-width: ${match[2]}px`))
  expect(widths.filter(rule => rule.startsWith("max") ? Number(rule.slice(11, -2)) < 1000 : Number(rule.slice(11, -2)) <= 1000)).toEqual([])
  const rule = design.split("\n").find(line => line.startsWith("| D49 | approved |"))
  expect(rule).toContain("1000×600px")
  expect(design).not.toContain("700px compact")
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

test("Every Desktop theme keeps ink, boundary, plane and state-graphic contrast floors", async () => {
  const spec = await designSpec()
  const luminance = (hex: string) => hex.match(/[\da-f]{2}/gi)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0)
  const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
  const floor = (role: string, planes: readonly string[], colors: Record<string, string>) => Math.min(...planes.map(plane => contrast(colors[role]!, colors[plane]!)))
  const planes = ["plane-chrome", "plane-canvas", "plane-raised"]
  const themes = { dark: spec.colors, ...Object.fromEntries(Object.entries(spec.themes).map(([name, theme]) => [name, theme.colors])) }
  const failures = Object.entries(themes).flatMap(([name, colors]) => [
    ...["ink", "ink-secondary", "ink-tertiary"].filter(role => floor(role, [...planes, "plane-hover", "plane-selected"], colors) < 4.5).map(role => `${name} ${role}`),
    ...["line-field", "line-subtle", "focus", "cobalt-graphic", "mint-graphic", "amber-graphic", "coral-graphic"].filter(role => floor(role, planes, colors) < 3).map(role => `${name} ${role}`),
    ...(contrast(colors["on-cobalt"]!, colors["cobalt-solid"]!) < 4.5 ? [`${name} on-cobalt`] : []),
    ...(new Set(["ink", "ink-secondary", "ink-tertiary"].map(role => colors[role])).size < 3 ? [`${name} ink tiers`] : []),
    ...(new Set(planes.map(role => colors[role])).size < 3 ? [`${name} planes`] : []),
  ])
  expect(failures).toEqual([])
})
