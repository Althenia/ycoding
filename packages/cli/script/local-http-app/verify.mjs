import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { once } from "node:events"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

if (!process.env.YCODING_TEST_PLAYWRIGHT_MODULE)
  throw new Error("Set YCODING_TEST_PLAYWRIGHT_MODULE to installed playwright-core; this check never installs dependencies.")
const { chromium } = createRequire(import.meta.url)(process.env.YCODING_TEST_PLAYWRIGHT_MODULE)
const { AjvJsonSchemaValidator } = createRequire(new URL("../../../core/package.json", import.meta.url))("@modelcontextprotocol/server/validators/ajv")
const statusSchema = JSON.parse(execFileSync("bun", ["-e", 'import { RemoteMcpApps } from "./src/remote-mcp-apps"; console.log(JSON.stringify(RemoteMcpApps.tools.find(tool => tool.name === "local_app_status").inputSchema))'], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8" }))
const validateStatus = new AjvJsonSchemaValidator().getValidator(statusSchema)
const appID = `app_${"a".repeat(32)}`
const html = await readFile(new URL("./index.html", import.meta.url), "utf8")
const requests = []
const servers = []
let browser

async function serve(handler) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return `http://127.0.0.1:${server.address().port}`
}

try {
  const childOrigin = await serve((request, response) => {
    requests.push({ path: request.url, cookie: request.headers.cookie })
    const url = new URL(request.url, "http://fixture.test")
    if (url.pathname === "/_ycoding/bootstrap") {
      response.writeHead(302, { location: "/app/" })
      return response.end()
    }
    const assets = {
      "/app/": ["text/html", `<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Actual fixture app</h1><img alt="Fixture image" src="/image.svg"><button id="api">Read API</button><p id="result"></p><a href="relative.html">Relative page</a><button id="attack">Attempt top navigation</button><script src="/app.js"></script></body></html>`],
      "/style.css": ["text/css", "h1 { color: rgb(10, 123, 71); }"],
      "/app.js": ["text/javascript", `document.querySelector('#api').onclick=async()=>{document.querySelector('#result').textContent=await(await fetch('/api')).text()}; document.querySelector('#attack').onclick=()=>{try{top.location='/escaped'}catch{document.querySelector('#result').textContent='Navigation blocked'}}; parent.postMessage({jsonrpc:'2.0',method:'tools/call',params:{name:'forbidden'}},'*');`],
      "/image.svg": ["image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>'],
      "/api": ["text/plain", "Fixture API response"],
      "/app/relative.html": ["text/html", "<!doctype html><h1>Actual relative page</h1>"],
    }
    const asset = assets[url.pathname]
    response.writeHead(asset ? 200 : 404, { "content-type": asset?.[0] ?? "text/plain" })
    response.end(asset?.[1] ?? "Not found")
  })
  const wrapperOrigin = await serve((request, response) => {
    const empty = request.url.includes("empty")
    response.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${childOrigin}; connect-src 'none'; base-uri 'none'; form-action 'none'`,
    })
    response.end(html.replace('<script id="preview-policy" type="application/json">[]</script>', `<script id="preview-policy" type="application/json">${JSON.stringify(empty ? [] : [childOrigin])}</script>`))
  })
  const hostOrigin = await serve((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end(`<!doctype html><style>body{margin:0}iframe{display:block;width:100%;height:1000px;border:0}</style><iframe id="wrapper" title="SIMULATEDHOST" sandbox="allow-scripts allow-same-origin" src="${wrapperOrigin}/app${_request.url.includes("empty") ? "?empty" : ""}"></iframe><script>
      window.methods=[]; window.calls=[]; window.answer='same'; window.last=null;
      window.send=(value)=>document.querySelector('iframe').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:value},'${wrapperOrigin}');
      window.payload=()=>({structuredContent:{kind:'local-http-app',version:1,appID:'${appID}',sessionID:'ses_fixture',expiresAt:new Date(Date.now()+60000).toISOString(),status:'ready'},_meta:{localApp:{origin:'${childOrigin}',url:'${childOrigin}/_ycoding/bootstrap?ticket=fixture_token_0123456789'}}});
      addEventListener('message',event=>{
        if(event.source!==document.querySelector('iframe').contentWindow)return;
        const data=event.data; methods.push(data.method);
        if(data.method==='ui/initialize')event.source.postMessage({jsonrpc:'2.0',id:data.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'SIMULATEDHOST',version:'1'}}},event.origin);
        if(data.method==='tools/call'){
          calls.push(data.params);
          const result=answer==='error'?{error:{code:-32000,message:'SECRET_HOST_ERROR'}}:{result:answer==='same'?{structuredContent:last.structuredContent}:last};
          event.source.postMessage({jsonrpc:'2.0',id:data.id,...result},event.origin);
        }
      });
    </script>`)
  })
  browser = await chromium.launch({ headless: true, ...(process.env.YCODING_WEB_CHROME ? { executablePath: process.env.YCODING_WEB_CHROME } : {}) })
  const profiles = []
  const errors = []
  async function open(options = {}, suffix = "") {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, ...options })
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${hostOrigin}/${suffix}`)
    const wrapper = page.frameLocator("#wrapper")
    await wrapper.getByRole("button", { name: "Refresh", exact: true }).waitFor()
    await page.waitForFunction(() => window.methods.includes("ui/notifications/initialized"))
    return { page, wrapper }
  }
  async function deliver(page, overrides = {}, hidden = true) {
    await page.evaluate(({ overrides, hidden }) => {
      const value = window.payload()
      Object.assign(value.structuredContent, overrides)
      if (!hidden) delete value._meta
      window.last = value
      window.send(value)
    }, { overrides, hidden })
  }
  for (const width of [320, 639, 640, 1440])
    for (const colorScheme of ["light", "dark"])
      for (const reducedMotion of ["no-preference", "reduce"]) {
        const { page, wrapper } = await open({ viewport: { width, height: 1000 }, colorScheme, reducedMotion })
        assert.match(await wrapper.locator("#status").innerText(), /Pending initialization/)
        await deliver(page)
        await wrapper.locator('#status[data-state="loaded"]').waitFor()
        assert.match(await wrapper.locator("#status").innerText(), /app response not verified/)
        const child = wrapper.frameLocator("#preview")
        await child.getByRole("heading", { name: "Actual fixture app" }).waitFor()
        assert.equal(await child.locator("h1").evaluate((el) => getComputedStyle(el).color), "rgb(10, 123, 71)")
        await child.locator("img").evaluate((el) => el.decode())
        const frame = page.frames().find((item) => item.url().startsWith(wrapperOrigin))
        assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        const control = await wrapper.getByRole("button", { name: "Refresh", exact: true }).boundingBox()
        assert.ok(control.height >= 44 && control.width >= 44)
        assert.equal(await wrapper.locator("#preview").getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms")
        assert.equal(await wrapper.locator("#preview").getAttribute("referrerpolicy"), "no-referrer")
        assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector("#refresh")).transitionDuration), "0s")
        assert.equal(await frame.evaluate(() => { try { return !!document.querySelector('iframe').contentDocument.body } catch { return false } }), false)
        assert.deepEqual(await page.evaluate(() => window.methods), ["ui/initialize", "ui/notifications/initialized"])
        assert.equal(await frame.evaluate(() => localStorage.length + sessionStorage.length), 0)
        assert.equal((await wrapper.locator("body").innerText()).includes("fixture_token"), false)
        profiles.push({ width, colorScheme, reducedMotion, result: "pass" })
        await page.close()
      }
  {
    const { page, wrapper } = await open()
    await deliver(page)
    await wrapper.locator('#status[data-state="loaded"]').waitFor()
    const child = wrapper.frameLocator("#preview")
    await child.locator("#api").click()
    await child.getByText("Fixture API response", { exact: true }).waitFor()
    const topURL = page.url()
    await child.locator("#attack").click()
    await child.getByText("Navigation blocked", { exact: true }).waitFor()
    assert.equal(page.url(), topURL)
    await child.getByRole("link", { name: "Relative page" }).click()
    await child.getByRole("heading", { name: "Actual relative page" }).waitFor()
    const before = requests.filter((r) => r.path.startsWith("/_ycoding/bootstrap")).length
    await wrapper.locator("#refresh").focus()
    assert.notEqual(await wrapper.locator("#refresh").evaluate((el) => getComputedStyle(el).boxShadow), "none")
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => window.calls.length === 1)
    await wrapper.locator('#status[data-state="loaded"]').waitFor()
    assert.equal(requests.filter((r) => r.path.startsWith("/_ycoding/bootstrap")).length, before)
    const calls = await page.evaluate(() => window.calls)
    assert.equal(validateStatus(calls[0].arguments).valid, true)
    assert.deepEqual(calls, [{ name: "local_app_status", arguments: { sessionID: "ses_fixture", input: { id: appID } } }])
    await page.evaluate(() => { window.answer = "error" })
    await wrapper.locator("#refresh").click()
    await wrapper.locator('#status[data-state="unavailable"]').waitFor()
    assert.equal(await wrapper.locator("#preview").count(), 0)
    assert.equal((await wrapper.locator("body").innerText()).includes("SECRET_HOST_ERROR"), false)
    await page.close()
  }
  for (const status of ["unavailable", "unknown-unavailable", "expired", "revoked", "unknown"]) {
    const { page, wrapper } = await open()
    await deliver(page)
    await wrapper.locator('#status[data-state="loaded"]').waitFor()
    await deliver(page, status === "unknown-unavailable" ? { status: "unavailable", reason: "not_registered", expiresAt: null } : { status })
    await wrapper.locator(`#status[data-state="${["unknown", "unknown-unavailable"].includes(status) ? "unavailable" : status}"]`).waitFor()
    assert.equal(await wrapper.locator("#preview").count(), 0)
    await page.close()
  }
  {
    const { page, wrapper } = await open()
    await deliver(page, { expiresAt: new Date(Date.now() + 1200).toISOString() })
    await wrapper.locator('#status[data-state="loaded"]').waitFor()
    await wrapper.locator('#status[data-state="expired"]').waitFor()
    assert.equal(await wrapper.locator("#preview").count(), 0)
    await page.close()
  }
  for (const scenario of ["empty", "disallowed", "no-meta", "changed-lease"]) {
    const { page, wrapper } = await open({}, scenario === "empty" ? "?empty" : "")
    const before = requests.length
    if (scenario === "disallowed") {
      await page.evaluate(() => { const value=window.payload(); value._meta.localApp.origin='http://localhost:1'; value._meta.localApp.url='http://localhost:1/_ycoding/bootstrap?ticket=fixture'; window.send(value) })
    } else {
      if (scenario === "changed-lease") {
        await deliver(page)
        await wrapper.locator('#status[data-state="loaded"]').waitFor()
      }
      await deliver(page, scenario === "changed-lease" ? { appID: "different_app" } : {}, scenario === "empty")
    }
    await wrapper.locator('#status[data-state="unavailable"]').waitFor()
    assert.equal(await wrapper.locator("#preview").count(), 0)
    if (scenario !== "changed-lease") assert.equal(requests.length, before)
    await page.close()
  }
  {
    const { page, wrapper } = await open()
    await deliver(page)
    await wrapper.locator('#status[data-state="loaded"]').waitFor()
    const frame = page.frames().find((item) => item.url().startsWith(wrapperOrigin))
    await frame.evaluate(() => dispatchEvent(new Event("pagehide")))
    assert.equal(await wrapper.locator("#preview").count(), 0)
    await deliver(page)
    assert.equal(await wrapper.locator("#preview").count(), 0)
    assert.equal(await wrapper.locator("#refresh").isDisabled(), true)
    await page.close()
  }
  assert.ok(requests.some((r) => r.path === "/style.css"))
  assert.ok(requests.some((r) => r.path === "/app.js"))
  assert.ok(requests.some((r) => r.path === "/image.svg"))
  assert.ok(requests.some((r) => r.path === "/api"))
  assert.equal(requests.some((r) => r.cookie), false)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ evidence: "SIMULATEDHOST", actualChatGPT: "unverified", browser: browser.version(), profiles, scenarios: ["assets", "api", "relative-navigation", "isolation", "no-forwarding", "no-top-navigation", "same-lease-refresh", "refresh-error", "unavailable", "unknown-unavailable", "revoked", "expiry-timer", "invalid", "empty-policy", "disallowed-origin", "changed-lease", "pagehide"], cookies: "none" }, null, 2))
} finally {
  await browser?.close()
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))))
}
