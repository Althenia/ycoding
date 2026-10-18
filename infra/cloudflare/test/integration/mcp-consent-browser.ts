import { launchBrowser } from "../../../../apps/web/verify/cdp"
import { authorityLines, consentResponse, errorResponse, noticeResponse } from "../../src/mcp-consent"

const repositoryRoot = new URL("../../../../", import.meta.url).pathname
const fontsDirectory = `${repositoryRoot}apps/web/dist/fonts`
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
for (const font of ["Geist.woff2", "GeistMono.woff2"])
  if (!(await Bun.file(`${fontsDirectory}/${font}`).exists()))
    throw new Error(`Missing apps/web/dist/fonts/${font}: run \`bun run build:web\` first.`)

const hostileName = `<img src=x onerror="window.__pwned=1"> ${"W".repeat(120)}`
const hostileDevice = `<script>window.__pwned=1</script>${"M".repeat(200)}`
const longHost = `https://${"a".repeat(60)}.${"b".repeat(60)}.example/callback`
const longDevice = "d".repeat(64)

const pages: Record<string, () => Response> = {
  "/notice": () =>
    noticeResponse(
      { clientName: "Test Client", redirectUri: "https://client.example/callback", resource: "https://relay.example/api/mcp/devices/dev_1", expiresInMinutes: 10, csrfToken: "csrf-notice" },
      [],
    ),
  "/notice-loopback": () =>
    noticeResponse(
      { clientName: "Local Client", redirectUri: "http://127.0.0.1:8123/callback", resource: "https://relay.example/api/mcp/devices/dev_1", expiresInMinutes: 1, csrfToken: "csrf-notice" },
      [],
    ),
  "/notice-hostile": () =>
    noticeResponse(
      { clientName: hostileName, redirectUri: longHost, resource: `https://relay.example/api/mcp/devices/${longDevice}`, expiresInMinutes: 10, csrfToken: "csrf-notice" },
      [],
    ),
  "/consent": () =>
    consentResponse(
      { clientName: "Test Client", redirectUri: "https://client.example/callback", resource: "https://relay.example/api/mcp/devices/dev_1", deviceName: "Studio Mac", csrfToken: "csrf-consent" },
      [],
    ),
  "/consent-hostile": () =>
    consentResponse(
      { clientName: hostileName, redirectUri: longHost, resource: `https://relay.example/api/mcp/devices/${longDevice}`, deviceName: hostileDevice, csrfToken: "csrf-consent" },
      [],
    ),
  "/error": () => errorResponse(400, { title: "Request expired", message: "This authorization request is no longer valid." }),
}

const viewports = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const
const schemes = ["light", "dark"] as const
const expectedColors = {
  light: { background: "rgb(255, 255, 255)", text: "rgb(11, 15, 20)", primary: "rgb(11, 133, 80)" },
  dark: { background: "rgb(11, 17, 21)", text: "rgb(244, 247, 246)", primary: "rgb(78, 226, 155)" },
} as const

