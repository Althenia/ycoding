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
  return <For each={props.tokens}>{(token) => {
    if (token.type === "text" || token.type === "escape") return <>{token.text}</>
    if (token.type === "codespan") return <code>{token.text}</code>
    if (token.type === "strong") return <strong><Inline tokens={token.tokens ?? []} /></strong>
    if (token.type === "em") return <em><Inline tokens={token.tokens ?? []} /></em>
    if (token.type === "del") return <del><Inline tokens={token.tokens ?? []} /></del>
    if (token.type === "br") return <br />
    if (token.type === "link" || token.type === "image") {
      const href = safeHref(token.href)
      const label = token.type === "image" ? token.text || token.href : <Inline tokens={token.tokens ?? []} />
      return href ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <span>{token.type === "image" ? token.text : token.raw}</span>
    }
    if (token.type === "html") return <>{token.raw}</>
    return <>{"text" in token && typeof token.text === "string" ? token.text : token.raw}</>
  }}</For>
}

function Blocks(props: { readonly tokens: readonly Token[] }): JSX.Element {
  return <For each={props.tokens}>{(token) => {
    if (token.type === "space") return null
    if (token.type === "heading") return <div class={`transcript-md__heading transcript-md__heading--${token.depth}`} role="heading" aria-level={token.depth}><Inline tokens={token.tokens ?? []} /></div>
    if (token.type === "paragraph") return <p><Inline tokens={token.tokens ?? []} /></p>
    if (token.type === "text") return <p><Inline tokens={token.tokens ?? marked.Lexer.lexInline(token.text)} /></p>
    if (token.type === "hr") return <hr />
    if (token.type === "html") return <p>{token.raw}</p>
    if (token.type === "blockquote") return <blockquote><Blocks tokens={token.tokens ?? []} /></blockquote>
    if (token.type === "list") {
      const items = <For each={token.items}>{(item) => <li><Show when={item.task}><input type="checkbox" disabled checked={item.checked} aria-label={item.checked ? "Completed task" : "Incomplete task"} /></Show><Blocks tokens={item.tokens.filter((entry: Token) => entry.type !== "checkbox")} /></li>}</For>
      return token.ordered ? <ol start={token.start || 1}>{items}</ol> : <ul>{items}</ul>
    }
    if (token.type === "table") return <div class="transcript-md__table" tabindex="0"><table><thead><tr><For each={token.header}>{(cell) => <th><Inline tokens={cell.tokens} /></th>}</For></tr></thead><tbody><For each={token.rows}>{(row) => <tr><For each={row}>{(cell) => <td><Inline tokens={cell.tokens} /></td>}</For></tr>}</For></tbody></table></div>
    if (token.type === "code") return <FencedCode text={token.text} language={token.lang} />
    return <p>{token.raw}</p>
  }}</For>
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
