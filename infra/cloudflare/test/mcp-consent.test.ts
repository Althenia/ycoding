import { describe, expect, test } from "bun:test"
import { authorityLines, consentResponse, consentStyles, errorResponse, escapeHtml, noticeResponse } from "../src/mcp-consent"

const notice = {
  clientName: "Test Client",
  redirectUri: "https://client.example/callback",
  resource: "https://relay.example/api/mcp/devices/dev_1",
  expiresInMinutes: 10,
  csrfToken: "csrf-token-1",
}

const consent = {
  clientName: "Test Client",
  redirectUri: "https://client.example/callback",
  resource: "https://relay.example/api/mcp/devices/dev_1",
  deviceName: "Studio Mac",
  csrfToken: "csrf-token-2",
}

async function tokens() {
  const css = await Bun.file(new URL("../../../apps/web/src/styles/tokens.css", import.meta.url)).text()
  return { light: block(css, /:root\s*\{([^}]*)\}/), dark: block(css, /\[data-theme="dark"\]\s*\{([^}]*)\}/) }
}

function block(source: string, pattern: RegExp) {
  return declarations(pattern.exec(source)?.[1] ?? "")
}

function declarations(text: string) {
  return Object.fromEntries(
    [...text.matchAll(/(--yc-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1] ?? "", (match[2] ?? "").trim().replace(/\s+/g, " ")]),
  )
}

describe("consent escaping", () => {
  test("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;")
  })

  test("renders untrusted client, device, and host text only as escaped text", async () => {
    const hostile = `<img src=x onerror=alert(1)>"'&`
    const notices = await noticeResponse({ ...notice, clientName: hostile, csrfToken: `"><b>` }, []).text()
    const consents = await consentResponse({ ...consent, clientName: hostile, deviceName: hostile, csrfToken: `"><b>` }, []).text()
    for (const html of [notices, consents]) {
      expect(html).not.toContain("<img")
      expect(html).not.toContain("<b>")
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;")
    }
  })
})

describe("consent pages", () => {
  test("the pre-Google notice names the client, redirect host, resource, and authority but no device name", async () => {
    const response = noticeResponse(notice, ["yc_mcp_auth=token; Path=/api/mcp/oauth"])
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain("Connect <bdi>Test Client</bdi> to YCoding")
    expect(html).toContain("<bdi>client.example</bdi>")
    expect(html).toContain("https://relay.example/api/mcp/devices/dev_1")
    for (const line of authorityLines) expect(html).toContain(escapeHtml(line))
    expect(html).toContain('method="post" action="/api/mcp/oauth/login"')
    expect(html).toContain('name="csrf" value="csrf-token-1"')
    expect(html).toContain("Continue to Google")
    expect(html).not.toContain("Studio Mac")
    expect(html).not.toContain("Deny")
    expect(html).toContain("expires in 10 minutes")
    expect(response.headers.get("set-cookie")).toContain("yc_mcp_auth=token")
  })

  test("the final consent names the device and offers Allow and Deny for the same binding", async () => {
    const html = await consentResponse(consent, []).text()
    expect(html).toContain("Allow <bdi>Test Client</bdi> to control <bdi>Studio Mac</bdi>?")
    expect(html).toContain('method="post" action="/api/mcp/oauth/consent"')
    expect(html).toContain('name="decision" value="allow"')
    expect(html).toContain('name="decision" value="deny"')
    expect(html.indexOf('value="allow"')).toBeLessThan(html.indexOf('value="deny"'))
    for (const line of authorityLines) expect(html).toContain(escapeHtml(line))
    expect(html).toContain("30-day grant")
  })

  test("authority covers every Session, below-home creation, Always approvals, YOLO, providers, shells, and usage", () => {
    const text = authorityLines.join("\n")
    for (const phrase of ["every existing and future Session", "strictly below the home directory", "approve always", "autonomy (YOLO)", "provider connections", "background shells", "usage, cost"])
      expect(text).toContain(phrase)
  })

  test("a loopback redirect shows a warning and an HTTPS redirect does not", async () => {
    const loopback = await noticeResponse({ ...notice, redirectUri: "http://127.0.0.1:8080/cb" }, []).text()
    expect(loopback).toContain('role="note"')
    expect(loopback).toContain("<bdi>127.0.0.1:8080</bdi>")
    expect(await noticeResponse(notice, []).text()).not.toContain('role="note"')
    expect(await consentResponse({ ...consent, redirectUri: "http://localhost:3000/cb" }, []).text()).toContain('role="note"')
  })

  test("the error page escapes its text and tells the user how to continue", async () => {
    const response = errorResponse(403, { title: "Request <refused>", message: "Not <allowed>" })
    const html = await response.text()
    expect(response.status).toBe(403)
    expect(html).toContain("Request &lt;refused&gt;")
    expect(html).toContain("Not &lt;allowed&gt;")
    expect(html).toContain("start the connection again")
  })

  test("responses are uncacheable, nonce-styled, scriptless, and free of external assets", async () => {
    for (const response of [noticeResponse(notice, []), consentResponse(consent, []), errorResponse(400, { title: "t", message: "m" })]) {
      const html = await response.clone().text()
      const policy = response.headers.get("content-security-policy") ?? ""
      const nonce = /nonce="([^"]+)"/.exec(html)?.[1] ?? ""
      expect(nonce.length).toBeGreaterThan(16)
      expect(policy).toContain(`style-src 'nonce-${nonce}'`)
      expect(policy).toContain("default-src 'none'")
      expect(policy).toContain("frame-ancestors 'none'")
      expect(policy).not.toContain("form-action")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
      expect(html).not.toMatch(/<script|<img|<link|<iframe|<object|src=|@import/i)
      expect([...html.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1])).toEqual(['"/fonts/Geist.woff2"', '"/fonts/GeistMono.woff2"'])
      expect(policy).toContain("font-src 'self'")
      expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"')
    }
  })

  test("each page uses a fresh nonce", async () => {
    const first = /nonce="([^"]+)"/.exec(await noticeResponse(notice, []).text())?.[1]
    const second = /nonce="([^"]+)"/.exec(await noticeResponse(notice, []).text())?.[1]
    expect(first).not.toBe(second)
  })
})