const submissions: { readonly path: string; readonly fields: Record<string, string> }[] = []
const fontHits = new Map<string, number>()
const problems: string[] = []

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/fonts/")) {
      const name = url.pathname.slice("/fonts/".length)
      if (name !== "Geist.woff2" && name !== "GeistMono.woff2") return new Response("not found", { status: 404 })
      fontHits.set(name, (fontHits.get(name) ?? 0) + 1)
      return new Response(Bun.file(`${fontsDirectory}/${name}`), { headers: { "content-type": "font/woff2", "cache-control": "no-store" } })
    }
    if (request.method === "POST") {
      submissions.push({ path: url.pathname, fields: Object.fromEntries(new URLSearchParams(await request.text())) })
      return new Response("recorded", { headers: { "content-type": "text/plain" } })
    }
    const page = pages[url.pathname]
    return page ? page() : new Response("not found", { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`
const browser = await launchBrowser(executable, 1440, 900)

try {
  let cases = 0
  for (const path of Object.keys(pages)) {
    for (const viewport of viewports) {
      for (const scheme of schemes) {
        cases += 1
        const label = `${path} ${viewport.width}x${viewport.height} ${scheme}`
        const found = await inspect(path, viewport, scheme)
        for (const problem of found) problems.push(`${label}: ${problem}`)
        console.log(`${found.length === 0 ? "ok" : "FAIL"} ${label}`)
      }
    }
  }
  const headers = await Promise.all(Object.keys(pages).map(async (path) => (await fetch(`${base}${path}`)).headers.get("content-security-policy") ?? ""))
  for (const policy of headers) if (!policy.includes("font-src 'self'") || policy.includes("unsafe-inline") || policy.includes("script-src")) problems.push(`unexpected CSP: ${policy}`)
  for (const font of ["Geist.woff2", "GeistMono.woff2"]) if ((fontHits.get(font) ?? 0) === 0) problems.push(`${font} was never requested from /fonts`)
  if (problems.length > 0) throw new Error(`MCP consent browser checks failed:\n${problems.join("\n")}`)
  console.log(`MCP consent browser checks passed (${cases} page cases, ${submissions.length} keyboard submissions)`)
} finally {
  await browser.close()
  await server.stop(true)
}

async function inspect(path: string, viewport: (typeof viewports)[number], scheme: (typeof schemes)[number]): Promise<string[]> {
  const found: string[] = []
  const page = await browser.openPage()
  try {
    await page.injectOnNewDocument(
      `window.__violations = []; document.addEventListener("securitypolicyviolation", (event) => window.__violations.push(event.violatedDirective + " " + event.blockedURI))`,
    )
    await page.setViewport(viewport.width, viewport.height)
    await page.setColorScheme(scheme)
    await page.navigate(`${base}${path}`)
    await page.evaluate("document.fonts.ready.then(() => true)")

    const layout = await page.evaluate<{ scrollWidth: number; innerWidth: number; wide: string[]; clipped: string[]; main: { left: number; right: number; width: number } }>(`(() => {
      const width = document.documentElement.clientWidth
      const wide = [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > width + 0.5).map((element) => element.tagName + "." + element.className)
      const clipped = [...document.querySelectorAll("li, dd, dt, h1, p")].filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.tagName)
      const rect = document.querySelector("main").getBoundingClientRect()
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth: width, wide, clipped, main: { left: rect.left, right: width - rect.right, width: rect.width } }
    })()`)
    if (layout.scrollWidth > layout.innerWidth) found.push(`horizontal overflow ${layout.scrollWidth} > ${layout.innerWidth}`)
    if (layout.wide.length > 0) found.push(`elements past the viewport edge: ${layout.wide.join(", ")}`)
    if (layout.clipped.length > 0) found.push(`clipped text: ${layout.clipped.join(", ")}`)
    if (viewport.width >= 1024 && (layout.main.width > 620 || Math.abs(layout.main.left - layout.main.right) > 1)) found.push(`reading column is ${layout.main.width}px, offsets ${layout.main.left}/${layout.main.right}`)

    const colors = await page.evaluate<{ background: string; text: string; primary: string | null }>(`(() => {
      const primary = document.querySelector(".button--primary")
      return {
        background: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
        primary: primary ? getComputedStyle(primary).backgroundColor : null,
      }
    })()`)
    if (colors.background !== expectedColors[scheme].background) found.push(`background ${colors.background}`)
    if (colors.text !== expectedColors[scheme].text) found.push(`text ${colors.text}`)
    if (colors.primary !== null && colors.primary !== expectedColors[scheme].primary) found.push(`primary ${colors.primary}`)

    const text = await page.evaluate<string>(`document.querySelector("main").innerText.replace(/\\s+/g, " ")`)
    if (!path.startsWith("/error")) for (const line of authorityLines) if (!text.includes(line)) found.push(`missing authority: ${line}`)
    if (path.endsWith("hostile")) {
      const hostile = await page.evaluate<{ injected: number; pwned: boolean; text: string }>(`({
        injected: document.querySelectorAll("main img, main script, main b").length,
        pwned: window.__pwned !== undefined,
        text: document.querySelector("main").innerText,
      })`)
      if (hostile.injected > 0 || hostile.pwned) found.push("untrusted text created markup or ran script")
      if (!hostile.text.includes('<img src=x onerror="window.__pwned=1">')) found.push("hostile client name is not shown literally")
      if (path === "/consent-hostile" && !hostile.text.includes("<script>window.__pwned=1</script>")) found.push("hostile device name is not shown literally")
    }
    if (path === "/notice-loopback" && !text.includes("Local address.")) found.push("loopback note missing")
    if (path.startsWith("/notice") && text.includes("Studio Mac")) found.push("device name shown before Google")

    const loaded = await page.evaluate<string[]>(`[...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', ""))`)
    const fonts = await page.platformFonts("h1")
    if (!loaded.includes("Geist") || !fonts.some((font) => font.familyName === "Geist" && font.isCustomFont && font.glyphCount > 0)) found.push(`Geist not rendered from the web font (loaded: ${loaded.join(", ")})`)
    if (!path.startsWith("/error")) {
      const mono = await page.platformFonts(".consent__mono")
      if (!loaded.includes("Geist Mono") || !mono.some((font) => font.familyName === "Geist Mono" && font.isCustomFont && font.glyphCount > 0)) found.push("Geist Mono not rendered from the web font")
    }

    const violations = await page.evaluate<string[]>("window.__violations")
    if (violations.length > 0) found.push(`CSP violations: ${violations.join("; ")}`)
    const failures = page.networkFailures().filter((failure) => failure !== "unknown: net::ERR_CACHE_MISS")
    if (failures.length > 0) found.push(`network failures: ${failures.join("; ")}`)

    if (path !== "/error") found.push(...(await keyboard(page, path, scheme)))
  } finally {
    await page.close()
  }
  return found
}

