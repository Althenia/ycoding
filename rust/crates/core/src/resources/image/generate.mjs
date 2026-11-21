import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const modulePath = process.env.YCODING_PHOTON_MODULE
if (!modulePath) throw new Error("Supply YCODING_PHOTON_MODULE for already installed Photon 0.3.4")
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(path.join(path.dirname(modulePath), "package.json"), "utf8"))
if (manifest.version !== "0.3.4") throw new Error("Require Photon 0.3.4")
const photon = require(modulePath)
const directory = path.dirname(fileURLToPath(import.meta.url))
if (process.argv.includes("--inputs")) {
  for (const [name, width, height] of [["small", 8, 6], ["portrait", 4, 16], ["noise", 32, 32]]) {
    const pixels = Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 73 + Math.floor(i / 4) * 29) % 256)
    const image = new photon.PhotonImage(Uint8Array.from(pixels), width, height)
    writeFileSync(path.join(directory, `${name}.png`), image.get_bytes())
    if (name === "noise") writeFileSync(path.join(directory, "noise.jpg"), image.get_bytes_jpeg(82))
    image.free()
  }
}
const source = execFileSync("git", ["show", "main:packages/core/src/image/photon.ts"], { encoding: "utf8" })
const qualities = source.match(/const JPEG_QUALITIES = (\[[^\]]+\])/)[0]
const normalizer = source.split('return Effect.fn("Image.Photon.normalize")(')[1].replace(/\)\n\}\)\s*$/, "").replace("function*", "async function").replace("const photon = yield* loadPhoton", "").replaceAll("return yield* new SizeError", "throw new SizeError").replaceAll("yield*", "await")
class DecodeError extends Error { constructor(fields) { super("decode"); Object.assign(this, fields); this.kind = "decode" } }
class SizeError extends Error { constructor(fields) { super("size"); Object.assign(this, fields); this.kind = "size" } }
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`${qualities};return (${normalizer})`)
const normalize = new Function("photon", "DecodeError", "SizeError", "Effect", code)(photon, DecodeError, SizeError, { try: ({ try: run, catch: fail }) => { try { return run() } catch (error) { throw fail(error) } } })
const defaults = { autoResize: true, maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 5 * 1024 * 1024 }
const cases = [
  ["small.png", {}], ["small.png", { maxWidth: 4, maxHeight: 4 }], ["portrait.png", { maxWidth: 3, maxHeight: 5 }],
  ["small.png", { autoResize: false, maxWidth: 1 }], ["noise.png", { maxBase64Bytes: 1200 }],
  ["noise.png", { maxBase64Bytes: 900 }], ["noise.png", { maxBase64Bytes: 300 }], ["noise.jpg", { maxWidth: 12, maxHeight: 12 }],
  ["noise.jpg", {}], ["small.png", { maxBase64Bytes: 1 }], [null, {}],
  ["small.png", { autoResize: false, maxWidth: 5000000000, maxHeight: 6000000000, maxBase64Bytes: 1 }],
]
const result = []
for (const [filename, overrides] of cases) {
  const content = { uri: `fixture://${filename || "invalid"}`, name: "Fixture image", content: filename ? readFileSync(path.join(directory, filename)).toString("base64") : "bm90IGFuIGltYWdl", encoding: "base64", mime: filename?.endsWith("jpg") ? "image/jpeg" : "image/png" }
  const limits = { ...defaults, ...overrides }
  try {
    const output = await normalize(content.uri, content, limits)
    const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(output.content, "base64"))
    result.push({ content, limits, output, width: decoded.get_width(), height: decoded.get_height() })
    decoded.free()
  } catch (error) {
    result.push({ content, limits, error: { kind: error.kind, resource: error.resource, ...(error.kind === "size" ? { width: error.width, height: error.height, bytes: error.bytes, maxWidth: error.maxWidth, maxHeight: error.maxHeight, maxBytes: error.maxBytes } : {}) } })
  }
}
writeFileSync(path.join(directory, "corpus.json"), JSON.stringify(result, null, 2) + "\n")
