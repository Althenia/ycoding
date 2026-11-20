export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText && await navigator.clipboard.writeText(text).then(() => true, () => false)) return true
  const focused = document.activeElement
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.cssText = "position:fixed;inset-block-start:0;inset-inline-start:0;opacity:0;pointer-events:none"
  document.body.append(area)
  area.select()
  const copied = document.execCommand("copy")
  area.remove()
  if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
  return copied
}