describe("consent styles", () => {
  test("light and dark token declarations equal the web tokens", async () => {
    const web = await tokens()
    const light = block(consentStyles, /:root\s*\{([^}]*)\}/)
    const dark = block(consentStyles, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)
    expect(Object.keys(light).length).toBeGreaterThan(20)
    expect(Object.keys(dark).length).toBeGreaterThan(8)
    for (const [name, value] of Object.entries(light)) expect({ name, value }).toEqual({ name, value: web.light[name] })
    for (const [name, value] of Object.entries(dark)) expect({ name, value }).toEqual({ name, value: web.dark[name] })
  })

  test("gutter steps match the web gutter at 480px and 640px", async () => {
    const css = await Bun.file(new URL("../../../apps/web/src/styles/tokens.css", import.meta.url)).text()
    for (const [width, gutter] of [[480, "20px"], [640, "24px"]] as const) {
      expect(css).toMatch(new RegExp(`@media \\(min-width: ${width}px\\)\\s*\\{\\s*:root\\s*\\{\\s*--yc-gutter: ${gutter};`))
      expect(consentStyles).toMatch(new RegExp(`@media \\(min-width: ${width}px\\)\\s*\\{\\s*:root\\s*\\{\\s*--yc-gutter: ${gutter};`))
    }
  })

  test("every referenced role is declared and no raw color or motion is used", () => {
    const declared = new Set(Object.keys(block(consentStyles, /:root\s*\{([^}]*)\}/)))
    const media = [...consentStyles.matchAll(/@media \(min-width: \d+px\)\s*\{\s*:root\s*\{([^}]*)\}/g)]
    for (const match of media) for (const name of Object.keys(declarations(match[1] ?? ""))) declared.add(name)
    const referenced = [...consentStyles.matchAll(/var\((--yc-[\w-]+)\)/g)].map((match) => match[1] ?? "")
    expect(referenced.filter((name) => !declared.has(name))).toEqual([])
    const rules = consentStyles.replace(/:root\s*\{[^}]*\}/g, "")
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
    expect(consentStyles).not.toMatch(/animation|transition|@keyframes/)
  })

  test("loads Geist and Geist Mono from same-origin stable font paths", () => {
    const faces = [...consentStyles.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "")
    expect(faces).toHaveLength(2)
    expect(faces[0]).toContain('font-family: "Geist";')
    expect(faces[0]).toContain('src: url("/fonts/Geist.woff2") format("woff2");')
    expect(faces[1]).toContain('font-family: "Geist Mono";')
    expect(faces[1]).toContain('src: url("/fonts/GeistMono.woff2") format("woff2");')
    for (const face of faces) {
      expect(face).toContain("font-weight: 100 900;")
      expect(face).toContain("font-display: swap;")
    }
    expect(consentStyles).not.toMatch(/https?:\/\//)
  })

  test("owns buttons, focus, scrollbars, targets, and 320px reflow", () => {
    expect(consentStyles).toContain(":focus-visible")
    expect(consentStyles).toContain("outline: 2px solid var(--yc-focus)")
    expect(consentStyles).toContain("min-block-size: var(--yc-control-h)")
    expect(consentStyles).toContain("flex-wrap: wrap")
    expect(consentStyles).toContain("overflow-wrap: anywhere")
    expect(consentStyles).toContain("::-webkit-scrollbar-thumb")
    expect(consentStyles).toContain("prefers-color-scheme: dark")
    expect(consentStyles).toContain("grid-template-columns: minmax(0, 1fr)")
  })
})
