import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4681
const origin = `http://127.0.0.1:${port}`
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: Bun.Subprocess | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["node_modules/.bin/vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80 && server.exitCode === null; attempt += 1) {
    try {
      if ((await fetch(`${origin}/verify/remote.html`)).ok) {
        browser = await launchBrowser(browserPath, 1440, 900)
        return
      }
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error("Workspaces fixture server did not start; check that port 4681 is free")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function open(theme: "light" | "dark", workspaces: "overflow" | "default") {
  const page = await browser!.openPage()
  await page.setViewport(1440, 900)
  await page.navigate(`${origin}/verify/remote.html?view=sessions&theme=${theme}${workspaces === "overflow" ? "&workspaces=overflow" : ""}`)
  const expected = workspaces === "overflow" ? 22 : 1
  for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .workspace-nav__item').length`) !== expected; attempt += 1) await Bun.sleep(50)
  expect(await page.evaluate<number>(`document.querySelectorAll('.workspace__rail .workspace-nav__item').length`)).toBe(expected)
  await page.evaluate(`(() => {
    document.querySelector('.fixture__banner')?.remove();
    document.querySelector('.fixture__controls')?.remove();
    const fixture = document.querySelector('.fixture');
    fixture.style.height = '100dvh';
    fixture.style.minHeight = '0';
    fixture.style.overflow = 'hidden';
  })()`)
  return page
}

const measure = `(() => {
  const nav = document.querySelector('.workspace__rail .workspace-nav');
  const style = getComputedStyle(nav);
  return {
    hasMore: nav.hasAttribute('data-more-below'),
    mask: style.maskImage,
    scrollTop: nav.scrollTop,
    scrollHeight: nav.scrollHeight,
    clientHeight: nav.clientHeight,
    edge: nav.getBoundingClientRect().bottom,
    viewportHeight: innerHeight,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`

describe("desktop Workspaces scroll cue", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`fades only while more items are below in ${theme}`, async () => {
      const page = await open(theme, "overflow")
      try {
        const top = await page.evaluate<{ hasMore: boolean; mask: string; scrollHeight: number; clientHeight: number; edge: number; viewportHeight: number; overflow: boolean }>(measure)
        expect(top.scrollHeight).toBeGreaterThan(top.clientHeight)
        expect(top.edge).toBeLessThanOrEqual(top.viewportHeight)
        expect(top.hasMore).toBe(true)
        expect(top.mask).toContain("linear-gradient")
        expect(top.mask).toMatch(/^linear-gradient\(rgb\(0, 0, 0\) calc\(100% - [^)]+\), rgba\(0, 0, 0, 0\)\)$/)
        expect(top.overflow).toBe(false)

        await page.evaluate(`document.querySelector('.workspace__rail .workspace-nav').scrollTop = 10000`)
        for (let attempt = 0; attempt < 30 && await page.evaluate<boolean>(`document.querySelector('.workspace__rail .workspace-nav').hasAttribute('data-more-below')`); attempt += 1) await Bun.sleep(20)
        const end = await page.evaluate<{ hasMore: boolean; mask: string; scrollTop: number; scrollHeight: number; clientHeight: number }>(measure)
        expect(end.scrollTop).toBeGreaterThan(0)
        expect(end.scrollHeight - end.clientHeight - end.scrollTop).toBeLessThanOrEqual(1)
        expect(end.hasMore).toBe(false)
        expect(end.mask).toBe("none")

        await page.evaluate(`document.querySelector('.workspace__rail .workspace-nav').scrollTop = 0`)
        for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .workspace-nav').hasAttribute('data-more-below')`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail .workspace-nav').hasAttribute('data-more-below')`)).toBe(true)

        await page.evaluate(`document.querySelectorAll('.workspace__rail .workspace-nav__item')[12].focus()`)
        for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .workspace-nav').hasAttribute('data-more-below')`); attempt += 1) await Bun.sleep(20)
        const focus = await page.evaluate<{ focused: boolean; bottom: number; edge: number; padding: number; hasMore: boolean }>(`(() => {
          const nav = document.querySelector('.workspace__rail .workspace-nav');
          const item = document.querySelectorAll('.workspace__rail .workspace-nav__item')[12];
          return { focused: document.activeElement === item, bottom: item.getBoundingClientRect().bottom,
            edge: nav.getBoundingClientRect().bottom, padding: parseFloat(getComputedStyle(nav).scrollPaddingBlockEnd),
            hasMore: nav.hasAttribute('data-more-below') };
        })()`)
        expect(focus.focused).toBe(true)
        expect(focus.hasMore).toBe(true)
        expect(focus.padding).toBeGreaterThan(0)
        expect(focus.bottom).toBeLessThanOrEqual(focus.edge - focus.padding + 1)

        await page.setViewport(1440, 1800)
        for (let attempt = 0; attempt < 30 && await page.evaluate<boolean>(`document.querySelector('.workspace__rail .workspace-nav').hasAttribute('data-more-below')`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.workspace__rail .workspace-nav')).maskImage`)).toBe("none")
        await page.setViewport(1440, 900)
        for (let attempt = 0; attempt < 30 && !await page.evaluate<boolean>(`document.querySelector('.workspace__rail .workspace-nav').hasAttribute('data-more-below')`); attempt += 1) await Bun.sleep(20)
        expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail .workspace-nav').hasAttribute('data-more-below')`)).toBe(true)
      } finally { await page.close() }
    }, 30_000)

    test(`has no cue when the list fits in ${theme}`, async () => {
      const page = await open(theme, "default")
      try {
        const state = await page.evaluate<{ hasMore: boolean; mask: string; scrollHeight: number; clientHeight: number }>(measure)
        expect(state.scrollHeight).toBeLessThanOrEqual(state.clientHeight)
        expect(state.hasMore).toBe(false)
        expect(state.mask).toBe("none")
      } finally { await page.close() }
    }, 30_000)
  }

  test("the fade does not block a visible workspace button", async () => {
    const page = await open("light", "overflow")
    try {
      const target = await page.evaluate<{ x: number; y: number; title: string; hit: string }>(`(() => {
        const nav = document.querySelector('.workspace__rail .workspace-nav');
        const bounds = nav.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.bottom - 12;
        return { x, y, title: [...nav.querySelectorAll('.workspace-nav__item')].find(item => {
          const rect = item.getBoundingClientRect(); return rect.top <= y && rect.bottom >= y;
        })?.title ?? '', hit: document.elementFromPoint(x, y)?.closest('.workspace-nav__item')?.title ?? '' };
      })()`)
      expect(target.title.length).toBeGreaterThan(0)
      expect(target.hit).toBe(target.title)
      await page.mouse("mousePressed", target.x, target.y)
      await page.mouse("mouseReleased", target.x, target.y)
      for (let attempt = 0; attempt < 40 && await page.evaluate<string>(`document.querySelector('.workspace-nav__item[aria-current="true"]')?.title ?? ''`) !== target.title; attempt += 1) await Bun.sleep(25)
      expect(await page.evaluate<string>(`document.querySelector('.workspace-nav__item[aria-current="true"]')?.title ?? ''`)).toBe(target.title)
    } finally { await page.close() }
  }, 30_000)

  test("forced colors removes the mask and reduced motion has no animated cue", async () => {
    const page = await open("light", "overflow")
    try {
      expect(await page.evaluate<boolean>(`document.querySelector('.workspace__rail .workspace-nav').hasAttribute('data-more-below')`)).toBe(true)
      await page.setForcedColors(true)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.workspace__rail .workspace-nav')).maskImage`)).toBe("none")
      await page.setForcedColors(false)
      await page.setReducedMotion(true)
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('.workspace__rail .workspace-nav')).transitionDuration`)).toBe("0s")
    } finally { await page.close() }
  }, 30_000)
})
