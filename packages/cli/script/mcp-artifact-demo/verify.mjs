import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { once } from "node:events"

if (!process.env.YCODING_TEST_PLAYWRIGHT_MODULE)
  throw new Error(
    "Set YCODING_TEST_PLAYWRIGHT_MODULE to an installed playwright-core module; this check never installs dependencies.",
  )
const { chromium } = createRequire(import.meta.url)(process.env.YCODING_TEST_PLAYWRIGHT_MODULE)
const html = await readFile(new URL("./index.html", import.meta.url), "utf8")
const requests = []
const view = createServer((request, response) => {
  requests.push(request.url)
  response.writeHead(200, {
    "content-type": "text/html",
    "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; frame-src ${request.url === "/blocked" ? "'none'" : "'self'"}; base-uri 'none'; form-action 'none'`,
  })
  response.end(html)
})
view.listen(0, "127.0.0.1")
await once(view, "listening")
const viewOrigin = `http://127.0.0.1:${view.address().port}`
const host = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" })
  response.end(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}iframe{display:block;width:100%;height:1400px;border:0}</style></head><body><iframe id="app" title="Simulated MCP host" sandbox="allow-scripts allow-same-origin" src="${viewOrigin}/allowed"></iframe><script>
    window.methods=[];
    addEventListener('message',event=>{
      if(event.source!==document.querySelector('iframe').contentWindow)return;
      const data=event.data;
      methods.push(data.method);
      if(data.method==='ui/initialize')event.source.postMessage({jsonrpc:'2.0',id:data.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'local-fixture',version:'1'},hostCapabilities:{},hostContext:{}}},event.origin);
    });
  </script></body></html>`)
})
host.listen(0, "127.0.0.1")
await once(host, "listening")
const browser = await chromium.launch({
  headless: true,
  ...(process.env.YCODING_WEB_CHROME ? { executablePath: process.env.YCODING_WEB_CHROME } : {}),
})
const failures = []
const report = []
try {
  for (const width of [320, 639, 640, 1440])
    for (const colorScheme of ["light", "dark"])
      for (const reducedMotion of ["no-preference", "reduce"]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme, reducedMotion })
        page.on("pageerror", (error) => failures.push(error.message))
        await page.goto(`http://127.0.0.1:${host.address().port}`)
        const app = page.frameLocator("#app")
        await app.locator('#host-status[data-state="initialized"]').waitFor()
        await app.locator("#variant-cards").focus()
        await page.keyboard.press("Enter")
        await app.getByRole("heading", { name: "Cards variant", exact: true }).waitFor()
        assert.equal(await app.locator("#variant-view article").count(), 3)
        await app.locator("#variant-list").click()
        await app.getByRole("heading", { name: "List variant", exact: true }).waitFor()
        await app.locator("#variant-view ol").waitFor()
        const frame = page.frames().find((item) => item.url().startsWith(viewOrigin))
        await frame.evaluate(() => history.back())
        await app.getByRole("heading", { name: "Cards variant", exact: true }).waitFor()
        assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        await app.locator("#probe-button").click()
        await app.locator('#probe-status[data-state="confirmed"]').waitFor()
        const nested = app.frameLocator("#probe-frame")
        await nested.locator("#child-variant-cards").click()
        await nested.getByRole("heading", { name: "Nested cards variant", exact: true }).waitFor()
        assert.equal(await app.locator("#probe-frame").getAttribute("sandbox"), "allow-scripts")
        const child = frame.childFrames()[0]
        assert.equal(
          await child.evaluate(() => {
            try {
              return !!parent.document
            } catch {
              return false
            }
          }),
          false,
        )
        await child.evaluate(() =>
          parent.postMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "start_task" } }, "*"),
        )
        await frame.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        )
        assert.deepEqual(await page.evaluate(() => window.methods), ["ui/initialize", "ui/notifications/initialized"])
        await child.evaluate(() => fetch("/network-escape").catch(() => undefined))
        assert.equal(requests.includes("/network-escape"), false)
        report.push({
          width,
          colorScheme,
          reducedMotion,
          variants: "pass",
          keyboard: "pass",
          history: "pass",
          isolatedProbe: "pass",
        })
        await page.close()
      }
  const blocked = await browser.newPage()
  await blocked.goto(`http://127.0.0.1:${host.address().port}`)
  await blocked.locator("#app").evaluate((element, url) => {
    element.src = url
  }, `${viewOrigin}/blocked`)
  const app = blocked.frameLocator("#app")
  await app.locator('#host-status[data-state="initialized"]').waitFor()
  await app.locator("#probe-button").click()
  await app.locator('#probe-status[data-state="confirmed"]').waitFor()
  assert.deepEqual(failures, [])
  assert.equal(
    requests.every((url) => url === "/allowed" || url === "/blocked"),
    true,
  )
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        profiles: report,
        frameSrcNoneSrcdoc: "confirmed in this Chromium fixture; actual host enforcement remains unverified",
        actualChat: "unverified",
        pageErrors: failures,
        networkEscape: "blocked",
      },
      null,
      2,
    ),
  )
  await blocked.close()
} finally {
  await browser.close()
  await Promise.all([
    new Promise((resolve, reject) => host.close((error) => (error ? reject(error) : resolve()))),
    new Promise((resolve, reject) => view.close((error) => (error ? reject(error) : resolve()))),
  ])
}
