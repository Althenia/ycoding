import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4396
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

test("ghost suggestion fills by Right or 44px touch action without sending; typing, Escape, activity and source mismatch dismiss", async () => {
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, width === 390 ? 844 : 900)
        if (width === 390) await page.setCoarsePointer(true)
        await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
        await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
        await page.evaluate(
          `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; localStorage.removeItem('ycoding.remote.composer-collapsed')`,
        )
        const baseline = await page.evaluate<number>(
          `document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height`,
        )
        await page.evaluate(`window.composerPrediction()`)
        await wait(page, `document.querySelector('.mini-composer__mount .composer__use-prediction') !== null`)
        const layout = await page.evaluate<{
          text: string
          value: string
          height: number
          width: number
          row: number
          overflow: boolean
        }>(
          `(() => { const field=document.querySelector('.mini-composer__mount .composer__input'), button=document.querySelector('.composer__use-prediction'); return { text:field.placeholder, value:field.value, height:button.getBoundingClientRect().height, width:button.getBoundingClientRect().width, row:document.querySelector('.mini-composer__mount .composer__row').getBoundingClientRect().height, overflow:document.documentElement.scrollWidth>innerWidth }; })()`,
        )
        expect(layout.text).toBe("Run the focused tests")
        expect(layout.value).toBe("")
        expect(layout.height).toBeGreaterThanOrEqual(44)
        expect(layout.width).toBeGreaterThanOrEqual(44)
        expect(layout.row).toBe(baseline)
        expect(layout.overflow).toBe(false)
        await page.evaluate(
          `(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); field.focus(); field.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true, cancelable:true })) })()`,
        )
        await wait(
          page,
          `document.querySelector('.mini-composer__mount .composer__input').value === 'Run the focused tests'`,
        )
        expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
        await page.evaluate(
          `window.composerSetDraft('ses_fixture', ''); window.composerPrediction('Inspect the test results')`,
        )
        await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
        await page.evaluate(`document.querySelector('.composer__use-prediction').click()`)
        await wait(
          page,
          `document.querySelector('.mini-composer__mount .composer__input').value === 'Inspect the test results'`,
        )
        expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
        await page.evaluate(`window.composerPrediction('Do not overwrite me')`)
        expect(
          await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__input').value`),
        ).toBe("Inspect the test results")
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
        await page.evaluate(
          `window.composerSetDraft('ses_fixture', ''); window.composerPrediction('Try the new behavior');`,
        )
        await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
        await page.evaluate(
          `(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); field.value='My draft'; field.dispatchEvent(new Event('input',{bubbles:true})); field.value=''; field.dispatchEvent(new Event('input',{bubbles:true})); })()`,
        )
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
        await page.evaluate(`window.composerPrediction('Review the changes');`)
        await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
        await page.evaluate(
          `document.querySelector('.mini-composer__mount .composer__input').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }))`,
        )
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
        await page.evaluate(`window.composerPrediction('Try the new behavior'); window.composerSetStatus('running')`)
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
        await page.evaluate(`window.composerPrediction('Check the result', 'msg_old')`)
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
      } finally {
        await page.close()
      }
    }
}, 60000)

async function ready() {
  try {
    return (await fetch(`http://127.0.0.1:${port}/verify/composer-fixture.html`)).ok
  } catch {
    return false
  }
}

