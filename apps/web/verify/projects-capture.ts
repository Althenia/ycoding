import { launchBrowser } from "./cdp"

const executable = process.env.YCODING_WEB_CHROME
const auditPath = process.env.DAEDALUS_RENDER_AUDIT
if (!executable || !auditPath) throw new Error("Set YCODING_WEB_CHROME and DAEDALUS_RENDER_AUDIT")
const output = new URL("../../../.cache/projects-redesign/web/build-captures/", import.meta.url)
const audit = await Bun.file(auditPath).text()
const port = 4604
const server = Bun.spawn(["bun", "run", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore" })
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
const results: unknown[] = []
async function wait(page: Page, expression: string) {
  for (let i = 0; i < 100; i++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(40) }
  throw new Error(`Unsettled capture: ${expression}`)
}
async function click(page: Page, label: string) {
  await page.evaluate(`[...document.querySelectorAll('button,a')].find(e=>e.getClientRects().length && !e.closest('[inert]') && (e.getAttribute('aria-label')||e.textContent).trim()===${JSON.stringify(label)}).click()`)
}
async function capture(page: Page, scene: string, width: number, theme: string, root: string) {
  await page.evaluate(`document.querySelector('.fixture__banner')?.remove();document.querySelector('.fixture__controls')?.remove()`)
  await page.evaluate("document.fonts.ready")
  await Bun.sleep(220)
  const filename = `${width}-${theme}-${scene}.png`
  await Bun.write(new URL(filename, output), Buffer.from(await page.screenshot(), "base64"))
  await page.evaluate(audit)
  const result = await page.evaluate(`auditRender({root:${JSON.stringify(root)},spacing:[0,1,2,4,6,8,12,16,20,24,28,32,40,48,64],iconSizes:[14,16,18,20,24],controlHeights:[24,32,36,40,44,48],minTarget:24,coarseTarget:44})`)
  const overflow = await page.evaluate<boolean>("document.documentElement.scrollWidth>innerWidth")
  results.push({ filename, width, theme, overflow, audit: result })
}
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then(r => r.ok, () => false)) { ready = true; break }
    await Bun.sleep(100)
  }
  if (!ready) throw new Error("Built fixture preview unavailable")
  browser = await launchBrowser(executable, 1440, 900, { scrollbars: true })
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const page = await browser.openPage()
    try {
      await page.setViewport(width, 900)
      await page.setCoarsePointer(width === 390)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-${width}`)
      await wait(page, "document.querySelectorAll('.project-card').length===2")
      await page.evaluate(`document.querySelector('.fixture__banner').remove();document.querySelector('.fixture__controls').remove()`)
      await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      await capture(page, "list", width, theme, ".projects")
      await click(page, "Open project Release train")
      await wait(page, "document.querySelector('.project-context')?.textContent.includes('Master of Release train')")
      await capture(page, "chat", width, theme, ".workspace")
      if (width === 390) { await click(page, "Sessions 5"); await capture(page, "sessions-sheet", width, theme, "dialog") }
      await page.evaluate(`document.querySelector('${width === 390 ? "dialog" : ".project-desktop"} .project-tab:last-child').click()`)
      await capture(page, "settings", width, theme, width === 390 ? "dialog" : ".project-desktop")
      await page.evaluate(`document.querySelector('${width === 390 ? "dialog" : ".project-desktop"} .project-tab:first-child').click()`)
      await click(page, "New session…")
      await capture(page, "new-session", width, theme, "dialog")
      await page.pressKey("Escape", "Escape", 27)
      await wait(page, "!document.querySelector('dialog[open]')")
      if (width === 390) await click(page, "Sessions 5")
      await click(page, "Delete session Audit dashboards")
      await capture(page, "delete-session", width, theme, "dialog")
      await page.pressKey("Escape", "Escape", 27)
      await wait(page, "!document.querySelector('dialog[open]')")
      await click(page, "Projects")
      await wait(page, "document.querySelectorAll('.project-card').length===2")
      await click(page, "New project")
      await capture(page, "create", width, theme, ".projects")
      for (const state of ["loading", "empty", "error"]) {
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-${width}&coordination=${state}`)
        await wait(page, "!!document.querySelector('.projects')")
        await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
        await capture(page, `list-${state}`, width, theme, ".projects")
      }
    } finally { await page.close() }
  }
  await Bun.write(new URL("render-audit.json", output), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results.map((entry) => { const r = entry as { filename: string; overflow: boolean; audit: { counts: unknown } }; return { file: r.filename, overflow: r.overflow, counts: r.audit.counts } }), null, 2))
} finally {
  await browser?.close()
  server.kill()
  await server.exited
}
