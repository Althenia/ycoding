import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"
import { summarizeCapturedChanges } from "../../../packages/client/src/file-change-summary"

const port = 4424
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then(
        (response) => response.ok,
        () => false,
      )
    ) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Transcript stability fixture did not start")
})
afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

async function wait(page: { evaluate<T>(expression: string): Promise<T> }, expression: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return
    await Bun.sleep(30)
  }
  throw new Error(`Timed out: ${expression}`)
}

test("captured summaries stay at each completed prompt's final reply across tool, text, tool, and final steps", async () => {
  const page = await browser!.openPage()
  type CaptureMessage = Parameters<typeof summarizeCapturedChanges>[0][number]
  const raw: (CaptureMessage & { readonly text?: string })[] = []
  const patch = (path: string) => ({ type: "tool", id: `call_${raw.length}`, name: "patch", state: { status: "completed", content: [], structured: { files: [{ file: path, patch: "@@ -1 +1 @@\n-before\n+after" }] } } })
  const reply = (id: string, content: readonly (NonNullable<CaptureMessage["content"]>[number] & { readonly text?: string })[]) => ({ id, type: "assistant", agent: "god", model: { providerID: "openai", id: "gpt-6" }, content, time: { created: raw.length + 1, completed: raw.length + 2 } })
  const update = async (running: boolean) => {
    const captured = summarizeCapturedChanges(raw, new Map(), () => "unused").flatMap((unit) => unit.files.map((file) => ({ placementMessageID: unit.placementMessageID, ...file })))
    const before = await page.evaluate<number>(`window.remoteOperationReport().operations['session.capturedChanges.list'] ?? 0`)
    await page.evaluate(`window.responseSnapshot(${JSON.stringify(raw)},${JSON.stringify(captured)},${running})`)
    await wait(page, `window.responseStatus() === '${running ? "running" : "idle"}'`)
    await wait(page, `(window.remoteOperationReport().operations['session.capturedChanges.list'] ?? 0)>${before}`)
  }
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&responseProbe=1`)
    await wait(page, `typeof window.remoteOperationReport === 'function' && window.remoteOperationReport().operations['session.snapshot'] >= 1`)
    raw.push({ id: "response_prompt_1", type: "user", text: "Make the first change", time: { created: 1, completed: 2 } })
    for (const step of [reply("response_tool_1", [patch("src/first.ts")]), reply("response_text_1", [{ type: "text", text: "An intermediate reply" }]), reply("response_tool_2", [patch("src/first.ts")])]) {
      raw.push(step)
      await update(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('.file-change-card').length`)).toBe(0)
    }
    raw.push(reply("response_final_1", [{ type: "text", text: "First final reply" }]))
    await update(false)
    await wait(page, `document.querySelector('[data-message-id="response_final_1"] .file-change-card') !== null`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.file-change-card')].map(card=>card.closest('[data-message-id]').dataset.messageId)`)).toEqual(["response_final_1"])
    expect(await page.evaluate<string>(`document.querySelector('.file-change-card__totals').textContent`)).toBe("+2 −2")
    raw.push({ id: "response_prompt_2", type: "user", text: "Make the second change", time: { created: 7, completed: 8 } }, reply("response_tool_3", [patch("src/second.ts")]))
    await update(true)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.file-change-card')].map(card=>card.closest('[data-message-id]').dataset.messageId)`)).toEqual(["response_final_1"])
    raw.push(reply("response_final_2", [{ type: "text", text: "Second final reply" }]))
    await update(false)
    await wait(page, `document.querySelector('[data-message-id="response_final_2"] .file-change-card') !== null`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.file-change-card')].map(card=>card.closest('[data-message-id]').dataset.messageId)`)).toEqual(["response_final_1", "response_final_2"])
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.file-change-card__totals')].map(node=>node.textContent)`)).toEqual(["+2 −2", "+1 −1"])
  } finally { await page.close() }
})

