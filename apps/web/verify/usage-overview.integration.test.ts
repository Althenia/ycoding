import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4727
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(executable, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("overview leads with spend, separates account quotas and Backend rates, and keeps a flat responsive anatomy", async () => {
  for (const width of [320, 390, 768, 1024, 1440]) for (const theme of ["light", "dark"]) for (const reduced of [false, true]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?forecast=states`)
      await wait(page, `document.querySelectorAll('.usage-consumption__row').length === 3 && document.querySelectorAll('.usage-donut__arc').length === 2`)
      await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.fonts.ready`)
      await page.evaluate(`Promise.all(document.querySelector('.usage-page').getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished))`)
      const result = await page.evaluate<{
        order: string[]; tops: number[]; quotaHeading: boolean; flat: boolean; dividers: boolean; surface: boolean;
        equalCharts: boolean; columns: number; content: number; overflow: boolean; namedControls: boolean; icons: boolean; values: string[]; requests: number;
      }>(`(() => {
        const root = document.querySelector('.usage-page');
        const regions = [...root.children].filter(node => node.matches('.usage-head, .usage-spend, .usage-quotas, .usage-visuals, .usage-consumption, [aria-labelledby="usage-breakdown-title"], .incidents, .usage-cost-note'));
        const flat = [...root.querySelectorAll('.usage-provider, .usage-chart, .usage-distribution, .usage-breakdown-section, .usage-breakdown, .incidents, .incidents__panel')].every(node => {
          const style = getComputedStyle(node);
          return style.borderTopLeftRadius === '0px' && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderRightWidth === '0px';
        });
        const visuals = root.querySelector('.usage-visuals'), style = getComputedStyle(visuals);
        const charts = [...visuals.children].map(node => node.getBoundingClientRect());
        const buttons = [...root.querySelectorAll('button')].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        const heading = root.querySelector('#usage-allowances');
        return { order: regions.map(node => node.classList[0]), tops: regions.map(node => node.getBoundingClientRect().top), flat,
          quotaHeading: !!heading && heading.getBoundingClientRect().height >= 20 && !heading.classList.contains('visually-hidden'),
          dividers: [...root.querySelectorAll('.usage-provider')].every(node => getComputedStyle(node).borderInlineStartWidth === '2px'),
          surface: style.backgroundColor === getComputedStyle(root).getPropertyValue('--yc-surface').trim() || style.backgroundColor === getComputedStyle(root.querySelector('.usage-toggle')).backgroundColor,
          equalCharts: Math.abs(charts[0].width - charts[1].width) <= 1,
          columns: style.gridTemplateColumns.split(' ').length, content: root.clientWidth,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          namedControls: buttons.every(node => (node.getAttribute('aria-label') || node.textContent).trim() && node.getBoundingClientRect().height >= 44),
          icons: [...root.querySelectorAll('h1, #usage-allowances, .usage-chart h3, .usage-distribution h3, .usage-consumption h2, #usage-breakdown-title, #incidents-title')].every(node => !!node.querySelector('svg[aria-hidden="true"]')),
          values: [...root.querySelectorAll('.usage-tile')].map(node => node.textContent), requests: window.usageRequests().length };
      })()`)
      expect(result.order).toEqual(["usage-head", "usage-spend", "usage-quotas", "usage-visuals", "usage-breakdown-section", "usage-breakdown-section", "incidents", "usage-cost-note"])
      expect(result.tops.every((top, index) => index === 0 || top > result.tops[index - 1]!)).toBe(true)
      expect(result).toMatchObject({ quotaHeading: true, flat: true, dividers: true, surface: true, equalCharts: true, overflow: false, namedControls: true, icons: true, requests: 1 })
      expect(result.columns).toBe(result.content >= 1024 ? 2 : 1)
      expect(await page.evaluate<{ readonly radius: string; readonly fill: boolean; readonly rules: string; readonly headings: number }>(`(() => { const strip = getComputedStyle(document.querySelector('.usage-tiles')); return { radius: strip.borderTopLeftRadius, fill: strip.backgroundColor !== 'rgba(0, 0, 0, 0)', rules: [strip.borderTopWidth, strip.borderBottomWidth, ...[...document.querySelectorAll('.usage-tile')].map(node => getComputedStyle(node).borderInlineStartWidth)].join(','), headings: document.querySelectorAll('.usage-page .usage-ordinal').length } })()`)).toEqual({ radius: "20px", fill: true, rules: "0px,0px,0px,0px,0px", headings: 0 })
      expect(result.values[0]).toContain("Today$5.40")
      expect(result.values[0]).toContain("31 requests")
      expect(result.values[1]).toContain("Yesterday$5.22")
      expect(result.values[2]).toMatch(/^Last 30 days\$\d/)
      expect(result.values[2]).not.toMatch(/Known|unreported/)
      expect(await page.evaluate<string>(`document.querySelector('.usage-quotas').textContent`)).not.toContain("tokens/min")
      expect(await page.evaluate<string>(`document.querySelector('.usage-consumption').textContent`)).toContain("Recorded consumption · Backend")
      if (reduced) expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.usage-meter > span, .usage-donut__arc')].every(node => getComputedStyle(node).animationName === 'none')`)).toBe(true)
    } finally { await page.close() }
  }
}, 180_000)

