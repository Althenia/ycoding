import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { licenseSource, outputs, render, sources } from "../../../packages/cli/script/generate-extension-fonts"

const repository = path.resolve(import.meta.dir, "../../..")

async function scratch(sans = "wOF2-sans", mono = "wOF2-mono") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-fonts-"))
  await mkdir(path.join(directory, "assets/brand/fonts"), { recursive: true })
  await Bun.write(path.join(directory, sources.sans), sans)
  await Bun.write(path.join(directory, sources.mono), mono)
  await Bun.write(path.join(directory, licenseSource), "Copyright test\nLicense test\n")
  return directory
}

describe("generated extension fonts", () => {
  test("fonts.js and the popup.css font block equal the output rendered from the canonical Geist assets", async () => {
    const rendered = await render({ directory: repository })
    expect(await Bun.file(path.join(repository, outputs.module)).text()).toBe(rendered.module)
    expect(await Bun.file(path.join(repository, outputs.stylesheet)).text()).toBe(rendered.stylesheet)
  })

  test("each artifact carries the complete upstream copyright and license verbatim", async () => {
    const license = (await Bun.file(path.join(repository, "assets/brand/fonts/OFL.txt")).text()).trim()
    expect(license).toContain("Copyright 2024 The Geist Project Authors")
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1")
    for (const output of [outputs.module, outputs.stylesheet])
      expect(await Bun.file(path.join(repository, output)).text(), output).toContain(`/*! Geist and Geist Mono font data. Upstream copyright and license, copied verbatim from assets/brand/fonts/OFL.txt:\n\n${license}\n*/`)
  })

  test("the embedded bytes are the unmodified WOFF2 files", async () => {
    const worker = await import("../fonts.js")
    const css = await Bun.file(new URL("../popup.css", import.meta.url)).text()
    const embedded = [...css.matchAll(/font-family: "([^"]+)";\s+src: url\("data:font\/woff2;base64,([A-Za-z0-9+/=]+)"\)/g)]
    expect(embedded.map((match) => match[1])).toEqual(["Geist", "Geist Mono"])
    for (const [family, source] of [["Geist", sources.sans], ["Geist Mono", sources.mono]]) {
      const original = await Bun.file(path.join(repository, source)).bytes()
      const data = embedded.find((match) => match[1] === family)[2]
      expect(Buffer.compare(Buffer.from(data, "base64"), Buffer.from(original))).toBe(0)
    }
    expect(Buffer.compare(Buffer.from(worker.geistSans, "base64"), await Bun.file(path.join(repository, sources.sans)).bytes())).toBe(0)
  })

  test("a changed source font changes both outputs and regeneration overwrites a hand-edited block", async () => {
    const directory = await scratch()
    const changed = await scratch("wOF2-sans-changed")
    try {
      const stylesheet = ":root { color: red }\n"
      const baseline = await render({ directory, stylesheet })
      expect((await render({ directory: changed, stylesheet })).module).not.toBe(baseline.module)
      expect((await render({ directory: changed, stylesheet })).stylesheet).not.toBe(baseline.stylesheet)
      const edited = baseline.stylesheet.replace("font-weight: 100 900", "font-weight: 400")
      expect((await render({ directory, stylesheet: edited })).stylesheet).toBe(baseline.stylesheet)
      expect(baseline.module).toContain(Buffer.from("wOF2-sans").toString("base64"))
      expect(baseline.module).not.toContain(Buffer.from("wOF2-mono").toString("base64"))
    } finally {
      await Promise.all([rm(directory, { recursive: true, force: true }), rm(changed, { recursive: true, force: true })])
    }
  })

  test("regeneration is idempotent, keeps the hand-written stylesheet around the block, and rejects damaged input", async () => {
    const directory = await scratch()
    const empty = await scratch("not a font")
    try {
      const first = await render({ directory, stylesheet: "a { b: c }\n" })
      expect(await render({ directory, stylesheet: first.stylesheet })).toEqual(first)
      const surrounded = await render({
        directory,
        stylesheet: first.stylesheet.replace("a { b: c }", "top { x: y }").concat("tail { z: w }\n"),
      })
      expect(surrounded.stylesheet.startsWith("top { x: y }")).toBe(true)
      expect(surrounded.stylesheet.endsWith("tail { z: w }\n")).toBe(true)
      expect(surrounded.stylesheet.match(/generated:fonts begin/g)).toHaveLength(1)
      await expect(render({ directory, stylesheet: first.stylesheet.replace("/* generated:fonts end */", "") })).rejects.toThrow("unterminated")
      await expect(render({ directory: empty, stylesheet: "" })).rejects.toThrow("not a WOFF2 font")
    } finally {
      await Promise.all([rm(directory, { recursive: true, force: true }), rm(empty, { recursive: true, force: true })])
    }
  })
})
