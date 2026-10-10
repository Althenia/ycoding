import { expect, test } from "bun:test"

const document = await Bun.file(new URL("../DESIGN.md", import.meta.url)).text()
const stylesheet = await Bun.file(new URL("../companion/popup.css", import.meta.url)).text()
const html = await Bun.file(new URL("../companion/popup.html", import.meta.url)).text()
const manifest = await Bun.file(new URL("../companion/manifest.json", import.meta.url)).json()

function drift(document, css) {
  const spec = Bun.YAML.parse(document.split("---")[1])
  const roots = Array.from(css.matchAll(/:root\s*\{([^}]+)\}/g), (match) =>
    Object.fromEntries(Array.from(match[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]+);/g), (value) => [value[1], value[2]])),
  )
  const differences = []
  for (const [label, expected, actual] of [
    ["light", spec.colors, roots[0]],
    ["dark", spec.themes.dark.colors, roots[1]],
  ]) {
    for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)]))
      if (expected[name] !== actual[name]) differences.push(`${label}.${name}`)
  }
  const variable = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim().replaceAll('"', "")
  const body = /font:\s*(\d+px)\/([\d.]+) var\(--font-sans\)/.exec(css)
  const pairs = [
    [spec.typography.body.fontFamily, variable("font-sans")],
    [spec.typography.mono.fontFamily, variable("font-mono")],
    [spec.typography.body.fontSize, body?.[1]],
    [spec.typography.body.lineHeight, Number(body?.[2])],
    [spec.rounded.control, variable("radius-control")],
    [spec.rounded.card, variable("radius-card")],
    [spec.spacing.gap, variable("gap")],
    [spec.spacing.padding, variable("padding")],
    [spec.controls.height, variable("control-height")],
    [spec.controls.focus, variable("focus-width")],
    [spec.layout.width, variable("popup-width")],
  ]
  pairs.forEach(([expected, actual], index) => {
    if (expected !== actual) differences.push(`token.${index}`)
  })
  return differences
}

test("companion palette matches design in both directions; changed, missing, extra and dark values fail", () => {
  expect(drift(document, stylesheet)).toEqual([])
  expect(drift(document, stylesheet.replace("--focus: #1764b2", "--focus: #ffffff"))).toContain("light.focus")
  expect(drift(document, stylesheet.replace("--focus: #1764b2;", ""))).toContain("light.focus")
  expect(drift(document, stylesheet.replace("--focus: #a9d0ff", "--focus: #ffffff"))).toContain("dark.focus")
  expect(
    drift(document.replace('  badge-on: "#28753e"', '  badge-on: "#28753e"\n  extra: "#ffffff"'), stylesheet),
  ).toContain("light.extra")
  expect(drift(document, stylesheet.replace("--focus: #1764b2;", "--focus: #1764b2; --extra: #ffffff;"))).toContain(
    "light.extra",
  )
  expect(drift(document.replace("height: 34px", "height: 40px"), stylesheet)).toContain("token.8")
  expect(drift(document, stylesheet.replace("--font-sans:", "--missing-font:"))).toContain("token.0")
})

test("popup owns accessible controls, local typography, state and shortcut without broad Meet host access", () => {
  expect(html).toContain('id="status" role="status" aria-live="polite"')
  expect(html).toContain('id="error" role="alert"')
  expect(html).toContain('for="consent"')
  expect(html).toContain('for="microphone"')
  expect(html).toContain("headphones")
  expect(html).toContain("echo cancellation")
  expect(stylesheet).toContain("--control-height: 34px")
  expect(stylesheet).toContain("@media (pointer: coarse)")
  expect(stylesheet).toContain("min-height: 44px")
  expect(html).toContain("<summary>Capture help</summary>")
  expect(stylesheet).toContain(":focus-visible")
  expect(stylesheet).toContain("appearance: none")
  expect(stylesheet).toContain("forced-colors")
  expect(stylesheet).toContain('url("fonts/Geist.woff2")')
  expect(stylesheet).toContain('url("fonts/GeistMono.woff2")')
  expect(stylesheet).not.toContain("https://")
  expect(manifest.minimum_chrome_version).toBe("116")
  expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"])
  expect(manifest.commands["stop-capture"].description).toContain("Stop")
  expect(manifest.externally_connectable).toBeUndefined()
})

test("secondary capture guidance is collapsed while consent and microphone choice remain visible", () => {
  const capture = html.match(/<form id="capture"[\s\S]*?<\/form>/)?.[0]
  const help = html.match(/<details class="help"[\s\S]*?<\/details>/)?.[0]
  expect(capture).toContain('id="consent"')
  expect(capture).toContain('id="microphone"')
  expect(capture).not.toContain("Use headphones")
  expect(capture).not.toContain("Select the Meet tab")
  expect(help).toContain("Use headphones")
  expect(help).toContain("echo cancellation")
  expect(help).toContain("ycoding meeting")
  expect(help).toContain("/meeting start")
  expect(help).not.toContain('id="consent"')
  expect(help).not.toContain('id="microphone"')
  expect(help).not.toContain(" open")
})

test("the microphone access page reuses the popup treatment and is packaged", async () => {
  const page = await Bun.file(new URL("../companion/microphone.html", import.meta.url)).text()
  const build = await Bun.file(new URL("../companion/build.js", import.meta.url)).text()
  expect(page).toContain('<link rel="stylesheet" href="popup.css" />')
  expect(page).toContain('class="access-page"')
  expect(page).toContain('id="status" role="status" aria-live="polite"')
  expect(page).toContain('<button id="allow" class="primary" type="button">Allow microphone</button>')
  expect(page).toContain('<button id="settings" type="button" hidden>Open Chrome site settings</button>')
  expect(stylesheet).toContain(".access-page")
  expect(build).toContain('"microphone.html"')
  expect(build).toContain('"microphone.js"')
})

test("companion distinguishes its microphone launcher while preserving the Y header mark", () => {
  expect(manifest.icons).toEqual({
    16: "icons/ycoding-meeting-16.png",
    32: "icons/ycoding-meeting-32.png",
    48: "icons/ycoding-meeting-48.png",
    128: "icons/ycoding-meeting-128.png",
  })
  expect(manifest.action.default_icon).toEqual(manifest.icons)
  expect(html).toContain('<img src="icons/ycoding-32.png" width="24" height="24" alt=""')
})
