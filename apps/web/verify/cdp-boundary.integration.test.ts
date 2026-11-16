import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

let browser: Awaited<ReturnType<typeof launchBrowser>>

beforeAll(async () => {
  const executable = process.env.YCODING_WEB_CHROME
  if (!executable) throw new Error("YCODING_WEB_CHROME is required")
  browser = await launchBrowser(executable, 640, 480)
}, 30_000)

afterAll(async () => { await browser?.close() })

test("evaluation applies the caller decoder after an asynchronous browser result", async () => {
  const page = await browser.openPage()
  try {
    const size = await page.evaluate("Promise.resolve({ size: 7 })", (value: unknown) => {
      if (typeof value !== "object" || value === null || !("size" in value) || typeof value.size !== "number") throw new Error("Expected numeric size")
      return value.size
    })
    expect(size).toBe(7)
  } finally { await page.close() }
}, 15_000)

test("evaluation rejects when the caller decoder refuses the browser value", async () => {
  const page = await browser.openPage()
  try {
    const outcome = await page.evaluate("41", (_value: unknown) => { throw new Error("The caller decoder refused this result") }).then(
      (value) => ({ status: "resolved", value }),
      (cause: unknown) => ({ status: "rejected", message: cause instanceof Error ? cause.message : String(cause) }),
    )
    expect(outcome).toEqual({ status: "rejected", message: "The caller decoder refused this result" })
  } finally { await page.close() }
}, 15_000)

test("raw evaluation preserves values and rejects browser exceptions", async () => {
  const page = await browser.openPage()
  try {
    expect(await page.evaluate("({ text: 'fixture', items: [1, false, null] })")).toEqual({ text: "fixture", items: [1, false, null] })
    expect(await page.evaluate("undefined")).toBeUndefined()
    const outcome = await page.evaluate("(() => { throw new Error('Browser evaluation failed') })()").then(
      () => "resolved",
      (cause: unknown) => cause instanceof Error ? cause.message : String(cause),
    )
    expect(outcome).toContain("Browser evaluation failed")
  } finally { await page.close() }
}, 15_000)
