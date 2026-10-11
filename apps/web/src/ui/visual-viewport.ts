export const keyboardOpenThreshold = 80
export const keyboardLayoutMax = 1200

export function keyboardOcclusion(input: {
  readonly layoutWidth: number
  readonly layoutHeight: number
  readonly offsetTop: number
  readonly height: number
}): { readonly open: boolean; readonly inset: number } {
  if (!(input.layoutWidth < keyboardLayoutMax) || !(input.height > 0) || !(input.layoutHeight > 0)) return { open: false, inset: 0 }
  const covered = Math.round(input.layoutHeight - Math.max(0, input.offsetTop) - input.height)
  const inset = covered > keyboardOpenThreshold ? covered : 0
  return { open: inset > 0, inset }
}

export function visualViewportFrame(viewport: { readonly offsetTop: number; readonly height: number } | null | undefined): { readonly top: number; readonly height: number } | undefined {
  if (!viewport || !(viewport.height > 0)) return undefined
  return { top: Math.max(0, Math.round(viewport.offsetTop)), height: Math.round(viewport.height) }
}

export type KeyboardChromeTarget = {
  dataset: { keyboardOpen?: string }
  style: { setProperty(name: string, value: string): void }
}

export function paintKeyboardChrome(element: KeyboardChromeTarget, occlusion: { readonly open: boolean; readonly inset: number }): void {
  element.style.setProperty("--yc-keyboard-inset", `${occlusion.open ? occlusion.inset : 0}px`)
  if (!occlusion.open) {
    delete element.dataset.keyboardOpen
    return
  }
  element.dataset.keyboardOpen = ""
}

type ViewportLike = EventTarget & { readonly offsetTop: number; readonly height: number }

export function watchVisualViewport(onFrame: (viewport: ViewportLike | null) => void): () => void {
  let bound: ViewportLike | null = null
  const publish = () => {
    const viewport = window.visualViewport as ViewportLike | null
    if (viewport !== bound) {
      release()
      bind(viewport)
    }
    onFrame(viewport)
  }
  const bind = (viewport: ViewportLike | null) => {
    bound = viewport
    viewport?.addEventListener("resize", publish)
    viewport?.addEventListener("scroll", publish)
  }
  const release = () => {
    bound?.removeEventListener("resize", publish)
    bound?.removeEventListener("scroll", publish)
    bound = null
  }
  bind(window.visualViewport as ViewportLike | null)
  window.addEventListener("resize", publish)
  publish()
  return () => {
    window.removeEventListener("resize", publish)
    release()
  }
}

export function watchKeyboardChrome(element: HTMLElement): () => void {
  return watchVisualViewport(() => {
    const viewport = window.visualViewport
    paintKeyboardChrome(element, keyboardOcclusion({
      layoutWidth: window.innerWidth,
      layoutHeight: window.innerHeight,
      offsetTop: viewport?.offsetTop ?? 0,
      height: viewport?.height ?? 0,
    }))
  })
}