test("agent headings appear only for actual text replies while every assistant keeps its footer", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&transcriptProbe=1`)
    await wait(page, `document.querySelector('[data-message-id="probe_tool_only"]') !== null`)
    for (const id of ["probe_tool_only", "probe_thought_only"]) {
      expect(await page.evaluate<boolean>(`document.querySelector('[data-message-id="${id}"] .transcript-message__agent') !== null`)).toBe(false)
      expect(await page.evaluate<boolean>(`document.querySelector('[data-message-id="${id}"] .transcript-message__footer') !== null`)).toBe(true)
    }
    expect(await page.evaluate<string>(`document.querySelector('[data-message-id="probe_mixed_reply"] .transcript-message__agent').textContent`)).toBe("God")
    expect(await page.evaluate<string>(`document.querySelector('[data-message-id="probe_mixed_reply"] .transcript-md').textContent`)).toContain("A real assistant reply")
  } finally { await page.close() }
})

test("New session is a named compact plus action in the sidebar and list and keeps a resident draft", async () => {
  for (const [width, route] of [[1440, "chat"], [1440, "sessions"], [390, "sessions"]] as const) for (const reduced of [false, true]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, 900)
      await page.setCoarsePointer(width === 390)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=${route}&team=two`)
      await wait(page, `document.querySelector('.mini-composer__mount textarea') !== null`)
      await page.evaluate(`(() => { const field=document.querySelector('.mini-composer__mount textarea'); field.value='Keep this draft'; field.dispatchEvent(new Event('input',{bubbles:true})); window.newSessionDraft=field; })()`)
      const button = `[...document.querySelectorAll('.new-session__trigger')].find(button=>button.getBoundingClientRect().width>0 && !button.closest('[inert]'))`
      const before = await page.evaluate<{ name: string; title: string; icon: boolean; width: number; height: number }>(`(() => { const button=${button},rect=button.getBoundingClientRect(); return {name:button.getAttribute('aria-label') || button.textContent.trim(),title:button.title,icon:button.querySelector('svg')!==null,width:rect.width,height:rect.height} })()`)
      expect(before.name).toBe("New session")
      expect(before.title).toBe("New session")
      expect(before.icon).toBe(true)
      expect(before.width).toBeLessThanOrEqual(44)
      expect(before.height).toBeGreaterThanOrEqual(width === 390 ? 44 : 36)
      await page.evaluate(`${button}.focus()`)
      await page.pressKey(" ", "Space", 32)
      await wait(page, `document.querySelector('.new-session-composer') !== null`)
      expect(await page.evaluate<string>(`window.newSessionDraft.value`)).toBe("Keep this draft")
      expect(await page.evaluate<boolean>(`window.newSessionDraft.isConnected`)).toBe(true)
    } finally { await page.close() }
  }
})

test("streaming Markdown retains its tail node and code focus while latest-follow tracks real growth", async () => {
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.setReducedMotion(theme === "dark")
        await page.navigate(
          `http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&transcriptProbe=1&theme=${theme}`,
        )
        await wait(page, `document.querySelector('[data-message-id="probe_tail"] .transcript-md__code') !== null`)
        await page.evaluate(
          `(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture=document.querySelector('.fixture'); fixture.style.height='100dvh'; fixture.style.minHeight='0'; fixture.style.overflow='hidden'; })()`,
        )
        await page.evaluate(
          `Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished))`,
        )
        await wait(
          page,
          `(() => { const root=document.querySelector('.workspace__scroll'); return root.scrollHeight-root.clientHeight-root.scrollTop<=2 })()`,
        )
        const before = await page.evaluate<{ height: number; heading: number }>(
          `(() => { const row=document.querySelector('[data-message-id="probe_tail"]'),root=document.querySelector('.workspace__scroll'); return {height:row.querySelector('.transcript-md__code').getBoundingClientRect().height,heading:row.querySelector('[role="heading"]').getBoundingClientRect().top+root.scrollTop} })()`,
        )
        await page.evaluate(
          `(() => { const tail=document.querySelector('[data-message-id="probe_tail"]'); window.tailRow=tail; window.tailCode=tail.querySelector('.transcript-md__code'); window.tailHeading=tail.querySelector('[role="heading"]'); window.tailCopy=tail.querySelector('.transcript-md__code button'); window.tailCopy.focus({preventScroll:true}); window.transcriptDelta('\\nconst next = 2'); })()`,
        )
        await wait(
          page,
          `document.querySelector('[data-message-id="probe_tail"] pre').textContent.includes('const next = 2')`,
        )
        expect(
          await page.evaluate<unknown>(
            `({ row:window.tailRow===document.querySelector('[data-message-id="probe_tail"]'), code:window.tailCode===document.querySelector('[data-message-id="probe_tail"] .transcript-md__code'), heading:window.tailHeading===document.querySelector('[data-message-id="probe_tail"] [role="heading"]'), focus:document.activeElement===window.tailCopy })`,
          ),
        ).toEqual({ row: true, code: true, heading: true, focus: true })
        await wait(
          page,
          `(() => { const root=document.querySelector('.workspace__scroll'); return root.scrollHeight-root.clientHeight-root.scrollTop<=2 })()`,
        )
        const after = await page.evaluate<{ height: number; heading: number }>(
          `({height:window.tailCode.getBoundingClientRect().height,heading:window.tailHeading.getBoundingClientRect().top+document.querySelector('.workspace__scroll').scrollTop})`,
        )
        expect(after.height).toBeGreaterThan(before.height)
        expect(Math.abs(after.heading - before.heading)).toBeLessThanOrEqual(1)
      } finally {
        await page.close()
      }
    }
})

