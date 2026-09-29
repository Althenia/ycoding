import { Show, createSignal, type JSX } from "solid-js"
import { Link } from "../../router/router"
import { BrandMark, ThemeToggle } from "../../ui/site"
import { createInviteHttp } from "../http"
import { formatAccessKey, inviteLandingView, takeInviteToken, type InvitePhase } from "../invite"

export function InvitePage(): JSX.Element {
  let token = takeInviteToken(window.location.hash, (path) => window.history.replaceState(null, "", path))
  const [phase, setPhase] = createSignal<InvitePhase>(token ? "ready" : "invalid")
  const [key, setKey] = createSignal("")
  const [copyStatus, setCopyStatus] = createSignal("")
  const view = () => inviteLandingView(phase())
  const accept = async () => {
    if (!token || !view().canAccept) return
    setPhase("accepting")
    const result = await createInviteHttp().redeem(token)
    if (!result.ok) {
      setPhase(result.status === 404 ? "invalid" : "error")
      return
    }
    setKey(formatAccessKey(result.value.accessKey))
    token = undefined
    setPhase("revealed")
  }
  return (
    <main id="remote-main" class="sign-in">
      <div class="sign-in__panel">
        <div class="sign-in__top">
          <Link href="/" class="brand" title="YCoding home"><BrandMark compact /></Link>
          <ThemeToggle />
        </div>
        <div class="sign-in__head">
          <h1 class="sign-in__title">{view().title}</h1>
          <Show when={!view().showKey}><p class="sign-in__lede">Accept to create your remote account and its access key.</p></Show>
        </div>
        <Show when={view().message}><p class="sign-in__error" role="alert">{view().message}</p></Show>
        <Show when={view().canAccept || phase() === "accepting" || phase() === "error"}>
          <button class="button button--primary sign-in__provider" type="button" disabled={phase() === "accepting"}
            onClick={() => void accept()}>{phase() === "accepting" ? "Accepting…" : "Accept invite"}</button>
        </Show>
        <Show when={view().showKey}>
          <div class="field">
            <label class="field__label" for="new-access-key">Access key</label>
            <input id="new-access-key" class="input" value={key()} readOnly autocomplete="off" spellcheck={false} />
            <p class="field__hint">Use this key to sign in on your other devices. It is shown only once. Store it somewhere safe.</p>
          </div>
          <button type="button" class="button button--secondary" onClick={() => {
            void navigator.clipboard.writeText(key()).then(() => setCopyStatus("Copied"), () => setCopyStatus("Copy unavailable"))
          }}>Copy</button>
          <Show when={copyStatus()}><p role="status" class="field__hint">{copyStatus()}</p></Show>
          <button type="button" class="button button--primary sign-in__provider" onClick={() => window.location.assign("/remote/")}>Continue</button>
        </Show>
        <Show when={phase() === "invalid"}><Link href="/remote" class="text-link">Sign in with an access key</Link></Show>
      </div>
    </main>
  )
}
