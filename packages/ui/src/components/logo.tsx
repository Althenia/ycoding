import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 256 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M40 40h32v64H40zm144 0h32v64h-32zM40 112h64v64H72v-32H40zm112 0h64v32h-32v32h-32zm-40 72h32v32h-32z"
        fill="#67D7A4"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 256 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M40 40h32v64H40zm144 0h32v64h-32zM40 112h64v64H72v-32H40zm112 0h64v32h-32v32h-32zm-40 72h32v32h-32z"
        fill="#67D7A4"
      />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 160"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform="translate(24 24) scale(.4375)">
        <path d="M40 40h40l48 64-24 32z" fill="#67D7A4" />
        <path d="M176 40h40l-64 96-24-32z" fill="var(--icon-strong-base)" />
        <path d="M104 112h48v104h-48z" fill="var(--icon-strong-base)" />
        <rect x="116" y="104" width="24" height="24" transform="rotate(45 128 116)" fill="#F0BE62" />
      </g>
      <text
        x="164"
        y="91"
        fill="var(--icon-strong-base)"
        font-family="Geist Mono, ui-monospace, monospace"
        font-size="68"
        font-weight="600"
        letter-spacing="-2"
      >
        YCoding
      </text>
      <text
        x="168"
        y="124"
        fill="#67D7A4"
        font-family="Geist Mono, ui-monospace, monospace"
        font-size="16"
        font-weight="400"
      >
        terminal coding agent
      </text>
    </svg>
  )
}