test.each(["typing", "Escape"])(
  "%s before prediction arrival survives another Session draft but permits a newer reply",
  async (action) => {
    for (const width of [390, 1440])
      for (const theme of ["light", "dark"]) {
        const page = await browser!.openPage()
        try {
          await page.setViewport(width, width === 390 ? 844 : 900)
          await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.composer-collapsed')`)
          await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
          await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
          await page.evaluate(
            `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.composerPredictionReply('msg_late')`,
          )
          await page.evaluate(
            `(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); field.focus(); ${action === "typing" ? "field.value='My draft'; field.dispatchEvent(new Event('input',{bubbles:true})); field.value=''; field.dispatchEvent(new Event('input',{bubbles:true}));" : "field.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));"} })()`,
          )
          await page.evaluate(
            `window.composerPredictionSession('ses_other'); window.composerPredictionReply('msg_other')`,
          )
          await page.evaluate(
            `(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); field.value='Other draft'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`,
          )
          await page.evaluate(
            `window.composerPredictionSession('ses_fixture'); window.composerPredictionReply('msg_late')`,
          )
          await page.evaluate(`window.composerPredictionEvent('Run the late tests', 'msg_late')`)
          expect(
            await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__input').placeholder`),
          ).toBe("Ask anything…")
          expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(
            true,
          )
          await page.evaluate(`window.composerPredictionEvent('Run the repeated tests', 'msg_late')`)
          expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(
            true,
          )
          expect(await page.evaluate<string>(`window.composerState().drafts.ses_other`)).toBe("Other draft")
          await page.evaluate(`window.composerSetDraft('ses_other','')`)
          await page.evaluate(
            `window.composerPredictionReply('msg_newer'); window.composerPredictionEvent('Review the new reply', 'msg_newer')`,
          )
          await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
          expect(
            await page.evaluate<boolean>(
              `document.activeElement === document.querySelector('.mini-composer__mount .composer__input')`,
            ),
          ).toBe(true)
          expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
          await page.evaluate(
            `window.composerSwitchSession(); window.composerPredictionEvent('Stale reply from the previous session', 'msg_newer')`,
          )
          expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(
            true,
          )
          await page.evaluate(
            `window.composerPredictionReply('msg_late'); window.composerPredictionEvent('Review this session reply', 'msg_late')`,
          )
          await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
          expect(
            await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__input').value`),
          ).toBe("")
          for (const deviceID of ["dev_fixture", "dev_other"]) {
            await page.pressEscape()
            expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(
              true,
            )
            await page.evaluate(
              `window.composerPredictionConnection(${JSON.stringify(deviceID)}); window.composerPredictionEvent('Fresh connection reply', 'msg_late')`,
            )
            await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
          }
        } finally {
          await page.close()
        }
      }
  },
  60000,
)

