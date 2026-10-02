import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
export const licenseSource = "assets/brand/fonts/OFL.txt"
export const sources = {
  sans: "assets/brand/fonts/Geist.woff2",
  mono: "assets/brand/fonts/GeistMono.woff2",
} as const
export const outputs = {
  module: "extensions/chrome/fonts.js",
  stylesheet: "extensions/chrome/popup.css",
} as const

const command = "bun packages/cli/script/generate-extension-fonts.ts"
const begin = `/* generated:fonts begin - regenerate with ${command}; do not edit */`
const end = "/* generated:fonts end */"

export async function render(input: { readonly directory?: string; readonly stylesheet?: string } = {}) {
  const directory = input.directory ?? root
  const licenseText = (await Bun.file(path.join(directory, licenseSource)).text()).trim()
  if (licenseText.includes("*/")) throw new Error(`${licenseSource} cannot be embedded in a comment`)
  const legal = `/*! Geist and Geist Mono font data. Upstream copyright and license, copied verbatim from ${licenseSource}:\n\n${licenseText}\n*/`
  const [sans, mono] = await Promise.all(
    [sources.sans, sources.mono].map(async (source) => {
      const bytes = await Bun.file(path.join(directory, source)).bytes()
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "wOF2") throw new Error(`${source} is not a WOFF2 font`)
      return Buffer.from(bytes).toString("base64")
    }),
  )
  const stylesheet = input.stylesheet ?? (await Bun.file(path.join(directory, outputs.stylesheet)).text())
  return {
    module: `${legal}\n// Generated from ${sources.sans} by ${command}.\nexport const geistSans = ${JSON.stringify(sans)}\n`,
    stylesheet: withGeneratedBlock(stylesheet, fontFaces(legal, sans, mono)),
  }
}

function fontFaces(legal: string, sans: string, mono: string) {
  const face = (family: string, data: string) =>
    `@font-face {\n  font-family: ${JSON.stringify(family)};\n  src: url("data:font/woff2;base64,${data}") format("woff2");\n  font-weight: 100 900;\n  font-style: normal;\n  font-display: block;\n}`
  return `${begin}\n${legal}\n${face("Geist", sans)}\n${face("Geist Mono", mono)}\n${end}\n`
}

function withGeneratedBlock(stylesheet: string, block: string) {
  const start = stylesheet.indexOf(begin)
  if (start === -1) return `${stylesheet.trimEnd()}\n\n${block}`
  const stop = stylesheet.indexOf(end, start)
  if (stop === -1) throw new Error("popup.css has an unterminated generated font block")
  return `${stylesheet.slice(0, start)}${block}${stylesheet.slice(stop + end.length).replace(/^\n/, "")}`
}

if (import.meta.main) {
  const check = process.argv.includes("--check")
  const rendered = await render()
  const current = {
    module: await Bun.file(path.join(root, outputs.module)).text().catch(() => undefined),
    stylesheet: await Bun.file(path.join(root, outputs.stylesheet)).text(),
  }
  const drift = (["module", "stylesheet"] as const).filter((name) => current[name] !== rendered[name])
  if (check) {
    if (drift.length) console.error(`Generated extension fonts are stale: ${drift.map((name) => outputs[name]).join(", ")}`)
    process.exit(drift.length ? 1 : 0)
  }
  await Promise.all(drift.map((name) => Bun.write(path.join(root, outputs[name]), rendered[name])))
  console.log(drift.length ? `Updated ${drift.map((name) => outputs[name]).join(", ")}` : "Extension fonts are up to date")
}
