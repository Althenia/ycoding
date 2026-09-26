import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4326
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the remote fixture server")
  browser = await launchBrowser(browserPath, 1440, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

describe("remote Session creation entry point", () => {
  test("closes creation and navigation dialogs when creating from Conversation", async () => {
    for (const entry of [
      { query: "view=chat", width: 1440 },
      { query: "view=chat&sessions=empty", width: 1440 },
      { query: "view=chat", width: 390 },
    ]) {
      const page = await openRemote(entry.query)
      try {
        await page.setViewport(entry.width, 900)
        if (entry.width === 390) await page.evaluate(`document.querySelector('button[aria-label="Open sessions"]')?.click()`)
        const trigger = entry.width === 390 ? 'dialog[aria-label="Sessions"] .new-session__trigger:not([disabled])' : '.new-session__trigger:not([disabled])'
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(trigger)}) !== null`)) break
          await Bun.sleep(100)
        }
        await page.evaluate(`document.querySelector(${JSON.stringify(trigger)})?.click()`)
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] select') !== null`)) break
          await Bun.sleep(100)
        }
        await page.evaluate(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Create session')?.click()`)
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)) break
          await Bun.sleep(100)
        }
        expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() ?? ''`)).toBe("New session")
        expect(await page.evaluate<number>(`document.querySelectorAll('dialog[open]').length`)).toBe(0)
        expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === 'session.prompt').length`)).toBe(0)
      } finally { await page.close() }
    }
  }, 30_000)

  test("creates from a previously opened repository and opens the blank conversation", async () => {
    const page = await requireBrowser().openPage()
    await page.setViewport(1440, 900)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await page.evaluate<boolean>(`document.querySelector(".sessions-page") !== null`)) break
      await Bun.sleep(100)
    }

    try {
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "New session")`)).toBe(true)
      await page.evaluate(`[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "New session")?.click()`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] select') !== null`)) break
        await Bun.sleep(100)
      }
      expect(await page.evaluate<boolean>(`(() => {
        const dialog = document.querySelector('dialog[aria-label="New session"]');
        return dialog instanceof HTMLDialogElement && dialog.open && dialog.querySelector("select.select") instanceof HTMLSelectElement && dialog.querySelector(".custom-select") === null;
      })()`)).toBe(true)
      expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('dialog[aria-label="New session"] option')].map(option => option.textContent.trim())`)).toEqual([
        "YCoding — /workspace/ycoding",
        "Other repository — /workspace/other",
      ])

      await page.evaluate(`(() => {
        const select = document.querySelector('dialog[aria-label="New session"] select');
        if (!(select instanceof HTMLSelectElement)) throw new Error('Previously opened repository select missing');
        select.value = [...select.options].find(option => option.textContent.includes('/workspace/other'))?.value ?? '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`)
      await page.evaluate(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Create session')?.click()`)
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await page.evaluate<boolean>(`location.pathname === "/remote" && document.querySelector(".conversation-breadcrumb") !== null && document.body.innerText.includes("No messages yet")`)) break
        await Bun.sleep(100)
      }
      expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote")
      expect(await page.evaluate<boolean>(`document.querySelector(".composer") !== null && document.body.innerText.includes("No messages yet")`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll(".transcript > .message").length`)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("offers New session in the SessionPanel and no-selected conversation", async () => {
    for (const [query, selector] of [
      ["view=chat", ".workspace__rail .new-session__trigger"],
      ["view=chat&sessions=empty", ".app--empty .new-session__trigger"],
    ] as const) {
      const page = await requireBrowser().openPage()
      await page.setViewport(1440, 900)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector(".workspace__main") !== null`)) break
        await Bun.sleep(100)
      }

      try {
        expect(await page.evaluate<boolean>(`(() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          return button instanceof HTMLButtonElement && !button.disabled && button.textContent.trim() === "New session";
        })()`)).toBe(true)
      } finally {
        await page.close()
      }
    }
  }, 30_000)

  test("reports empty and unavailable workspace inventories and disables offline creation", async () => {
    for (const [query, message] of [
      ["view=sessions&workspaces=empty", "Open a repository locally once, then refresh."],
      ["view=sessions&workspaces=error", "workspaceError"],
    ] as const) {
      const page = await openRemote(query)
      try {
        await page.evaluate(`[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "New session")?.click()`)
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"]') !== null && document.querySelector('.new-session__message,.new-session__empty,.new-session__outcome') !== null`)) break
          await Bun.sleep(100)
        }
        expect(await page.evaluate<boolean>(message === "workspaceError"
          ? `document.querySelector('.new-session__outcome[role="alert"]') !== null`
          : `document.querySelector('.new-session__empty')?.textContent?.includes(${JSON.stringify(message)}) ?? false`)).toBe(true)
        if (message !== "workspaceError") {
          expect(await page.evaluate<boolean>(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Create session')?.disabled === true`)).toBe(true)
        }
      } finally {
        await page.close()
      }
    }

    const offline = await openRemote("view=sessions&connection=offline")
    try {
      expect(await offline.evaluate<boolean>(`[...document.querySelectorAll('.sessions-page__toolbar .new-session__trigger')].some(button => button.disabled)`)).toBe(true)
    } finally {
      await offline.close()
    }
  }, 30_000)

  test("warns on an unknown creation and retries without resending create", async () => {
    const page = await openRemote("view=sessions&creation=unknown")
    try {
      await page.evaluate(`[...document.querySelectorAll('.sessions-page__toolbar .new-session__trigger')].at(0)?.click()`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] select') !== null`)) break
        await Bun.sleep(100)
      }
      await page.evaluate(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Create session')?.click()`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.new-session__outcome--unknown') !== null`)) break
        await Bun.sleep(100)
      }
      expect(await page.evaluate<boolean>(`document.querySelector('.new-session__outcome--unknown')?.textContent?.includes('Check Sessions before dismissing') ?? false`)).toBe(true)
      expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].map(button => button.textContent.trim())`)).toContain("Dismiss")
      await page.evaluate(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Retry')?.click()`)
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await page.evaluate<boolean>(`location.pathname === "/remote" && document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === "New session"`)) break
        await Bun.sleep(100)
      }
      expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote")
      expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === "session.create").length`)).toBe(1)
      expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === "session.prompt").length`)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("lets a failed creation be retried or reset for another repository", async () => {
    const page = await openRemote("view=sessions&creation=failed")
    try {
      await page.evaluate(`[...document.querySelectorAll('.sessions-page__toolbar .new-session__trigger')].at(0)?.click()`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] select') !== null`)) break
        await Bun.sleep(100)
      }
      await page.evaluate(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Create session')?.click()`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('.new-session__outcome[role="alert"]') !== null`)) break
        await Bun.sleep(100)
      }
      expect(await page.evaluate<readonly string[]>(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].map(button => button.textContent.trim())`)).toContain("Retry")
      await page.evaluate(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Choose another repository')?.click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] select') instanceof HTMLSelectElement`)).toBe(true)
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Create session')?.disabled === false`)).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("disables creation retry while the selected machine is offline", async () => {
    const page = await openRemote("view=sessions&creation=failed")
    try {
      await page.evaluate(`document.querySelector('.sessions-page__toolbar .new-session__trigger')?.click()`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] [role="alert"]')?.textContent?.includes('Workspace directory is unavailable') === true`)) break
        await Bun.sleep(100)
      }
      await page.evaluate(`document.querySelector('.fixture__controls button:nth-child(2)')?.click()`)
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] .new-session__actions .button--primary')?.disabled === true`)) break
        await Bun.sleep(25)
      }
      expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] .new-session__actions .button--primary')?.disabled === true`)).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("contains the native repository select and restores focus when the dialog is dismissed", async () => {
    for (const width of [390, 768] as const) {
      const page = await openRemote("view=sessions", width)
      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (await page.evaluate<boolean>(`document.querySelector('.sessions-page__toolbar .new-session__trigger')?.disabled === false`)) break
          await Bun.sleep(100)
        }
        await page.evaluate(`(() => { const button = document.querySelector('.sessions-page__toolbar .new-session__trigger'); button?.focus(); button?.click(); })()`)
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] select') !== null`)) break
          await Bun.sleep(100)
        }
        const state = await page.evaluate<{
          readonly containsFocus: boolean
          readonly open: boolean
          readonly activeElement: string
          readonly labelled: boolean
          readonly labelText: string
          readonly contained: boolean
          readonly overflow: boolean
        }>(`(() => {
          const dialog = document.querySelector('dialog[aria-label="New session"]');
          const select = dialog?.querySelector('select.select');
          const bounds = dialog?.getBoundingClientRect();
          return {
            containsFocus: dialog instanceof HTMLDialogElement && dialog.contains(document.activeElement),
            open: dialog instanceof HTMLDialogElement && dialog.open,
            activeElement: document.activeElement instanceof HTMLElement ? document.activeElement.tagName + "." + document.activeElement.className : "none",
            labelText: select instanceof HTMLSelectElement ? select.labels?.[0]?.querySelector('span')?.textContent?.trim() ?? "" : "",
            labelled: select instanceof HTMLSelectElement && select.labels?.[0]?.querySelector('span')?.textContent?.trim() === 'Previously opened repository',
            contained: bounds !== undefined && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        })()`)
        expect(state.containsFocus, JSON.stringify(state)).toBe(true)
        expect(state.labelled, JSON.stringify(state)).toBe(true)
        expect(state.contained).toBe(true)
        expect(state.overflow).toBe(false)

        await page.pressEscape()
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"]') === null`)) break
          await Bun.sleep(25)
        }
        expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"]') === null`)).toBe(true)
        expect(await page.evaluate<boolean>(`document.activeElement?.classList.contains('new-session__trigger') ?? false`)).toBe(true)
      } finally {
        await page.close()
      }
    }
  }, 30_000)

  test("closing during creation leaves it on Sessions and restores trigger focus", async () => {
    const page = await openRemote("view=sessions&creationDelay=700")
    try {
      await page.evaluate(`(() => { const button = document.querySelector('.sessions-page__toolbar .new-session__trigger'); button?.focus(); button?.click(); })()`)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"] select') !== null`)) break
        await Bun.sleep(100)
      }
      await page.evaluate(`[...document.querySelectorAll('dialog[aria-label="New session"] button')].find(button => button.textContent.trim() === 'Create session')?.click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"]')?.textContent?.includes('Creating session…') ?? false`)).toBe(true)
      await page.evaluate(`document.querySelector('dialog[aria-label="New session"] .overlay__close')?.click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"]') === null`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.activeElement?.classList.contains('new-session__trigger') ?? false`)).toBe(true)
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await page.evaluate<boolean>(`[...document.querySelectorAll('.sessions-table__select')].some(button => button.textContent.trim() === 'New session')`)) break
        await Bun.sleep(100)
      }
      expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote/sessions")
      expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.sessions-table__select')].some(button => button.textContent.trim() === 'New session')`)).toBe(true)
      expect(await page.evaluate<number>(`window.remoteMutationReport().filter(request => request.operation === "session.prompt").length`)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)
})

function requireBrowser() {
  if (!browser) throw new Error("Browser was not initialized")
  return browser
}

async function openRemote(query: string, width = 1440) {
  const page = await requireBrowser().openPage()
  await page.setViewport(width, 900)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelector('.app') !== null`)) return page
    await Bun.sleep(100)
  }
  await page.close()
  throw new Error(`${query}: remote workspace did not render`)
}

async function ready(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/verify/remote.html`)).ok
  } catch {
    return false
  }
}
