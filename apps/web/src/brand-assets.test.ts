import { describe, expect, test } from "bun:test"

const copies = [
  { local: "../public/brand/ycoding-mark.svg", canonical: "../../../assets/brand/ycoding-mark.svg" },
  { local: "../public/icons/icon-256.png", canonical: "../../../assets/brand/ycoding-icon-256.png" },
  { local: "../public/icons/icon-512.png", canonical: "../../../assets/brand/ycoding-icon-512.png" },
] as const

async function digest(url: URL) {
  return new Bun.CryptoHasher("sha256").update(new Uint8Array(await Bun.file(url).arrayBuffer())).digest("hex")
}

describe("canonical brand assets", () => {
  test("public copies stay byte-identical to the canonical repository files", async () => {
    for (const asset of copies) {
      const local = await digest(new URL(asset.local, import.meta.url))
      const canonical = await digest(new URL(asset.canonical, import.meta.url))
      expect(local).toBe(canonical)
    }
  })
})
