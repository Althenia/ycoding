import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./logo.tsx", import.meta.url)).text()
const css = await Bun.file(new URL("./logo.css", import.meta.url)).text()

describe("logo", () => {
  test("uses the canonical YCoding mark geometry for compact and splash assets", () => {
    expect(source).toContain(
      'd="M40 40h32v64H40zm144 0h32v64h-32zM40 112h64v64H72v-32H40zm112 0h64v32h-32v32h-32zm-40 72h32v32h-32z"',
    )
    expect(source).toContain('fill="#67D7A4"')
    expect(source).toContain('data-component="logo-mark"')
    expect(source).toContain('data-component="logo-splash"')
    expect(source).toContain('viewBox="0 0 256 256"')
    expect(css).toContain("aspect-ratio: 1")
  })

  test("uses the canonical YCoding wordmark", () => {
    expect(source).toContain('viewBox="0 0 720 160"')
    expect(source).toContain('transform="translate(24 24) scale(.4375)"')
    expect(source).toContain('d="M40 40h40l48 64-24 32z"')
    expect(source).toContain('transform="rotate(45 128 116)"')
    expect(source).toContain("YCoding")
    expect(source).toContain("terminal coding agent")
    expect(source).toContain('fill="var(--icon-strong-base)"')
    expect(source).not.toContain('fill="#F2F3F5"')
  })
})
