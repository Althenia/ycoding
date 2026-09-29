import { Show, createSignal } from "solid-js"
import { Modal } from "../ui/modal"
import { pwaInstall } from "./install"

export function InstallPWAButton() {
  const [open, setOpen] = createSignal(false)
  const [error, setError] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  const install = async () => {
    setError(false)
    const result = await pwaInstall.install()
    if (result === "manual") setOpen(true)
    if (result === "unavailable" && !pwaInstall.isInstalled()) setError(true)
  }
  return <>
    <Show when={pwaInstall.canInstall()}>
      <button ref={trigger} type="button" class="button button--secondary button--small" onClick={() => void install()}>Install App</button>
    </Show>
    <Show when={error()}><span class="settings__hint" role="alert">Installation couldn't start. Try the browser's install menu.</span></Show>
    <Show when={open() && !pwaInstall.isInstalled()}>
      <Modal class="overlay--pwa-install" label="Install YCoding" returnFocus={trigger!} onClose={() => setOpen(false)}>
        <ol class="steps">
          <Show when={pwaInstall.installMethod() === "ios-manual"}>
            <li class="steps__item"><span class="steps__text">Tap the Share button in Safari.</span></li>
            <li class="steps__item"><span class="steps__text">Select Add to Home Screen.</span></li>
            <li class="steps__item"><span class="steps__text">Tap Add.</span></li>
          </Show>
          <Show when={pwaInstall.installMethod() === "safari-manual"}>
            <li class="steps__item"><span class="steps__text">On macOS Sonoma 14 or later, choose File → Add to Dock in Safari.</span></li>
            <li class="steps__item"><span class="steps__text">Click Add.</span></li>
          </Show>
        </ol>
      </Modal>
    </Show>
  </>
}
