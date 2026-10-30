import { describe, expect, test } from "bun:test"
import { declarationsWhere, readStylesheet, type Declarations, type Stylesheet } from "../../styles/css-rules"

const read = (name: string) => Bun.file(new URL(name, import.meta.url)).text()
const remoteCSS = () => Bun.file(new URL("../../styles/remote.css", import.meta.url)).text()
const rule = (css: string, selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"=]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? ""

describe("machine and device presentation", () => {
  test("renders no secondary hostname line in Machine or Devices", async () => {
    const [tsx, alias] = await Promise.all([read("settings.tsx"), read("device-alias.css")])
    expect(tsx).not.toContain("machine-row__hostname")
    expect(tsx).not.toContain("device__hostname")
    expect(alias).not.toContain("hostname")
  })

  test("keeps hostname data for tooltips, edit labels and removal identification", async () => {
    const tsx = await read("settings.tsx")
    expect(tsx).toContain("title={machine().name}")
    expect(tsx).toContain("`Name for ${machine().name}`")
    expect(tsx).toContain("`Remove ${device.name}`")
  })

  test("describes account-shared names without a hostname subtitle", async () => {
    const tsx = await read("settings.tsx")
    const scope = tsx.match(/id="machine-row-scope"[^>]*>([^<]*)</)?.[1] ?? ""
    expect(scope).toMatch(/shared across your account's browsers/)
    expect(scope).not.toMatch(/hostname|beneath/i)
  })

  test("lists machines as a vertical stack of compact rows without horizontal scrolling", async () => {
    const css = await read("device-alias.css")
    const list = rule(css, ".machine-row")
    expect(list).toContain("flex-direction: column")
    expect(list).not.toMatch(/overflow-x|scroll-snap/)
    const item = rule(css, ".machine-row__item")
    expect(item).toContain("grid-template-columns")
    expect(item).not.toMatch(/flex:|max-inline-size|scroll-snap/)
    expect(rule(css, ".machine-row .button")).toContain("min-block-size: var(--yc-hit-min)")
  })

  test("sizes Keep machine awake status to its content", async () => {
    const [css, settings] = await Promise.all([remoteCSS(), read("settings.css")])
    expect(rule(css, ".machine-awake__status")).not.toContain("min-block-size")
    expect(settings).not.toMatch(/machine-awake__status\s*\{[^}]*min-block-size/)
  })
})

const declared = (sheet: Stylesheet, selector: string, conditioned = false): Declarations =>
  declarationsWhere(sheet, (candidate) => (conditioned ? candidate.conditions.length > 0 : candidate.conditions.length === 0) && candidate.header.split(",").map((part) => part.trim()).includes(selector))

describe("W85 numbered Settings sections", () => {
  test("renders the ordinal outside the heading's accessible name", async () => {
    const tsx = await read("settings.tsx")
    const section = tsx.slice(tsx.indexOf("function Section("), tsx.indexOf("The account section shows"))
    expect(section).toContain('<span class="settings__ordinal" aria-hidden="true" />')
    expect(section).toContain("<h2 id={props.id}>{props.title}</h2>")
    expect(section).toContain("aria-labelledby={props.id}")
    expect(section.indexOf("settings__ordinal")).toBeLessThan(section.indexOf("<h2"))
    expect(section.slice(section.indexOf("<h2"), section.indexOf("</h2>"))).not.toContain("settings__ordinal")
  })

  test("numbers rendered sections from 01 in order, so a hidden Office leaves no gap", async () => {
    const css = await readStylesheet("remote.css")
    expect(declared(css, ".settings")["counter-reset"]).toBe("settings-section")
    expect(declared(css, ".settings__section")["counter-increment"]).toBe("settings-section")
    const ordinal = declared(css, ".settings__ordinal::before")
    expect(ordinal.content).toBe('"§" counter(settings-section, decimal-leading-zero)')
    expect(ordinal.color).toBe("var(--yc-green-strong)")
    expect(ordinal["font-family"]).toBe("var(--yc-font-mono)")
    const tsx = await read("settings.tsx")
    expect(tsx.match(/<Section\b/g)?.length).toBe(9)
    const shell = await Bun.file(new URL("./shell.tsx", import.meta.url)).text()
    expect(shell).toContain("<Show when={!props.phoneLayout}><OfficeSettings office={props.office} /></Show>")
    expect(shell).not.toMatch(/settings-accordion|aria-expanded[^\n]*settings__section/)
  })
})

describe("W83 flat Settings surfaces", () => {
  test("draws records as ruled rows rather than framed cards or tables", async () => {
    const css = await readStylesheet("remote.css")
    for (const selector of [".account-card", ".device-table", ".list", ".notification-table"]) {
      const surface = declared(css, selector)
      expect(surface.border === undefined || surface.border === "0").toBe(true)
      expect(surface["border-radius"] === undefined || surface["border-radius"] === "0").toBe(true)
    }
    expect(declared(css, ".device-table__head").background).toBe("transparent")
    expect(declared(css, ".notification-table thead th").background).toBe("transparent")
  })

  test("shows Appearance and Office choices as underline segments", async () => {
    const css = await readStylesheet("remote.css")
    for (const selector of [".appearance-segments .filters__option", ".office-settings .filters__option"]) {
      const option = declared(css, selector)
      expect(option["border-radius"]).toBe("0")
      expect(option["border-block-end"]).toBe("2px solid transparent")
    }
    const active = declared(css, ".appearance-segments .filters__option--active")
    expect(active["border-block-end-color"]).toBe("var(--yc-text)")
    expect(active.background).toBe("transparent")
  })
})