test("provider marks follow reported identities and retain labels without invented marks or backgrounds", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?provider=muse&forecast=states`)
    await wait(page, `document.querySelectorAll('.usage-provider').length === 7`)
    await wait(page, `[...document.querySelectorAll('.usage-provider .provider-logo img')].every(image => image.complete && image.naturalWidth > 0)`)
    const providers = await page.evaluate<{ id: string; label: string; marks: number; transparent: boolean; size: boolean; sources: boolean }[]>(`[...document.querySelectorAll('.usage-provider')].map(node => {
      const marks = [...node.querySelectorAll('.provider-logo')];
      return { id: node.dataset.providerId, label: node.querySelector('h3').textContent, marks: marks.length,
        transparent: marks.every(mark => [mark, ...mark.querySelectorAll('img')].every(part => { const style = getComputedStyle(part); return style.backgroundImage === 'none' && style.backgroundColor === 'rgba(0, 0, 0, 0)'; })),
        size: marks.every(mark => mark.getBoundingClientRect().width === 20 && mark.getBoundingClientRect().height === 20),
        sources: marks.every(mark => [...mark.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0)) };
    })`)
    expect(providers.map(provider => [provider.id, provider.label, provider.marks])).toEqual([
      ["muse", "Muse (Meta)", 1], ["openai", "Codex", 1], ["anthropic", "Claude", 1], ["github-copilot", "Copilot", 1], ["openrouter", "OpenRouter", 1], ["disconnected", "Disconnected provider", 0], ["failed", "Provider with an error", 0],
    ])
    expect(providers.every(provider => provider.transparent && provider.size && provider.sources)).toBe(true)
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(1)
  } finally { await page.close() }
})

test("overview controls keep report scopes, exact table values, distribution metrics and filter inputs", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/usage-fixture.html?forecast=states`)
    await wait(page, `document.querySelectorAll('.usage-breakdown tbody tr').length === 25`)
    expect(await page.evaluate<unknown[]>(`window.usageRequests().flatMap(item => [item.input.daily, item.input.monthly, item.input.breakdown]).map(slot => ({ group: slot.group, limit: slot.limit, sort: slot.sort, order: slot.order }))`)).toEqual([
      { group: "day", limit: 30, sort: "key", order: "asc" }, { group: "model", limit: 200, sort: "cost", order: "desc" }, { group: "model", limit: 25, sort: "cost", order: "desc" },
    ])
    await page.evaluate(`document.querySelector('.usage-chart__head button').focus()`)
    await page.pressKey("Enter", "Enter", 13, "\r")
    expect(await page.evaluate<number>(`document.querySelectorAll('#usage-daily-table tbody tr').length`)).toBe(30)
    expect(await page.evaluate<string>(`document.querySelector('#usage-daily-table tbody tr').textContent`)).toContain("$5.40")
    await page.evaluate(`document.querySelector('[aria-label="Distribution metric"] button:last-child').click()`)
    expect(await page.evaluate<string>(`document.querySelector('.usage-donut__total').getAttribute('aria-label')`)).toBe("Exact token total: 91,840")
    expect(await page.evaluate<number>(`window.usageRequests().length`)).toBe(1)
    await choose(page, "Usage group", "Provider / profile / model")
    await choose(page, "Usage provider", "Codex")
    await page.evaluate(`(() => { for (const [label, value] of [['Recorded profile', 'Personal'], ['Model ID', 'gpt-6-sol'], ['Selected effort', 'high']]) { const input = [...document.querySelectorAll('.usage-filter-controls label')].find(node => node.textContent.trim() === label).querySelector('input'); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); } })()`)
    await wait(page, `window.usageRequests().some(item => item.input?.breakdown?.selectedEffort === 'high')`)
    expect(await page.evaluate<unknown>(`window.usageRequests().at(-1).input.breakdown`)).toMatchObject({ group: "provider-profile-model", providerID: "openai", profile: "Personal", modelID: "gpt-6-sol", selectedEffort: "high", offset: 0, limit: 25, sort: "cost", order: "desc" })
    await wait(page, `document.querySelector('.usage-tile:first-child strong')?.textContent === '$5.40'`)
  } finally { await page.close() }
})

async function choose(page: Page, label: string, value: string) {
  await page.evaluate(`document.querySelector('[aria-label="${label}"]').click()`)
  await wait(page, `!!document.querySelector('[role="listbox"][aria-label="${label}"]')`)
  await page.evaluate(`[...document.querySelectorAll('[role="listbox"][aria-label="${label}"] [role="option"]')].find(node => node.textContent.trim() === ${JSON.stringify(value)}).click()`)
  await wait(page, `!document.querySelector('.custom-select__surface')`)
}
async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 60; attempt++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
const ready = () => fetch(`http://127.0.0.1:${port}/verify/usage-fixture.html`).then(response => response.ok, () => false)