test("background snapshot, todos, captured changes, and status preserve an expanded file and the reader's anchor", async () => {
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      const page = await browser!.openPage()
      try {
        await page.setViewport(width, 900)
        await page.setReducedMotion(theme === "dark")
        await page.navigate(
          `http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&transcriptProbe=1&theme=${theme}`,
        )
        await wait(page, `document.querySelector('[data-message-id="probe_tail"]') !== null`)
        await page.evaluate(
          `(() => { const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-300})); root.scrollTop=0 })()`,
        )
        await wait(
          page,
          `document.querySelector('.file-change-card__summary') !== null && document.querySelector('.todo-panel') !== null`,
        )
        await page.evaluate(
          `(() => { document.querySelector('.fixture__banner')?.remove(); document.querySelector('.fixture__controls')?.remove(); const fixture=document.querySelector('.fixture'); fixture.style.height='100dvh'; fixture.style.minHeight='0'; fixture.style.overflow='hidden'; })()`,
        )
        await page.evaluate(
          `Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished))`,
        )
        await page.evaluate(
          `(() => { document.querySelector('.file-change-card__summary').click(); const button=document.querySelector('.file-change-card__file-toggle'); button.click(); const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-200})); window.anchor=document.querySelector('[data-message-id="probe_reply_4"]'); root.scrollTop+=window.anchor.getBoundingClientRect().top-root.getBoundingClientRect().top-16; root.dispatchEvent(new Event('scroll')); button.focus({preventScroll:true}); window.fileButton=button; window.fileRow=button.closest('li'); window.todoRow=document.querySelector('.todo-panel__item'); window.anchorBefore={top:window.anchor.getBoundingClientRect().top,height:window.anchor.getBoundingClientRect().height,scroll:root.scrollTop,breadcrumb:document.querySelector('.conversation-breadcrumb').getBoundingClientRect().height}; })()`,
        )
        await page.evaluate(
          `window.transcriptDelta('\\nconst other = 3'); window.remoteStatus(['ses_fixture'], []); window.transcriptRefresh()`,
        )
        await wait(page, `window.remoteOperationReport().operations['session.capturedChanges.list'] >= 2`)
        await wait(page, `document.querySelector('.file-change-card__diff').textContent.includes('fresh')`)
        const after = await page.evaluate<{
          same: boolean
          expanded: string
          focus: boolean
          todo: boolean
          top: number
          height: number
          scroll: number
          breadcrumb: number
          before: { top: number; height: number; scroll: number; breadcrumb: number }
        }>(
          `({same:window.fileRow===document.querySelector('.file-change-card__file'),expanded:document.querySelector('.file-change-card__file-toggle').getAttribute('aria-expanded'),focus:document.activeElement===window.fileButton,todo:window.todoRow===document.querySelector('.todo-panel__item'),top:window.anchor.getBoundingClientRect().top,height:window.anchor.getBoundingClientRect().height,scroll:document.querySelector('.workspace__scroll').scrollTop,breadcrumb:document.querySelector('.conversation-breadcrumb').getBoundingClientRect().height,before:window.anchorBefore})`,
        )
        expect(after.same).toBe(true)
        expect(after.expanded).toBe("true")
        expect(after.focus).toBe(true)
        expect(after.todo).toBe(true)
        expect(Math.abs(after.top - after.before.top)).toBeLessThanOrEqual(1)
        expect(Math.abs(after.height - after.before.height)).toBeLessThanOrEqual(1)
        expect(Math.abs(after.scroll - after.before.scroll - (after.breadcrumb - after.before.breadcrumb))).toBeLessThanOrEqual(1)
        await Bun.write(
          new URL(`../../../.cache/tmp/transcript-stability-${width}-${theme}.png`, import.meta.url),
          Buffer.from(await page.screenshot(), "base64"),
        )
      } finally {
        await page.close()
      }
    }
})

