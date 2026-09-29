import { describe, expect, test } from "bun:test"
import { createPWAInstall } from "./install"

const macSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
const iosSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"

function browser(options: { userAgent?: string; platform?: string; touch?: number; standalone?: boolean; installed?: boolean } = {}) {
  const events = new EventTarget()
  const media = new EventTarget()
  const displayMode = Object.assign(media, { matches: options.installed ?? false })
  return {
    environment: {
      window: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        matchMedia: () => displayMode,
      },
      navigator: {
        userAgent: options.userAgent ?? "Mozilla/5.0 Chrome/130.0 Safari/537.36",
        platform: options.platform ?? "Win32",
        maxTouchPoints: options.touch ?? 0,
        standalone: options.standalone ?? false,
      },
    },
    emit: (event: Event) => events.dispatchEvent(event),
    displayMode: (matches: boolean) => { displayMode.matches = matches; media.dispatchEvent(new Event("change")) },
  }
}

function installPrompt(outcome: "accepted" | "dismissed") {
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    calls: 0,
    prompt() { this.calls += 1; return Promise.resolve() },
    userChoice: Promise.resolve({ outcome }),
  })
  return event
}

describe("PWA install state", () => {
  test("does not access browser globals at import or initialization, and starts safely without a window", () => {
    const install = createPWAInstall()
    expect(install.isInstalled()).toBe(false)
    expect(install.canInstall()).toBe(false)
    expect(install.installMethod()).toBe("unsupported")
    install.start()
    expect(install.installMethod()).toBe("unsupported")
  })

  for (const outcome of ["accepted", "dismissed"] as const) {
    test(`captures a Chromium prompt before Settings mounts and clears it after ${outcome}`, async () => {
      const target = browser()
      const install = createPWAInstall()
      install.start(target.environment)
      const event = installPrompt(outcome)
      target.emit(event)
      expect(event.defaultPrevented).toBe(true)
      expect(install.installMethod()).toBe("native")
      expect(install.canInstall()).toBe(true)
      expect(await install.install()).toBe(outcome)
      expect(event.calls).toBe(1)
      expect(install.canInstall()).toBe(false)
      expect(install.installMethod()).toBe("unsupported")
      expect(await install.install()).toBe("unavailable")
      expect(event.calls).toBe(1)
    })
  }

  test("clears a failed prompt without claiming installation", async () => {
    const target = browser()
    const install = createPWAInstall()
    install.start(target.environment)
    const event = Object.assign(installPrompt("accepted"), { prompt: () => Promise.reject(new Error("unavailable")) })
    target.emit(event)
    expect(await install.install()).toBe("unavailable")
    expect(install.canInstall()).toBe(false)
    expect(install.isInstalled()).toBe(false)
  })

  test("appinstalled hides the action even before display-mode changes", () => {
    const target = browser()
    const install = createPWAInstall()
    install.start(target.environment)
    target.emit(installPrompt("accepted"))
    target.emit(new Event("appinstalled"))
    expect(install.isInstalled()).toBe(true)
    expect(install.canInstall()).toBe(false)
    expect(install.installMethod()).toBe("unsupported")
  })

  test("standalone display mode and iOS navigator.standalone suppress installation", () => {
    const target = browser()
    const install = createPWAInstall()
    install.start(target.environment)
    target.emit(installPrompt("accepted"))
    target.displayMode(true)
    expect(install.isInstalled()).toBe(true)
    expect(install.canInstall()).toBe(false)
    target.displayMode(false)
    expect(install.isInstalled()).toBe(false)
    expect(install.canInstall()).toBe(true)
    const ios = createPWAInstall()
    ios.start(browser({ userAgent: iosSafari, platform: "iPhone", standalone: true }).environment)
    expect(ios.isInstalled()).toBe(true)
    expect(ios.canInstall()).toBe(false)
  })

  for (const [name, options, method] of [
    ["iPhone Safari", { userAgent: iosSafari, platform: "iPhone" }, "ios-manual"],
    ["iPad Safari with desktop user agent", { userAgent: macSafari, platform: "MacIntel", touch: 5 }, "ios-manual"],
    ["macOS Safari 17", { userAgent: macSafari, platform: "MacIntel" }, "safari-manual"],
  ] as const) {
    test(`${name} offers instructions but never a programmatic prompt`, async () => {
      const install = createPWAInstall()
      install.start(browser(options).environment)
      expect(install.installMethod()).toBe(method)
      expect(install.canInstall()).toBe(true)
      expect(await install.install()).toBe("manual")
    })
  }

  test("unsupported browsers, older Safari, and non-Safari iOS do not show an install action", () => {
    for (const options of [
      { userAgent: "Mozilla/5.0 Firefox/130", platform: "Win32" },
      { userAgent: macSafari.replace("Version/17.0", "Version/16.6"), platform: "MacIntel" },
      { userAgent: iosSafari.replace("Version/17.0 Mobile/15E148 Safari/604.1", "CriOS/130.0 Mobile/15E148 Safari/604.1"), platform: "iPhone" },
    ]) {
      const install = createPWAInstall()
      install.start(browser(options).environment)
      expect(install.installMethod()).toBe("unsupported")
      expect(install.canInstall()).toBe(false)
    }
  })
})
