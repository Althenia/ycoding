import { expect, test } from "bun:test"
import { z } from "zod"
import { viewAssets, viewPolicy } from "../view/assets"

const document = await Bun.file(new URL("../view/DESIGN.md", import.meta.url)).text()
const stylesheet = await Bun.file(new URL("../view/style.css", import.meta.url)).text()

function differences(document: string, css: string) {
  const spec = z
    .object({
      colors: z.record(z.string(), z.string()),
      themes: z.object({ dark: z.object({ colors: z.record(z.string(), z.string()) }) }),
      typography: z.object({
        body: z.object({ fontFamily: z.string(), fontSize: z.string(), lineHeight: z.number() }),
        mono: z.object({ fontFamily: z.string() }),
        metrics: z.object({ fontSize: z.string() }),
      }),
      rounded: z.object({ control: z.string(), panel: z.string() }),
      spacing: z.object({ gap: z.string(), padding: z.string() }),
      controls: z.object({ height: z.string(), focus: z.string() }),
      layout: z.object({
        content: z.string(),
        operations: z.string(),
        insights: z.string(),
        dialog: z.string(),
      }),
      motion: z.object({ duration: z.object({ quick: z.string() }), easing: z.object({ standard: z.string() }) }),
    })
    .parse(Bun.YAML.parse(document.split("---")[1]))
  const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map((match) =>
    Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]+);/g)].map((value) => [value[1], value[2]])),
  )
  const changes = [
    { label: "light", expected: spec.colors, actual: roots[0] },
    { label: "dark", expected: spec.themes.dark.colors, actual: roots[1] },
  ].flatMap(({ label, expected, actual }) => {
    if (!actual) return ["missing-root"]
    return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
      .filter((key) => expected[key] !== actual[key])
      .map((key) => `${label}.${key}`)
  })
  const value = (key: string) => new RegExp(`--${key}:\\s*([^;]+);`).exec(css)?.[1].trim()
  const body = /font:\s*(\d+px)\/([\d.]+) var\(--font-sans\)/.exec(css)
  const pairs = [
    [spec.typography.body.fontFamily, value("font-sans")],
    [spec.typography.mono.fontFamily, value("font-mono")],
    [spec.typography.body.fontSize, body?.[1]],
    [spec.typography.body.lineHeight, Number(body?.[2])],
    [spec.rounded.control, value("radius-control")],
    [spec.rounded.panel, value("radius-panel")],
    [spec.spacing.gap, value("gap")],
    [spec.spacing.padding, value("padding")],
    [spec.controls.height, value("control-height")],
    [spec.controls.focus, value("focus-width")],
    [spec.layout.content, value("content-width")],
    [spec.layout.operations, value("operations-width")],
    [spec.layout.insights, value("insights-width")],
    [spec.layout.dialog, value("dialog-width")],
    [spec.motion.duration.quick, value("quick")],
    [spec.motion.easing.standard, value("ease")],
    [spec.typography.metrics.fontSize, /dd\s*\{[^}]*font:\s*(\d+px)/.exec(css)?.[1]],
  ]
  pairs.forEach(([expected, actual], index) => {
    if (expected !== actual) changes.push(`token.${index}`)
  })
  return changes
}

test("Telemetry design values match CSS both ways and reject light/dark/missing/extra/type/layout drift", () => {
  expect(differences(document, stylesheet)).toEqual([])
  expect(differences(document, stylesheet.replace("--focus: #0b8b50;", "--focus: #ffffff;"))).toContain("light.focus")
  expect(differences(document, stylesheet.replace("--focus: #4ee29b;", "--focus: #ffffff;"))).toContain("dark.focus")
  expect(differences(document, stylesheet.replace("--focus: #0b8b50;", ""))).toContain("light.focus")
  expect(
    differences(document, stylesheet.replace("--focus: #0b8b50;", "--focus: #0b8b50; --extra: #ffffff;")),
  ).toContain("light.extra")
  expect(
    differences(document.replace('  focus: "#0b8b50"', '  focus: "#0b8b50"\n  extra: "#ffffff"'), stylesheet),
  ).toContain("light.extra")
  expect(differences(document, stylesheet.replace("--control-height: 44px", "--control-height: 32px"))).toContain(
    "token.8",
  )
  expect(differences(document, stylesheet.replace("--font-sans:", "--missing-font:"))).toContain("token.0")
  expect(differences(document, stylesheet.replace("--operations-width: 272px", "--operations-width: 280px"))).toContain(
    "token.11",
  )
  expect(differences(document, stylesheet.replace("--insights-width: 300px", "--insights-width: 0px"))).toContain(
    "token.12",
  )
})

test("binary-embedded Telemetry assets use external scripts, canonical local fonts/mark and strict CSP", async () => {
  const page = viewAssets.get("/view")!.body
  const script = viewAssets.get("/view/app.js")!.body
  const css = viewAssets.get("/view/style.css")!.body
  expect(page).toContain('<script type="module" src="/view/app.js"></script>')
  expect(page).not.toMatch(/<script[^>]*>\s*[^<\s]/)
  expect(page).not.toMatch(/\son\w+=/)
  expect(page).not.toContain("https://")
  expect(script).toContain('history.replaceState(null, "", location.pathname)')
  expect(script).not.toMatch(/localStorage|sessionStorage|innerHTML/)
  expect(viewPolicy).toContain("default-src 'none'")
  expect(viewPolicy).toContain("frame-ancestors 'none'")
  expect(viewPolicy).not.toContain("unsafe-inline")
  expect(css).toContain("SIL OPEN FONT LICENSE")
  for (const [family, file] of [
    ["Geist", "Geist.woff2"],
    ["Geist Mono", "GeistMono.woff2"],
  ]) {
    expect(css).toContain(`font-family: "${family}"`)
    const font = await Bun.file(new URL(`../../../assets/brand/fonts/${file}`, import.meta.url)).bytes()
    expect(css).toContain(Buffer.from(font).toString("base64"))
  }
  expect(viewAssets.get("/view/mark.svg")!.body).toBe(
    await Bun.file(new URL("../../../assets/brand/ycoding-mark.svg", import.meta.url)).text(),
  )
  expect(css).toContain("prefers-reduced-motion")
  expect(css).toContain(":focus-visible")
  expect(page).toContain('id="findings"')
  expect(page).not.toContain('id="findings" open')
  expect(page).not.toContain('id="operations-toggle"')
  expect(page).not.toContain('id="operations-content"')
  expect(page).not.toMatch(/chat-drawer|open-chat|close-chat|class="reader"/)
  expect(css).not.toMatch(/--measure:|--drawer-width:|\.reader|\.runtime-strip|#chat-drawer|operations-collapsed/)
})

test("Bun bundles every Telemetry asset as text without runtime filesystem lookup", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../view/assets.ts", import.meta.url).pathname],
    target: "bun",
  })
  expect(build.success).toBe(true)
  const output = await build.outputs[0].text()
  expect(output).toContain("<title>YCoding Meeting</title>")
  expect(output).toContain("data:font/woff2;base64,")
  expect(output).toContain("history.replaceState")
  expect(output).toContain("/view/model.js")
  expect(output).not.toMatch(/Bun\.file|readFileSync|readFile\(/)
})
