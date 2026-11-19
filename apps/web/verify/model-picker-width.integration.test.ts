import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import { launchBrowser, decodeBoolean, decodeNumber, decodeRecord, type Page } from "./cdp"

const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

const port = 4459
const url = `http://127.0.0.1:${port}/verify/composer-fixture.html?model=picker-width`
const modelChip = '.model-control__trigger[aria-label="Model"]'
const desktopChip = `.mini-composer__mount ${modelChip}`
const sheetChip = `.overlay--agent-model ${modelChip}`
const dialog = '[role="dialog"][aria-label="Choose model"], dialog[aria-label="Choose model"]'
const search = '[aria-label="Search models"]'
const list = '[role="listbox"][aria-label="Models"]'
const chooseModel = '.model-control__switch[aria-label="Choose model"]'
const back = 'button[aria-label="Back to model settings"]'
const settings = 'button[aria-label="Model settings"]'
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "inherit" })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(url).then((response) => response.ok, () => false)) break
    if (attempt === 59) throw new Error("The composer fixture did not start")
    await Bun.sleep(100)
  }
  browser = await launchBrowser(executable, 1440, 900)
}, 15_000)
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`Choose model contains long labels and focus at ${width}`, async () => {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      if (width === 390) await page.setCoarsePointer(true)
      await page.navigate(url)
      const chip = width === 390 ? sheetChip : desktopChip
      if (width === 390) await activate(page, ".mini-composer__mount .composer__mobile-trigger")
      await activate(page, chip)
      await activate(page, settings)
      await activate(page, chooseModel)
      await checkPicker(page, width, "settings")
      await activate(page, back)
      await wait(page, `document.activeElement.matches(${JSON.stringify(chooseModel)})`)
      await page.pressEscape()
      await wait(page, `document.activeElement.matches(${JSON.stringify(chip)}) && !document.querySelector('.model-control__surface')`)

      await activate(page, chip)
      await checkPicker(page, width, "chip")
      if (width === 390) {
        await page.evaluate(`(() => {
          const field = document.querySelector(${JSON.stringify(search)});
          field.focus();
          field.value = 'Synthetic width model';
          field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
        await wait(page, `document.querySelectorAll('.model-control__model').length === 1`)
        const sheet = await page.evaluate(`(() => {
          const bounds = document.querySelector('.overlay--model-control .overlay__surface').getBoundingClientRect();
          const list = document.querySelector(${JSON.stringify(list)});
          return { end: bounds.bottom, shorter: bounds.height < innerHeight, scrolls: list.scrollHeight > list.clientHeight };
        })()`, decodeRecord)
        expect(sheet).toEqual({ end: height, shorter: true, scrolls: false })
      }
      await page.pressEscape()
      await wait(page, `document.activeElement.matches(${JSON.stringify(chip)})`)
    } finally { await page.close() }
  }, 30_000)
}

async function activate(page: Page, selector: string) {
  await wait(page, `document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`)
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}

async function wait(page: Page, expression: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await page.evaluate(expression, decodeBoolean)) return
    await Bun.sleep(50)
  }
  throw new Error(`The picker did not reach ${expression}`)
}

async function checkPicker(page: Page, width: number, entry: "settings" | "chip") {
  await wait(page, `document.activeElement.matches(${JSON.stringify(search)}) && !!document.querySelector(${JSON.stringify(dialog)})`)
  const measure = () => page.evaluate(`(async () => {
    await document.fonts.ready;
    const dialog = document.querySelector(${JSON.stringify(dialog)});
    const surface = dialog.matches('.model-control__surface') ? dialog : dialog.querySelector('.model-control__surface');
    const shell = dialog.querySelector('.overlay__surface') ?? surface;
    const header = shell.querySelector('.overlay__head, .mini-picker__heading');
    const search = surface.querySelector(${JSON.stringify(search)});
    const list = surface.querySelector(${JSON.stringify(list)});
    await Promise.allSettled(shell.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished));
    const rect = node => node.getBoundingClientRect();
    const size = node => {
      const bounds = rect(node);
      return { scroll: node.scrollWidth, client: node.clientWidth, contentHeight: node.scrollHeight, clientHeight: node.clientHeight, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    };
    const inside = (inner, outer, outset = 0) => inner.left - outset >= outer.left && inner.right + outset <= outer.right && inner.top - outset >= outer.top && inner.bottom + outset <= outer.bottom;
    const hit = node => {
      const box = rect(node), point = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { width: box.width, height: box.height, inside: inside(box, rect(header)), hit: point === node || node.contains(point) };
    };
    const focus = getComputedStyle(search);
    const outline = parseFloat(focus.outlineWidth);
    const rows = [...list.children];
    const row = rows.find(node => node.textContent.includes('SyntheticProfile'));
    const provider = rows.find(node => node.getAttribute('role') === 'presentation' && node.textContent.startsWith('SyntheticProvider'));
    const textFits = node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].every(part => inside(part, rect(node)));
    };
    return {
      parts: { shell: size(shell), surface: size(surface), header: size(header), search: size(search), list: size(list) },
      inViewport: inside(rect(shell), { left: 0, right: innerWidth, top: 0, bottom: innerHeight }),
      childrenContained: [header, search, list].every(node => inside(rect(node), rect(shell))),
      searchFocused: document.activeElement === search && search.matches(':focus-visible'),
      searchOutline: outline > 0 && focus.outlineStyle !== 'none' && inside(rect(search), rect(surface), Math.max(0, outline + parseFloat(focus.outlineOffset))),
      verticalScroll: { height: list.clientHeight, content: list.scrollHeight, overflow: getComputedStyle(list).overflowY },
      close: hit(header.querySelector('button[aria-label^="Close "]')),
      navigation: hit(header.querySelector(${JSON.stringify(entry === "settings" ? back : settings)})),
      populated: row?.textContent.includes('longmodelidentifier') === true && !!provider,
      textContained: rows.every(textFits),
      rowsSeparate: rows.every((node, index) => index === 0 || rect(node).top >= rect(rows[index - 1]).bottom),
      placement: { sheet: dialog.getAttribute('aria-modal') === 'true', right: rect(shell).right, bottom: rect(shell).bottom, left: rect(shell).left, trigger: document.querySelector(${JSON.stringify(desktopChip)})?.getBoundingClientRect().left ?? 0 },
    };
  })()`, decodeRecord)
  const focused = await measure()
  const captureDir = process.env.YCODING_WEB_CAPTURE_DIR
  if (captureDir) {
    const prefix = join(captureDir, `choose-model-${width}-${entry}`)
    await Bun.write(`${prefix}.png`, Buffer.from(await page.screenshot(), "base64"))
  }
  await page.pressKey("Tab", "Tab", 9)
  await wait(page, `document.activeElement.matches('.model-control__model:focus-visible')`)
  const unfocused = await measure()
  if (captureDir) await Bun.write(join(captureDir, `choose-model-${width}-${entry}.json`), JSON.stringify({ focused, unfocused }, null, 2))
  expect(focused).toMatchObject({ searchFocused: true, searchOutline: true })
  expect(unfocused).toMatchObject({ searchFocused: false, searchOutline: false })
  for (const geometry of [focused, unfocused]) {
    expect(geometry.populated).toBe(true)
    const parts = Object.entries(decodeRecord(geometry.parts))
    expect(parts.filter(([name, value]) => {
      const part = decodeRecord(value)
      return decodeNumber(part.scroll) !== decodeNumber(part.client) || name !== "list" && decodeNumber(part.contentHeight) > decodeNumber(part.clientHeight)
    }), JSON.stringify(geometry)).toEqual([])
    expect(geometry).toMatchObject({ inViewport: true, childrenContained: true, textContained: true, rowsSeparate: true, close: { inside: true, hit: true }, navigation: { inside: true, hit: true } })
    for (const target of [geometry.close, geometry.navigation]) {
      const bounds = decodeRecord(target)
      expect(Math.min(decodeNumber(bounds.width), decodeNumber(bounds.height))).toBeGreaterThanOrEqual(width === 390 ? 44 : 24)
    }
  }
  const scrolling = decodeRecord(focused.verticalScroll)
  expect(decodeNumber(scrolling.content)).toBeGreaterThan(decodeNumber(scrolling.height))
  expect(scrolling.overflow).toMatch(/^(auto|scroll)$/)
  const placement = decodeRecord(focused.placement)
  expect(placement.sheet).toBe(width === 390)
  if (width === 390) expect(placement.bottom).toBe(844)
  else expect(placement.left).toBe(placement.trigger)
}
