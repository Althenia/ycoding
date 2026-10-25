import { describe, expect, test } from "bun:test"

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
