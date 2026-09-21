import { createSignal, onCleanup } from "solid-js"

/** Connectivity state for the shell notice. `true` means the browser reports a connection. */
export function shouldShowOfflineNotice(online: boolean): boolean {
  return !online
}

export function useOnlineStatus() {
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine)
  const goOnline = () => setOnline(true)
  const goOffline = () => setOnline(false)
  window.addEventListener("online", goOnline)
  window.addEventListener("offline", goOffline)
  onCleanup(() => {
    window.removeEventListener("online", goOnline)
    window.removeEventListener("offline", goOffline)
  })
  return online
}
