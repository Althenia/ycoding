import { createLink } from "@tanstack/solid-router"
import { splitProps, type ComponentProps, type JSX } from "solid-js"

function Anchor(props: JSX.AnchorHTMLAttributes<HTMLAnchorElement> & { readonly ariaCurrent?: "page"; readonly ariaLabel?: string; readonly "data-status"?: string }): JSX.Element {
  const [local, anchor] = splitProps(props, ["ariaCurrent", "ariaLabel", "aria-current", "data-status"])
  return <a {...anchor} aria-label={local.ariaLabel} aria-current={local.ariaCurrent} />
}

const RouterLink = createLink(Anchor)
const inactive = {}

export function Link(props: ComponentProps<typeof RouterLink>): JSX.Element {
  return <RouterLink activeProps={inactive} {...props} />
}
