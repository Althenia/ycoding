import { createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import "./mcp-app.css"

export interface McpAppView {
  readonly resourceUri: string
  readonly html: string | null
  readonly tool: unknown
  readonly input: unknown
  readonly output: unknown
}

export interface McpAppProps {
  readonly view?: McpAppView | null
  readonly fallback: JSX.Element
}

const protocolVersion = "2026-01-26"
const maxHtml = 128 * 1024
const maxNodes = 4096
const maxDepth = 32
const handshakeTimeout = 2_000
const staticElements = new Set([
  "article", "aside", "b", "blockquote", "br", "caption", "code", "dd", "details", "div", "dl", "dt", "em", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "kbd", "li", "main", "mark", "ol", "p",
  "pre", "s", "samp", "section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul", "var",
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function staticMarkup(html: string): string | undefined {
  if (html.length > maxHtml || !html.trim()) return undefined
  const template = document.createElement("template")
  template.innerHTML = html
  let remaining = maxNodes
  let hasContent = false
  const serialize = (parent: ParentNode, depth: number): string | undefined => {
    if (depth > maxDepth) return undefined
    let result = ""
    for (const child of parent.childNodes) {
      if (--remaining < 0) return undefined
      if (child.nodeType === Node.COMMENT_NODE) continue
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? ""
        if (text.trim()) hasContent = true
        result += text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        continue
      }
      if (!(child instanceof HTMLElement) || child.namespaceURI !== "http://www.w3.org/1999/xhtml"
        || child.attributes.length !== 0 || !staticElements.has(child.localName)) return undefined
      const tag = child.localName
      if (tag === "br" || tag === "hr") {
        result += `<${tag}>`
        continue
      }
      const contents = serialize(child, depth + 1)
      if (contents === undefined) return undefined
      result += `<${tag}>${contents}</${tag}>`
    }
    return result
  }
  const result = serialize(template.content, 0)
  return hasContent ? result : undefined
}

function frameDocument(markup: string, nonce: string, initId: string, parentOrigin: string): string {
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="utf-8"><meta name="referrer" content="no-referrer">
<style nonce="${nonce}">
  :root { color-scheme: light dark; overflow-wrap: anywhere; }
  body { margin: 1rem; font: 1rem/1.5 system-ui, sans-serif; }
  pre { white-space: pre-wrap; }
</style></head><body>${markup}
<script nonce="${nonce}">
  const origin = ${JSON.stringify(parentOrigin)};
  const version = ${JSON.stringify(protocolVersion)};
  const id = ${JSON.stringify(initId)};
  const send = (message) => parent.postMessage({ jsonrpc: "2.0", ...message }, origin === "null" ? "*" : origin);
  function receive(event) {
    if (event.source !== parent || event.origin !== origin) return;
    const data = event.data;
    if (data?.jsonrpc !== "2.0" || data.id !== id || data.result?.protocolVersion !== version) return;
    removeEventListener("message", receive);
    send({ method: "ui/notifications/initialized" });
  }
  addEventListener("message", receive);
  send({ method: "ui/initialize", id, params: {
    appInfo: { name: "Static MCP App", version }, appCapabilities: {}, protocolVersion: version,
  } });
</script></body></html>`
}

function resultParams(output: unknown) {
  if (typeof output === "string") return { content: [{ type: "text", text: output }] }
  if (!isRecord(output)) return undefined
  const content = Array.isArray(output.content) ? output.content.flatMap((block: unknown) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [{ type: "text", text: block.text }] : [],
  ) : []
  return {
    content,
    ...(isRecord(output.structuredContent) ? { structuredContent: output.structuredContent } : {}),
    ...(typeof output.isError === "boolean" ? { isError: output.isError } : {}),
  }
}

export function McpApp(props: McpAppProps): JSX.Element {
  const prepared = createMemo(() => {
    const view = props.view
    if (typeof document === "undefined" || !view || typeof view.resourceUri !== "string" || typeof view.html !== "string") return undefined
    try {
      const resource = new URL(view.resourceUri)
      if (resource.protocol !== "ui:" || !resource.hostname) return undefined
      const markup = staticMarkup(view.html)
      if (markup === undefined) return undefined
      return { markup, input: isRecord(view.input) ? view.input : undefined, output: resultParams(view.output) }
    } catch {
      return undefined
    }
  })
  return (
    <Show keyed when={prepared()} fallback={props.fallback}>
      {(value) => <AppFrame {...value} fallback={props.fallback} />}
    </Show>
  )
}

function AppFrame(props: {
  readonly markup: string
  readonly input: Record<string, unknown> | undefined
  readonly output: ReturnType<typeof resultParams>
  readonly fallback: JSX.Element
}): JSX.Element {
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">("loading")
  let frame: HTMLIFrameElement | undefined

  onMount(() => {
    const element = frame
    const parent = element?.ownerDocument.defaultView
    const source = element?.contentWindow
    if (!element || !parent || !source || !("srcdoc" in element) || !element.sandbox?.supports?.("allow-scripts")) {
      setStatus("failed")
      return
    }
    const bytes = parent.crypto?.getRandomValues(new Uint8Array(16))
    if (!bytes) {
      setStatus("failed")
      return
    }
    const nonce = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
    const initId = `init-${nonce}`
    let phase: "initialize" | "ready" | "done" = "initialize"
    let loaded = false
    let receiverActive = true
    const stop = () => {
      receiverActive = false
      parent.clearTimeout(timer)
      parent.removeEventListener("message", receive)
      element.removeEventListener("load", load)
    }
    const fail = () => {
      stop()
      setStatus("failed")
    }
    const load = () => {
      if (loaded) fail()
      else loaded = true
    }
    const send = (message: Record<string, unknown>) => source.postMessage({ jsonrpc: "2.0", ...message }, "*")
    const receive = (event: MessageEvent<unknown>) => {
      if (!receiverActive || !element.isConnected || element.contentWindow !== source || event.source !== source || event.origin !== "null") return
      const message = event.data
      if (!isRecord(message) || message.jsonrpc !== "2.0") return
      try {
        if (phase === "initialize" && message.method === "ui/initialize" && message.id === initId && isRecord(message.params)
          && message.params.protocolVersion === protocolVersion && isRecord(message.params.appCapabilities)
          && isRecord(message.params.appInfo) && typeof message.params.appInfo.name === "string"
          && typeof message.params.appInfo.version === "string") {
          phase = "ready"
          send({ id: initId, result: {
            protocolVersion, hostInfo: { name: "YCoding", version: protocolVersion }, hostCapabilities: {}, hostContext: {},
          } })
        } else if (phase === "ready" && message.method === "ui/notifications/initialized" && !("id" in message)
          && (!("params" in message) || isRecord(message.params))) {
          phase = "done"
          parent.clearTimeout(timer)
          send({ method: "ui/notifications/tool-input", params: props.input ? { arguments: props.input } : {} })
          if (props.output) send({ method: "ui/notifications/tool-result", params: props.output })
          setStatus("ready")
        }
      } catch {
        fail()
      }
    }
    const timer = parent.setTimeout(fail, handshakeTimeout)
    parent.addEventListener("message", receive)
    element.addEventListener("load", load)
    onCleanup(stop)
    try {
      element.srcdoc = frameDocument(props.markup, nonce, initId, parent.origin)
    } catch {
      fail()
    }
  })

  return (
    <>
      <Show when={status() !== "ready"}>{props.fallback}</Show>
      <Show when={status() !== "failed"}>
        <iframe
          class="mcp-app-frame"
          title="MCP App preview"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          hidden={status() !== "ready"}
          ref={(element) => { frame = element }}
        />
      </Show>
    </>
  )
}
