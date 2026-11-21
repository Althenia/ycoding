import { expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(`../../../${path}`, import.meta.url)).text()

test("no Chrome adapter path answers, dismisses or suppresses a page's JavaScript dialog", async () => {
  for (const file of ["controller.js", "kernel.js", "page.js", "script.js", "service-worker.js"]) {
    const source = await read(`extensions/interaction-chrome/${file}`)
    expect(source).not.toMatch(/handleJavaScriptDialog|window\.(?:alert|confirm|prompt)\s*=|defineProperty\(\s*window\s*,\s*["'](?:alert|confirm|prompt)/)
  }
  for (const file of ["chrome.ts", "chrome-isolated.ts"]) {
    expect(await read(`packages/core/src/interaction/${file}`)).not.toMatch(/handleJavaScriptDialog/)
  }
})
