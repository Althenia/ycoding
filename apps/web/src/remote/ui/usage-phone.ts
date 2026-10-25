import { createSignal, onCleanup, onMount } from "solid-js"

export const usagePhoneMaxWidth = 767

export function createUsagePhone() {
  const [phone, setPhone] = createSignal(false)
  let page: HTMLElement | undefined
  onMount(() => {
    const measure = () => setPhone(page!.getBoundingClientRect().width <= usagePhoneMaxWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(page!)
    measure()
    onCleanup(() => observer.disconnect())
  })
  return { phone, ref: (element: HTMLElement) => { page = element } }
}
