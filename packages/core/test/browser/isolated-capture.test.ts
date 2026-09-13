import { describe, expect, test } from "bun:test"
import { capturePage } from "../../src/browser/isolated-capture"
import type { Client } from "../../src/browser/isolated-cdp"

describe("isolated browser capture guard", () => {
  for (const fixture of [
    {
      name: "child frame",
      root: node("#document", {
        children: [node("IFRAME", { contentDocument: node("#document", { children: [password()] }) })],
      }),
    },
    {
      name: "shadow root",
      root: node("#document", {
        children: [node("DIV", { shadowRoots: [node("#document-fragment", { children: [password()] })] })],
      }),
    },
  ])
    test(`blocks a password input inside a ${fixture.name} before screenshot dispatch`, async () => {
      const commands: Array<{ readonly method: string; readonly params: unknown }> = []
      const cdp = client(fixture.root, commands)

      expect(await rejected(capturePage(cdp, "page", new AbortController().signal))).toMatchObject({
        message: "Capture is disabled while password fields are present",
      })
      expect(commands).toEqual([
        {
          method: "DOM.getDocument",
          params: { depth: 32, pierce: true },
        },
      ])
    })

  test("fails closed when a frame document cannot be inspected", async () => {
    const commands: Array<{ readonly method: string; readonly params: unknown }> = []
    const cdp = client(node("#document", { children: [node("IFRAME")] }), commands)

    expect(await rejected(capturePage(cdp, "page", new AbortController().signal))).toMatchObject({
      message: "Capture is disabled because the page could not be completely inspected",
    })
    expect(commands.some((command) => command.method === "Page.captureScreenshot")).toBe(false)
  })

  test("captures after the bounded pierced document is verified safe", async () => {
    const commands: Array<{ readonly method: string; readonly params: unknown }> = []
    const cdp = client(node("#document", { children: [node("INPUT", { attributes: ["type", "text"] })] }), commands)

    expect(await capturePage(cdp, "page", new AbortController().signal)).toMatchObject({
      mediaType: "image/png",
      data: "AAAA",
      bytes: 3,
    })
    expect(commands.map((command) => command.method)).toEqual(["DOM.getDocument", "Page.captureScreenshot"])
  })
})

function client(
  root: Readonly<Record<string, unknown>>,
  commands: Array<{ readonly method: string; readonly params: unknown }>,
): Pick<Client, "send"> {
  return {
    send(method, params = {}) {
      commands.push({ method, params })
      if (method === "DOM.getDocument") return Promise.resolve({ root })
      if (method === "Page.captureScreenshot") return Promise.resolve({ data: "AAAA" })
      return Promise.reject(new Error(`Unexpected Chrome command: ${method}`))
    },
  }
}

function rejected(promise: Promise<unknown>) {
  return promise.then(
    () => new Error("expected promise to reject"),
    (cause) => cause,
  )
}

function password() {
  return node("INPUT", { attributes: ["type", "password"] })
}

function node(nodeName: string, values: Readonly<Record<string, unknown>> = {}) {
  const children = Array.isArray(values.children) ? values.children : []
  return { nodeName, childNodeCount: children.length, ...values }
}
