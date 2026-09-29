import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn } from "bun"
import { launchBrowser } from "./cdp"

const chrome = process.env.YCODING_WEB_CHROME
if (!chrome) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable")

let browser: Awaited<ReturnType<typeof launchBrowser>>
let server: ReturnType<typeof spawn>
let origin: string

beforeAll(async () => {
  const port = 46000 + Math.floor(Math.random() * 1000)
  server = spawn(["node_modules/.bin/vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore" })
  origin = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(origin)).ok) {
        browser = await launchBrowser(chrome, 390, 844)
        return
      }
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error("Preview did not start")
}, 20_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

test("an invite fragment is hidden immediately and is redeemed only by Accept invite", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`${origin}/remote/invite#${"A".repeat(43)}`)
    expect(await page.evaluate<string>(`location.hash`)).toBe("")
    expect(await page.evaluate<string | undefined>(`document.querySelector('h1')?.textContent`)).toBe("You're invited to YCoding Remote")
    expect(await page.evaluate<string | undefined>(`[...document.querySelectorAll('button')].find(button => button.textContent?.includes('Accept invite'))?.textContent`)).toContain("Accept invite")
  } finally { await page.close() }
}, 30_000)

for (const width of [390, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`invite accept, invalid link, and access-key errors render at ${width}px in ${theme}`, async () => {
    const page = await browser.openPage()
    try {
      await page.setViewport(width, width === 390 ? 844 : 900)
      await page.setColorScheme(theme)
      await page.injectOnNewDocument(`(() => {
        localStorage.setItem('ycoding.theme', '${theme}');
        window.__inviteCalls = [];
        window.__keyStatus = 401;
        window.__invalidInvite = sessionStorage.getItem('invite-invalid') === '1';
        const send = window.fetch.bind(window);
        window.fetch = (input, init) => {
          if (input === '/api/me') return Promise.resolve(Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));
          if (input === '/api/auth/invite') {
            window.__inviteCalls.push({ url: input, body: JSON.parse(init.body) });
            return Promise.resolve(Response.json(window.__invalidInvite ? { error: { code: 'not_found' } } :
              { accessKey: '0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ' }, { status: window.__invalidInvite ? 404 : 201 }));
          }
          if (input === '/api/auth/key') return Promise.resolve(Response.json({ error: { code: 'unauthorized' } }, { status: window.__keyStatus }));
          return send(input, init);
        };
      })()`)
      await page.navigate(`${origin}/remote/invite#${"A".repeat(43)}`)
      expect(await page.evaluate<number>(`window.__inviteCalls.length`)).toBe(0)
      await page.evaluate(`([...document.querySelectorAll('button')].find(button => button.textContent?.includes('Accept invite')))?.click()`)
      const accepted = await page.evaluate<{ readonly hash: string; readonly calls: readonly { readonly url: string; readonly body: { readonly token: string } }[];
        readonly key: string; readonly note: string; readonly copy: boolean; readonly overflow: boolean }>(`(async () => {
        for (let i = 0; i < 50 && !document.querySelector('#new-access-key'); i++) await new Promise(resolve => setTimeout(resolve, 50));
        return { hash: location.hash, calls: window.__inviteCalls, key: document.querySelector('#new-access-key')?.value ?? '',
          note: document.querySelector('#new-access-key + .field__hint')?.textContent ?? '',
          copy: [...document.querySelectorAll('button')].some(button => button.textContent === 'Copy'),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`)
      expect(accepted.hash).toBe("")
      expect(accepted.calls).toEqual([{ url: "/api/auth/invite", body: { token: "A".repeat(43) } }])
      expect(accepted.key).toBe("0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ")
      expect(accepted.note).toContain("It is shown only once")
      expect(accepted.copy).toBe(true)
      expect(accepted.overflow).toBe(false)
      await page.evaluate(`setTimeout(() => ([...document.querySelectorAll('button')].find(button => button.textContent === 'Continue'))?.click(), 0)`)
      let continued = false
      for (let attempt = 0; attempt < 50 && !continued; attempt += 1) {
        try { continued = await page.evaluate<string>(`location.pathname`) === "/remote/" } catch {}
        if (!continued) await Bun.sleep(50)
      }
      expect(continued).toBe(true)

      await page.navigate(`${origin}/remote/invite`)
      expect(await page.evaluate<string | undefined>(`document.querySelector('[role="alert"]')?.textContent`)).toContain("already used or is no longer valid")
      expect(await page.evaluate<boolean>(`Boolean(document.querySelector('a[href="/remote"]'))`)).toBe(true)
      await page.evaluate(`sessionStorage.setItem('invite-invalid', '1')`)
      await page.navigate(`${origin}/remote/invite#${"B".repeat(43)}`)
      await page.evaluate(`([...document.querySelectorAll('button')].find(button => button.textContent?.includes('Accept invite')))?.click()`)
      expect(await page.evaluate<string | undefined>(`(async () => {
        for (let i = 0; i < 50 && !document.querySelector('[role="alert"]'); i++) await new Promise(resolve => setTimeout(resolve, 50));
        return document.querySelector('[role="alert"]')?.textContent;
      })()`)).toContain("already used or is no longer valid")

      await page.navigate(`${origin}/remote`)
      const form = await page.evaluate<{ readonly google: boolean; readonly autocomplete: string | null; readonly spellcheck: boolean;
        readonly autocapitalize: string | null }>(`(async () => {
        for (let i = 0; i < 50 && !document.querySelector('#remote-access-key'); i++) await new Promise(resolve => setTimeout(resolve, 50));
        const input = document.querySelector('#remote-access-key');
        return { google: [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Sign in with Google')),
          autocomplete: input?.getAttribute('autocomplete') ?? null, spellcheck: input?.spellcheck ?? true,
          autocapitalize: input?.getAttribute('autocapitalize') ?? null };
      })()`)
      expect(form).toEqual({ google: true, autocomplete: "off", spellcheck: false, autocapitalize: "characters" })
      await page.evaluate(`(() => { const input = document.querySelector('#remote-access-key'); input.value = 'bad'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.form.requestSubmit(); })()`)
      expect(await page.evaluate<string | undefined>(`(async () => {
        for (let i = 0; i < 50 && !document.querySelector('.field__error'); i++) await new Promise(resolve => setTimeout(resolve, 50));
        return document.querySelector('.field__error')?.textContent;
      })()`)).toBe("That access key isn't valid.")
      await page.evaluate(`(() => { window.__keyStatus = 429; document.querySelector('#remote-access-key').form.requestSubmit(); })()`)
      expect(await page.evaluate<string | undefined>(`(async () => {
        for (let i = 0; i < 50 && !document.querySelector('.field__error')?.textContent?.includes('Too many'); i++) await new Promise(resolve => setTimeout(resolve, 50));
        return document.querySelector('.field__error')?.textContent;
      })()`)).toBe("Too many attempts. Try again later.")
    } finally { await page.close() }
  }, 30_000)
}
