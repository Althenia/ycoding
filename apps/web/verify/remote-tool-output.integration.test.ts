import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeRecord, decodeString } from "./cdp"

const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
let origin = ""

beforeAll(async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 4220 + (process.pid % 100) + attempt * 101
    const candidate = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: import.meta.dir.replace(/\/verify$/, ""),
      stdout: "ignore",
      stderr: "ignore",
    })
    for (let poll = 0; poll < 60 && candidate.exitCode === null; poll += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`)
        if (response.ok) {
          server = candidate
          origin = `http://127.0.0.1:${port}`
          browser = await launchBrowser(browserPath, 390, 844)
          return
        }
      } catch {
        // Wait for the local source server.
      }
      await Bun.sleep(100)
    }
    candidate.kill()
    await candidate.exited
  }
  throw new Error("Vite did not start for the tool-output render test")
}, 30_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("remote tool output rendering", () => {
  test.each([1440, 390])("contains expanded shell input and results at %ipx without clipping text", async (width) => {
    const page = await browser!.openPage()
    const command = JSON.stringify({ command: `sample-${"x".repeat(512)}-end` }, null, 2)
    const output = `result-${"y".repeat(512)}-end`
    const expected = [[JSON.stringify({ command: "echo ready" }, null, 2), "ready\nfinished"], [command, output, output]]
    try {
      await page.setViewport(width, 900)
      await page.navigate(`${origin}/verify/transcript.html?tool-output=long-lines`)
      const state = await page.evaluate(`(async () => {
        for (let i = 0; i < 80 && document.querySelectorAll('.transcript-tool__toggle').length !== 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
        const cards = [...document.querySelectorAll('.transcript-tool')];
        if (cards.length !== 2) throw new Error('Expected two completed shell cards');
        const toggles = cards.map(card => card.querySelector('.transcript-tool__toggle'));
        const collapsed = toggles.every(toggle => toggle.getAttribute('aria-expanded') === 'false');
        toggles.forEach(toggle => toggle.click());
        await document.fonts.ready;
        const bodies = cards.map(card => card.querySelector('.transcript-tool__body'));
        await Promise.all(bodies.flatMap(body => body.getAnimations().map(animation => animation.finished)));
        const box = element => {
          const { left, right } = element.getBoundingClientRect();
          return { left, right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
        };
        const inside = (inner, outer) => inner.left >= outer.left && inner.right <= outer.right;
        const scrollers = ['.workspace__scroll', '.transcript-navigation', '.transcript'].map(selector => box(document.querySelector(selector)));
        const sections = ['.transcript-tool__body', '.collapsible__inner', '.transcript-tool__content', '.transcript-shell-output', 'pre.output'];
        const geometry = cards.map((card, index) => ({
          header: box(toggles[index]),
          body: [...card.querySelectorAll(sections.join(','))].map(box),
        }));
        const expected = ${JSON.stringify(expected)};
        const textIntact = cards.every((card, index) => {
          const blocks = [...card.querySelectorAll('pre.output')];
          return blocks.length === expected[index].length && blocks.every((pre, block) => {
            const code = pre.querySelector('code');
            const range = document.createRange();
            range.selectNodeContents(code);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            const selectable = getComputedStyle(code).userSelect !== 'none' && selection.toString() === expected[index][block];
            selection.removeAllRanges();
            if (pre.scrollWidth <= pre.clientWidth) return selectable;
            if (index === 0) return false;
            pre.scrollLeft = pre.scrollWidth;
            const reachable = range.getBoundingClientRect().right <= pre.getBoundingClientRect().right;
            return selectable && reachable && pre.scrollLeft > 0 && getComputedStyle(pre).overflowX === 'auto';
          });
        });
        return {
          geometry, scrollers,
          contained: geometry.every(card => card.body.every(body => inside(body, card.header))),
          noOuterOverflow: [box(document.documentElement), ...scrollers].every(box => box.scrollWidth === box.clientWidth),
          headersIntact: collapsed && toggles.every((toggle, index) => toggle.getAttribute('aria-expanded') === 'true' &&
            toggle.getAttribute('aria-controls') === bodies[index].id && toggle.textContent.includes('Completed') &&
            [...toggle.children].every(child => child.getBoundingClientRect().width > 0 && inside(box(child), box(toggle)))),
          textIntact,
        };
      })()`, decodeRecord)
      const { geometry, scrollers, ...checks } = state
      expect(checks, JSON.stringify({ width, geometry, scrollers })).toEqual({ contained: true, noOuterOverflow: true, headersIntact: true, textIntact: true })
    } finally {
      await page.close()
    }
  }, 30_000)

  test("hides both local capture paths, caps visible text, and labels client and device limits separately", async () => {
    const page = await browser!.openPage()
    try {
      await page.navigate(`${origin}/verify/transcript.html?tool-output=1`)
      const displayed = await page.evaluate(`(async () => {
        for (let i = 0; i < 40 && document.querySelectorAll('.transcript-tool').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 25));
        document.querySelectorAll('.transcript-tool__toggle').forEach(button => button.click());
        await new Promise(resolve => setTimeout(resolve, 25));
        const output = [...document.querySelectorAll('.transcript-tool .output code')].map(element => element.textContent ?? '').join('\\n');
        const notes = [...document.querySelectorAll('.transcript-tool')].map(tool => [...tool.querySelectorAll('.transcript-tool__note')].map(note => note.textContent ?? '').join(' '));
        return { output, notes };
      })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, output: (decodeString)(record["output"]), notes: (decodeArray(decodeString))(record["notes"]) } })
      expect(displayed.output).toContain("first line")
      expect(displayed.output).toContain("shell result")
      expect(displayed.output).not.toContain("/private/fixture/")
      expect(displayed.output.length).toBeLessThan(5_000)
      expect(displayed.notes[0]).toContain("available tool output")
      expect(displayed.notes[0]).toContain("truncated on the device")
      expect(displayed.notes[1]).toContain("truncated on the device")
      expect(displayed.notes[1]).not.toContain("available tool output")
    } finally {
      await page.close()
    }
  }, 30_000)
})
