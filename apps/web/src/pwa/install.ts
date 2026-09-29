import { createSignal } from "solid-js"

export type InstallMethod = "native" | "ios-manual" | "safari-manual" | "unsupported"

type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

function isInstallPrompt(event: Event): event is InstallPrompt {
  return "prompt" in event && typeof event.prompt === "function" && "userChoice" in event
}

type InstallEnvironment = {
  window: {
    addEventListener: (type: string, listener: EventListener) => void
    removeEventListener: (type: string, listener: EventListener) => void
    matchMedia: (query: string) => {
      matches: boolean
      addEventListener: (type: string, listener: EventListener) => void
      removeEventListener: (type: string, listener: EventListener) => void
    }
  }
  navigator: { userAgent: string; platform: string; maxTouchPoints: number }
}

export function createPWAInstall() {
  const [prompt, setPrompt] = createSignal<InstallPrompt>()
  const [installed, setInstalled] = createSignal(false)
  const [manualMethod, setManualMethod] = createSignal<InstallMethod>("unsupported")
  let stop: (() => void) | undefined
  const installMethod = (): InstallMethod => installed() ? "unsupported" : prompt() ? "native" : manualMethod()

  return {
    canInstall: () => !installed() && installMethod() !== "unsupported",
    isInstalled: installed,
    installMethod,
    start(environment?: InstallEnvironment) {
      if (stop) return
      const browser = environment ?? (typeof window !== "undefined" && typeof navigator !== "undefined" ? { window, navigator } : undefined)
      if (!browser) return
      const media = browser.window.matchMedia("(display-mode: standalone)")
      let appInstalled = false
      const updateInstalled = () => setInstalled(appInstalled || media.matches || Reflect.get(browser.navigator, "standalone") === true)
      const onPrompt: EventListener = (event) => {
        if (!isInstallPrompt(event)) return
        event.preventDefault()
        setPrompt(event)
      }
      const onInstalled = () => {
        appInstalled = true
        setPrompt(undefined)
        updateInstalled()
      }
      const safari = /AppleWebKit\//.test(browser.navigator.userAgent) && /Safari\//.test(browser.navigator.userAgent) &&
        !/(?:CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium)\//.test(browser.navigator.userAgent)
      const ios = /iPhone|iPad|iPod/.test(browser.navigator.userAgent) ||
        browser.navigator.platform === "MacIntel" && browser.navigator.maxTouchPoints > 1
      const version = Number(browser.navigator.userAgent.match(/Version\/(\d+)/)?.[1] ?? 0)
      setManualMethod(safari && ios ? "ios-manual" : safari && browser.navigator.platform.startsWith("Mac") && version >= 17 ? "safari-manual" : "unsupported")
      updateInstalled()
      browser.window.addEventListener("beforeinstallprompt", onPrompt)
      browser.window.addEventListener("appinstalled", onInstalled)
      media.addEventListener("change", updateInstalled)
      stop = () => {
        browser.window.removeEventListener("beforeinstallprompt", onPrompt)
        browser.window.removeEventListener("appinstalled", onInstalled)
        media.removeEventListener("change", updateInstalled)
        setPrompt(undefined)
      }
    },
    stop() {
      stop?.()
      stop = undefined
    },
    async install(): Promise<"accepted" | "dismissed" | "manual" | "unavailable"> {
      if (installed()) return "unavailable"
      const event = prompt()
      if (!event) return manualMethod() === "unsupported" ? "unavailable" : "manual"
      setPrompt(undefined)
      try {
        await event.prompt()
        return (await event.userChoice).outcome
      } catch {
        return "unavailable"
      }
    },
  }
}

export const pwaInstall = createPWAInstall()
