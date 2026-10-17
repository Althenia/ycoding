import { Show } from "solid-js"
import "./provider-logo.css"

const meta = { src: new URL("../../assets/providers/meta.svg", import.meta.url).href }
const zai = { src: new URL("../../assets/providers/zai.svg", import.meta.url).href, monochrome: true }

const logos = new Map<string, { readonly src: string; readonly dark?: string; readonly monochrome?: boolean }>([
  ["anthropic", { src: new URL("../../assets/providers/claude.svg", import.meta.url).href }],
  ["openrouter", { src: new URL("../../assets/providers/openrouter.svg", import.meta.url).href }],
  ["openai", { src: new URL("../../assets/providers/openai.svg", import.meta.url).href, monochrome: true }],
  ["meta", meta],
  ["muse", meta],
  ["github-copilot", { src: new URL("../../assets/providers/github-copilot.svg", import.meta.url).href, monochrome: true }],
  ["xai", { src: new URL("../../assets/providers/grok.svg", import.meta.url).href, monochrome: true }],
  ["zai", zai],
  ["zai-coding-plan", zai],
  ["cursor", {
    src: new URL("../../assets/providers/cursor-light.svg", import.meta.url).href,
    dark: new URL("../../assets/providers/cursor-dark.svg", import.meta.url).href,
  }],
  ["opencode-go", { src: new URL("../../assets/providers/opencode.svg", import.meta.url).href, monochrome: true }],
])

export function providerLogo(providerID: string) {
  return logos.get(providerID)
}

export function ProviderLogo(props: { readonly providerID: string }) {
  return <Show when={providerLogo(props.providerID)}>{(logo) =>
    <span class="provider-logo" aria-hidden="true">
      <Show when={logo().monochrome} fallback={<>
        <img class={logo().dark ? "provider-logo__light" : undefined} src={logo().src} alt="" draggable={false} />
        <Show when={logo().dark}>{(dark) => <img class="provider-logo__dark" src={dark()} alt="" draggable={false} />}</Show>
      </>}>
        <span class="provider-logo__glyph" style={{ "--provider-logo-mask": `url("${logo().src}")` }} />
      </Show>
    </span>
  }</Show>
}
