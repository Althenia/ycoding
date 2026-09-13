import { Browser } from "@ycoding-ai/schema/browser"
import type { Client } from "./isolated-cdp"

const MAX_INSPECTION_DEPTH = 32
const MAX_INSPECTION_NODES = 10_000
const incomplete = "Capture is disabled because the page could not be completely inspected"
const protectedField = "Capture is disabled while password fields are present"

export async function capturePage(cdp: Pick<Client, "send">, sessionId: string, signal: AbortSignal) {
  const document = record(
    await cdp.send("DOM.getDocument", { depth: MAX_INSPECTION_DEPTH, pierce: true }, sessionId, signal),
  )
  assertCaptureSafe(record(document.root))
  const capture = record(
    await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId, signal),
  )
  const data = string(capture.data)
  const bytes = Math.floor((data.length * 3) / 4)
  if (bytes > Browser.MAX_CAPTURE_BYTES) throw new globalThis.Error("Capture exceeds the 1 MiB limit")
  return Browser.CaptureOutput.make({ mediaType: "image/png", data, bytes })
}

function assertCaptureSafe(root: Readonly<Record<string, unknown>>) {
  const pending = [{ node: root, depth: 0 }]
  let inspected = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    inspected++
    if (inspected > MAX_INSPECTION_NODES) throw new globalThis.Error(incomplete)
    if (isPasswordInput(current.node)) throw new globalThis.Error(protectedField)

    const children = nodes(current.node.children)
    const shadowRoots = nodes(current.node.shadowRoots)
    const contentDocument = current.node.contentDocument === undefined ? [] : [record(current.node.contentDocument)]
    const childNodeCount = current.node.childNodeCount
    if (typeof childNodeCount === "number" && childNodeCount > children.length) throw new globalThis.Error(incomplete)
    if (String(current.node.nodeName).toLowerCase() === "iframe" && contentDocument.length === 0)
      throw new globalThis.Error(incomplete)

    const nested = [...children, ...shadowRoots, ...contentDocument]
    if (current.depth >= MAX_INSPECTION_DEPTH && nested.length > 0) throw new globalThis.Error(incomplete)
    pending.push(...nested.map((node) => ({ node, depth: current.depth + 1 })))
  }
}

function isPasswordInput(node: Readonly<Record<string, unknown>>) {
  if (String(node.nodeName).toLowerCase() !== "input") return false
  const values = Array.isArray(node.attributes) ? node.attributes : []
  return Array.from({ length: Math.floor(values.length / 2) }, (_, index) => [
    String(values[index * 2]).toLowerCase(),
    String(values[index * 2 + 1]).toLowerCase(),
  ]).some(([name, value]) => name === "type" && value === "password")
}

function nodes(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new globalThis.Error(incomplete)
  return value.map(record)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new globalThis.Error(incomplete)
  return value
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function string(value: unknown) {
  if (typeof value !== "string") throw new globalThis.Error("Chrome returned an invalid response")
  return value
}
