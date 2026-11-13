import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4397
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60; index++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/shared-presentation.html`).then((response) => response.ok, () => false)) { browser = await launchBrowser(executable, 1440, 900); return }
    await Bun.sleep(100)
  }
  throw new Error("Shared presentation fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("shared disclosures, companion and file callbacks respond to interaction", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/shared-presentation.html`)
    for (let index = 0; index < 60 && !await page.evaluate(`!!document.querySelector('.rl-chip')`); index++) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.rl-chip').click()`)
    expect(await page.evaluate<string>(`document.querySelector('.rl-output').textContent`)).toBe("tool result")
    await page.evaluate(`document.querySelector('.rl-reason-disclosure summary').click()`)
    expect(await page.evaluate<string>(`document.querySelector('.rl-reason').textContent`)).toBe("reasoning body")
    await page.evaluate(`document.querySelector('.rl-edited-disclosure').click(); document.querySelectorAll('.rl-edited-file')[1].click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("edited:b.ts")
    await page.evaluate(`[...document.querySelectorAll('.rl-edited-actions button')].find(button => button.textContent === 'Undo…').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("undo")
    await page.evaluate(`document.querySelector('[aria-label="Close Activity tab"]').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("close:activity")
    await page.evaluate(`document.querySelector('[aria-label="Add companion tab"]').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("add-tab")
    await page.evaluate(`document.querySelector('.rl-changes-open-full').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("full-changes")
    await page.evaluate(`document.querySelector('.rl-activity-row').click()`)
    expect(await page.evaluate<string>(`document.querySelector('.rl-pane-detail').textContent`)).toContain("Limited access")
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("shell:s")
    expect(await page.evaluate<string>(`document.querySelector('.rl-pane-detail .rl-output').textContent`)).toBe("shell output")
    await page.evaluate(`[...document.querySelectorAll('.rl-pane-detail button')].find(button => button.textContent === 'Load more output').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("output-page")
    await page.evaluate(`document.querySelector('.rl-pane-detail button').click(); document.querySelectorAll('.rl-activity-group')[1].querySelector('button').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("agent")
    await page.evaluate(`[...document.querySelectorAll('.rl-activity-group button')].find(button => button.textContent === 'Load older subagents').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("subagent-page")
    await page.evaluate(`document.querySelectorAll('.rl-file-jump button')[1].click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("select:b.ts")
    expect(await page.evaluate<string>(`document.querySelector('.rl-file-diff header').textContent`)).toBe("b.ts")
    expect(await page.evaluate<string>(`document.querySelector('.rl-turn-filter .custom-select__trigger').textContent`)).toContain("All Session changes")
    await page.evaluate(`document.querySelector('.rl-turn-filter .custom-select__trigger').click()`)
    await page.evaluate(`[...document.querySelectorAll('.custom-select__option')].find(option => option.textContent.includes('First turn')).click()`)
    expect(await page.evaluate<string>(`document.querySelector('.rl-file-diff header').textContent`)).toBe("a.ts")
    expect(await page.evaluate<number>(`document.querySelectorAll('.rl-diff-line[data-kind="added"] > *').length`)).toBe(4)
    expect(await page.evaluate<number>(`document.querySelectorAll('.rl-file-jump button').length`)).toBe(1)
    await page.evaluate(`document.querySelector('.rl-turn-filter .custom-select__trigger').focus()`)
    await page.pressKey("ArrowDown", "ArrowDown", 40)
    expect(await page.evaluate<string>(`document.querySelector('.rl-turn-filter .custom-select__trigger').getAttribute('aria-expanded')`)).toBe("true")
    await page.pressKey("Home", "Home", 36)
    await page.pressKey("Enter", "Enter", 13, "\r")
    expect(await page.evaluate<number>(`document.querySelectorAll('.rl-file-jump button').length`)).toBe(2)
    expect(await page.evaluate<string>(`document.activeElement.className`)).toContain("custom-select__trigger")
    await page.evaluate(`document.querySelector('.rl-turn-filter .custom-select__trigger').click()`)
    await page.evaluate(`[...document.querySelectorAll('.custom-select__option')].find(option => option.textContent.includes('First turn')).click()`)
    await page.evaluate(`[...document.querySelectorAll('.rl-revert button')].find(button => button.textContent === 'Revert changes…').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).not.toBe("commit")
    await page.evaluate(`[...document.querySelectorAll('.rl-revert button')].find(button => button.textContent === 'Confirm revert').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("commit")
    await page.evaluate(`document.querySelector('.rl-context-messages').click()`)
    expect(await page.evaluate<string>(`document.querySelector('.rl-context-message-list').textContent`)).toContain("user · question")
    await page.evaluate(`document.querySelector('#callback .file-change-card__view').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("callback:a.ts")
    await page.evaluate(`document.querySelector('#fallback .file-change-card__view').click()`)
    expect(await page.evaluate<string>(`document.body.dataset.result`)).toBe("fallback")
  } finally { await page.close() }
}, 30_000)
