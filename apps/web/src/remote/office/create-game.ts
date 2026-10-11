import Phaser from "phaser"
import { createOfficeMailbox, type OfficeFrameInput } from "./bridge"
import { OfficeScene } from "./OfficeScene"
import type { OfficeRoomID } from "./types"

export type OfficeHandle = {
  update: (input: OfficeFrameInput) => void
  fit: () => void
  zoomBy: (factor: number) => void
  panBy: (x: number, y: number) => void
  follow: () => void
  focus: (actorID: string) => void
  destroy: () => void
}

const visibilityCleanup = new WeakMap<Phaser.Game, () => void>()
const disposedGames = new WeakSet<Phaser.Game>()

class OfficeGame extends Phaser.Game {
  protected override start(): void {
    const add = Reflect.get(document, "addEventListener")
    const previousBlur = window.onblur
    const previousFocus = window.onfocus
    let visibilityListener: EventListenerOrEventListenerObject | undefined
    document.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      if (type === "visibilitychange") visibilityListener = listener
      return add.call(document, type, listener, options)
    }
    try {
      super.start()
    } finally {
      document.addEventListener = add
    }
    const installedBlur = window.onblur
    const installedFocus = window.onfocus
    const cleanup = () => {
      if (visibilityListener) document.removeEventListener("visibilitychange", visibilityListener)
      if (window.onblur === installedBlur) window.onblur = previousBlur
      if (window.onfocus === installedFocus) window.onfocus = previousFocus
    }
    if (disposedGames.has(this)) {
      cleanup()
      return
    }
    visibilityCleanup.set(this, cleanup)
  }

  override destroy(removeCanvas: boolean, noReturn?: boolean): void {
    disposedGames.add(this)
    visibilityCleanup.get(this)?.()
    visibilityCleanup.delete(this)
    super.destroy(removeCanvas, noReturn)
  }
}

export function mountOffice(host: HTMLElement, initial: OfficeFrameInput, selectSession: (id: string) => void, fail: (message: string) => void, onLocations: (locations: Readonly<Record<string, OfficeRoomID | undefined>>) => void, inspectEntity: (id: string) => void, onEntityClaims: (claims: ReadonlyMap<string, readonly string[]>) => void): OfficeHandle {
  const mailbox = createOfficeMailbox(initial)
  const resolution = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  let failed = false
  let game: OfficeGame | undefined
  const reportFailure = (message: string) => {
    if (failed) return
    failed = true
    game?.pause()
    fail(message)
  }
  const style = getComputedStyle(host)
  const scene = new OfficeScene(mailbox, selectSession, reportFailure, resolution, onLocations, {
    sans: style.getPropertyValue("--yc-font-sans").trim() || "sans-serif",
    mono: style.getPropertyValue("--yc-font-mono").trim() || "monospace",
  }, inspectEntity, onEntityClaims)
  game = new OfficeGame({
    type: Phaser.AUTO, parent: host,
    width: Math.max(1, Math.round(host.clientWidth * resolution)), height: Math.max(1, Math.round(host.clientHeight * resolution)),
    backgroundColor: "#1b2832", pixelArt: true,
    render: { antialias: false, roundPixels: true },
    audio: { noAudio: true }, input: { keyboard: false, mouse: { preventDefaultWheel: false } }, autoFocus: false,
    fps: { target: 30, limit: initial.preferences.quality === "battery" ? 20 : 30, forceSetTimeOut: false },
    scale: { mode: Phaser.Scale.NONE }, scene: [scene],
    banner: false,
  })
  if (failed) game.pause()
  let disposed = false
  let zeroSize = !host.clientWidth || !host.clientHeight
  const resize = new ResizeObserver(() => {
    if (disposed || !host.clientWidth || !host.clientHeight) return
    game.scale.resize(Math.round(host.clientWidth * resolution), Math.round(host.clientHeight * resolution))
    scene.resize()
    if (zeroSize) scene.defaultView()
    zeroSize = false
  })
  resize.observe(host)
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || disposed || failed) return
    event.preventDefault()
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? host.clientHeight : 1
    scene.panBy((event.deltaX || (event.shiftKey ? event.deltaY : 0)) * unit, (event.shiftKey ? 0 : event.deltaY) * unit)
  }
  host.addEventListener("wheel", wheel, { passive: false })
  const visibility = () => {
    if (disposed || failed) return
    if (document.hidden) { game.pause(); return }
    scene.adoptLatest()
    scene.update(0, 0)
    scene.settle()
    game.resume()
  }
  document.addEventListener("visibilitychange", visibility)
  const fontSettlement = () => scene.refreshFonts()
  document.fonts.addEventListener("loadingdone", fontSettlement)
  const contextLost = () => reportFailure("The office renderer lost its graphics context. Return to the normal workspace or reload the view.")
  const canvas = () => host.querySelector("canvas")
  const ready = () => {
    canvas()?.setAttribute("aria-hidden", "true")
    canvas()?.addEventListener("webglcontextlost", contextLost)
    visibility()
  }
  game.events.once("ready", ready)
  return {
    update: (input) => {
      if (disposed) return
      mailbox.update(input)
    },
    fit: () => scene.fit(),
    zoomBy: (factor) => scene.zoomBy(factor),
    panBy: (x, y) => scene.panBy(x, y),
    follow: () => scene.follow(),
    focus: (actorID) => scene.focus(actorID),
    destroy: () => {
      if (disposed) return
      disposed = true
      resize.disconnect()
      host.removeEventListener("wheel", wheel)
      document.removeEventListener("visibilitychange", visibility)
      document.fonts.removeEventListener("loadingdone", fontSettlement)
      game.events.off("ready", ready)
      canvas()?.removeEventListener("webglcontextlost", contextLost)
      game.resume()
      game.loop.wake()
      game.destroy(true, false)
    },
  }
}
