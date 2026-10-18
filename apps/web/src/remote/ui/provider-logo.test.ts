import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { ProviderLogo, providerLogo } from "./provider-logo"
import { declarationsWhere, parseStylesheet } from "../../styles/css-rules"

const providers = ["anthropic", "openrouter", "openai", "meta", "muse", "github-copilot", "xai", "zai", "zai-coding-plan", "cursor", "opencode-go"]

test("provider marks cover exactly the built-in account usage adapters", async () => {
  const source = await Bun.file(new URL("../../../../../packages/core/src/provider-usage.ts", import.meta.url)).text()
  const adapters = source.match(/adapters:\s*\{([\s\S]*?)\n\s*\},\n\s*ttlMs/)
  expect(adapters).not.toBeNull()
  const ids = [...adapters![1]!.matchAll(/^\s*(?:"([^"]+)"|(\w+))(?::.*)?,\s*$/gm)].map((match) => match[1] ?? match[2])
  expect(ids.sort()).toEqual([...providers].sort())
  const component = await Bun.file(new URL("./provider-logo.tsx", import.meta.url)).text()
  expect([...component.matchAll(/\[\s*"([^"]+)"\s*,/g)].map((match) => match[1]).sort()).toEqual([...providers].sort())
  for (const id of providers) expect(providerLogo(id)).toBeDefined()
  const providerID = "opencode"
  for (const id of ["", providerID, "google", "runpod", "OpenAI", "custom", "constructor", "__proto__"]) expect(providerLogo(id)).toBeUndefined()
})

test("unknown providers add no markup or whitespace around their existing label", () => {
  expect(renderToString(() => ProviderLogo({ providerID: "custom" }))).toBe("")
  expect(renderToString(() => ["Custom provider", ProviderLogo({ providerID: "custom" }), " · unreported"]).replace(/<!--[\s\S]*?-->/g, "")).toBe("Custom provider · unreported")
})

test("each known mark is decorative and leaves the provider label to its consumer", () => {
  for (const providerID of providers) {
    const html = renderToString(() => ProviderLogo({ providerID }))
    expect(html).toContain('class="provider-logo"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toMatch(/<(?:a|button)\b|tabindex=|aria-label=/)
    expect(html).not.toContain("https://")
    for (const image of html.matchAll(/<img\b[^>]*>/g)) expect(image[0]).toMatch(/\balt(?:=""|(?=\s|>))/)
  }
})

test("all bundled marks are safe transparent vectors without embedded app tiles", async () => {
  const files = new Set(providers.flatMap((id) => {
    const logo = providerLogo(id)!
    return [logo.src, logo.dark].filter((file): file is string => file !== undefined)
  }))
  for (const file of files) {
    expect(file).toEndWith(".svg")
    const svg = await Bun.file(new URL(file)).text()
    expect(svg).toMatch(/<svg\b[^>]*viewBox=/)
    expect(svg).toMatch(/<path\b/)
    expect(svg).not.toMatch(/<(?:rect|image|foreignObject|script|text)\b|\bon\w+\s*=|(?:href|src)\s*=|data:|https?:\/\/(?!www\.w3\.org)/i)
    expect(svg).not.toMatch(/background\s*:/i)
  }
})

test("supplied Claude, OpenRouter and Meta colors remain inside their transparent glyphs", async () => {
  expect(await Bun.file(new URL(providerLogo("anthropic")!.src)).text()).toContain('#D97757')
  expect(await Bun.file(new URL(providerLogo("openrouter")!.src)).text()).toContain('#C8FF00')
  expect(await Bun.file(new URL(providerLogo("meta")!.src)).text()).toContain('#0082FB')
  for (const id of ["anthropic", "openrouter", "meta", "muse"]) expect(providerLogo(id)!.monochrome).not.toBe(true)
  expect(providerLogo("meta")).toBe(providerLogo("muse"))
  expect(providerLogo("zai")).toBe(providerLogo("zai-coding-plan"))
})

test("neutral marks use source currentColor masks or the supplied Cursor theme originals", async () => {
  for (const id of ["openai", "github-copilot", "xai", "zai", "zai-coding-plan", "opencode-go"]) {
    const logo = providerLogo(id)!
    expect(logo.monochrome).toBe(true)
    expect(await Bun.file(new URL(logo.src)).text()).toContain('currentColor')
  }
  const cursor = providerLogo("cursor")!
  expect(await Bun.file(new URL(cursor.src)).text()).toContain('#26251e')
  expect(await Bun.file(new URL(cursor.dark!)).text()).toContain('#edecec')
  const html = renderToString(() => ProviderLogo({ providerID: "cursor" }))
  expect(html).toContain('provider-logo__light')
  expect(html).toContain('provider-logo__dark')
})

test("logo geometry and theme treatment have no tile, border, shadow, filter or color rewrite", async () => {
  const css = await Bun.file(new URL("./provider-logo.css", import.meta.url)).text()
  const sheet = parseStylesheet("provider-logo.css", css)
  const logo = declarationsWhere(sheet, (rule) => rule.header === ".provider-logo")
  expect(logo["inline-size"]).toBe("var(--yc-space-5)")
  expect(logo["block-size"]).toBe("var(--yc-space-5)")
  expect(logo.background).toBe("transparent")
  expect(logo.border).toBe("0")
  expect(logo["box-shadow"]).toBe("none")
  expect(css).toContain("object-fit: contain")
  expect(css).toContain("mask-size: contain")
  expect(css).toContain(':root[data-theme="dark"]')
  expect(css).toContain('prefers-color-scheme: dark')
  expect(css).toContain('currentColor')
  expect(css).not.toMatch(/filter\s*:|mix-blend-mode\s*:|#[\da-f]{3,8}\b|gradient\(/i)
})

test("asset provenance records product attribution, transformations and the third-party license", async () => {
  const document = await Bun.file(new URL("../../assets/providers/ASSETS.md", import.meta.url)).text()
  for (const id of providers) expect(document).toContain(`\`${id}\``)
  expect(document).toContain("Claude")
  expect(document).toContain("Meta API")
  expect(document).toContain("currentColor")
  expect(document).toContain("No backgrounds")
  expect(document).toContain("https://")
  expect(await Bun.file(new URL("../../assets/providers/LICENSE.lobehub", import.meta.url)).text()).toContain("MIT License")
})
