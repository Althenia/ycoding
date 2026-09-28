import { mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { characterSheet } from "./office-art/characters"
import { environmentFurniture, environmentTiles, wallTiles } from "./office-art/environment"
import { encodePNG } from "./office-art/png"

const out = join(import.meta.dir, "../src/remote/office/assets")
const images = {
  tiles: environmentTiles(),
  walls: wallTiles(),
  ...environmentFurniture(),
  characters: characterSheet(),
}
const encoded = Object.entries(images).map(([name, art]) => ({ name, art, bytes: encodePNG(art) }))
const total = encoded.reduce((sum, asset) => sum + asset.bytes.length, 0)
if (total > 400 * 1024) throw new Error(`Office art exceeds 400 KiB: ${total} bytes`)

await mkdir(out, { recursive: true })
const current = new Set(encoded.map((asset) => `${asset.name}.png`))
for (const file of await readdir(out)) {
  if (file.endsWith(".png") && !current.has(file)) await rm(join(out, file))
}
await Promise.all(encoded.map((asset) => Bun.write(join(out, `${asset.name}.png`), asset.bytes)))
await Bun.write(join(out, "manifest.json"), JSON.stringify({
  provenance: "Original procedural office art",
  license: "CC0-1.0",
  assets: encoded.map((asset) => ({ file: `${asset.name}.png`, width: asset.art.width, height: asset.art.height, bytes: asset.bytes.length })),
}, null, 2) + "\n")
console.log(`Generated ${encoded.length} original office PNGs (${total} bytes)`)
