import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("uses the canonical YCoding mark and visible name in every callback state", async () => {
    const mark = await Bun.file(new URL("../../../assets/brand/ycoding-mark.svg", import.meta.url)).text()
    const geometry = mark.match(/<path[^>]+>/)?.[0]
    expect(geometry).toBeDefined()
    for (const html of [
      OauthCallbackPage.success({ provider: "Test integration", autoClose: false }),
      OauthCallbackPage.error("Test error", { provider: "Test integration" }),
      OauthCallbackPage.bootstrap({ provider: "Test integration", tokenPath: "/callback" }),
    ]) {
      const brand = html.match(/<div class="brand">([\s\S]*?)<\/div>/)?.[1]
      expect(brand).toContain("<span>YCoding</span>")
      expect(brand).toContain('viewBox="0 0 256 256"')
      expect(brand).toContain(geometry!)
      expect(brand).not.toContain('viewBox="0 0 234 42"')
      expect(html).not.toMatch(/<(?:img|script)[^>]+src=["']https?:/)
    }
  })

  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })
})