test("visible ghost Tab fills only, retains attachments and caret, and otherwise preserves keyboard precedence and native focus", async () => {
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, width === 390 ? 844 : 900)
        if (width === 390) await page.setCoarsePointer(true)
        await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.composer-collapsed')`)
        await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
        await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
        await page.evaluate(
          `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.composerPrediction()`,
        )
        await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
        for (const option of [
          "isComposing:true",
          "keyCode:229",
          "shiftKey:true",
          "altKey:true",
          "ctrlKey:true",
          "metaKey:true",
        ]) {
          expect(
            await page.evaluate<boolean>(
              `(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); const event=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true,${option}}); field.dispatchEvent(event); return event.defaultPrevented })()`,
            ),
          ).toBe(false)
          expect(
            await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__input').value`),
          ).toBe("")
        }
        for (const block of [
          "window.composerPredictionEnabled(false)",
          "document.querySelector('.composer-fixture > button').click()",
        ]) {
          await page.evaluate(block)
          expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(
            true,
          )
          expect(
            await page.evaluate<boolean>(
              `(() => { const event=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}); document.querySelector('.mini-composer__mount .composer__input').dispatchEvent(event); return event.defaultPrevented })()`,
            ),
          ).toBe(false)
          expect(
            await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__input').value`),
          ).toBe("")
          await page.evaluate(
            block === "window.composerPredictionEnabled(false)" ? "window.composerPredictionEnabled(true)" : block,
          )
          await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
        }
        await page.evaluate(
          `(() => { const transfer=new DataTransfer(); transfer.items.add(new File(['evidence'],'evidence.txt',{type:'text/plain'})); const field=document.querySelector('.mini-composer__mount .composer__input'); field.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer})); field.focus(); })()`,
        )
        await wait(page, `document.querySelector('.mini-composer__mount .composer__attachment') !== null`)
        await page.pressKey("Tab", "Tab", 9)
        await wait(
          page,
          `document.querySelector('.mini-composer__mount .composer__input').value === 'Run the focused tests'`,
        )
        expect(
          await page.evaluate<{ focused: boolean; start: number; end: number; attachments: number }>(
            `(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); return {focused:document.activeElement===field,start:field.selectionStart,end:field.selectionEnd,attachments:document.querySelectorAll('.mini-composer__mount .composer__attachment').length} })()`,
          ),
        ).toEqual({ focused: true, start: 21, end: 21, attachments: 1 })
        expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
        await page.pressKey("Tab", "Tab", 9)
        expect(
          await page.evaluate<boolean>(
            `document.activeElement !== document.querySelector('.mini-composer__mount .composer__input')`,
          ),
        ).toBe(true)
        await page.evaluate(
          `(() => { const field=document.querySelector('.mini-composer__mount .composer__input'); field.value='/pla'; field.dispatchEvent(new Event('input',{bubbles:true})); field.focus(); })()`,
        )
        await wait(page, `document.querySelector('.mini-composer__mount [role="option"]') !== null`)
        await page.pressKey("Tab", "Tab", 9)
        expect(
          await page.evaluate<string>(`document.querySelector('.mini-composer__mount .composer__input').value`),
        ).toBe("/plan ")
        expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
        await page.evaluate(
          `window.composerSetDraft('ses_fixture',''); window.composerPrediction('Hidden while disconnected'); window.composerPredictionTransport(false)`,
        )
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
        await page.evaluate(
          `window.composerPredictionReply('msg_offline'); window.composerPredictionEvent('Late disconnected event', 'msg_offline')`,
        )
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
        await page.evaluate(`window.composerPredictionTransport(true)`)
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
        await page.evaluate(
          `window.composerPrediction('Collapsed suggestion'); document.querySelector('.mini-composer__mount .composer__dock-toggle').click()`,
        )
        await wait(page, `document.querySelector('.mini-composer__mount .composer--collapsed') !== null`)
        expect(await page.evaluate<boolean>(`document.querySelector('.composer__use-prediction') === null`)).toBe(true)
        expect(
          await page.evaluate<boolean>(
            `(() => { const event=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}); document.querySelector('.mini-composer__mount .composer__input').dispatchEvent(event); return event.defaultPrevented })()`,
          ),
        ).toBe(false)
        expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
        await page.evaluate(
          `document.querySelector('.mini-composer__mount .composer__dock-toggle').click(); window.composerPrediction('Send only on Enter')`,
        )
        await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
        await page.evaluate(`document.querySelector('.mini-composer__mount .composer__input').focus()`)
        await page.pressKey("Tab", "Tab", 9)
        expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
        await page.pressKey("Enter", "Enter", 13)
        await wait(page, `window.composerRequests().length === 1`)
        expect(
          await page.evaluate<{ operation: string; input: { text: string; files: { name: string }[] } }>(
            `window.composerRequests()[0]`,
          ),
        ).toMatchObject({
          operation: "session.prompt",
          input: { text: "Send only on Enter", files: [{ name: "evidence.txt" }] },
        })
      } finally {
        await page.close()
      }
    }
}, 60000)

test("a 35-word prediction above 200 characters fits the composer and Tab accepts its complete text without sending", async () => {
  const text =
    "Review the completed implementation against the agreed requirements, inspect the modified files for regressions, verify focused tests and browser behavior, then summarize any remaining risks before deciding whether the changes are ready for safe integration."
  expect(text.split(/\s+/).length).toBe(35)
  expect(text.length).toBeGreaterThan(200)
  expect(text.length).toBeLessThanOrEqual(400)
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, width === 390 ? 844 : 900)
        if (width === 390) await page.setCoarsePointer(true)
        await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.composer-collapsed')`)
        await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
        await wait(page, `document.querySelector('.mini-composer__mount .composer__input') !== null`)
        await page.evaluate(
          `(async () => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; await document.fonts.ready; window.composerPredictionReply('msg_long'); window.composerPredictionEvent(${JSON.stringify(text)}, 'msg_long'); })()`,
        )
        await wait(page, `document.querySelector('.composer__use-prediction') !== null`)
        const geometry = `(() => {
        const root=document.querySelector('.mini-composer__mount'), field=root.querySelector('.composer__input'), row=root.querySelector('.composer__row').getBoundingClientRect(), rect=field.getBoundingClientRect(), actions=root.querySelector('.composer__actions').getBoundingClientRect();
        return { placeholder:field.placeholder, value:field.value, height:rect.height, fits:field.scrollHeight<=field.clientHeight+1 && field.scrollWidth<=field.clientWidth+1, contained:rect.left>=row.left && rect.right<=row.right && rect.top>=row.top && rect.bottom<=actions.top, overflow:document.documentElement.scrollWidth>innerWidth,
          actionsExposed:Array.from(root.querySelectorAll('.composer__actions button, .composer__dock button')).every(button => { const box=button.getBoundingClientRect(); return box.width>0 && box.height>0 && box.left>=0 && box.right<=innerWidth && box.top>=0 && box.bottom<=innerHeight && button.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)) }),
          focused:document.activeElement===field, start:field.selectionStart, end:field.selectionEnd };
      })()`
        const ghost = await page.evaluate<{
          placeholder: string
          value: string
          height: number
          fits: boolean
          contained: boolean
          overflow: boolean
          actionsExposed: boolean
        }>(geometry)
        expect(ghost).toMatchObject({
          placeholder: text,
          value: "",
          fits: true,
          contained: true,
          overflow: false,
          actionsExposed: true,
        })
        await page.evaluate(`document.querySelector('.mini-composer__mount .composer__input').focus()`)
        await page.pressKey("Tab", "Tab", 9)
        await wait(
          page,
          `document.querySelector('.mini-composer__mount .composer__input').value === ${JSON.stringify(text)}`,
        )
        const accepted = await page.evaluate<{
          value: string
          height: number
          fits: boolean
          contained: boolean
          overflow: boolean
          actionsExposed: boolean
          focused: boolean
          start: number
          end: number
        }>(geometry)
        expect(accepted).toMatchObject({
          value: text,
          fits: true,
          contained: true,
          overflow: false,
          actionsExposed: true,
          focused: true,
          start: text.length,
          end: text.length,
        })
        expect(accepted.height).toBeCloseTo(ghost.height, 0)
        expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(0)
      } finally {
        await page.close()
      }
    }
}, 60000)

