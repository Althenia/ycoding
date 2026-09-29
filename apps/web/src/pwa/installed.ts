export function isInstalledApp(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || Reflect.get(navigator, "standalone") === true
}

export function lockInstalledAppZoom(): void {
  if (!isInstalledApp()) return
  document.documentElement.style.touchAction = "pan-x pan-y"
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (viewport) viewport.content = `${viewport.content}, maximum-scale=1`
}
