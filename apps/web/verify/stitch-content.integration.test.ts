import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium executable")
const root = new URL("../../../", import.meta.url).pathname
const port = 4183
let server: ReturnType<typeof Bun.spawn>
let reference: ReturnType<typeof Bun.serve>
let browser: Awaited<ReturnType<typeof launchBrowser>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--config", "verify/stitch-content.vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("../", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await fetch(`http://127.0.0.1:${port}/`).then(response => response.ok, () => false)
    if (ready) break
    if (attempt === 59) throw new Error("Stitch fixture Vite server did not start")
    await Bun.sleep(100)
  }
  reference = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(Bun.file(`${root}.aphrodite/stitch-review/export-adaptation/p10.html`)) })
  browser = await launchBrowser(chrome, 1600, 1200)
})

afterAll(async () => {
  await browser?.close()
  await reference?.stop(true)
  server?.kill()
  if (server) await server.exited
})

describe("P10 source-to-component fixture content", () => {
  for (const specimen of [1440, 768, 390]) {
    test(`renders the approved ${specimen} title, copy and topic order`, async () => {
      const manifest = await Bun.file(`${root}.verification-tmp/stitch-fidelity/native/manifest.json`).json() as { entries: { family: string; declaredWidth: number; selector: string }[] }
      const binding = manifest.entries.find(entry => entry.family === "p10" && entry.declaredWidth === specimen)
      if (!binding) throw new Error("Native P10 binding missing")
      const titles = ["Quickstart", "Installation", "Terminal", "Command line", "Remote workspace", "Sessions", "Agents", "Models", "Providers", "Plugins", "MCP", "Goal", "YOLO", "Guardrails", "Notifications", "Permissions", "Tools", "Appearance", "Troubleshooting"]
      const source = await browser.openPage()
      await source.navigate(`http://127.0.0.1:${reference.port}/p10.html`)
      const expected = await source.evaluate<{ title: string; lede: string; cards: { title: string; description: string }[] }>(`(() => {
        const frame = document.querySelector(${JSON.stringify(binding.selector)});
        if (!frame) throw new Error('Native frame missing');
        const text = element => element?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
        const heading = frame.querySelector('h1');
        return { title: text(heading), lede: text(heading?.nextElementSibling), cards: ${JSON.stringify(titles)}.map(title => {
          const label = [...frame.querySelectorAll('h3,a')].filter(element => text(element) === title).at(-1);
          if (!label) throw new Error('Native topic missing: '+title);
          return {title, description: text(label.parentElement.querySelector('p'))};
        }) };
      })()`)
      await source.close()
      const page = await browser.openPage()
      await page.setViewport(specimen, 900)
      await page.navigate(`http://127.0.0.1:${port}/docs?stitch=p10&specimen=${specimen}`)
      const actual = await page.evaluate<{ title: string; lede: string; cards: { title: string; description: string }[]; groups: number[]; hrefs: string[] }>(`(() => {
        const text = element => element?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
        const cards = [...document.querySelectorAll('.docs-topic-index .card')];
        return { title: text(document.querySelector('.docs-article > h1')), lede: text(document.querySelector('.docs-article__lede')),
          cards: cards.map(card => { const description=card.querySelector('.card__text'); return {title:text(card.querySelector('.card__title')),description:description && getComputedStyle(description).display!=='none'?text(description):''} }),
          groups: [...document.querySelectorAll('.docs-topic-index .doc-section')].map(group=>group.querySelectorAll('.card__link').length),
          hrefs: cards.map(card=>card.querySelector('a').getAttribute('href')) };
      })()`)
      expect(actual.title).toBe(expected.title)
      expect(actual.lede).toBe(expected.lede)
      expect(actual.groups).toEqual([2, 4, 12, 1])
      expect(actual.cards).toEqual(expected.cards)
      expect(actual.hrefs).toEqual(["/docs/quickstart", "/docs/installation", "/docs/usage/tui", "/docs/usage/command-line", "/docs/usage/remote", "/docs/usage/sessions", ...["agents", "models", "providers", "plugins", "mcp", "goal", "yolo", "guardrails", "notifications", "permissions", "tools", "appearance"].map(slug => `/docs/configuration/${slug}`), "/docs/troubleshooting"])
      await page.close()
    }, 15_000)
  }
})