async function wait(page: { evaluate<T>(script: string): Promise<T> }, expression: string) {
  for (let index = 0; index < 100; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(50)
  }
  throw new Error(`Did not settle: ${expression}`)
}

test("/suggest opens the memory dialog, sends only checked scopes with the hint, and Escape sends nothing", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    const input = ".mini-composer__mount textarea"
    try {
      await page.setViewport(width, width === 390 ? 844 : 900)
      await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.composer-collapsed')`)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector(${JSON.stringify(input)}) !== null`)
      const submit = async (text: string) => {
        await page.evaluate(
          `(() => { const field=document.querySelector(${JSON.stringify(input)}); field.focus(); field.value=${JSON.stringify(text)}; field.dispatchEvent(new Event('input',{bubbles:true})); })()`,
        )
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]').click()`)
        await wait(page, `document.querySelector('dialog[aria-label="Suggest next message"]')?.open === true`)
      }
      await submit("/suggest focus on tests")
      const dialog = await page.evaluate<{
        labels: string[]
        checked: boolean[]
        focusInside: boolean
        overflow: boolean
      }>(
        `(() => { const dialog=document.querySelector('dialog[aria-label="Suggest next message"]'); const boxes=[...dialog.querySelectorAll('input[type=checkbox]')]; return { labels: boxes.map(box => box.closest('label').textContent.trim()), checked: boxes.map(box => box.checked), focusInside: dialog.contains(document.activeElement), overflow: document.documentElement.scrollWidth > innerWidth } })()`,
      )
      expect(dialog).toEqual({
        labels: ["Project memory (this repository)", "Global memory (shared knowledge)"],
        checked: [false, false],
        focusInside: true,
        overflow: false,
      })
      expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)}).value`)).toBe("")
      await page.evaluate(
        `document.querySelector('dialog[aria-label="Suggest next message"] input[type=checkbox]').click()`,
      )
      await page.evaluate(
        `[...document.querySelectorAll('dialog[aria-label="Suggest next message"] button')].find(button => button.textContent.trim() === 'Suggest').click()`,
      )
      await wait(
        page,
        `!document.querySelector('dialog[aria-label="Suggest next message"]')?.open && window.composerRequests().length === 1`,
      )
      expect(await page.evaluate<unknown>(`window.composerRequests()`)).toEqual([
        { operation: "session.prediction", input: { memory: ["repository"], hint: "focus on tests" } },
      ])
      await wait(page, `document.activeElement === document.querySelector(${JSON.stringify(input)})`)
      await submit("/suggest")
      await page.pressEscape()
      await wait(page, `!document.querySelector('dialog[aria-label="Suggest next message"]')?.open`)
      expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(1)
    } finally {
      await page.close()
    }
  }
}, 60000)

test("/prompt opens the generate dialog, sends mode and memory, and hides Steer and Queue without a Session", async () => {
  for (const width of [390, 1440]) {
    const page = await browser!.openPage()
    const input = ".mini-composer__mount textarea"
    try {
      await page.setViewport(width, width === 390 ? 844 : 900)
      await page.injectOnNewDocument(`localStorage.removeItem('ycoding.remote.composer-collapsed')`)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector(${JSON.stringify(input)}) !== null`)
      const submit = async (text: string) => {
        await page.evaluate(
          `(() => { const field=document.querySelector(${JSON.stringify(input)}); field.focus(); field.value=${JSON.stringify(text)}; field.dispatchEvent(new Event('input',{bubbles:true})); })()`,
        )
        await page.evaluate(`document.querySelector('.mini-composer__mount button[aria-label="Send prompt"]').click()`)
        await wait(page, `document.querySelector('dialog[aria-label="Generate prompt"]')?.open === true`)
      }
      await submit("/prompt focus the tests")
      const dialog = await page.evaluate<{
        radios: string[]
        checked: string | null
        memory: string[]
        memoryChecked: boolean[]
        focusInside: boolean
        overflow: boolean
      }>(
        `(() => { const dialog=document.querySelector('dialog[aria-label="Generate prompt"]'); const radios=[...dialog.querySelectorAll('input[type=radio]')]; const boxes=[...dialog.querySelectorAll('input[type=checkbox]')]; return { radios: radios.map(radio => radio.closest('label').textContent.trim()), checked: radios.find(radio => radio.checked)?.closest('label').textContent.trim() ?? null, memory: boxes.map(box => box.closest('label').textContent.trim()), memoryChecked: boxes.map(box => box.checked), focusInside: dialog.contains(document.activeElement), overflow: document.documentElement.scrollWidth > innerWidth } })()`,
      )
      expect(dialog).toEqual({
        radios: ["Start a task", "Steer", "Queue follow-up", "Goal objective"],
        checked: "Start a task",
        memory: ["Project memory (this repository)", "Global memory (shared knowledge)"],
        memoryChecked: [false, false],
        focusInside: true,
        overflow: false,
      })
      expect(
        await page.evaluate<boolean>(
          `document.activeElement===document.querySelector('dialog[aria-label="Generate prompt"] input[value="start"]')`,
        ),
      ).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector(${JSON.stringify(input)}).value`)).toBe("")
      await page.evaluate(`document.querySelector('dialog[aria-label="Generate prompt"] input[type=checkbox]').click()`)
      await page.evaluate(
        `[...document.querySelectorAll('dialog[aria-label="Generate prompt"] button')].find(button => button.textContent.trim() === 'Generate').click()`,
      )
      await wait(
        page,
        `!document.querySelector('dialog[aria-label="Generate prompt"]')?.open && window.composerRequests().length === 1`,
      )
      expect(await page.evaluate<unknown>(`window.composerRequests()`)).toEqual([
        {
          operation: "session.promptGenerate",
          input: { mode: "start", intent: "focus the tests", memory: ["repository"] },
        },
      ])
      await wait(page, `document.activeElement === document.querySelector(${JSON.stringify(input)})`)
      await submit("/prompt later")
      await page.pressEscape()
      await wait(page, `!document.querySelector('dialog[aria-label="Generate prompt"]')?.open`)
      expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(1)
      await wait(
        page,
        `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`,
      )
      await page.evaluate(
        `(() => { const field=document.querySelector('.new-session-composer textarea'); field.focus(); field.value='/prompt open the task'; field.dispatchEvent(new Event('input',{bubbles:true})); })()`,
      )
      await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]').click()`)
      await wait(page, `document.querySelector('dialog[aria-label="Generate prompt"]')?.open === true`)
      expect(
        await page.evaluate<string[]>(
          `[...document.querySelectorAll('dialog[aria-label="Generate prompt"] input[type=radio]')].map(radio => radio.closest('label').textContent.trim())`,
        ),
      ).toEqual(["Start a task", "Goal objective"])
      await page.pressEscape()
      await wait(page, `!document.querySelector('dialog[aria-label="Generate prompt"]')?.open`)
      expect(await page.evaluate<number>(`window.composerRequests().length`)).toBe(1)
    } finally {
      await page.close()
    }
  }
}, 60000)