async function keyboard(page: Awaited<ReturnType<typeof browser.openPage>>, path: string, scheme: (typeof schemes)[number]): Promise<string[]> {
  const found: string[] = []
  const consentPage = path.startsWith("/consent")
  const names = consentPage ? ["Allow access", "Deny"] : ["Continue to Google"]
  const sizes = await page.evaluate<{ name: string; width: number; height: number; left: number; right: number }[]>(`[...document.querySelectorAll("button")].map((button) => {
    const rect = button.getBoundingClientRect()
    return { name: button.textContent.trim(), width: rect.width, height: rect.height, left: rect.left, right: document.documentElement.clientWidth - rect.right }
  })`)
  if (sizes.map((size) => size.name).join("|") !== names.join("|")) found.push(`buttons are ${sizes.map((size) => size.name).join("|")}`)
  for (const size of sizes) {
    if (size.height < 44 || size.width < 44) found.push(`${size.name} target is ${size.width}x${size.height}`)
    if (size.left < 0 || size.right < 0) found.push(`${size.name} leaves the viewport horizontally`)
  }

  const focusRing = await page.evaluate<string>(`(() => { const probe = document.createElement("i"); probe.style.color = "var(--yc-focus)"; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color })()`)
  const focused = `(() => {
    const element = document.activeElement
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return { name: element.textContent.trim(), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, visible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= document.documentElement.clientWidth }
  })()`
  for (const name of names) {
    await page.pressKey("Tab", "Tab", 9)
    const active = await page.evaluate<{ name: string; outlineStyle: string; outlineWidth: string; outlineColor: string; visible: boolean }>(focused)
    if (active.name !== name) found.push(`Tab reached ${active.name}, expected ${name}`)
    if (active.outlineStyle !== "solid" || active.outlineWidth !== "2px" || active.outlineColor !== focusRing) found.push(`${name} focus indicator is ${active.outlineWidth} ${active.outlineStyle} ${active.outlineColor}, expected ${focusRing}`)
    if (!active.visible) found.push(`${name} is not visible when focused`)
  }
  const last = names[names.length - 1] ?? ""
  const before = submissions.length
  await page.pressKey("Enter", "Enter", 13, "\r")
  const expectedDecision = consentPage ? "deny" : undefined
  const submitted = await waitForSubmission(before)
  if (!submitted) found.push(`Enter on ${last} submitted nothing`)
  else {
    const expectedPath = consentPage ? "/api/mcp/oauth/consent" : "/api/mcp/oauth/login"
    if (submitted.path !== expectedPath) found.push(`${last} posted to ${submitted.path}`)
    if (submitted.fields.csrf !== (consentPage ? "csrf-consent" : "csrf-notice")) found.push(`${last} posted csrf ${submitted.fields.csrf}`)
    if (submitted.fields.decision !== expectedDecision) found.push(`${last} posted decision ${submitted.fields.decision}`)
  }
  if (consentPage) {
    await page.navigate(`${base}${path}`)
    await page.setColorScheme(scheme)
    await page.pressKey("Tab", "Tab", 9)
    const mark = submissions.length
    await page.pressKey("Enter", "Enter", 13, "\r")
    const allowed = await waitForSubmission(mark)
    if (allowed?.fields.decision !== "allow") found.push(`Enter on Allow access posted decision ${allowed?.fields.decision}`)
  }
  return found
}

async function waitForSubmission(before: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (submissions.length > before) return submissions[submissions.length - 1]
    await Bun.sleep(50)
  }
  return undefined
}
