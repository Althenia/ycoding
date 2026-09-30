import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { marked, type Token } from "marked"

export function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href)
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : undefined
  } catch {
    return undefined
  }
}

function Inline(props: { readonly tokens: readonly Token[] }): JSX.Element {
  return <For each={props.tokens.map(tokenKey)}>{(key) => {
    const current = () => props.tokens[Number(key.slice(0, key.indexOf(":")))]!
    const token = current()
    const text = () => { const value = current(); return "text" in value && typeof value.text === "string" ? value.text : value.raw }
    const tokens = () => { const value = current(); return "tokens" in value ? value.tokens ?? [] : [] }
    if (token.type === "text" || token.type === "escape") return <>{text()}</>
    if (token.type === "codespan") return <code>{text()}</code>
    if (token.type === "strong") return <strong><Inline tokens={tokens()} /></strong>
    if (token.type === "em") return <em><Inline tokens={tokens()} /></em>
    if (token.type === "del") return <del><Inline tokens={tokens()} /></del>
    if (token.type === "br") return <br />
    if (token.type === "link" || token.type === "image") {
      const href = () => { const value = current(); return (value.type === "link" || value.type === "image") ? safeHref(value.href) : undefined }
      return <Show when={href()} fallback={<span>{token.type === "image" ? text() : current().raw}</span>}>
        <a href={href()} target="_blank" rel="noopener noreferrer">{token.type === "image" ? text() : <Inline tokens={tokens()} />}</a>
      </Show>
    }
    if (token.type === "html") return <>{current().raw}</>
    return <>{text()}</>
  }}</For>
}

function Blocks(props: { readonly tokens: readonly Token[] }): JSX.Element {
  return <For each={props.tokens.map(tokenKey)}>{(key) => {
    const current = () => props.tokens[Number(key.slice(0, key.indexOf(":")))]!
    const token = current()
    const tokens = () => { const value = current(); return "tokens" in value ? value.tokens ?? [] : [] }
    const text = () => { const value = current(); return "text" in value && typeof value.text === "string" ? value.text : value.raw }
    if (token.type === "space") return null
    if (token.type === "heading") {
      const depth = () => { const value = current(); return value.type === "heading" ? value.depth : 1 }
      return <div class={`transcript-md__heading transcript-md__heading--${depth()}`} role="heading" aria-level={depth()}><Inline tokens={tokens()} /></div>
    }
    if (token.type === "paragraph") return <p><Inline tokens={tokens()} /></p>
    if (token.type === "text") return <p><Inline tokens={tokens().length ? tokens() : marked.Lexer.lexInline(text())} /></p>
    if (token.type === "hr") return <hr />
    if (token.type === "html") return <p>{current().raw}</p>
    if (token.type === "blockquote") return <blockquote><Blocks tokens={tokens()} /></blockquote>
    if (token.type === "list") {
      const list = () => { const value = current(); return value.type === "list" ? value : undefined }
      const items = <For each={list()?.items.map((_: unknown, index: number) => index)}>{(index) => {
        const item = () => list()!.items[index]!
        return <li><Show when={item().task}><input type="checkbox" disabled checked={item().checked} aria-label={item().checked ? "Completed task" : "Incomplete task"} /></Show><Blocks tokens={item().tokens.filter((entry: Token) => entry.type !== "checkbox")} /></li>
      }}</For>
      return token.ordered ? <ol start={list()?.start || 1}>{items}</ol> : <ul>{items}</ul>
    }
    if (token.type === "table") {
      const table = () => { const value = current(); return value.type === "table" ? value : undefined }
      return <div class="transcript-md__table" tabindex="0"><table><thead><tr><For each={table()?.header.map((_: unknown, index: number) => index)}>{(index) => <th><Inline tokens={table()!.header[index]!.tokens} /></th>}</For></tr></thead><tbody><For each={table()?.rows.map((_: unknown, index: number) => index)}>{(row) => <tr><For each={table()!.rows[row]!.map((_: unknown, index: number) => index)}>{(cell) => <td><Inline tokens={table()!.rows[row]![cell]!.tokens} /></td>}</For></tr>}</For></tbody></table></div>
    }
    if (token.type === "code") {
      const language = () => { const value = current(); return value.type === "code" ? value.lang : undefined }
      return <FencedCode text={text()} language={language()} />
    }
    return <p>{current().raw}</p>
  }}</For>
}

function tokenKey(token: Token, index: number): string {
  return `${index}:${token.type}${token.type === "list" && token.ordered ? ":ordered" : ""}`
}

function FencedCode(props: { readonly text: string; readonly language?: string }) {
  const [copyState, setCopyState] = createSignal("Copy code")
  const copy = async () => {
    if (!navigator.clipboard) {
      setCopyState("Clipboard unavailable")
      return
    }
    try {
      await navigator.clipboard.writeText(props.text)
      setCopyState("Copied")
    } catch {
      setCopyState("Copy failed")
    }
  }
  return <div class="transcript-md__code"><div class="transcript-md__code-head"><span>{props.language || "text"}</span><button type="button" onClick={() => void copy()}>{copyState()}</button></div><pre tabindex="0"><code>{props.text}</code></pre></div>
}

export function Markdown(props: { readonly text: string }): JSX.Element {
  const tokens = createMemo<readonly Token[]>((previous = []) => marked.lexer(props.text).map((token, index) => previous[index]?.raw === token.raw ? previous[index] : token))
  return <div class="transcript-md"><Blocks tokens={tokens()} /></div>
}
