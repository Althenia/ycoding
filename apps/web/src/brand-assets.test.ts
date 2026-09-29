import { describe, expect, test } from "bun:test"

const copies = [
  { local: "../public/brand/ycoding-mark.svg", canonical: "../../../assets/brand/ycoding-mark.svg" },
  { local: "../public/icons/icon-256.png", canonical: "../../../assets/brand/ycoding-icon-256.png" },
  { local: "../public/icons/icon-192.png", canonical: "../../../assets/brand/ycoding-icon-192.png" },
  { local: "../public/icons/icon-512.png", canonical: "../../../assets/brand/ycoding-icon-512.png" },
  { local: "../public/icons/icon-maskable-512.png", canonical: "../../../assets/brand/ycoding-icon-maskable-512.png" },
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

  test("installed-app and home-screen icons use the padded maskable variant", async () => {
    const manifest = await Bun.file(new URL("../public/manifest.webmanifest", import.meta.url)).json()
    const icons: readonly { readonly src: string; readonly sizes: string; readonly type: string; readonly purpose: string }[] = manifest.icons
    expect(icons.filter((icon) => icon.purpose.split(" ").includes("maskable"))).toEqual([
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ])
    expect(manifest).toMatchObject({ id: "/remote", name: "YCoding", short_name: "YCoding", start_url: "/remote", display: "standalone" })
    expect(icons.some((icon) => icon.sizes === "192x192" && icon.purpose === "any")).toBe(true)
    expect(icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "any")).toBe(true)
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text()
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/icon-maskable-512.png" />')
  })
})