test("a 300-message transcript mounts a bounded window and holds the reader through prepend, streaming, and follow", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(`http://127.0.0.1:${port}/verify/transcript.html?long=1`)
    await wait(page, `(() => { const root=document.querySelector('.workspace__scroll'); return document.querySelector('[data-message-id="long_answer_149"]') !== null && root.scrollHeight-root.clientHeight-root.scrollTop<=2 })()`)
    const mounted = await page.evaluate<number>(`document.querySelectorAll('[data-message-id]').length`)
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThanOrEqual(60)
    expect(await page.evaluate<number>(`document.querySelectorAll('.transcript-navigation__tick').length`)).toBe(150)

    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); window.samples=[]; window.sampling=true; const tick=()=>{ if(!window.sampling) return; window.samples.push({top:root.scrollTop,gap:root.scrollHeight-root.clientHeight-root.scrollTop}); requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`)
    for (let index = 0; index < 20; index++) {
      await page.evaluate(`window.longDelta('\\n\\n${"Another streamed paragraph. ".repeat(3)}')`)
      await Bun.sleep(35)
    }
    await Bun.sleep(150)
    const following = await page.evaluate<readonly { top: number; gap: number }[]>(`(() => { window.sampling=false; return window.samples })()`)
    expect(following.length).toBeGreaterThan(20)
    expect(Math.max(...following.map((sample) => sample.gap))).toBeLessThanOrEqual(2)
    expect(following.every((sample, index) => index === 0 || sample.top >= following[index - 1]!.top - 0.5)).toBe(true)

    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-300})); root.scrollTop=root.scrollHeight-root.clientHeight-700 })()`)
    await Bun.sleep(300)
    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); const bounds=root.getBoundingClientRect(); const row=[...document.querySelectorAll('[data-message-id]')].find(item=>item.getBoundingClientRect().bottom>bounds.top+20); window.anchorRow=row; window.anchorBase=row.getBoundingClientRect().top; window.samples=[]; window.sampling=true; const tick=()=>{ if(!window.sampling) return; window.samples.push(window.anchorRow.getBoundingClientRect().top); requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`)
    for (let index = 0; index < 20; index++) {
      await page.evaluate(`window.longDelta('\\n\\n${"Streaming while scrolled up. ".repeat(3)}')`)
      await Bun.sleep(35)
    }
    await Bun.sleep(150)
    const away = await page.evaluate<{ readonly samples: readonly number[]; readonly base: number; readonly same: boolean }>(`(() => { window.sampling=false; return { samples: window.samples, base: window.anchorBase, same: window.anchorRow.isConnected } })()`)
    expect(away.same).toBe(true)
    expect(away.samples.length).toBeGreaterThan(20)
    expect(Math.max(...away.samples.map((top) => Math.abs(top - away.base)))).toBeLessThanOrEqual(1)

    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-300})); root.scrollTop=100; })()`)
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); const bounds=root.getBoundingClientRect(); const row=[...document.querySelectorAll('[data-message-id]')].find(item=>item.getBoundingClientRect().bottom>bounds.top+20); window.anchorRow=row; window.anchorBase=row.getBoundingClientRect().top; window.samples=[]; window.sampling=true; const tick=()=>{ if(!window.sampling) return; window.samples.push(window.anchorRow.getBoundingClientRect().top); requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`)
    await wait(page, `document.querySelector('.transcript-navigation__beginning') !== null`)
    await Bun.sleep(150)
    const prepended = await page.evaluate<{ readonly samples: readonly number[]; readonly base: number; readonly same: boolean; readonly prompts: number; readonly mounted: number }>(`(() => { window.sampling=false; return { samples: window.samples, base: window.anchorBase, same: window.anchorRow.isConnected, prompts: document.querySelectorAll('.transcript-navigation__tick').length, mounted: document.querySelectorAll('[data-message-id]').length } })()`)
    expect(prepended.prompts).toBe(200)
    expect(prepended.same).toBe(true)
    expect(prepended.mounted).toBeLessThanOrEqual(60)
    expect(Math.max(...prepended.samples.map((top) => Math.abs(top - prepended.base)))).toBeLessThanOrEqual(1)
  } finally { await page.close() }
}, 40_000)

test("a 150-Session window mounts bounded rows and keeps the reader anchored while paging both ways", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(1440, 900)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=14501&pageRows=200`)
    await wait(page, `window.remoteInventoryReport?.().rows === 200 && document.querySelectorAll('.sessions-table__row').length > 0`)
    const window150 = await page.evaluate<{ readonly mounted: number; readonly count: string | null; readonly indexes: readonly string[] }>(`({ mounted: document.querySelectorAll('.sessions-table__row').length, count: document.querySelector('.sessions-table').getAttribute('aria-rowcount'), indexes: [...document.querySelectorAll('.sessions-table__row')].slice(0, 2).map(row => row.getAttribute('aria-rowindex')) })`)
    expect(window150.mounted).toBeGreaterThan(0)
    expect(window150.mounted).toBeLessThanOrEqual(50)
    expect(Number(window150.count)).toBe(await page.evaluate<number>(`window.remoteInventoryReport().rows`) + 1)
    expect(window150.indexes.every((value) => value !== null && Number(value) >= 2)).toBe(true)

    const anchored = async (setup: string, trigger: string) => {
      const before = await page.evaluate<string>(`(() => { const report = window.remoteInventoryReport(); return report.rows + ':' + report.firstListed })()`)
      await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); ${setup} })()`)
      await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      await page.evaluate(`(() => { const root=document.querySelector('.workspace__scroll'); const bounds=root.getBoundingClientRect(); const row=[...document.querySelectorAll('.sessions-table__row')].find(item=>item.getBoundingClientRect().top>=bounds.top); window.anchorRow=row; window.anchorBase=row.getBoundingClientRect().top; window.samples=[]; window.sampling=true; const tick=()=>{ if(!window.sampling) return; window.samples.push(window.anchorRow.getBoundingClientRect().top); requestAnimationFrame(tick) }; requestAnimationFrame(tick); ${trigger} })()`)
      await wait(page, `(() => { const report = window.remoteInventoryReport(); return report.rows + ':' + report.firstListed !== ${JSON.stringify(before)} })()`)
      await Bun.sleep(250)
      return page.evaluate<{ readonly samples: readonly number[]; readonly base: number; readonly same: boolean; readonly mounted: number; readonly rows: number }>(`(() => { window.sampling=false; return { samples: window.samples, base: window.anchorBase, same: window.anchorRow.isConnected, mounted: document.querySelectorAll('.sessions-table__row').length, rows: window.remoteInventoryReport().rows } })()`)
    }
    for (let step = 0; step < 4; step++) {
      const forward = await anchored(`root.scrollTop=root.scrollHeight-root.clientHeight-100`, `root.dispatchEvent(new WheelEvent('wheel',{deltaY:250,bubbles:true}))`)
      expect(forward.same).toBe(true)
      expect(forward.mounted).toBeLessThanOrEqual(50)
      expect(Math.max(...forward.samples.map((top) => Math.abs(top - forward.base)))).toBeLessThanOrEqual(1)
    }
    const backward = await anchored(`root.scrollTop=100`, `root.dispatchEvent(new WheelEvent('wheel',{deltaY:-250,bubbles:true}))`)
    expect(backward.same).toBe(true)
    expect(backward.mounted).toBeLessThanOrEqual(50)
    expect(Math.max(...backward.samples.map((top) => Math.abs(top - backward.base)))).toBeLessThanOrEqual(1)
  } finally { await page.close() }
}, 60_000)
