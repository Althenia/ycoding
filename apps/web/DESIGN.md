---
version: alpha
name: YCoding web
description: Instrument palette, planes and shell chrome over the approved Stitch project 10627183425669399580 Web composition, with canonical executable tokens and runtime boundaries.
surface: web
extends: ../../DESIGN.md
colors:
  plane-chrome: "#f3f6fb"
  plane-canvas: "#fafcfe"
  plane-raised: "#e5eaf0"
  plane-hover: "#dde2e9"
  plane-selected: "#d3d8df"
  plane-inverse: "#151618"
  line-divider: "#c4c9d1"
  line-subtle: "#80858c"
  line-field: "#70757c"
  ink: "#151618"
  ink-secondary: "#404449"
  ink-tertiary: "#565b62"
  ink-inverse: "#f3f6fb"
  focus: "#088955"
  scrim: "rgba(243, 246, 251, 0.5)"
  selection: "rgba(47, 112, 242, 0.32)"
  green-tonal: "#e4efe8"
  green-tonal-hover: "#d6e7dc"
  green-line: "#85bd9c"
  green-graphic: "#088955"
  green-solid: "#007547"
  green-solid-hover: "#00653d"
  green-ink: "#045e39"
  on-green: "#fbfcfb"
  mint-tonal: "#d1f8e1"
  mint-tonal-hover: "#bef1d4"
  mint-line: "#5fc995"
  mint-graphic: "#06915f"
  mint-solid: "#027d51"
  mint-solid-hover: "#046c46"
  mint-ink: "#026641"
  on-mint: "#fafcfe"
  violet-tonal: "#eee9fe"
  violet-tonal-hover: "#e5ddff"
  violet-line: "#b99efe"
  violet-graphic: "#8759dd"
  violet-solid: "#7743cc"
  violet-solid-hover: "#6932bb"
  violet-ink: "#642bb4"
  on-violet: "#fafcfe"
  teal-tonal: "#d2f5f5"
  teal-tonal-hover: "#bfeeed"
  teal-line: "#63c3c4"
  teal-graphic: "#0b8c8d"
  teal-solid: "#037879"
  teal-solid-hover: "#006869"
  teal-ink: "#026263"
  on-teal: "#fafcfe"
  sky-tonal: "#dbf1ff"
  sky-tonal-hover: "#c7e8fe"
  sky-line: "#69bbeb"
  sky-graphic: "#0484b9"
  sky-solid: "#0071a0"
  sky-solid-hover: "#03628b"
  sky-ink: "#025c83"
  on-sky: "#fafcfe"
  amber-tonal: "#ffe9ce"
  amber-tonal-hover: "#ffddb1"
  amber-line: "#e2a449"
  amber-graphic: "#a56d00"
  amber-solid: "#f9a80a"
  amber-solid-hover: "#e49905"
  amber-ink: "#744c00"
  on-amber: "#151618"
  coral-tonal: "#ffe6e4"
  coral-tonal-hover: "#fed9d5"
  coral-line: "#ff8a84"
  coral-graphic: "#d03f41"
  coral-solid: "#be222d"
  coral-solid-hover: "#ac001e"
  coral-ink: "#a2001b"
  on-coral: "#fafcfe"
  terminal-bg: "#0c1413"
  terminal-fg: "#d8e6de"
  terminal-dim: "#8fa79b"
  terminal-accent: "#5fe3a1"
  code-ink: "#151618"
  code-keyword: "#642bb4"
  code-string: "#045e39"
  code-number: "#a2001b"
  code-comment: "#565b62"
  code-function: "#025c83"
  code-type: "#744c00"
  code-property: "#026263"
  code-meta: "#404449"
typography:
  font-sans: '"Geist", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
  font-mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace'
  size-2xs: 12px
  leading-2xs: 16px
  size-xs: 13px
  leading-xs: 20px
  size-sm: 14px
  leading-sm: 22px
  size-md: 16px
  leading-md: 26px
  size-lg: 18px
  leading-lg: 28px
  size-xl: 20px
  leading-xl: 30px
  size-2xl: 24px
  leading-2xl: 32px
  size-3xl: 30px
  leading-3xl: 38px
  size-4xl: 36px
  leading-4xl: 42px
  size-display: 40px
  leading-display: 44px
  weight-regular: 400
  weight-medium: 500
  weight-semibold: 600
  weight-bold: 700
  tracking-tight: -0.02em
  tracking-wide: 0.06em
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
  "10": 40px
  "12": 48px
  "16": 64px
  "20": 80px
rounded:
  detail: 4px
  control: 6px
  card: 8px
  composer: 12px
  pill: 999px
elevation:
  float: "0 1px 2px rgba(0, 0, 0, 0.08), 0 12px 32px -8px rgba(0, 0, 0, 0.12)"
  focus-ring: "0 0 0 2px var(--yc-plane-canvas), 0 0 0 4px var(--yc-focus)"
controls:
  control-h: 44px
  control-h-dense: 36px
  hit-min: 44px
  control-pad-x: 16px
  border-width: 1px
  scrollbar-size: 12px
  icon-xs: 14px
  icon-sm: 16px
  icon-md: 20px
cursors:
  surface: default
  action: pointer
  text: text
  disabled: not-allowed
  busy: progress
  pan: grab
  panning: grabbing
  zoom-in: zoom-in
  adjust-x: ew-resize
  resize-y: ns-resize
layout:
  measure: 68ch
  measure-narrow: 54ch
  measure-wide: 120ch
  header-h: 60px
  header-public-h: 56px
  header-session-h: 44px
  status-strip-h: 36px
  bottom-nav-h: 56px
  content-max: 1200px
  public-max: 1440px
  content-max-wide: 1600px
  rail-w: 256px
  rail-min-w: 232px
  rail-max-w: 360px
  activity-w: 80px
  companion-w: 448px
  docs-nav-w: 248px
  docs-toc-w: 200px
  device-max: 180px
  gutter: 16px
motion:
  duration:
    instant: 80ms
    quick: 140ms
    base: 220ms
    trace: 1760ms
    spin: 660ms
  easing:
    standard: "cubic-bezier(0.2, 0, 0, 1)"
    entrance: "cubic-bezier(0, 0, 0.2, 1)"
    exit: "cubic-bezier(0.4, 0, 1, 1)"
    linear: linear
    caret: "steps(2, jump-none)"
  semantic:
    spatial-dur: "var(--yc-dur-base)"
    effect-dur: "var(--yc-dur-quick)"
    exit-dur: "var(--yc-dur-quick)"
    feedback-dur: "var(--yc-dur-instant)"
    travel: "1"
    ease: "var(--yc-ease-standard)"
  reduced:
    spatial-dur: 0s
    effect-dur: "var(--yc-dur-instant)"
    exit-dur: 0s
    travel: "0"
layers:
  header: 30
  nav: 20
  scrim: 90
  overlay: 100
  toast: 110
breakpoints:
  compact: 360
  phone: 480
  small: 640
  tablet: 768
  desktop: 1024
  wide: 1280
  expansive: 1600
devices:
  phone:
    width: 390
    height: 844
    pointer: coarse
    hover: false
    dpr: 3
  desktop:
    width: 1440
    height: 900
    pointer: fine
    hover: true
    dpr: 1
themes:
  dark:
    colors:
      plane-chrome: "#0e1116"
      plane-canvas: "#15181d"
      plane-raised: "#1d2228"
      plane-hover: "#242930"
      plane-selected: "#2b3138"
      plane-inverse: "#f1f4f8"
      line-divider: "#363c44"
      line-subtle: "#676e77"
      line-field: "#848b95"
      ink: "#f1f4f8"
      ink-secondary: "#bfc5cd"
      ink-tertiary: "#a1a8b2"
      ink-inverse: "#0e1116"
      focus: "#55a67a"
      scrim: "rgba(14, 17, 22, 0.72)"
      selection: "rgba(93, 148, 255, 0.32)"
      green-tonal: "#143021"
      green-tonal-hover: "#163b28"
      green-line: "#226f49"
      green-graphic: "#55a67a"
      green-solid: "#027e4d"
      green-solid-hover: "#056b41"
      green-ink: "#9ac8ac"
      on-green: "#f2f4f3"
      mint-tonal: "#0b3421"
      mint-tonal-hover: "#094029"
      mint-line: "#00764c"
      mint-graphic: "#0cb477"
      mint-solid: "#23d08c"
      mint-solid-hover: "#40dd99"
      mint-ink: "#4fdb9b"
      on-mint: "#0e1116"
      violet-tonal: "#2f2349"
      violet-tonal-hover: "#3a2a5b"
      violet-line: "#6c4dab"
      violet-graphic: "#a47bfb"
      violet-solid: "#b99efe"
      violet-solid-hover: "#c4afff"
      violet-ink: "#c4afff"
      on-violet: "#0e1116"
      teal-tonal: "#0d3232"
      teal-tonal-hover: "#0c3d3e"
      teal-line: "#057273"
      teal-graphic: "#21adae"
      teal-solid: "#31c8ca"
      teal-solid-hover: "#48d5d6"
      teal-ink: "#56d4d5"
      on-teal: "#0e1116"
      sky-tonal: "#102f40"
      sky-tonal-hover: "#113a4f"
      sky-line: "#136b95"
      sky-graphic: "#33a3dd"
      sky-solid: "#43befd"
      sky-solid-hover: "#6cc9ff"
      sky-ink: "#6cc9ff"
      on-sky: "#0e1116"
      amber-tonal: "#3c2603"
      amber-tonal-hover: "#4a2f01"
      amber-line: "#875800"
      amber-graphic: "#cc8801"
      amber-solid: "#ec9f07"
      amber-solid-hover: "#fcab11"
      amber-ink: "#f9ac30"
      on-amber: "#0e1116"
      coral-tonal: "#461c1b"
      coral-tonal-hover: "#572220"
      coral-line: "#a33c3b"
      coral-graphic: "#f16461"
      coral-solid: "#ff8a84"
      coral-solid-hover: "#ffa09a"
      coral-ink: "#fea09a"
      on-coral: "#0e1116"
      code-ink: "#f1f4f8"
      code-keyword: "#c4afff"
      code-string: "#9ac8ac"
      code-number: "#fea09a"
      code-comment: "#a1a8b2"
      code-function: "#6cc9ff"
      code-type: "#f9ac30"
      code-property: "#56d4d5"
      code-meta: "#bfc5cd"
    elevation:
      float: "0 1px 2px rgba(0, 0, 0, 0.35), 0 12px 32px -8px rgba(0, 0, 0, 0.5)"
  onedark-light:
    colors:
      plane-chrome: "#f3f6f9"
      plane-canvas: "#fafcfe"
      plane-raised: "#e6eaee"
      plane-hover: "#dee2e6"
      plane-selected: "#d4d8dd"
      plane-inverse: "#1a1b1c"
      line-divider: "#c5c9ce"
      line-subtle: "#818589"
      line-field: "#6e7276"
      ink: "#1a1b1c"
      ink-secondary: "#414447"
      ink-tertiary: "#55585c"
      ink-inverse: "#f3f6f9"
      focus: "#088955"
      scrim: "rgba(243, 246, 249, 0.5)"
      selection: "rgba(47, 112, 242, 0.32)"
      green-tonal: "#e4efe8"
      green-tonal-hover: "#d6e7dc"
      green-line: "#85bd9c"
      green-graphic: "#088955"
      green-solid: "#007547"
      green-solid-hover: "#00653d"
      green-ink: "#045e39"
      on-green: "#fbfcfb"
      mint-tonal: "#d1f8e1"
      mint-tonal-hover: "#bef1d4"
      mint-line: "#5fc995"
      mint-graphic: "#06915f"
      mint-solid: "#027d51"
      mint-solid-hover: "#046c46"
      mint-ink: "#026641"
      on-mint: "#fafcfe"
      violet-tonal: "#eee9fe"
      violet-tonal-hover: "#e5ddff"
      violet-line: "#b99efe"
      violet-graphic: "#8759dd"
      violet-solid: "#7743cc"
      violet-solid-hover: "#6932bb"
      violet-ink: "#642bb4"
      on-violet: "#fafcfe"
      teal-tonal: "#d2f5f5"
      teal-tonal-hover: "#bfeeed"
      teal-line: "#63c3c4"
      teal-graphic: "#0b8c8d"
      teal-solid: "#037879"
      teal-solid-hover: "#006869"
      teal-ink: "#026263"
      on-teal: "#fafcfe"
      sky-tonal: "#dbf1ff"
      sky-tonal-hover: "#c7e8fe"
      sky-line: "#69bbeb"
      sky-graphic: "#0484b9"
      sky-solid: "#0071a0"
      sky-solid-hover: "#03628b"
      sky-ink: "#025c83"
      on-sky: "#fafcfe"
      amber-tonal: "#ffe9ce"
      amber-tonal-hover: "#ffddb1"
      amber-line: "#e2a449"
      amber-graphic: "#a56d00"
      amber-solid: "#f9a80a"
      amber-solid-hover: "#e49905"
      amber-ink: "#744c00"
      on-amber: "#1a1b1c"
      coral-tonal: "#ffe6e4"
      coral-tonal-hover: "#fed9d5"
      coral-line: "#ff8a84"
      coral-graphic: "#d03f41"
      coral-solid: "#be222d"
      coral-solid-hover: "#ac001e"
      coral-ink: "#a2001b"
      on-coral: "#fafcfe"
  onedark-dark:
    colors:
      plane-chrome: "#1c1f26"
      plane-canvas: "#23262e"
      plane-raised: "#2a2f39"
      plane-hover: "#313741"
      plane-selected: "#393f4a"
      plane-inverse: "#f0f3fa"
      line-divider: "#444a57"
      line-subtle: "#727986"
      line-field: "#8b92a0"
      ink: "#f0f3fa"
      ink-secondary: "#c5cbd7"
      ink-tertiary: "#a4abb9"
      ink-inverse: "#1c1f26"
      focus: "#63ac83"
      scrim: "rgba(28, 31, 38, 0.72)"
      selection: "rgba(103, 156, 255, 0.32)"
      green-tonal: "#223e2e"
      green-tonal-hover: "#254935"
      green-line: "#2d7852"
      green-graphic: "#63ac83"
      green-solid: "#027e4d"
      green-solid-hover: "#056b41"
      green-ink: "#b9d8c5"
      on-green: "#f0f4f1"
      mint-tonal: "#1b422f"
      mint-tonal-hover: "#1a4d35"
      mint-line: "#038053"
      mint-graphic: "#1eba7d"
      mint-solid: "#23d08c"
      mint-solid-hover: "#40dd99"
      mint-ink: "#66efae"
      on-mint: "#1c1f26"
      violet-tonal: "#3d3158"
      violet-tonal-hover: "#47386a"
      violet-line: "#7556b4"
      violet-graphic: "#aa83ff"
      violet-solid: "#b99efe"
      violet-solid-hover: "#c4afff"
      violet-ink: "#d5c7fe"
      on-violet: "#1c1f26"
      teal-tonal: "#1c4040"
      teal-tonal-hover: "#1c4b4b"
      teal-line: "#137b7c"
      teal-graphic: "#2cb3b5"
      teal-solid: "#31c8ca"
      teal-solid-hover: "#48d5d6"
      teal-ink: "#6ce7e8"
      on-teal: "#1c1f26"
      sky-tonal: "#1e3d4f"
      sky-tonal-hover: "#1f475e"
      sky-line: "#21749e"
      sky-graphic: "#3baae3"
      sky-solid: "#43befd"
      sky-solid-hover: "#6cc9ff"
      sky-ink: "#9fdafe"
      on-sky: "#1c1f26"
      amber-tonal: "#4b3413"
      amber-tonal-hover: "#593c0f"
      amber-line: "#926001"
      amber-graphic: "#d48e02"
      amber-solid: "#ec9f07"
      amber-solid-hover: "#fcab11"
      amber-ink: "#ffc577"
      on-amber: "#1c1f26"
      coral-tonal: "#562b28"
      coral-tonal-hover: "#662f2d"
      coral-line: "#ad4543"
      coral-graphic: "#f86a67"
      coral-solid: "#ff8a84"
      coral-solid-hover: "#ffa09a"
      coral-ink: "#ffbeb9"
      on-coral: "#1c1f26"
  onedark-pro-dark:
    colors:
      plane-chrome: "#14171f"
      plane-canvas: "#1a1e27"
      plane-raised: "#222631"
      plane-hover: "#292e3a"
      plane-selected: "#303543"
      plane-inverse: "#eff2f9"
      line-divider: "#3b414f"
      line-subtle: "#6b7181"
      line-field: "#858c9d"
      ink: "#eff2f9"
      ink-secondary: "#c1c7d5"
      ink-tertiary: "#a1a8b9"
      ink-inverse: "#14171f"
      focus: "#55a67a"
      scrim: "rgba(20, 23, 31, 0.72)"
      selection: "rgba(93, 148, 255, 0.32)"
      green-tonal: "#1a3627"
      green-tonal-hover: "#1d412e"
      green-line: "#26724c"
      green-graphic: "#55a67a"
      green-solid: "#027e4d"
      green-solid-hover: "#056b41"
      green-ink: "#b4d6c1"
      on-green: "#eff3f0"
      mint-tonal: "#133a28"
      mint-tonal-hover: "#10452e"
      mint-line: "#017a4f"
      mint-graphic: "#0cb477"
      mint-solid: "#1bcd89"
      mint-solid-hover: "#3bda96"
      mint-ink: "#62ecab"
      on-mint: "#14171f"
      violet-tonal: "#352950"
      violet-tonal-hover: "#3f3061"
      violet-line: "#6f50ae"
      violet-graphic: "#a47bfb"
      violet-solid: "#b699fe"
      violet-solid-hover: "#c1aaff"
      violet-ink: "#d2c3fe"
      on-violet: "#14171f"
      teal-tonal: "#143838"
      teal-tonal-hover: "#134343"
      teal-line: "#047576"
      teal-graphic: "#21adae"
      teal-solid: "#2bc5c7"
      teal-solid-hover: "#44d2d3"
      teal-ink: "#69e4e5"
      on-teal: "#14171f"
      sky-tonal: "#173547"
      sky-tonal-hover: "#173f55"
      sky-line: "#186e98"
      sky-graphic: "#33a3dd"
      sky-solid: "#3fbafa"
      sky-solid-hover: "#63c6ff"
      sky-ink: "#97d7fe"
      on-sky: "#14171f"
      amber-tonal: "#432d0a"
      amber-tonal-hover: "#503404"
      amber-line: "#8a5b00"
      amber-graphic: "#cc8801"
      amber-solid: "#e89c06"
      amber-solid-hover: "#f9a703"
      amber-ink: "#ffc16a"
      on-amber: "#14171f"
      coral-tonal: "#4e2321"
      coral-tonal-hover: "#5d2725"
      coral-line: "#a63f3e"
      coral-graphic: "#f16461"
      coral-solid: "#ff847f"
      coral-solid-hover: "#fe9b95"
      coral-ink: "#ffbab4"
      on-coral: "#14171f"
  high-contrast-light:
    colors:
      plane-chrome: "#f6f9fd"
      plane-canvas: "#fefeff"
      plane-raised: "#e9edf3"
      plane-hover: "#dfe3e9"
      plane-selected: "#d5d9df"
      plane-inverse: "#050607"
      line-divider: "#6a6d73"
      line-subtle: "#4a4d53"
      line-field: "#32363b"
      ink: "#050607"
      ink-secondary: "#26292d"
      ink-tertiary: "#3f4348"
      ink-inverse: "#f6f9fd"
      focus: "#045534"
      scrim: "rgba(246, 249, 253, 0.5)"
      selection: "rgba(0, 62, 181, 0.32)"
      green-tonal: "#e7f1eb"
      green-tonal-hover: "#d7e9dd"
      green-line: "#2d7e55"
      green-graphic: "#045534"
      green-solid: "#034f2f"
      green-solid-hover: "#024428"
      green-ink: "#024428"
      on-green: "#fefefe"
      mint-tonal: "#d3f9e3"
      mint-tonal-hover: "#bff3d6"
      mint-line: "#068758"
      mint-graphic: "#025c3b"
      mint-solid: "#005636"
      mint-solid-hover: "#014a2e"
      mint-ink: "#014a2e"
      on-mint: "#fefeff"
      violet-tonal: "#f0ebff"
      violet-tonal-hover: "#e6dffe"
      violet-line: "#7b5abf"
      violet-graphic: "#5b24a7"
      violet-solid: "#5616a4"
      violet-solid-hover: "#4c0195"
      violet-ink: "#4c0195"
      on-violet: "#fefeff"
      teal-tonal: "#d4f7f6"
      teal-tonal-hover: "#c0efef"
      teal-line: "#0e8283"
      teal-graphic: "#02595a"
      teal-solid: "#005354"
      teal-solid-hover: "#004748"
      teal-ink: "#004748"
      on-teal: "#fefeff"
      sky-tonal: "#dff2fe"
      sky-tonal-hover: "#caeafe"
      sky-line: "#217aa7"
      sky-graphic: "#015477"
      sky-solid: "#004e6f"
      sky-solid-hover: "#004260"
      sky-ink: "#004260"
      on-sky: "#fefeff"
      amber-tonal: "#ffebd2"
      amber-tonal-hover: "#ffdfb6"
      amber-line: "#996605"
      amber-graphic: "#694400"
      amber-solid: "#624001"
      amber-solid-hover: "#543600"
      amber-ink: "#543600"
      on-amber: "#fefeff"
      coral-tonal: "#fee9e7"
      coral-tonal-hover: "#ffdbd8"
      coral-line: "#b74846"
      coral-graphic: "#940018"
      coral-solid: "#8a0016"
      coral-solid-hover: "#780011"
      coral-ink: "#780011"
      on-coral: "#fefeff"
      terminal-bg: "#f5f5f5"
      terminal-fg: "#000000"
      terminal-dim: "#404040"
      terminal-accent: "#00632f"
  high-contrast-dark:
    colors:
      plane-chrome: "#020204"
      plane-canvas: "#050608"
      plane-raised: "#0b0d11"
      plane-hover: "#14161a"
      plane-selected: "#1d1f24"
      plane-inverse: "#fdfdff"
      line-divider: "#606369"
      line-subtle: "#9b9fa5"
      line-field: "#b3b8be"
      ink: "#fdfdff"
      ink-secondary: "#dbdee3"
      ink-tertiary: "#c0c4cb"
      ink-inverse: "#020204"
      focus: "#a5cdb5"
      scrim: "rgba(2, 2, 4, 0.72)"
      selection: "rgba(165, 197, 254, 0.32)"
      green-tonal: "#021f10"
      green-tonal-hover: "#022a17"
      green-line: "#428d65"
      green-graphic: "#a5cdb5"
      green-solid: "#aed3bc"
      green-solid-hover: "#c3ddcd"
      green-ink: "#cee3d6"
      on-green: "#010202"
      mint-tonal: "#002212"
      mint-tonal-hover: "#002c1a"
      mint-line: "#2c9667"
      mint-graphic: "#57e2a2"
      mint-solid: "#4deba5"
      mint-solid-hover: "#62f8b2"
      mint-ink: "#75fdbb"
      on-mint: "#020204"
      violet-tonal: "#1e1236"
      violet-tonal-hover: "#291847"
      violet-line: "#896bcb"
      violet-graphic: "#c9b7fe"
      violet-solid: "#cfbffe"
      violet-solid-hover: "#dbcfff"
      violet-ink: "#e1d7ff"
      on-violet: "#020204"
      teal-tonal: "#002020"
      teal-tonal-hover: "#002a2b"
      teal-line: "#329091"
      teal-graphic: "#5edadb"
      teal-solid: "#55e3e4"
      teal-solid-hover: "#68f0f1"
      teal-ink: "#7bf5f6"
      on-teal: "#020204"
      sky-tonal: "#001d2e"
      sky-tonal-hover: "#00283c"
      sky-line: "#3a89b4"
      sky-graphic: "#7fcffe"
      sky-solid: "#8ed4ff"
      sky-solid-hover: "#aedffe"
      sky-ink: "#bce5fe"
      on-sky: "#020204"
      amber-tonal: "#281700"
      amber-tonal-hover: "#341f00"
      amber-line: "#ab7312"
      amber-graphic: "#ffb33c"
      amber-solid: "#febd5e"
      amber-solid-hover: "#ffce8d"
      amber-ink: "#fed7a3"
      on-amber: "#020204"
      coral-tonal: "#330b0b"
      coral-tonal-hover: "#430f10"
      coral-line: "#c55a57"
      coral-graphic: "#feaba5"
      coral-solid: "#feb5af"
      coral-solid-hover: "#fec8c4"
      coral-ink: "#fed2ce"
      on-coral: "#020204"
---

# YCoding Web design

## Overview

The public site and the enrolled-machine workspace share the Instrument palette, Geist prose, JetBrains Mono metadata, and plain YCoding wordmark. Instrument owns the color roles, planes, radii, the remote shell chrome (labeled activity bar, Session list column, status bar) and the running trace; page content composition follows Stitch `projects/10627183425669399580`; `.stitch/DESIGN.md` indexes the inspected sources. Settings uses `90ef806b96884717a9403ab5092cd412` for stacked sections and `a2e160a2713f41bfa82e1d55132018c5` for the neighboring phone filter sheet. Team uses `e913f34cc3c04b7983000a381da06cf7`; coordination uses `b8ac4f46a3b547bfbc1d8589d6cd785a` and the layout in the local HTML export of `e60b24bb256b42048b498ac92f47139f`. That last export supplies structure, not a verified raster comparison. Neither the Desktop project nor its local controls govern Web.

`src/styles/tokens.css` implements the base and dark values in this front matter; `src/theme/schemes.ts` owns alternate palettes. Light and alternate themes are native product variants. They are not claimed as directly observed Stitch variants. The bidirectional drift test compares base and dark roles, alternate palettes, and the reduced-motion mapping.

## Principles

- Use the source for composition and the Web tokens for executable type, color, spacing, and density.
- Lay out reported state and real actions. Open records use space and tone, not a frame for every row.
- Keep names, focus, and touch targets through wrapping and reflow. Distinguish loading, absent, failed, and unknown values.
- Keep a source export, a rendered fixture, a technical check, and visual acceptance separate.

## Rules

R1–R12 apply with their stated surface scopes. Each Web rule states its current visual, functional, authorization, data, accessibility or Office contract. W105 binds source provenance and native capability boundaries.

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| W1 | approved | Web CSS MUST use the declared `--yc-*` theme roles and fixed breakpoint steps; documented base and dark token values MUST agree with `tokens.css`. | `src/styles/design-md.test.ts`, `src/styles/tokens.test.ts` |
| W2 | approved | Primary actions MUST use `--yc-green-solid` and `--yc-on-green`, NEVER a status or foreground role for the surface; normal-size labels MUST reach 4.5:1 in both themes. | `src/styles/contrast.test.ts` |
| W3 | approved | Dense controls MUST become 44px on coarse pointers; gutter/display overrides MUST follow the steps below rather than viewport interpolation. | `src/styles/tokens.test.ts` |
| W4 | approved | Loading placeholders MUST wait 140 ms, reserve region-specific geometry, and remain static under reduced motion. | `verify/loading.integration.test.ts` |
| W5 | approved | The Running and recent carousel MUST reserve its initial height and show at most ten roots; it and the Session list MUST order waiting families first, then running families, then the rest, with descending reported activity time within each group, using updated time only when activity is unreported and a stable Session ID tie-break. Waiting means attention outside the failure-only and loss-only subsets; Running excludes Waiting, and Idle excludes both and archived Sessions. The Session filters MUST read All, Waiting, Running, Idle in that order. Waiting carousel cards MUST say Waiting for you using the attention ink and dot, and each card MUST expose its status as an accessible description. A failed Waiting read MUST report its unavailability without blocking Running and recent cards. Pins MUST NOT override that activity order. Status and activity updates MUST refresh order without clearing resident rows, and a refresh of a ready Session list MUST NOT show it as loading. Active cursors MUST bind to an ordering epoch and reject changed membership or sort keys instead of silently skipping or repeating roots. The browser MUST retain its rows until a complete bounded window around the visible anchor settles, then replace that window atomically; previous and next cursors MUST keep roots moved outside that window reachable. Restoration MUST resolve an interior anchor through the virtualizer's key and measurement, render it outside overscan when needed, then correct its viewport offset without changing focus. A failed anchored refresh MUST preserve the ready list, connection, and cursors and report its failure in a named Session list status region using the existing panel-note treatment; an unsupported anchor-field rejection MUST identify the machine update required, without an alternate request path. A missing anchor starts at the first page. Pagination MUST follow the same sort keys; carousel pagination appears only on overflow. A mouse MUST be able to drag the rail (pan cursor at rest, panning cursor and no snapping mid-drag, a press that travels under 6px stays a click, and a drag release MUST NOT open the card under the pointer); a pointer click MUST NOT leave a focus ring on the opened card while keyboard focus keeps the ring. | `verify/running-sessions.integration.test.ts`, `verify/remote-inventory-feed.integration.test.ts`, `test/remote-activity-order.test.ts`, `test/remote-carousel.test.ts`, `test/remote-session.test.ts`, `test/remote-speed.test.ts`, `src/remote/view-model.test.ts`, `src/remote/ui/remote-redesign.test.ts`, `../../packages/cli/test/remote-operations.test.ts`, `../../packages/remote/test/contract.test.ts` |
| W6 | approved | User transcript bubbles MUST be right-aligned; assistant content MUST remain left-aligned, and history paging MUST preserve the visible row. Streaming Markdown MUST retain blocks and inline nodes while their position and semantic kind stay unchanged; growing content MUST remain live without remounting code controls or losing focus. Background snapshots, unchanged todos, and captured-file rereads MUST preserve the reader's message anchor and deliberate scroll-up; captured paths MUST retain their row, expansion, and focused control while refreshed counts and patches remain live. Latest-follow MUST still track real content growth. | `verify/transcript.integration.test.ts`, `verify/transcript-stability.integration.test.ts` |
| W7 | approved | The shared foundation MUST unconditionally own `scrollbar-width`, `scrollbar-color` and WebKit scrollbar parts for every scroll region, including the document, transcript, rail, companion, Team inspector, command and picker lists, sheets and machine cards. Standard scrollbars use thin width and `--yc-line-field` on a transparent track. Engines supporting the owned WebKit parts MUST reset the competing standard properties to auto and use a 12px gutter, transparent track and corner, no arrow buttons, and a pill thumb 4px wide at rest in `--yc-line-field`, widening to 8px on hover in the same `--yc-line-field` and on drag in `--yc-focus`; every thumb state keeps 3:1 against each plane and the terminal plate. Coarse pointers retain that ownership; forced colors MUST use CanvasText/Canvas system inks and automatic width. Engine and operating-system overlay visibility remains platform-controlled. From 768px with a fine pointer, primary scroll regions MUST reserve the gutter so overflow never shifts content, and Conversation rows outside the scroller MUST stop at the scroller's content edge while full-width bands reach the window edge. | `verify/scrollbar.integration.test.ts`, `src/styles/composition.test.ts`, `src/styles/contrast.test.ts` |
| W8 | approved | Popovers MUST appear beside their triggers without losing focus return, including portalled ones; sheets/dialogs MUST keep keyboard focus contained. | `verify/status-panel-motion.integration.test.ts`, `verify/composer-controls.integration.test.ts` |
| W9 | approved | The public hero MUST stay neutral in both themes with no ambient glow; the hero sits on the plain `--yc-plane-canvas`. The light composer capsule MUST keep its `--yc-line-field` outline, and content-level neutral controls, picker outlines and fields MUST keep boundaries of at least 3:1 against every plane they sit on, except the transparent desktop composer metadata selectors. Ghost icon actions in the conversation header and composer dock MUST identify by icon ink of at least 3:1, show a tonal fill on hover, and use the `--yc-focus` ring (W30). | `verify/light-office.integration.test.ts`, `src/styles/contrast.test.ts`, `src/styles/composition.test.ts` |
| W10 | approved | On a tall viewport, the landing hero MUST absorb spare vertical space while keeping its content centered; the capabilities section MUST meet the footer without a blank band in either theme. On short viewports, content MUST keep its natural height and remain scrollable. | `verify/light-office.integration.test.ts` |
| W11 | approved | Settings MUST show the browser or installed-app mode in an App section; show Install App only when native install is offered or supported Apple manual steps apply. Manual instructions MUST use the shared modal as a compact dialog on desktop and sheet on phones, without mimicking platform UI; closing MUST return keyboard focus to the action. | `src/pwa/install.test.ts`, `verify/pwa-install.integration.test.ts` |
| W12 | approved | The Sessions page MUST own its repository filter through the Workspace selector at every width. Its options MUST remain within the visual viewport, scroll when necessary and keep the keyboard-selected option visible. Choosing a repository MUST retain the existing filter operation, loading/error states and focus return; the global Session rail MUST remain present (W46). | `verify/workspace-scroll-cue.integration.test.ts` |
| W13 | approved | Every modal sheet or dialog MUST have exactly one named close control at the end of its owning header; the shared `Modal` owns that control in `.overlay__head`, so embedded panel headers MUST NOT repeat the title or close. A standalone panel owns its own title and close. Team places its active count beside that sole title, pads the sheet body by `--yc-space-4`, and scrolls the body with Load older after the task cards in flow. The close target MUST be at least `--yc-hit-min`, and Escape MUST dismiss with focus returned to the trigger. Pointer-opened selector sheets MUST keep the close icon free of an automatic focus outline without blurring it; keyboard activation and subsequent keyboard navigation MUST retain the existing visible focus treatment. Unknown activation and forced-colors rendering MUST retain visible focus. | `verify/team.integration.test.ts`, `verify/modal-close.integration.test.ts` |
| W14 | approved | Settings → Office MUST render only when the shell can show Office, using its phone-layout state. The Notifications table MUST keep channel headers on one line at phone width, center switches under their headers, and contain any horizontal overflow within its own scroll region. | `verify/remote-fidelity.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W15 | approved | Office MUST allocate height after visible shell notices, keep its controls and roster reachable, and fit the entire floor. Zoomed views MUST support drag, two-axis wheel/trackpad and focused arrow-key panning within floor bounds. Manual panning MUST suspend following without changing Session selection; browser zoom gestures MUST retain their ordinary behavior. | `verify/office.integration.test.ts`, `verify/office-engine.integration.test.ts` |
| W16 | approved | Setting a goal MUST NOT disable or block the composer: submitting releases the draft at once, one goal request per Session is in flight, and a second `/goal` is refused with its text kept. The Goal control MUST show one Setting goal indicator — a compact `Goal…` label over a dot trail drawn inside the existing Goal control, which keeps its idle box and hides its idle label while busy — together with the Goal control marked busy and named Setting goal and an always-mounted polite live region announcing it. The indicator MUST be contained in the Goal control's unchanged box at every width, so no other control, chip, or row changes size or position between idle and busy. Mode chips MUST retain readable full words under W65, never clipped bars or category codes. Reduced motion MUST remove its entrance and dot animation. A failed or uncertain request MUST return `/goal <text>` to an empty draft with its outcome toast. | `verify/composer-controls.integration.test.ts`, `test/remote-session.test.ts` |
| W17 | approved | The monthly provider distribution MUST expose one accessible legend list whose entries each show the provider, its share, and its exact value in the selected Spend or Tokens metric; it MUST NOT add a second visible table or a View table control. The total and its metric unit MUST sit inside the donut's hole, with their combined rendered text width and height contained by the hole's inscribed circle so neither text overlaps the ring. Keep the exact total in the total's accessible name and title for assistive technology, hover, and keyboard focus; when its rendered width does not fit the hole at the actual chart size, display one decimal with a lowercase k, m, or b suffix (preserving the `$` prefix for money), while values that fit remain exact. Re-evaluate fit when the value, metric, font, or chart size changes. The total, provider names, and exact legend amounts MUST stay inside their card at phone, tablet, and desktop widths. Missing values MUST render empty (never zero or a placeholder), each metric MUST keep its own unit, and switching Spend and Tokens MUST keep the selection and its unit. It uses the existing chart, text, and border tokens with no palette change; the daily chart keeps its own table. While the monthly distribution loads below 1280px, where its body is stacked, its placeholder MUST reserve 400px for the chart, total, and legend; from 1280px, where the body is side by side, it keeps the 280px reserve, and no other chart or the shared loading placeholder changes. | `verify/usage-page.integration.test.ts`, `src/remote/ui/usage-model.test.ts` |
| W18 | approved | Composer suggestions MUST use one anatomy at every width: a panel anchored above the composer field with a visible header titled Suggestions and a named Close control, over one scrolling listbox of options. The panel MUST be bounded by the visual viewport: never taller than the space between the field and the top of the workspace scroll region or visual viewport, and below 768px never taller than 75% of the visual viewport height (above 768px, 40% of it or 360px), and never shorter than its 54px header, so Close stays reachable, while an on-screen keyboard cannot leave the panel covering the app or the field. The panel MUST be measured again when the visual viewport resizes or scrolls and when the draft changes, and Arrow-key and typing changes MUST keep the active option visible inside the list. Close and Escape MUST dismiss it and return focus to the field; an outside press MUST dismiss it without taking focus, so the pressed control keeps its focus and its action. Every dismissal MUST leave the draft unchanged, and a dismissed token MUST NOT reopen until its text changes or the cursor moves to another token. A failed file search MUST show the same panel with its error and no options, and MUST dismiss the same way. Choices, file search, and selection MUST behave as before. | `verify/composer-controls.integration.test.ts`, `src/remote/ui/composer-logic.test.ts` |
| W19 | approved | Jump to top and Jump to latest MUST share one anchored pill at the conversation column's end edge. Below 768px reserve a row for the pill; at wider widths it floats without a layout row. The pill MUST sit above the Todo panel, composer, and pending decisions without covering them, MUST leave the last transcript content reachable by scroll clearance, MUST appear only while a jump is possible, and its targets MUST be at least 36px, 44px on coarse pointers. Follow and jump behavior MUST be unchanged; reduced motion MUST remove its transition. The Sessions screen MUST show the same pill with only Jump to top, at the Sessions content's end edge above the bottom navigation, while that screen is scrolled from its top; the pill MUST NOT show a Jump to latest there, and a Conversation pill MUST NOT show while another screen is active. | `verify/transcript.integration.test.ts`, `verify/remote-navigation.integration.test.ts`, `src/styles/composition.test.ts` |
| W20 | approved | The Edited files card MUST be one collapsible summary at every width: a single header control with icon, title, totals, and chevron, named with its full counts, collapsed by default in one row. Expanding MUST list every file with its counts and its full path as the accessible name, each file expanding to its own diffs, side by side from 768px and unified below. Each prompt-to-next-prompt unit with completed edits MUST have its own card after that unit's last assistant message, with one row per path whose counts sum only that unit's recorded patches and its exactly claimed child stretches; totals MUST NOT carry into a later unit's card, and a card MUST NOT be replaced by a ledger or recovery summary. While the Session runs, only the latest unit's card MUST be hidden. Counts, provenance, and empty or unavailable states MUST match the diffs shown. | `verify/file-change-card.integration.test.ts` |
| W21 | approved | Team MUST be one compact icon control with its active count, named Open Team, beside Notifications in the header at every width. It opens the same Team panel or sheet and returns focus to itself. No Team bar or row exists; the Conversation and Office switch appears when Office is shown. | `verify/team.integration.test.ts`, `verify/modal-close.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W22 | approved | Selecting Sessions, Usage, or Settings from another screen MUST show that screen at its top; entering Conversation MUST show the latest message and resume following. Each position MUST be in place before the entering screen is first painted visibly. Streaming text or progress MUST NOT override a reader's deliberate wheel, touch, or keyboard scroll-away, including small gestures near the bottom; resume following only at the actual bottom or through Jump to latest. Filters, paging, and switching the selected Session inside a screen MUST NOT arbitrarily reset its scroll. | `verify/remote-navigation.integration.test.ts`, `verify/conversation-reading.integration.test.ts`, `verify/reader-keyboard.integration.test.ts` |
| W23 | approved | Office MUST NOT show an unexplained empty floor while the selected family's team and activity inputs load: an initial-loading indication MUST be visible and named, a selected Session whose team has not been read yet counts as loading, and unsupported, error, and offline states MUST settle explicitly. The loading placeholder MUST reserve its geometry immediately and show its notice only after 140 ms measured from renderer readiness. Once the initial reads settle, existing members MUST appear directly at their reported workstation or lounge spot with no entrance animation; only a genuinely new arrival on an already-ready floor uses the entrance. Background refreshes MUST preserve the current actors and positions, and after first hydration a background snapshot whose required inputs are still loading MUST be ignored rather than retarget seated members. Backend-confirmed idle members MAY use finite desk-rest, pantry-stop, seated-rest and table-play sequences with identity-varied dwell times and existing poses, with no new art asset. Each destination MUST have one claim; agents MUST perform only after arrival and return or choose another free rest after a bounded dwell. Decorative actions MUST create no tool, task, speech or schedule labels and MUST NOT persist. Reduced motion MUST stop every sprite animation and show one fixed state-appropriate frame. A backend non-idle, attention or unavailable fact MUST clear decorative trips and gestures on the next applied snapshot; corroborated handoff feedback MUST retain its separate ownership. | `verify/office.integration.test.ts`, `verify/office-engine.integration.test.ts`, `src/remote/office/director.test.ts`, `src/remote/office/model.test.ts` |
| W24 | approved | Transient popups MUST appear only for failed or unknown mutations and for notices that carry actual failure evidence; a successful send, ordinary status, approval, and offline change MUST NOT raise a popup. The notification center, its unread badge, actionable cards, and OS channels remain separate and unchanged by this rule. A failed or unknown popup keeps its safe retry, manual dismiss, six-second expiry, hover and focus pause, and MUST NOT cover the header. A model-selection `outcome_unknown` MUST remain unknown rather than failed. A fresh read from the same connection and selected Session MAY confirm the exact provider, model, variant, and profile without replaying the switch; an unchanged explicit profile selection MUST NOT prove a profile rebind. A submitted prompt MUST show one static, named receipt beneath its bubble for sending, failed, unknown, queued, processing, sent, or read state. Sending covers an optimistic local submission until admission; an admitted steer and the latest user prompt while the Session is running show Processing, including after promotion or consumption; a queued input stays Queued until promotion; idle, failed, and interrupted Sessions show Sent or Read. The receipt MUST NOT add an animation beside its text, including when reduced motion is requested, and MUST retain its bubble geometry and composer focus. An older pending-input read MUST NOT remove a submission outstanding at read start or a submission or live admission received during that read, even after acknowledgement. Promotion MUST keep one bubble with the same message identity. Backend consumption takes precedence over a late send acknowledgement. | `verify/prompt-feedback.integration.test.ts`, `verify/pending-input-visibility.integration.test.ts`, `test/remote-session-send.test.ts`, `verify/remote-shell-layout.integration.test.ts`, `verify/notifications.integration.test.ts`, `verify/composer-controls.integration.test.ts`, `src/remote/view-model.test.ts` |
| W25 | approved | Session companion Activity MUST show Shell processes, Subagent tasks and Side chats as directly visible headed sections with counts, without a duplicate context summary. Each task row shows a status mark, title, and model, over four usage slots in fixed order — Tokens (inclusive), Cost (inclusive), Context with a meter, and Cache — where a slot still loading, one reported as unreported, one with a value, and a Tokens or Cost slot on a connector without task costs (stating `Update YCoding`, never a bare dash) are four distinct states and unreported is never shown as zero; the Tokens and Cost labels stay on one line and the slot columns give them the wider tracks; and compact named controls (Open, Cancel, Answer) sized by `--yc-control-h-dense` (36px, and 44px on coarse pointers) with no size outside the declared tokens. Within a section, task rows reserve at least the first-load placeholder's 138px height, keep launch-time order, and MUST NOT reorder or resize when a status, usage value, or count changes. Only the first load shows a placeholder; refreshes and reconnects MUST retain rows, and older pages load through one compact Load older row after the last card. W13 still governs the sheet's single title, count, and close. | `verify/team.integration.test.ts`, `verify/loading.integration.test.ts`, `verify/modal-close.integration.test.ts`, `test/remote-team.test.ts`, `src/remote/ui/team-model.test.ts` |
| W26 | approved | The selected-subagent context bar MUST use one anatomy across widths and remain compact by default: agent identity, a status mark paired with its status word (unreported states say so), named icon-only Main session, Previous subagent, and Next subagent navigation, and a named Subagent details icon. Navigation and details MUST retain owned focus, keyboard activation, and `--yc-control-h-dense` targets (36px, 44px on coarse pointers); absent siblings stay present but disabled. At narrow widths, whole header groups may wrap, but navigation buttons MUST NOT wrap or shrink their touch targets. The details action MUST lazily mount description, Model, Tokens (inclusive), Cache (hit share with read and write counts), Cost (inclusive), Context (total over limit), a status line asking for `Update YCoding` when the connector reports no task costs, and the full parent title inside the existing shared Modal: a phone bottom sheet or desktop dialog with one Subagent details title, one owned Close control, Escape, trapped focus, and focus return. Details MUST retain every reported value, wrap without horizontal overflow, and never show an unreported value as zero; they MUST NOT expand inline and consume transcript height. Closed details MUST remain unmounted; the shared Modal owns normal/reduced-motion entry, inert exit, and focus semantics. Selection changes MUST dismiss the previous Session's details. A waiting answer form MUST remain outside the Modal and directly actionable. The closed phone bar MUST leave a usable transcript rather than show all descriptive and usage rows by default. In Office, the Conversation and Office switch MUST pair an icon with each label in one segmented control of at least `--yc-hit-min` height, keep its sliding selection and waiting-decision mark, and stay reachable by arrow keys. Reuse existing tokens and the shared icon set. | `verify/team.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts`, `verify/office.integration.test.ts`, `src/remote/ui/subagent-bar.test.ts` |
| W27 | approved | Settings → Machine MUST show one Keep machine awake row after the picker: a named switch for the manual preference, an effective-state text label (On, Off, Checking, Unavailable, Unsupported, Error), and one polite status region with idle/lid parts, defer hold, and the reported system-sleep control (`system`: off, on, held, setup, unsupported, error; absent from older connectors and then omitted). Keep the full macOS safety explanation visible on wide layouts. On phone layouts, show the battery and heat caution alongside status and keep the same full explanation in a collapsed-by-default, named `Keep-awake safety details` disclosure (W95). Its control MUST expose its expanded state and controlled region, keep keyboard focus, and never change the switch or send a keep-awake request. A deferred family holds effective On even when the switch is unchecked; expose lid errors without claiming lid control; system `on` MUST state that a closed lid on battery stays awake until the battery dies and Sleep does not sleep, `setup` MUST name `ycoding keep-awake setup`, and system `error` MUST use the attention tone with an alert. Keep older connector status readable and label missing lid state unreported. Disable unknown, unsupported, unreachable, older, silent, or failed reads with explicit reason/Retry, never false Off. Disable changes in flight, retain reported state on failure, and reconcile an unknown outcome once without replay. Reread on Settings open or machine change; never remember machine preference or use a browser wake lock. Reuse `.defs__row`, `.switch`, `.field__hint`, `.button--secondary`, and `--yc-coral-ink`/`--yc-amber-ink` tones. | `src/remote/keep-awake.test.ts`, `test/remote-keep-awake.test.ts`, `verify/keep-awake-settings.integration.test.ts` |
| W28 | approved | A guardrail request returned for the selected family MUST be answerable from that view using family authorization, not an owner-Session equality check. Show its owner and escaped inspectable action/targets; missing context disables approval and leaves Reject. Hard reviews MUST show the Hard review badge, Approve once, and Reject without Always. A pending hard request MUST head `Guardrail review (hard review)` and MUST show only the authorized typed actions available under current policy; the browser MUST NOT infer or synthesize a decision from category mode. An escalated guardrail or permission request MUST identify its handoff in the existing request-note treatment with the canonical decisionReviewText output and the typed actions currently available, beside any queued prompt and without a generic stuck state, while preserving the request's authorized typed actions; a failed, refused, invalid, or unsupported-route decision names its fixed reason and the manual action (an unsupported strict structured-output route also names configuring a supported decision helper) and shows no invented choice or confidence: a recorded decision failure reads Decision unavailable with its fixed diagnostic reason and NEVER as a model escalation, a valid model escalation retains its reported choice and unrounded confidence, and a historical escalation with no recorded reason reads that the diagnostic reason was not recorded without an invented choice or confidence. Its durable escalation notice MUST render chronologically through the existing System-message treatment with that same canonical text; restart retains that notice but no interrupted request or action. Settled guardrail rows MUST use collapsed-by-default `.transcript-notice` disclosures in settlement order before live requests. Expanded rows, graded escalation notices, pending escalated request cards, and review-box guardrail items MUST list Allow, Deny, Approve all, Approve, Reject, and Escalate grades as reported with unrounded confidence and literal, wrapping evidence; mark the reported choice with Selected text and the green strong border, never color alone. Absent grades MUST retain the reported choice/confidence treatment. Expanded decision-tool blocks MUST render each graded answer without selecting a null choice or hiding other tool output. Disable duplicate pending sends, retain failed/uncertain outcomes without replay, fence obsolete replies, and keep phone jump controls clear of actions. Reuse request-card, danger outline/halo, token, and focus treatments. | `test/remote-session.test.ts`, `verify/guardrail-family.integration.test.ts`, `src/remote/projection.test.ts`, `src/remote/decision-grades.test.ts`, `src/remote/ui/guardrail-label.test.ts`, `verify/review-box.integration.test.ts` |
| W29 | approved | Team activity MUST combine reported active subagent tasks and actually running shell rows, while task-tab totals stay separate. Exited, timed-out, memory-limited, or killed shells MUST NOT count as running. Until the relevant shell read settles, activity MUST remain qualified as unreported rather than claim an exact zero; truncated loaded activity MUST NOT be presented as an exact total. Canonical backend root-running state MUST drive Session running filters and carousel placement, including live background work, without inventing model execution, generation speed, or a model elapsed-start time. Preserve known activity during same-family refreshes. | `src/remote/ui/team-model.test.ts`, `test/remote-team.test.ts`, `verify/team.integration.test.ts`, `verify/running-sessions.integration.test.ts` |
| W30 | approved | Icon-bearing action controls MUST NOT use decorative hue borders, outlines, or focus halos. Their focus role MUST be the green `--yc-focus` ring (2px, at least 3:1 on every plane) with the existing outline/halo geometry, including shared buttons, Team, navigation, camera, picker and inline actions; it stays distinct from the hover plane and the selected check. Expanded Team and outlined task actions MUST use transparent or neutral borders. Pending agent/model pickers MUST retain their pending description and use a neutral border with `--yc-green-tonal` fill. Preserve semantic hue glyphs, filled primary actions, status marks, and selected-item highlights. Keyboard focus MUST remain visible; forced-colors system rendering remains the accessibility exception. | `verify/modal-close.integration.test.ts`, `verify/mobile-native.integration.test.ts`, `src/styles/contrast.test.ts` |
| W31 | approved | Cursor roles MUST be defined only by the design system's `cursors` tokens and shared foundation rules. Components MUST consume semantic roles, NEVER introduce cursor keywords, custom cursor images, or document-wide mouse-move cursor handlers. Enabled actions MUST show action, editable/selectable text text, unavailable controls disabled, and busy controls busy; background loading MUST NOT turn usable controls into unavailable cursors. Office MUST show pan on the floor, action on selectable actors, and panning during a drag, restoring the role on release, cancellation, exit, or disposal. | `src/styles/cursors.test.ts`, `src/styles/design-md.test.ts`, `verify/cursors.integration.test.ts`, `verify/office-engine.integration.test.ts` |
| W32 | approved | The conversation transcript and both Session lists (the sidebar rail and the Sessions table) MUST be windowed: only rows near the viewport (at least six rows of overscan) are mounted, keyed by message or Session ID so row identity and measured size survive prepend, trim, and reorder. Each list MUST own its scroller's `overflow-anchor` as `none`, so the virtualizer alone decides position; every scroll-position write MUST land in the same task as the DOM change that caused it, so no intermediate frame shows a shifted row. The row at the reader's position MUST keep its viewport offset (within 1px) through older-history and Session-page loading, streaming growth below or above it, and resize; while following the latest message the last row MUST stay at the bottom. Rows mounted by scrolling MUST NOT replay the entrance animation. Windowed rows MUST render with the same classes and tokens as unwindowed rows, keep keyboard focus mounted, and expose position (`aria-posinset`/`aria-setsize` on the sidebar list, `aria-rowindex`/`aria-rowcount` on the Sessions table). Smooth scrolling MUST respect reduced motion. | `verify/transcript-stability.integration.test.ts`, `src/remote/ui/virtual-rows.test.ts` |
| W33 | approved | A remote route MUST paint its page frame or its loading placeholder within two frames of navigation and MUST NOT leave the active route panel empty while its reads load; a revisit while its reads are fresh, or after hovering its navigation link, MUST show the cached content on the first frame. While a connection's first Session list loads, the Conversation route MUST show the screen loading placeholder, never the New-session composer. It reuses the existing loading placeholder (W4) with no new token or component. | `verify/remote-transitions.integration.test.ts`, `src/remote/ui/route-panel.test.ts`, `src/remote/queries.test.ts` |
| W34 | approved | Sending MUST release the submitted draft without waiting for network acknowledgement and MUST keep the composer editable. Correlated failures and retries MUST retain the submitted input without erasing a newer draft. Agent/model catalog failures MUST show the reported reason and a named Retry agent and model catalog action using the existing field-hint and secondary-button treatments; Retry MUST target the same Session or repository and restore both selectors on success. Unsupported catalogs MUST state that the connected machine needs updating. | `verify/composer-controls.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts`, `test/remote-session-send.test.ts` |
| W35 | approved | New chat at `/remote` MUST open a standalone draft paired directly with the compact, neutral repository selector and refresh action aligned at the composer's start edge, keep the composer card and submit control visually primary, keep the required-repository state unmistakable through accessible labeling (`aria-required`, `aria-describedby` pointing at the helper line, the compact neutral `Required` badge, and the helper line) without a filled hue trigger or hue border, draw the green `--yc-focus` ring with a 2px offset on `:focus-visible`, ship no invented draft text, show one truthful helper line with no contradictory optional/required copy, and use the compact phone composer summary so compose and send stay prominent. Session detail at `/remote/session` MUST show the selected transcript with its Session and device IDs in the URL. Its title and Back to Sessions action MUST stay pinned above the scrolling transcript, and a selected Session MUST remain reachable through a contextual Resume session action outside primary navigation. A workspace's plus action MUST record its workspace and source in the URL and lock that repository; an unavailable origin MUST block creation instead of choosing another repository. Navigation MUST NOT create a Session or discard the selected Session's unsent draft or an interacted-with landing draft. Inactive retained content MUST be inert and non-painted. Uncertain creation MUST retain attachments; successful creation releases the submitted landing. Sidebar collapse and resize MUST retain the reader's anchor within 1px; focus handoff MUST NOT scroll either viewport. | `verify/workspace-shell.integration.test.ts`, `verify/conversation-reading.integration.test.ts`, `verify/new-session.integration.test.ts` |
| W36 | approved | The main transcript MUST show human-facing question text and recorded answers without opening a completed tool disclosure; pending, cancelled, and failed questions MUST retain truthful state. A parent Conversation MUST expose its pending direct child questions with the existing Team answer form and request-card anatomy. Team and Conversation MUST share the owned answer operation, reject duplicate in-flight answers, retain family ownership checks, and NEVER automatically replay uncertain mutations. Reuse request header/body/action classes, Markdown, shared field/button tokens, and existing Team focus treatment; NEVER invent API or durable producer fields. | `verify/conversation-questions.integration.test.ts`, `src/remote/question-history.test.ts`, `test/remote-child-question.test.ts` |
| W37 | approved | A submitted attachment upload MUST remain visible for its owning Session after the editor releases that submitted draft, including 0% before the first acknowledgement, reported chunk progress, and Cancel upload. Upload state MUST NOT appear in another Session or an inactive landing. Failed preparation MUST retain the submitted originals and prompt ID in the existing receipt with its explicit Retry send, without replacing newer editor text or attachments or automatically replaying an uncertain upload. A locally rejected oversized request MUST explain its limit without releasing the draft. Reuse the existing upload status, progress element, failure receipt, and button tokens. | `verify/upload-flow.integration.test.ts`, `test/remote-session-send.test.ts` |
| W38 | approved | Initial Sessions inventory reads MUST show named loading content in both Running and recent and the shared Session rail, NEVER an unexplained empty reserved region after the 140ms reveal. Reuse session-shaped placeholders and existing card/list tokens; expose one status per region and mark decorative duplicates hidden. Running and recent skeletons MUST follow their cards' typography- and spacing-derived dimensions, border, radius, and surface treatment without changing shared session placeholders. A populated carousel MUST retain its 196px initial reserve through settlement; background refresh MUST retain loaded cards and workspace controls without replacing them with skeletons. Empty settled inventory MUST show the existing truthful empty state. | `verify/conversation-reading.integration.test.ts`, `verify/running-sessions.integration.test.ts` |
| W39 | approved | Settings MUST show a locally held, bounded latency report and an explicitly read, paged report of the selected machine's SQLite samples received within seven days. Both MUST contain only fixed remote operation names, outcome categories, request queue and send-to-settlement durations, and browser long-task durations when supported. The report MUST distinguish queued time from settlement time, state that settlement time includes relay, network, and backend work or a timeout/close, and never imply it measures DOM paint. It MUST omit payloads, identifiers, URLs, errors, and long-task attribution. Local Copy and Clear MUST use the owned `.button`, `.textarea`, and Settings section treatments, remain keyboard operable, and distinguish clearing this tab from persisted rows. Stored reads MUST show loading, empty, unavailable, unsupported, and failure states without claiming unknown values are zero; an earlier machine's result MUST never paint after a switch. | `src/remote/transport.test.ts`, `test/remote-session.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W40 | approved | The existing Choose model list MUST put recent valid model choices first, then models from the currently selected provider, followed by remaining provider groups in stable order. Recent choices MUST identify their provider when displayed outside a provider group, omit models unavailable in the current catalog, and never duplicate a model in a provider group. Search MUST retain all matching models and keyboard selection; changing a Session or selected machine MUST NOT silently change its model to match display order. Reuse the existing picker heading, group, option, focus, and selected-row treatments without adding a new token or dialog. | `src/remote/ui/composer-logic.test.ts`, `verify/model-replay.integration.test.ts` |
| W42 | approved | Color schemes MUST layer on the light, dark, and system preference as a second stored choice (`ycoding.theme-scheme`): Default, One Dark, One Dark Pro, and High contrast. A scheme is a base16 palette per mode mapped by one function to the semantic color tokens, so adding a scheme adds a palette object and no CSS; `data-theme` MUST remain the resolved light or dark mode and `data-scheme` the painted scheme. One Dark Pro has no light palette and keeps the default light theme. Under System with the Default scheme, a system request for more contrast (`prefers-contrast: more`) MUST paint High contrast; an explicit scheme is never overridden. High contrast MUST hold body text, secondary and tertiary ink, accent, warning, and danger ink to 7:1 on every page surface and soft fill, and its primary label, boundaries, and focus to 7:1, 4.5:1, and 4.5:1. Every other scheme MUST meet the Default theme floors. The stored scheme MUST paint with the first frame from a style tag generated from the palettes, and the theme-color tags MUST follow the painted scheme. | `src/theme/schemes.test.ts`, `src/theme/theme.test.ts`, `src/styles/contrast.test.ts`, `src/styles/design-md.test.ts` |
| W41 | approved | Below 768px the agent picker, the model control, the Agent and model sheet, and other modal sheets and dropdowns MUST open as content-sized sheets: a fixed header with the title and a named Close control, the search field when the picker is searchable, and one list. A sheet MUST use `block-size: auto` and a `max-block-size` of the visual viewport (`offsetTop` and `height`, `100dvh` when unreported) minus safe-area insets, anchored to the visual viewport's block end, and MUST NOT stretch to fill that viewport or use `100vh`. Option and control rows MUST use `--yc-hit-min` and `align-content: start`; they MUST NOT grow to fill leftover space. Content past the maximum MUST scroll inside the list while the header stays put. The sheet MUST follow visual-viewport resize and scroll so it stays above an on-screen keyboard. A sheet MUST be `aria-modal`, move focus inside on open (the search field, else the list or first control), keep Tab and Shift+Tab inside, close on Escape and Close, and return focus to its trigger. Escape MUST close only the innermost sheet. A breakpoint change MUST close an open or closing sheet, clear its search query, and leave the next open clean. Exit motion MUST reuse the existing sheet exit and drop under reduced motion. | `verify/composer-controls.integration.test.ts`, `verify/custom-select-fullscreen.integration.test.ts`, `src/styles/composition.test.ts`, `src/remote/ui/composer-logic.test.ts` |
| W43 | approved | The remote workspace MUST offer one command palette through its named header control, Ctrl+K or Cmd+K, and Ctrl+P outside text fields; Cmd+P MUST retain browser printing. Place its header control before the adjacent Team and Notifications pair required by W21. Show supported actions for the current view and connection state, grouped under Session, Commands, Skills, Navigation, Settings, and Account, with a relevance-ranked list during search. Search MUST match slash names and skill IDs. Keep focus in the modal; arrows, Home, End, and Enter navigate and select, and Escape or Close returns focus to the opener. Argument-taking actions MUST preserve the existing draft and focus the composer. Below 768px and on short coarse-pointer screens, size the sheet to its content up to the visual viewport, keep option rows at `--yc-hit-min` without stretching them, and scroll the list inside that maximum; use existing overlay, input, list, focus, and motion tokens. | `verify/command-palette.integration.test.ts`, `src/remote/ui/command-palette-model.test.ts`, `src/styles/command-palette.test.ts` |
| W44 | approved | Shared dropdown selectors below 768px MUST open as content-sized bottom sheets: `block-size: auto`, anchored to the visual viewport's block end, with `max-block-size` of that viewport (`offsetTop` and `height`, `100dvh` when unreported) minus safe-area insets. Lay out the grab handle, fixed-height heading, subtitle, option list, optional footer, and Confirm Selection in that order, with the heading directly below the handle. Option rows MUST use `--yc-hit-min` and `align-content: start` and MUST NOT stretch to fill leftover space. Content past the maximum MUST scroll inside the list while the heading and Confirm Selection stay put. The sheet MUST follow visual-viewport resize and scroll so it stays above an on-screen keyboard. Preserve staged selection, cancellation without changing the value, keyboard navigation, and focus return. Desktop selectors MUST retain anchored popovers. Reuse semantic surface, option, focus, and safe-area tokens; do not change unrelated modal dialogs. | `verify/custom-select-fullscreen.integration.test.ts` |
| W45 | approved | The model control MUST expose a compact `Profile · Default ›` row (or the full selected or unavailable profile name); its full choices MUST replace the body inside the SAME model panel, NEVER open a nested picker. Reuse option, focus, and content-sized mobile sheet treatments; offer a distinct Use provider default action only when eligible. Profile-only changes MUST remain pending until confirmed by the Session operation, preserve drafts on failure, and never activate a provider-wide profile. Unavailable saved profiles MUST remain visible with an actionable warning and block sending instead of silently changing accounts. Model, effort, and speed changes within a provider MUST retain profile identity; provider changes MUST NOT transfer a profile name. Named-profile effort choices MUST use that profile's advertised variant IDs, never another account's list. Keep account-exclusive models selectable with an eligible profile and block an ineligible provider-default selection. | `src/remote/ui/composer-logic.test.ts`, `verify/model-replay.integration.test.ts` |
| W46 | approved | The remote workspace MUST retain one shared searchable Session rail across New chat, Conversation, Projects and project context, Sessions, Workspaces, Usage and Settings. It presents New chat, Session search and the grouped Session list, without a machine footer (W96). From 768px outside the phone layout the destinations live in the labeled activity bar (W88): Chat, Sessions, Projects, Workspaces, Usage, and Settings pinned at its end. Web keeps this grouping, ordering and its breakpoints (W5, W80); it does not adopt the Desktop state groups. Project and repository controls MUST stay in their route-owned content or context panel, NEVER replace the Session list. The activity bar MUST expose Chat plus Projects, Sessions, Workspaces, Usage and Settings, and the phone BottomNav those five destinations, with correct current-page state and at least 44px targets. Phone labels MUST stay on one line at 320–430px, retaining the 12px type floor and owned 16px leading. The phone Session navigator MUST be a left-side, full-viewport-height drawer up to 320px wide, with its real searchable Session list scrolling between the header and five-destination footer. Keep New chat, Close/Escape, scrim-tap and horizontal swipe-left dismissal, overscroll containment, top/bottom safe areas, retained search/list scroll, focus containment and return. Other modal and dropdown sheets retain their component contracts. Workspaces MUST list previously opened repositories from the connected machine with loading, empty and failed-read states. The named collapse action, independent scrolling, focus and reader position remain intact. The phone-layout predicate `(max-width: 767px), (max-height: 599px) and (pointer: coarse)` owns the switch to phone navigation; New chat and safe-area behavior remain available. | `verify/workspace-shell.integration.test.ts`, `verify/remote-navigation.integration.test.ts`, `verify/new-session.integration.test.ts`, `verify/mobile-native.integration.test.ts`, `src/styles/composition.test.ts` |
| W47 | approved | Center selected Session notices, transcript, pending requests, todos, subagent bar, jump slot and composer on one track capped at 64rem. Give both sides matching insets within the available pane; at 1024px and above reserve at least 40px per side so the prompt rail fits outside the track. Treat the scrollbar gutter separately. Assistant prose, code, tools, tables and diffs MUST use the track without a nested 68ch cap. Keep user bubbles bounded and trailing. Companion docking reduces the pane width, not the shared alignment. Keep Geist Sans for interface text, JetBrains Mono for compact metadata, the full-width identity header, W99 composer reserve and full accessible model names. Fine-pointer composer controls fit one row when width permits. Route handoff and overlays retain their motion tokens and reduced-motion behavior. | `verify/workspace-shell.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts`, `verify/remote-transitions.integration.test.ts`, `verify/transcript.integration.test.ts`, `src/styles/composition.test.ts`, `src/remote/ui/transcript-layout.test.ts` |
| W48 | approved | Sessions and Usage MUST start at the workspace gutter and fill one column up to `--yc-content-max`, widening to `--yc-content-max-wide` from 1600px. W47 owns Session detail. Settings MUST center its heading and all open sections on one track capped at 64rem that shrinks to fit the viewport. Align Machine, Keep awake and preference rows to the same edges; use `--yc-measure` for explanatory prose. Keep phone sections stacked without clipping controls or making a page-wide scroller. New chat and public pages retain their own measures. | `src/styles/composition.test.ts`, `src/styles/tokens.test.ts`, `src/remote/ui/settings-layout.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W49 | approved | Machine display aliases MUST use canonical account-owned device metadata keyed by stable device ID and shared across browsers. Save through the authenticated same-origin alias endpoint for the owner's nonrevoked device; aliases MUST be trimmed, single-line, and 1–48 characters, with null clearing the alias. The UI MUST send null for empty input or the hostname, retain the draft and reported name on failure, prevent duplicate in-flight saves, and never replay uncertain mutations. Browser-local names MUST NOT be read, imported, or mapped. Apply the canonical alias to every machine display while retaining the real hostname in the Devices table, the Machine row's secondary line, and removal identification; the Machine section MUST state the account-shared scope. | `src/remote/device-alias.test.ts`, `test/remote-device-alias.test.ts`, `verify/remote-shell-layout.integration.test.ts`, `verify/machine-row.integration.test.ts` |
| W50 | approved | Session detail MUST expose one named composer-dock toggle in the dock chrome with a 44px target and owned `.button` treatment, never in the header. Collapsing MUST retain a one-row raised floating handle with the toggle; the textarea, attachments, agent/model controls and send action MUST be hidden and inert. The expanded Hide composer control MUST sit as a raised pill at the end edge beneath the floating composer card (in the coarse landscape phone layout, at the end of the single dock row). At 320px it MUST remain the same 44px pill beneath the card, keeping at least 30% of a 320×700 viewport for the transcript and the composer contained within the viewport without horizontal overflow. It MUST use the existing dock chrome and MUST NOT overlap the draft. Tab MUST reach the toggle; Escape in the collapsed handle MUST do nothing new, and no global shortcut is added. Collapse while the textarea is focused MUST focus the toggle; expansion MUST return focus to the textarea. Store the collapsed preference per browser in `ycoding.remote.composer-collapsed` using guarded localStorage access. A newly selected Session, pending permission or form request, or command-palette draft MUST expand it. The transcript MUST gain the dock's freed height while jump and todo anchoring remain unchanged; there MUST be no horizontal page overflow from 320px through 1440px or in phone layout. Height changes use `--yc-dur-base` and `--yc-ease-standard` except reduced motion, which is immediate. | `src/remote/ui/composer-dock.test.ts`, `verify/composer-controls.integration.test.ts` |
| W51 | approved | The Team Subagents list MUST group pinned direct managed children first under `Pinned`, ordered by durable pin time, then preserve existing active/inactive order for unpinned children. Each child MUST expose a named pin/unpin icon button with a 44px target; actions MUST use the closed remote pin operations and preserve backend ownership checks. | `src/remote/ui/team-model.test.ts`, `verify/team.integration.test.ts` |
| W52 | approved | An undecided connected machine MUST show one non-blocking **Help improve YCoding** card in the remote workspace, using existing surface, border, spacing, and button tokens. Its text and Agree/Not now actions MUST match the consent notice contract; the card MUST hide after a confirmed decision and while consent is unsupported, disconnected, or still unread. Settings → Diagnostics MUST keep a labeled **Save telemetry on this machine** toggle and visible mutation failure feedback. | `src/remote/ui/view-model.test.ts`, `test/remote-session.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W53 | approved | Every Office prop MUST have one stable typed entity with a unique ID, kind, readable name, room, walkable interaction spot, capacity, description, and explicit state; the catalog MUST derive from `map.ts` and loaded assets. Runtime activity alone may claim objects: reported research tools use bookshelves, edits use the actor's exclusive workstation, shell/tests use a terminal or monitor, searches use a whiteboard, thinking uses a desk, and attention raises a hand at the desk. Idle leisure remains within the established leisure rules. Capacity MUST prevent simultaneous claims; no inferred work, hidden randomness, or unsown random variation is allowed. Hover and click MUST expose a named inspect card with room, state, user, and description; Escape closes it and an accessible announcement identifies the inspected object. The canvas remains keyboard-focusable for panning, but MUST NOT expose a keyboard object list. Decorative object motion, travel, and time-of-day tint MUST stop under reduced motion; Low rendering quality MUST stop decorative animation. | `src/remote/office/entities.test.ts`, `verify/office.integration.test.ts`, `verify/office-engine.integration.test.ts` |
| W54 | approved | Usage quota refresh MUST be a fixed-size icon-only `Refresh quotas` button using the shared refresh icon, `--yc-hit-min` square target, and existing neutral button surface. It MUST retain its geometry while busy, expose `aria-busy` and stay disabled for the read's full loading state, and visibly rotate the icon; reduced motion MUST keep the busy state visible without rotation. The mobile layout MUST NOT stretch the control. | `verify/usage-page.integration.test.ts`, `src/remote/ui/usage-layout.test.ts` |
| W55 | approved | Confirm dialogs MUST use the named `.overlay--confirm` presentation and inset `.overlay__body` by `--yc-space-4` on every side. Body text and actions MUST share the header's inline inset, and actions MUST remain inside the padded body's inline and block edges. Other Modal consumers keep their owner-specific body spacing. | `verify/remote-fidelity.integration.test.ts` |
| W56 | approved | Below 1280px the workspace shell MUST read `window.visualViewport` on resize and scroll, comparing its offset and height with the layout viewport (`100dvh` when unreported). A covered inset above 80px is an open keyboard. While it is open, the app root (`.app`) MUST set `data-keyboard-open` and `--yc-keyboard-inset` to that occluded height in px; while it is closed the attribute is absent and the variable is `0px`. The shell MUST NOT also shrink its block size by that inset. The bottom Sessions/Usage/Settings bar MUST be hidden and its grid row MUST collapse so it does not sit between the composer and the keyboard. While `data-keyboard-open` is set, the composer MUST drop safe-area block-end padding and use `margin-block-end: var(--yc-keyboard-inset, 0px)` so its border box ends at the visual viewport's block end. The transcript or sheet list MUST remain the scroller; the page MUST NOT jump. At 1280px and above the shell keeps the layout viewport and does not set the attribute. | `src/ui/visual-viewport.test.ts`, `src/styles/composition.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W57 | approved | Composer desktop and phone controls MUST show the active request's estimated received-output rate when available and hide the rate while its live sample is insufficient. Without a live request, show the backend's duration-weighted aggregate of up to eight settled output samples for the selected provider/model. Retain model matching across variant/profile changes, output-free Steps and compaction, and restore earlier samples on model reselection and reload. Prefix `≈` for estimated rates. Keep existing metadata tokens and provider-counted trends. Usage labels MUST distinguish variant from profile. | `src/remote/projection.test.ts`, `src/remote/ui/usage-model.test.ts`, `verify/composer-controls.integration.test.ts` |
| W58 | approved | Usage MUST expose provider-qualified profile and model grouping, range, and selected-effort filtering without changing typed model-group identity. Use the shared named Group select for the complete grouping choice, with its contained phone sheet. Usage MUST NOT print the missing-value placeholders `unreported`, `Unknown`, `Known`, `?`, `N/A`, `Waiting`, or `Measuring`: a table cell or value with no data renders empty, a line or note whose values are all missing is omitted, a mixed line keeps only its known parts, a partial cost shows the known amount beside its priced/unpriced counts, an accessible name drops the missing phrase, and live speed shows the latest history rate (else nothing) while requests are active, keeping `Idle` when none is. Label measured generation median/p90 in tok/s with sample count and provider-timed/observed coverage; distinguish weighted throughput from request-rate percentiles and first-output latency samples. Show cache writes and priced/unpriced coverage. Preserve sorting/paging; narrow layouts MUST use wrapping details rather than clipped metric columns. An older connector's `invalid_message` for a new group, filter or time zone MUST show the `Update YCoding` state, never a generic error with Retry. W57 remains unchanged. | `src/remote/ui/usage-accounting.test.ts`, `src/remote/ui/usage-model.test.ts`, `verify/usage-accounting.integration.test.ts`, `verify/usage-page.integration.test.ts` |
| W59 | approved | The conversation transcript MUST NOT render or fetch per-prompt cost blocks, loading lines, unreported lines, or cost breakdowns beneath user messages; preserve delivery receipts, attachments, and send recovery. Prompt costs belong in Usage. Usage Prompts and Tasks views show main, children, and helpers separately, `so far` for unsettled contributors, and partial pricing (known cost plus priced/unpriced counts), unattributed, or retained-history gaps. Missing cost MUST NOT appear as zero or complete. Never transfer a pruned anchor's cost to a newer prompt. Prompts, Tasks, Team and Subagent details MUST agree for identical scopes. Recursive task rows are inclusive, not additive totals; retain W25/W26 anatomy and distinct loading/unreported/value states. Recursive task rows are labeled `inclusive` on Team cards and in Subagent details alike; a connector without task costs states `Update YCoding` there. Use existing metadata, details, border, subdued and warning tokens, with no new animation. | `src/remote/ui/conversation-cost.test.tsx`, `src/remote/ui/usage-model.test.ts`, `src/remote/ui/team-model.test.ts`, `test/remote-accounting.test.ts`, `verify/transcript.integration.test.ts`, `verify/team.integration.test.ts` |
| W60 | approved | Each quota window MUST show its reported usage and reset plus at most one concise forecast status line; provider, plan, and quota state words (stale, error, unauthorized) stay visible, and the provider header MUST show one freshness. The default status states only the outcome: `Forecast unavailable` (the raw reason lives in Details), `No increase observed` for a flat window (never unlimited), `Forecast stale`, `Forecast expired`, `Exhausted`, `Unlimited`, or `Estimated · <run-out, else projection at reset, else burn> · low or medium evidence`. A run-out at or before the forecast's own `asOf` MUST read `now`. A reported window at 100% or beyond, or with zero remaining, and a forecast in the `exhausted` state MUST take the danger role on the meter fill, used figure, and an `exhausted` pill; a missing limit or local spend MUST NOT mark a window exhausted. One keyboard-operable **Details** action per provider, named `<provider> details`, MUST open its diagnostic content in the shared `Modal` without expanding the quota card; it holds the quota source, stability, exact ISO update time, and for each window with a forecast its native-unit burn, projection, method, evidence, observation interval, exact freshness, and raw reason. Recorded consumption MUST be a separate Backend section of aligned rows (provider · model · profile, a whole or compact `tokens/min` rate where a positive rate below 1 reads `<1`, and an `est.` cost rate per hour); a missing cost rate is empty, partial pricing shows the known `est.` cost rate, and neither is shown as zero. Each row's Details action MUST open the shared `Modal` without changing row or page geometry and hold the exact rate, 5m and 60m rates, exact cost rate, priced/unpriced coverage, and observation interval, omitting missing values. The dialog MUST use one named Close control, Escape, contained focus and focus return; at phone widths it MUST be a viewport-bounded sheet and at desktop widths a bounded dialog. Opening and closing MUST preserve the background scroll position, and reduced motion MUST remove transition motion. Recorded consumption MUST NOT be presented as account quota, generation speed, or a bill. A forecast read that omits its quota section MUST read as unavailable (`lookup failed`); one that omits the recorded-consumption section renders no rows or message, while a present empty section keeps `No recorded consumption`. A window that reports a group MUST render that group name once as a heading before its consecutive windows, in reported order, using the existing divider and mono text roles without a nested surface; windows without a group render unchanged. Never infer quota limits or render missing numbers as zero. Reuse the shared modal, existing quota text, danger, and warning roles with no new token or dependency; retain light/dark and narrow wrapping without horizontal overflow. | `src/remote/ui/usage-accounting.test.ts`, `src/remote/ui/usage-model.test.ts`, `src/remote/ui/usage-layout.test.ts`, `verify/usage-page.integration.test.ts`, `verify/usage-accounting.integration.test.ts` |
| W61 | approved | A retained analytics Session row without a title MUST show `Session <id>`, keeping its ID without inferring deletion or borrowing another Session's name. Usage MUST identify configurable request-date retention (default 30 days) without claiming an unknown current period. Transcript/Team cost views MUST remain on Session-owned records and MUST NOT substitute analytics for missing Session history. Reuse existing identity and subdued-detail tokens. | `src/remote/ui/usage-model.test.ts`, `verify/usage-page.integration.test.ts` |
| W62 | approved | The selected-subagent bar MUST show its own Session live or settled generation rate beside its identity and in Subagent details, under W57, and hide it while the live sample is insufficient. Reuse compact metadata ink and the existing wrapping identity group; retain navigation targets, phone transcript space and closed-details lifetime under W26. | `src/remote/ui/subagent-bar.test.ts`, `verify/generation-speed.integration.test.ts` |
| W64 | approved | While a Session family has open review items, a Review panel MUST appear in the conversation request area above the composer, below live requests, reusing the request-card treatment and the danger outline/halo for hard items. Its header MUST read Review · N waiting, with a matching review N badge on the open family's Session list entry and in the Session companion header. The rail status retains its primary chip and any `.chip--attention` review badge. Items MUST show the owning Session or child · agent · description with a jump link, the reason (including `Automatic decisions are disabled` when automatic answers or model decisions are off, which MUST NOT imply a model decided), and the reported choice and unrounded confidence. Forms reuse form controls with Submit and Dismiss; subagent questions reuse the child-answer field with Dismiss; ordinary guardrail items offer Approve once, Always (only with outside directories), and Reject; hard items offer Approve once and Reject; permission items offer Approve once, Always, and Reject. The browser MUST NEVER decide on its own; duplicate sends MUST be disabled and failed or uncertain outcomes MUST stay visible without replay. An idle Session with open items in its scope reads waiting for your review. | `src/remote/projection.test.ts`, `test/remote-session.test.ts`, `verify/review-box.integration.test.ts` |
| W65 | approved | Composer controls, Session companion and Session list MUST use Permissions, Guardrails and Answers with effective Manual, YOLO or Auto values. Uniform categories show `Autonomous <mode>`; mixed categories retain their individual words. Goal, deferred, machine may sleep and review count use readable wrapping state chips. The shared Modal opens Autonomous settings as a selectable listbox with previous and next category arrows, arrow-key navigation and 1, 2, 3 set-all shortcuts. Entering YOLO in any category shows an in-dialog warning that it bypasses blockers, including hard, catastrophic and destructive guardrails, permission blocks and all questions; it pushes progression aggressively and the user accepts full responsibility. Persist only after `Accept risk & enable YOLO`; Cancel or Escape saves nothing. Existing YOLO requires no repeat confirmation. Manual and Auto persist directly. Rows show inherited effective modes and their source; pending, failed or unconfirmed reads and mutations remain explicit and are never replayed automatically. Close on Session change and disable controls while sending or disconnected. `/autonomous` opens the dialog; `/defer` toggles persistent family deferral, holds keep-awake and leaves unresolved manual decisions in Review. Prompts and commands do not clear defer. `/keep-awake` operates on the machine. Hidden evaluator agents remain absent from pickers and command lists. Preserve focus, phone targets and W103 composition. | `src/remote/autonomy.test.ts`, `src/remote/ui/autonomous-panel.test.tsx`, `src/remote/projection.test.ts`, `src/remote/ui/composer-action.test.ts`, `src/remote/ui/command-palette-model.test.ts`, `verify/composer-controls.integration.test.ts` |
| W66 | approved | The Session topbar MUST persistently show `keep-awake on` whenever the machine reports on, with `lid held` for lid on or held and `defer held` for a deferred-family hold. Other lid states MUST remain explicit. Use the shared chip treatment: success for on, danger for error, attention for unsupported. Loading and off MUST show nothing. Palette and Settings mutations MUST update the shared read immediately after settlement; mounted Session chrome MUST refresh the machine read every two seconds for changes from other clients. The indicator MUST wrap within its own full-width topbar row without clipping the Session identity or composer actions. | `src/remote/view-model.test.ts`, `verify/review-box.integration.test.ts` |
| W67 | approved | Review list failures MUST remain visible with Retry, preserving resident items and answer drafts. Review changes in any family member MUST invalidate the selected family's list through the connector's coalesced Session-list invalidation, including changes made by another client; NEVER substitute a child event's sequence for the selected Session's watermark. | `test/remote-session.test.ts`, `verify/review-box.integration.test.ts`, `../../packages/cli/test/remote-bridge.test.ts` |
| W63 | approved | The Team Shell tab MUST show only the selected root family's shells, grouped under their owning Session using the existing owner heading, status mark, and mono title treatments; an unknown-owner group MUST NOT appear. A shell owned by a completed child or deeper descendant MUST appear under that member, labelled from the owner identity the backend reports when its task row is not in the loaded page. List commands MUST be previews of at most 256 characters, ending in `…` when shortened; a row-count or response-size limit MUST show a qualified list notice. Opening a shell MUST read its complete command on demand with its output page; the shell output section MUST show that exact command unaltered in its own labelled mono block (`.team-view__command`, sunken surface, wrapped anywhere) separate from status and elapsed labels. An opened shell MUST retain its verified identity and catch final output after leaving the live list. Successful kill MUST remove the row, not retain a `killed` row; ID-free inventory invalidations MUST refresh the selected root's authorized family shell list even without a running-status transition. A failed read MUST retain the previous page and visible error, pause automatic polling, and offer `Retry output` using the existing Team button treatment; only an explicit read MAY resume polling. Team and Conversation polling MUST follow the shell's running and terminal status, independently of tool-call settlement, until all reported bytes have been read. Captured output MUST retain only the bounded 256 KiB tail in memory. | `src/remote/ui/team-model.test.ts`, `src/remote/projection.test.ts`, `test/remote-team.test.ts`, `verify/team.integration.test.ts`, `../../packages/cli/test/remote-operations.test.ts`, `../../packages/cli/test/remote-bridge.test.ts` |
| W68 | approved | Usage MUST show a **Model incidents** section after Breakdown and before the cost note, for the connected backend's retained fallbacks and guardrail escalations/rejections, independent of every other Usage panel. Use the named Incident grouping toggle (`Model`, `Agent`) and Incident range group (`7 days`, `30 days`, `All retained` default, `Custom UTC` with From inclusive and To exclusive dates in the existing field treatment). Show a table of 25 groups per page with `Showing a–b of N groups`, Previous/Next, and exact digit-grouped Fallbacks, Escalated, Rejected, Total, and the last incident as exact `YYYY-MM-DD HH:MM:SS UTC` inside a `time` element; never abbreviate counts or show an absent time as zero. Reuse usage table, toggle, chip, pagination, and message treatments; below 768px each row becomes one labelled card that wraps without horizontal overflow. Loading uses the shared placeholder; empty says `No model incidents in this period.`; an older connector says `Update YCoding on this machine to see model incidents.` without Retry; a failed read shows an alert with Retry and keeps the previous page. | `src/remote/ui/model-incident-model.test.ts`, `verify/incident-usage.integration.test.ts` |
| W69 | approved | Each incident group MUST expose a **Details** button named with its model and agent, with `aria-expanded`, `aria-controls`, and `--yc-hit-min` height, that opens an inline panel below the table (no overlay). The panel lists the 20 newest incidents for that model (and agent in Agent grouping) with the kind word, exact UTC time, category, rule IDs, agent, variant, profile, fallback target, and decider, and shows the model's exact guidance text in a wrapped mono block with an indicator reading `Guidance enabled` or `Guidance disabled` in words (never color alone), taken from the verified Session Location when provided and otherwise the backend default. **Clear guidance** MUST open the shared confirm dialog (`.overlay--confirm`, W55) naming the model, stating that it clears the model's guidance for every agent and Session on this backend and that incident counts are kept; Cancel and Escape return focus to the opener. A pending clear shows `Clearing…` and disables repeats; a failure stays in the dialog as an alert and can be retried; success closes it, announces `Guidance cleared for <model>.` in a status line, shows `Cleared <UTC time>`, and leaves every count unchanged. Detail read failures show an alert with Retry per read. | `src/remote/ui/model-incident-model.test.ts`, `verify/incident-usage.integration.test.ts` |
| W70 | approved | A pending **Restart recovery** item MUST render in the existing Review panel as one request card (`.request--review`) headed `Restart recovery`, with the child attribution button, the reason `The service restarted while this subagent was working`, and an explanation that the listed tool calls may or may not have finished so their results are unknown. Show each uncertain tool as its own body line of escaped mono identifiers (tool name, call ID, message ID), never as markup. The card MUST offer only **Continue** (primary) and **Stop** (secondary) as authorized typed client decisions with the existing button treatments, and no dismiss, approval, or text field; the subagent waits for the choice, and Stop states that Continue remains available from Team. Sending disables both controls, an unconfirmed or refused outcome stays on the card as an alert and is never replayed automatically, and a settled item leaves the panel. In Team, a task carrying a stopped recovery MUST read `stopped` and show one **Continue** control in the existing answer-button treatment that submits the same authorized recovery decision once, shows `Continuing…` while in flight, and reports a refused or unconfirmed outcome as the Team alert without replay; the control disappears when the refreshed task no longer carries the stopped recovery. A waiting subagent question marked deferred MUST read `This question is waiting in Review.` instead of offering the Team or Subagent-bar answer form. A `resumed` subagent notification MUST be read as its own outcome (`Subagent <title> resumed.`), never dropped or shown as another outcome. | `src/remote/projection.test.ts`, `src/remote/ui/team-model.test.ts`, `test/remote-session.test.ts`, `test/remote-team.test.ts`, `verify/restart-recovery.integration.test.ts`, `../../packages/cli/test/remote-operations.test.ts`, `../../packages/remote/test/contract.test.ts` |
| W71 | approved | A Session whose only attention reason is a lost background-work result MUST show the exact label `Background result lost` in the existing attention tone: the first Session-row and Session-list chip, ahead of Running, and the carousel card status with the attention ink and dot. It MUST NOT read Waiting for you, Failed, or any question or approval wording; MUST NOT draw the Session attention dot, the navigation attention dot, or the `waiting for your decision` navigation labels; MUST NOT match the Waiting filter, join the waiting group, or outrank a Session that is actually waiting; and a running Session with a lost result keeps the Running state but leads with the loss label. A permission, question, or review takes precedence, so the status reports that Session as waiting, not lost. Loss follows the latest status: a live status frame, status read, or Session list status snapshot that omits the Session removes the label, and a reconnect discards the loss flag until the new connection reports it, so a fresh status re-reports loss that persists. A System alert for a lost result titles `YCoding — background result lost` with the body `<subject> has a lost background-work result. Open it to review.`; generic, in-app, and overflow attention copy for an unspecified need says needs attention, and only an explicit permission, question, or review need says waiting. | `verify/remote-navigation.integration.test.ts`, `test/remote-activity-order.test.ts`, `src/remote/view-model.test.ts`, `src/remote/ui/remote-redesign.test.ts`, `src/remote/notifications.test.ts` |
| W73 | approved | The Relay MCP authorization pages (`infra/cloudflare/src/mcp-consent.ts`) MUST be server-rendered HTML with one nonce-bound inline stylesheet, no script, no animation or transition, and no third-party or external asset. They MUST declare only the `--yc-*` roles, light values in `:root` and dark values under `prefers-color-scheme: dark`, with the exact values and gutter steps of `tokens.css`, and the Geist font stacks backed by same-origin `@font-face` rules for `/fonts/Geist.woff2` and `/fonts/GeistMono.woff2` (stable copies of the brand fonts published by `script/build-web-assets.ts`, `font-display: swap`), with CSP `font-src 'self'` and no other external asset. One column MUST be at most `--yc-measure-narrow` plus the gutters and MUST reflow without horizontal scrolling at 320px, wrapping long client names, device names, hosts, and resource URLs. The pre-Google notice MUST show the client name, redirect host, resource URL, the complete authority list, and one Continue to Google action, and MUST NOT show the device name. The final consent, shown only after the Google owner is verified and allowlisted, MUST add the device name and offer Allow access (primary) before Deny (secondary). Every page MUST show the same authority list: every Session, creation in directories strictly below home, prompting and interrupting, questions and forms, once/Always/reject decisions, autonomy mode and goal changes, provider connections, shells, keep-awake, and usage reads. A loopback redirect MUST add a labeled local-address note, never color alone. Untrusted text MUST be HTML-escaped inside `<bdi>`. Buttons reuse the `.button`, `.button--primary`, and `.button--secondary` treatments at `--yc-control-h`, wrap to full width when two do not fit, keep the visible `--yc-focus` outline, and fine-pointer scrollbars use the owned W7 treatment. | `infra/cloudflare/test/mcp-consent.test.ts`, `infra/cloudflare/test/mcp-router.test.ts`, `script/build-web-assets.test.ts`, `infra/cloudflare/test/integration/mcp-consent-browser.ts` |
| W74 | approved | The Machine section MUST list every owned active machine, online or offline, plus the selected machine when revoked, as one vertical `.machine-row` list (`role="list"`, accessible name Machines) of `.machine-row__item` cards, with no dropdown, listbox, or separate rename panel. Each row MUST fill the section's inner track and keep its name, state, and action reachable with only Settings' vertical scrolling, including at 320px and 390px in both themes. The list MUST NEVER clip a neighboring machine or widen the page. A card shows a status dot with Online, Offline, or Revoked words, the displayed name, a secondary hostname line whenever the name is an alias or the name is being edited, and one Connect button. Connect is enabled only for an active, online machine that is not current and while no name is being edited; the current machine reads Connected with a green-strong border and `aria-current`, an ineligible one reads its state, and neither connects. Names and hostnames render as literal text, one line with ellipsis, with the hostname in an owned tooltip. Double-clicking an active machine's name or activating its `Edit name of <name>` icon button swaps only that name for an inline field (maximum 48 characters, trimmed; empty or the hostname clears the alias) with visible Save and Cancel buttons; Enter saves, Escape cancels, focus returns to the edit icon, only one card edits at a time, and a card keeps its DOM node across alias saves and store updates. Saving disables the form, says Saving, and preserves the reported name until confirmed; a failure retains the draft and appears beside the field with the existing `.field__hint` alert treatment. Every control is at least 44px. Revoked machines stay in Settings → Devices and a polite note counts them; when no machine is online the note reads No machines online. The section states the account-shared persistence scope beside the row. | `verify/machine-row.integration.test.ts`, `verify/device-picker.integration.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W75 | approved | Projects MUST list at `/remote/projects` through the Projects destination. Each Project has one Master and up to 64 members. Open project MUST open its Master on the ordinary Session route. The Master chat MUST retain the real transcript and composer, with Sessions and Settings in a docked panel from 1024px and a named, focus-contained sheet below it. Pin and badge the Master first, preserve member order, give every card its own Open session action, and restrict Remove and Delete… to members. Show reported live-state words, pending summaries, active driver titles, Active/Paused with reported pause reasons, member-only concurrency, and freshness. The activity sparkline MUST label the last-activity histogram honestly, not claim event counts. Create MUST accept an existing eligible root Session or create one in a typed absolute (POSIX, drive or UNC) or ~ directory sent unchanged, with known directories as optional quick choices. Settings MUST edit name, Master, membership, concurrency, delegated narrowing and client notification preferences. Changing Master MUST retain the previous Master as a member. Add MUST attach a running root Session from any directory without restarting it through `coordination.attach`, naming that effect in the dialog; a new Session's folder text MUST state that a Git repository is not required. Remove MUST detach through `coordination.detach`, never a member-list update, and MUST retain the Session; Delete Session MUST confirm history deletion; Delete project MUST confirm that all Sessions keep running and keep their histories. Mutations MUST send once with the opened revision, retain refusal reasons and reread unknown outcomes without replaying them. Loading, empty, unavailable and error states MUST name their condition and recovery. Never render lifecycle, receipt, claim, queue-capacity or budget controls. | `src/remote/coordination.test.ts`, `src/remote/queries.test.ts`, `verify/projects.integration.test.ts` |
| W76 | approved | Project Settings MUST offer external notification scopes `All sessions (default)`, `All masters` and `Selected masters` (up to 128 verified Master Sessions), plus question, permission, review, failure and completion categories. Keep the stored/wire scope `coordinators` and `coordinationFilter` names. An absent category set means all; an empty set mutes external alerts. Filter only System alerts and closed-app push, never in-app notices, pending controls or Session-less alerts. Withhold restricted delivery while the Master list is unavailable and say so. Store the filter per browser and report push update, absent subscription or failure. Settings → Notifications MUST link to Projects. | `src/remote/coordination.test.ts`, `src/remote/push.test.ts`, `test/remote-notifications.test.ts`, `verify/projects.integration.test.ts` |
| W77 | approved | A user-role input recorded with coordination provenance (`inputOrigin: "coordination"`) is the person's own first-person instruction channel and MUST render through the same user-message presentation as typed input: no Coordinator, Master, delegated or on-behalf wording, badge, persona or alignment, and never the originating Session's ID or title. Its provenance metadata is audit data only: the web view model MUST NOT carry it into presentation, receipts, ordering or any control, and its text MUST NOT settle, approve or answer a pending permission, guardrail review or question. | `src/remote/projection.test.ts`, `verify/projects.integration.test.ts` |
| W78 | approved | A settled automatic guardrail decision MUST become a conversation row only when its reply is `reject` (a blocked operation); `once` and `always` approvals MUST NEVER render a row, badge, banner, or summary in the conversation. A settled rejection row MUST render chronologically (including between assistant parts) only when its settlement time is at or after the first resident chat message, that is, the first message that is not a compaction, a compaction checkpoint, or pending input; rejections older than that message are omitted, and with no resident chat message no settled row renders. Settled rows MUST NEVER mount the transcript on their own: the transcript mounts only when a message is resident, so hydration never shows settled history ahead of chat. Store data, pending family requests, escalation notes, the Review panel, and grades or provenance on rejection rows are unchanged. | `src/remote/ui/transcript-rows.test.ts`, `verify/guardrail-family.integration.test.ts`, `verify/review-box.integration.test.ts` |
| W80 | approved | Web surfaces MUST consume the semantic roles in every declared token group of this front matter, `src/styles/tokens.css` and `schemeStylesheet()`. The registry includes the public/header layout roles and native motion, signal, companion, series and scrim roles. Any new or changed token requires approval and a same-change update to its declaration, consumers and bidirectional drift checks. Remote appearance MUST stay scoped to remote selectors and component stylesheets; public appearance belongs to `src/styles/site.css`, `src/styles/docs.css` and shared primitives in `src/styles/base.css`. Reuse these owners without adding a stylesheet. | `src/styles/design-md.test.ts`, `src/styles/tokens.test.ts`, `verify/public-fidelity.integration.test.ts`, `verify/docs-layout.integration.test.ts` |
| W81 | approved | Type MUST use the documented family, size/leading pairs, weights and tracking; radii and durations MUST use their semantic roles at each component owner. Public controls, index links and navigation use the component-specific shapes in W93; remote rows use W84, requests use W102 and the composer uses W99. Source-defined companion geometry is documented under Layout, Typography and W98. Layout switches MUST use the declared breakpoint steps, the phone-layout predicate and its coarse-landscape refinement `(max-height: 599px) and (pointer: coarse) and (orientation: landscape)`. Companion docking, composer caps and visual-viewport ownership MUST agree on the 1280px wide step. The Team inline-size container adapts accounting slots to its actual panel. Do not introduce arbitrary width tiers or container queries in shared surface stylesheets. | `src/styles/tokens.test.ts`, `src/styles/composition.test.ts` |
| W82 | approved | Web surfaces MUST NOT import source-only scaffolding: cursor roles stay with the shared foundation (W31), scrollbars stay with W7, visually hidden text uses `.visually-hidden`, stacking uses `--yc-z-*`, and simulation labels and review chrome stay out. New transitions and animations that do not consume the `--yc-motion-*` tokens (W95) MUST run only inside `@media (prefers-reduced-motion: no-preference)`; those that do are governed by the global token mapping in `tokens.css` and MUST NOT add a per-component `prefers-reduced-motion` block. The production reduced-motion model (travel removed, state preserved) stays, and a blanket `animation: none` or `transition: none !important` kill MUST NOT be added. | `src/styles/cursors.test.ts`, `src/styles/composition.test.ts`, `src/styles/tokens.test.ts`, `verify/overlay-motion.integration.test.ts`, `verify/scrollbar.integration.test.ts` |
| W83 | approved | Remote screens MUST build hierarchy from typography, whitespace and semantic tonal planes. Source-defined conversation and companion header boundaries, code, captured diff, request, search and selected-detail planes MUST use their owned semantic border and surface roles. Fields, pickers, the composer, floating layers, focus and hard-review danger states retain their meaningful boundaries (W9, W30, W64). The Usage provider divider remains a section boundary. NEVER add arbitrary nested frames, repeated full-width row rules or dashed decorative content frames. | `src/remote/ui/usage-layout.test.ts`, `verify/design-contract.integration.test.ts`, `verify/light-office.integration.test.ts` |
| W84 | approved | Session, Settings and Usage records MUST remain open rows separated by whitespace, with semantic hover, focus and current states. The Machine cards keep their distinct W74 selection/edit contract. Projects MUST use open Master-first sections without enclosing decorative project frames. Content MUST determine row height, with the existing dense minimum on fine pointers and 44px minimum on coarse pointers and below 768px. Session rail names MUST wrap within measured rows and share a minimum height and end edge; keyed windowing and measured sizes under W32 remain binding. | `src/remote/ui/virtual-rows.test.ts`, `src/remote/ui/settings-layout.test.ts`, `verify/remote-inventory-feed.integration.test.ts`, `verify/projects.integration.test.ts` |
| W85 | approved | Settings and Usage sections MUST open with an icon-led heading in the section's owned `Icon` and MUST NOT render `§NN` ordinals or section counters. Usage keeps its section-owned icons and the Group select (W58). A section that is not rendered (Office on a phone layout) leaves no gap. Headings MUST NOT change section order, content or visibility. Settings remains one stacked column with every section visible (W48); NEVER add an accordion or master-detail layout. | `src/remote/ui/settings-layout.test.ts`, `src/remote/ui/usage-layout.test.ts`, `verify/usage-page.integration.test.ts`, `verify/remote-fidelity.integration.test.ts` |
| W86 | approved | Each assistant turn MUST open with the Y mark, agent, model, effort and response metadata, never an ordinal. User input MUST render right-aligned (W6) as a borderless `--yc-green-tonal` capsule with `--yc-radius-composer` corners and a `--yc-radius-control` end-bottom corner. Place the delivery receipt below it. Use normal ink for prose and contrast-checked accents for Markdown headings, links and code. Style annotations as tonal disclosures on the shared W47 track; preserve streaming nodes, virtualizer anchors, W20 card placement and W59. An expanded shell tool card MUST keep its disclosure body, command, results and captured output within the header's inline edges. Long lines MUST stay selectable and scroll within their output blocks without widening the transcript. Session totals and costs MUST NOT render beside messages. | `src/remote/ui/transcript-layout.test.ts`, `src/remote/ui/transcript-rows.test.ts`, `verify/transcript.integration.test.ts`, `verify/conversation-reading.integration.test.ts`, `verify/transcript-stability.integration.test.ts`, `verify/remote-tool-output.integration.test.ts` |
| W87 | approved | Figures in Usage and summary values in Settings MUST be typographic figures: `--yc-font-sans` at an existing `--yc-size-*` step with tabular numerals, labels in uppercase at `--yc-tracking-wide`, and compact metadata in `--yc-font-mono`. Conversation gets no header statistics block, and no figure is derived, estimated or zero-filled beyond W58, W59 and W61. | `src/styles/tokens.test.ts`, `src/remote/ui/usage-layout.test.ts`, `verify/usage-overview.integration.test.ts` |
| W88 | approved | From 768px outside the phone layout, the 80px `--yc-activity-w` activity bar and the 256px `--yc-rail-w` Session list column MUST sit on `--yc-plane-chrome`, each ending in a `--yc-line-subtle` pane separator; the column keeps a plain YCoding wordmark and the shared W46 anatomy without a machine footer. Every activity item MUST show its 20px glyph above a visible one- or two-word label in a 72×56px target; navigation is NEVER icon-only. The current destination MUST expose `aria-current`, a `--yc-green-tonal` fill and `--yc-green-ink` glyph and label without a border or halo. Chat counts pending requests and Sessions counts waiting Sessions as an amber badge on the glyph corner, and the item's accessible name states the wait. Session selection MUST remain independently identifiable on `--yc-plane-selected` within the shared list; selecting a project MUST NOT replace that list. Phone navigation follows the same W46 destination inventory. | `src/remote/ui/shell-model.test.ts`, `src/remote/ui/remote-redesign.test.ts`, `src/styles/composition.test.ts`, `verify/workspace-rail-team.integration.test.ts`, `verify/remote-navigation.integration.test.ts` |
| W89 | approved | Sign-in and invitation MUST center their existing narrow form composition horizontally and vertically in the available page below the wordmark/theme bar, with natural scrolling when content exceeds the available height. Keep one open, unframed column with no enclosing panel border, fill or radius. Errors retain the danger note and alert semantics; Google and access-key controls, loading, invitation validation and the once-only key reveal MUST retain their actual states and operations. Source error examples are separate states, NEVER simultaneous invented errors or account facts. | `verify/invite.integration.test.ts`, `verify/remote-fidelity.integration.test.ts` |
| W90 | approved | Connection, notice and consent strips MUST present as tonal strips: a tone-soft fill, a leading tone icon or dot, `--yc-radius-card`, inset by `--yc-gutter`, with no inline-start bar and no rule. A strip exists only while it has something to say; W52 consent text and actions and the W24 popup rule are unchanged. | `src/remote/ui/remote-redesign.test.ts`, `verify/remote-shell-layout.integration.test.ts` |
| W91 | approved | The conversation MUST keep an opaque bordered identity header above the scrolling transcript and a docked Session companion on desktop, with a focus-contained phone surface. Preserve focus handoff, notifications, Office, policy controls, hard-review treatment and their existing authorization. The composer MUST expose its supported model effort choices without inventing variants. The companion Context tab MUST label the per-category breakdown an estimated input breakdown (request estimate, separate from provider-reported window tokens and cumulative spend), share each category against the sum of the seven estimated categories, and clear the shown window and breakdown on compaction, revert, or a provider/model change. | `verify/remote-shell-layout.integration.test.ts`, `verify/composer-controls.integration.test.ts`, `verify/modal-close.integration.test.ts`, `verify/review-box.integration.test.ts`, `verify/workspace-shell.integration.test.ts`, `src/remote/projection.test.ts` |
| W92 | approved | The remote workspace MUST NOT add source-only elements that have no production owner: a Remote help panel, a machine picker in the Sessions header, Running-and-recent pager dots, an Office floor drawn as SVG (the Phaser canvas stays and only the surrounding chrome is restyled), a textarea for the access key, success toasts (W24), simulation-only actions, a consolidated workspace-tools menu, a transcript tool-cluster wrapper, or the prototype's surface, viewport, theme and motion switchers. | `verify/office.integration.test.ts`, `verify/notifications.integration.test.ts`, `verify/remote-fidelity.integration.test.ts` |
| W93 | approved | Public routes MUST use one public header with its `1px solid var(--yc-line-subtle)` boundary, 56px height and 1440px outer track; documentation and changelog search belongs to that header, NEVER a second full-width search band. Article navigation and changelog filters MUST remain in their content/rail owners, with content-sized mobile sheets and focus return. Capability columns remain open with bare currentColor icons, and trust entries retain their tonal strip. Public `.button`, `.input`, `.select`, `.textarea`, index links and code controls use `--yc-radius-control`; article code uses `--yc-radius-card`. Global public navigation MUST use open text links with transparent fills and zero radius; its quiet current state uses semantic text ink and semibold weight, while routes, aria-current, visible focus and 44px targets remain intact. Use text ink rather than green-strong to retain the light translucent header's required contrast. Custom-select triggers and header search retain their component-owned shapes. Index topic groups are open; `.releases--timeline .release` uses transparent fill, zero radius and a 1px semantic bottom boundary, not rounded hover cards. The 404 recovery MUST be an open centered composition with a display-scale heading and genuine documentation, home and workspace links, without a card frame or synthetic diagnostics. Keep registry/release content canonical and prevent horizontal page overflow at 320px. | `verify/public-fidelity.integration.test.ts`, `verify/docs-layout.integration.test.ts`, `verify/light-office.integration.test.ts` |
| W94 | approved | Translucent navigation (the portrait `.bottom-nav` and the public site header) MUST use a 94% mix of its opaque plane (`--yc-plane-chrome` for the phone bar, `--yc-plane-canvas` for the public header) with a 12px backdrop blur, so `--yc-ink-secondary` labels keep 4.5:1 over the worst-case backdrop in both themes, and MUST fall back to the opaque plane under `prefers-reduced-transparency: reduce`, `forced-colors: active`, or where `backdrop-filter` is unsupported. The phone bar starts with an opaque token background and a `--yc-line-subtle` top boundary; its translucent fill and filter declarations are enhanced only when standard or prefixed backdrop filtering is supported. Navigation and toasts keep the `--yc-z-*` order. | `src/styles/contrast.test.ts`, `src/remote/ui/remote-redesign.test.ts`, `src/styles/composition.test.ts`, `verify/remote-shell-layout.integration.test.ts`, `verify/public-fidelity.integration.test.ts` |
| W95 | approved | Every collapse or expand MUST animate its height (a `grid-template-rows` `0fr`↔`1fr` track) and opacity together, so content below slides with it; the shared `Collapsible` (`src/ui/collapsible.tsx`, `.collapsible` in `base.css`) is the one disclosure primitive and `.motion-enter` the one entrance. Their timing MUST use only the `--yc-motion-*` tokens defined once in `tokens.css`: `--yc-motion-spatial-dur` (220ms, height and position), `--yc-motion-effect-dur` (140ms, opacity and colour crossfades and exits) and `--yc-motion-ease`. Under `prefers-reduced-motion: reduce` that one mapping makes spatial motion instant (0s) and keeps crossfades at `--yc-dur-instant` (80ms, at most 150ms); consumers declare no reduced-motion block of their own. A closed `Collapsible` is `inert` and `aria-hidden`, its content mounts on first open, and its clip keeps focus rings visible. A collapse or expand MUST NOT jump the transcript scroll position, and the scroll anchor MUST stay stable when content above it expands. | `src/styles/tokens.test.ts`, `src/styles/composition.test.ts`, `src/styles/design-md.test.ts`, `src/ui/collapsible.test.tsx`, `verify/motion-collapsible.integration.test.ts` |
| W96 | approved | The selected machine's name MUST appear in Settings → Machine as one `.defs__row` with the `Selected machine` key and the displayed name (the account alias when set, else the connection label while no machine is selected) above the W74 machine row; the workspace rail carries no machine footer. Switching machines stays with the machine row's Connect button (W74). | `verify/settings-machine.integration.test.ts`, `verify/machine-row.integration.test.ts` |
| W97 | approved | Use `--yc-sky-ink` for live status, file and model icons, and Markdown headings and links. Each use MUST pair with a distinct glyph, label or underline; color alone MUST NOT communicate state (R8). Green owns primary actions and current-place emphasis. Default uses `#1962c0` in light mode and `#79b8ff` in dark mode; W42 maps other schemes from `base0D`. Signal MUST reach 4.5:1 as text and 3:1 as a mark on page surfaces, including green, amber and danger fills. High contrast MUST reach 7:1 for signal text. | `src/styles/contrast.test.ts`, `src/styles/tokens.test.ts`, `src/styles/design-md.test.ts`, `src/theme/schemes.test.ts` |
| W98 | approved | The Session companion docks from 1280px; at 1279px and below it overlays as a fixed panel within the viewport. Context and Changes use `min(var(--yc-companion-w), 40vw)` while docked, at most 448px, and `min(var(--yc-companion-w), 100vw)` while overlaid. Activity uses a 380px desktop panel below the 56px conversation header. Expanded Team uses its separate 320px selected-child inspector. Header title, policy controls and close MUST fit without wrapping or overflow at docked widths; phone surfaces retain W13/W41 focus, sizing and close semantics. These are compositional values, not additional width steps. | `src/styles/tokens.test.ts`, `src/styles/design-md.test.ts`, `verify/shell-polish.integration.test.ts`, `verify/workspace-shell.integration.test.ts` |
| W99 | approved | In a selected conversation the composer MUST be one rounded card whose input capsule has a 26px radius, inset from the scroller's inline edges (8px below 768px), with placeholder `Ask YCoding…`, floating over the transcript: the transcript scroller MUST extend beneath the card so history stays visible beside and below it, and no full-width bar or band may sit behind it. The composer MUST measure the card's covered height into `--yc-composer-reserve` on `.workspace__main` whenever the draft, attachments, pending controls or collapse change it, and the scroller MUST reserve that height as end padding and scroll padding, so the last transcript row, pending request actions and queued bubbles end above the card top when scrolled to the end and while following the latest message. Growing the draft MUST keep the reader's anchored row within 1px. Below 768px the agent and model summary and status chips MUST take their own wrapping line above the draft, with attach and the end-aligned delivery, interrupt and send actions together on one line below the draft, never overlapping one another. | `src/remote/ui/composer-dock.test.ts`, `src/remote/ui/composer-layout.test.ts`, `verify/composer-controls.integration.test.ts`, `verify/transcript-polish.integration.test.ts` |
| W100 | approved | Session activity MUST render once at the live tail inside `.transcript-navigation`, above the composer and aligned with the conversation column. A running Session shows three subtle wave dots and concise Thinking, Writing, or Running tool text derived from its current execution. An in-flight send may show Sending. Pending inputs alone MUST NOT imply execution. Idle Sessions carry no activity row. Disconnected, Reconnecting, provider errors not already shown on the last assistant, and pending decisions retain their explicit status treatment. The composer and its bottom-left dock MUST NOT carry a transient status label. Queued inputs retain their Queued receipt (W24). Dots use `--yc-sky-ink`, muted text, and remain still under reduced motion or explicit motion off. | `src/remote/transcript-activity.test.ts`, `src/remote/ui/transcript-activity.test.ts`, `src/remote/ui/status-bar.test.ts` |
| W101 | approved | A user prompt's image attachments MUST render as thumbnails inside its bubble, in attachment order, after its text. `[Image N]` tokens that refer to an attached image MUST be removed from the shown text, tokens without a matching image stay as written, an image-only prompt shows a bubble with only its thumbnails, and non-image attachments stay file chips below the bubble. The stored message text MUST NOT change. Each thumbnail opens the lightbox dialog named after the file (W120). | `src/remote/view-model.test.ts`, `verify/transcript-polish.integration.test.ts` |
| W102 | approved | Permission, guardrail and question cards MUST share one layout: header to legend at most 12px, legend to description at most 4px, equal gaps between option rows, each owned (`appearance: none`) radio centred on its label's first line, the custom answer field aligned with the option labels at `--yc-control-h`, and one gap from the last field to the actions row. A resolved card MUST leave through a closing `Collapsible` before it unmounts. | `src/remote/ui/remote-redesign.test.ts`, `verify/shell-polish.integration.test.ts` |
| W103 | approved | The companion header title, Goal and Autonomous pills and close button MUST share one vertical centre, with the title, tab row and panel content on one start edge and 8px between the pills. The Context tab MUST lead with the measured total and its `/ <window> tokens` unit on one baseline, with the measured total in mono and capacity, remaining, percent used, measured model and estimate note in sans; breakdown token and percent columns use tabular sans figures with aligned end edges, and companion action buttons share one height, radius and inline padding. Session rows in the rail MUST retain the shared minimum height and end edge while growing for wrapped names and show running, waiting and failed state as a named state signal (W97), never a `Running` or `Failed` chip; the running mark is static under reduced motion. | `src/remote/ui/shell-model.test.ts`, `src/remote/ui/remote-redesign.test.ts`, `src/remote/ui/shared-workspace.test.ts`, `verify/shell-polish.integration.test.ts` |
| W104 | implemented | Categorical color and overlay backdrops MUST use the declared theme tokens: `--yc-violet-ink` and `--yc-effort-{none,minimal,low,medium,high,xhigh,max}` for effort, `--yc-context-{system,tools,assistant,reasoning,tool-calls}` for estimated-input categories (mint for user and muted for other), and `--yc-scrim` for floating backdrops. Do not infer execution or authorization from a series color. | `src/styles/design-md.test.ts`, `src/styles/tokens.test.ts` |
| W105 | approved | The Web source mapping MUST remain bound to inspected HTML/PNG exports from Stitch project `10627183425669399580`. Source-file captions, simulated platform chrome, synthetic identities and draft-only controls MUST NOT become product content or capabilities. Apply the current component contracts W46–W48, W75, W88–W89, W93 and W98–W103 directly. New chat keeps its real repository requirement. Expanded Team retains the attached master and reads the selected child's latest bounded snapshot; Projects retain reported ownership, members, pending summaries and owner-Session navigation. Decisions requiring the owning Session MUST open that Session, NEVER invent permission actions, histories, leases or repository metadata. Preserve functional, authorization, accessibility and Office boundaries and keep source/runtime differences inspectable. | `src/styles/design-md.test.ts`, `src/styles/contrast.test.ts`, `src/styles/typography.test.ts`, `src/remote/team-snapshot.test.ts`, `verify/workspace-rail-team.integration.test.ts`, `verify/scrollbar.integration.test.ts`, `verify/typography.integration.test.ts` |

| W106 | approved | Phone BottomNav MUST have a 56px interactive bar with `env(safe-area-inset-bottom)` outside that height, single-line labels and at least 44px targets. Touch actions MUST use manipulation and transparent tap highlights with immediate owned active feedback. Remote and public phone headers MUST keep one top-bar row plus the top safe area, concise identity/state and primary actions; secondary actions remain reachable through their existing navigation, companion or command owners. Public landing, documentation, article, changelog and 404 routes MUST retain the shared mobile navigation sheet, with reachable article contents and release-filter sheets. | `verify/mobile-native.integration.test.ts` |
| W107 | approved | Shared Modal and phone agent/model/profile, selector, command, subagent-details and companion sheets MUST remain content-sized within the visual viewport. A downward touch swipe originating on the handle/header MUST dismiss through the same owner as scrim tap, named Close and Escape, without changing staged selection, drafts, cancellation, focus containment/return or uncertain-mutation semantics. Sheet bodies MUST contain overscroll, rows MUST remain at least 44px on coarse pointers, and reduced motion MUST remove travel and exits. Horizontal code, diff and table regions MUST keep native momentum and `overscroll-behavior-x: contain`. Settings Machine MUST use the vertical list in W74, not a snapping region. Page content MUST NOT overflow horizontally from 320px through 1440px. | `verify/mobile-native.integration.test.ts`, `verify/custom-select-fullscreen.integration.test.ts`, `verify/composer-controls.integration.test.ts` |
| W108 | approved | Phone project, member and workspace inspection MUST open a detail view or sheet with explicit Back/Close and restore the retained list's scroll and focus. A selected inspector MUST NOT sit below stacked desktop columns. Open project and Open session MUST retain their genuine Session navigation; inspection creates no Session or mutation. Usage and Settings MUST retain readable stacked content, provider legend, viewport-bounded quota details and the notification switch matrix at 320px and 390×844, with every genuine control, reported value and state reachable. | `verify/mobile-native.integration.test.ts`, `verify/projects.integration.test.ts`, `verify/usage-page.integration.test.ts` |
| W109 | approved | Phone/coarse-pointer editable text fields, composer and search MUST use at least the existing 16px `--yc-size-md` input size. Visual-viewport resize/offset tracking, `100dvh`, safe-area and keyboard ownership under W56 MUST keep the composer and sheets visible without discarding drafts, hiding capabilities or fabricating viewport state. Streaming MUST preserve deliberate touch scroll-away under W22. | `verify/mobile-native.integration.test.ts`, `src/ui/visual-viewport.test.ts`, `verify/conversation-reading.integration.test.ts` |
| W110 | implemented | Expanded Team MUST discover each selected child's children through bounded `session.subagent.list` reads addressed to that child, with explicit pagination, retryable read failures and no inferred empty success. Descendants MUST remain inspectable to deeper levels with parent navigation, without joining the attached root's direct Team or gaining its answer, cancel, pin or review controls. Open child Session MUST select the discovered Session through the normal Session owner, retaining its actual parent, sibling Team and managed-child read-only state. Connection, family and selection fences, native owner checks and typed confirmations MUST remain intact. | `src/remote/queries.test.ts`, `test/remote-team.test.ts`, `verify/workspace-rail-team.integration.test.ts` |
| W111 | implemented | Web controls MUST retain the 12px text floor and authored link, icon and scrolling affordances. Native control tooltips MUST use the shared owned hover/focus tooltip. A tooltip inside an open native dialog MUST remain in that dialog's top layer, remain hoverable, and retain the trigger's accessible description and focus. Escape MUST dismiss an open tooltip without dismissing its enclosing dialog or immediately reopening within the same hovered or focused trigger; with no tooltip open, normal dialog Escape MUST remain unchanged. | `src/styles/typography.test.ts`, `src/styles/composition.test.ts`, `verify/workspace-rail-team.integration.test.ts`, `verify/scrollbar.integration.test.ts` |
| W112 | approved | The Project conversation header MUST keep its Project identity and navigation, compact status and role, and existing conversation and context actions outside the identity disclosure. On phones the identity and conversation tools keep the top row; Project actions may wrap below it and Sessions opens the existing context sheet. Closing the full Master and role details MUST grow the existing transcript viewport without replacing the conversation or losing its draft. The Project context's separate overview disclosure MUST close only the member status breakdown, running capacity and activity. Leave Project coordination, Sessions and its count and waiting cue, New session, Add session and the member cards and their actions usable. Both disclosures start expanded, expose their own expanded state and controlled region, and use the shared Collapsible (W95). Neither changes the other, the existing Sessions and Settings disclosures, or whole-context visibility. Reopening context MUST retain the overview choice. | `verify/projects.integration.test.ts`, `verify/mobile-native.integration.test.ts` |
| W113 | approved | The composer model chip and the model switch within Effort/Profile settings MUST open the same Choose model list. Keep model settings reachable, with a named back action where the list replaces settings and one named close action. Focus the search on entry; ArrowDown and ArrowUp move the active result and Enter in the search chooses it. Escape or selection MUST restore focus to the invoking control; the explicit Close action dismisses the picker and restores the composer chip. Retain the anchored desktop popover and content-sized phone sheet (W8, W41). The header, search (including its visible focus ring), and compact Recent and provider groups MUST fit without horizontal scrolling, including long provider, profile and model names or IDs. Retain full accessible labels and selection state. Only the bounded result list scrolls vertically. Searching, backing out and dismissing MUST preserve the draft and model settings and MUST NOT submit any changes. | `verify/model-replay.integration.test.ts`, `verify/model-picker-width.integration.test.ts` |
| W114 | implemented | Genuine Dot-originated steer prompts (`kind: "synthetic"` outside internal envelopes, system/review/instruction/history/peer/audit metadata and notices) MUST render with the same right-aligned `--yc-green-tonal` prompt capsule as user prompts (W86), displaying cleaned user-facing steer text with transport markup stripped while keeping `transcript-message--synthetic` class, `Dot steer prompt` accessible labeling and a `Dot steer` receipt rather than human authorship claims. When steer text is empty or contains only transport markup, NEVER invent text or render an empty bubble. Keep non-steer synthetic notices, `Dots.peer`, `Goal · steer` and side-chat history snapshots unchanged. | `src/remote/projection.test.ts`, `src/remote/view-model.test.ts`, `src/remote/ui/conversation-folio.test.tsx`, `verify/transcript.integration.test.ts` |
| W115 | approved | From 768px outside the phone layout the remote workspace MUST show one 28px `--yc-status-h` status bar across the window's bottom edge on `--yc-plane-chrome` with a `--yc-line-subtle` top boundary. It reads connection, machine, and for an open Session its model, autonomy and context meter, then the running count at the end edge. Values come from reported state only and an unreported value is omitted, never zero. Connection and machine open Settings, autonomy opens the autonomy dialog, context opens the companion Context tab and the running count opens Sessions; model is a static readout. The running count is a polite live region; when a child task runs it switches to the branch glyph and names `N Sessions running, a child task started`. Below 1100px of bar width, long labels switch to their short forms. Below 768px the bar is absent and the phone bottom bar remains. | `src/remote/ui/shell-model.test.ts`, `src/remote/ui/shared-workspace.test.ts`, `src/remote/ui/remote-redesign.test.ts` |
| W116 | approved | While the open Session executes, a 2px mint trace MUST run along the status bar's top edge and the conversation header's bottom boundary; when a child task also runs, a Y junction branches off the trace. The trace is `aria-hidden`; the status bar's running count carries the announcement. Under `prefers-reduced-motion: reduce` the loops stop, the run shows a static 50% mint line, and the branch and junction appear with an opacity change of at most 80ms and no travel. An idle Session draws no header trace. | `src/remote/ui/shared-workspace.test.ts`, `verify/design-contract.integration.test.ts` |
| W117 | approved | Adjacent planes MUST differ by a visible step: in light themes canvas→raised MUST reach at least 1.15:1 and chrome→raised at least 1.10:1. Dark themes keep their measured steps (canvas→raised about 1.11:1) and carry pane structure on `--yc-line-subtle` separators of at least 3:1 against chrome, canvas and raised; field and composer boundaries use `--yc-line-field` at 3:1 or more on every plane. Every text tier MUST reach 4.5:1 on every plane including selected (7:1 in High contrast), and white on green solid at least 4.5:1, in default, One Dark, One Dark Pro and High contrast schemes. | `src/styles/contrast.test.ts`, `src/theme/schemes.test.ts` |
| W118 | approved | A Session with admitted, unpromoted queued user input MUST show one compact pending tray directly above the composer field and no tray when there is none. Only real user-authored queued messages count; steer prompts (which promote at the next step boundary and keep their transcript receipt), synthetic, system, compaction, notification and unadmitted optimistic rows are NEVER listed. The collapsed tray shows a stacked edge, the count and a one-line preview of the first message; the expanded tray lists every message in order. Each row has icon buttons named Steer now and Remove pending message that call the Session's pending operations and then re-read the list; Steer now moves the message out of the tray into the transcript flow; a stale input shows the short status note "That input is no longer pending." and the list refreshes. The tray uses `--yc-plane-raised`, `--yc-line-subtle` and `--yc-radius-card`. | `src/remote/pending-tray.test.ts`, `test/remote-session.test.ts`, `verify/composer-fixes.integration.test.ts` |
| W119 | approved | Every user, assistant and agent message body MUST render through the shared Markdown component. A fenced code block MUST render as a `transcript-md__code` card on `--yc-plane-raised` with a `--yc-plane-hover` header holding the `code` icon and language label (Markdown, TypeScript, JavaScript, Rust, Python, JSON, Bash, or Code) and the Wrap lines toggle (`aria-pressed`) and Copy code button (Copied with a check). Syntax spans MUST use the `--yc-code-*` roles at 4.5:1 or better on the raised and hover planes in every theme; the span text MUST equal the raw code. Raw HTML stays inert text and unsafe links are dropped. | `src/remote/ui/markdown.test.ts`, `src/remote/ui/code-highlight.test.ts`, `src/styles/contrast.test.ts`, `verify/composer-fixes.integration.test.ts` |
| W120 | implemented | A sent image thumbnail MUST be a button labeled `Open image <name>` that opens one modal `dialog` named `Image: <name>`. The dialog shows the full image at natural size up to 96% of the viewport (full screen below 768px) with `object-fit: contain`, never cropped. Close, a backdrop click and Escape MUST close it and return focus to the thumbnail that opened it, and reopening MUST work after every way of closing. | `verify/transcript-polish.integration.test.ts` |
| W121 | implemented | A user prompt admitted from Dots native input (`metadata.dotsInput.origin` is `dots-native`) MUST carry the 20px ChatGPT origin badge on its bubble's top-leading corner. When its delivery is `steer`, and on every genuine synthetic Dot steer (W114), a `Steer` marker MUST sit 4px after the badge on the same center line: a 20px pill on `--yc-plane-raised` with a `--yc-line-subtle` border and 600 `--yc-size-2xs` mono `--yc-ink` text, without a `title`. Queued Dot input shows the badge only. Ordinary prompts and any other `dotsInput.origin` show neither. | `verify/dot-steer-marker.integration.test.ts`, `src/remote/projection.test.ts` |
| W122 | implemented | A pending guardrail card MUST show `Waiting <age>` from the request's `created` time, refreshed at least every 15 seconds, and a `Stale` badge (`--yc-amber-tonal` with `--yc-amber-ink`) once the wait reaches `Guardrail.staleAfterMs` (15 minutes). A request without `created`, as older backends send, MUST render with its reason, IDs and actions and no age or `Stale` badge. The note line MUST name both the owning Session and the request ID. A `Review recovery` group with `Cancel` (secondary) and `Retry` (ghost) MUST lead the card footer, with the decision actions at its end; both send the Session-scoped `session.guardrail.cancel` or `session.guardrail.retry` mutation once and are disabled while a decision for the card is pending. Retry re-presents the same pending review: it reaches only `session.guardrail.retry`, never the reply operation, never approves, rejects or settles the review and never runs its command; the card stays pending with its waiting age unchanged and no did-not-run or approval notice. A `guardrail.cancelled` event MUST drop the card whether or not it carries a reason and add a transcript notice that the review was cancelled, or expired, and that the action did not run; a request the backend no longer lists drops on the next request list read, including after reconnect. | `verify/guardrail-family.integration.test.ts`, `src/remote/guardrail-wait.test.ts`, `src/remote/projection.test.ts` |

## Colors

Every theme declares the same Instrument role set: six planes (chrome, canvas, raised, hover, selected, inverse), three lines (divider, subtle, field), three ink tiers plus inverse ink, focus, scrim, selection, and for each of green, mint, violet, teal, sky, amber and coral a tonal fill and its hover, a line, a graphic, a solid with its hover and on-color, and an ink. `src/styles/tokens.css` holds the default light and dark values in the front matter; `src/theme/schemes.ts` holds One Dark, One Dark Pro and High contrast. Exported source colors resolve to these roles, not a parallel palette.

Chrome carries the activity bar, the Session list column, the companion, the status bar and the phone bars; canvas carries the reading track and public pages; raised carries cards, fields, the composer, request cards and dialog bodies. In light themes canvas→raised is 1.18:1 and chrome→raised 1.12:1. Dark themes keep their measured steps and draw pane structure with `--yc-line-subtle` separators at 3:1 or more (W117). `--yc-line-divider` separates rows inside a component that already has a boundary and never marks a pane edge.

Green is the interaction hue: primary actions (`--yc-green-solid` with `--yc-on-green`), focus, current navigation and product-chrome links. Mint means running and completed work only. Use violet for reasoning and Projects, teal for terminal and tools, sky for files, models and Markdown headings and links, amber for attention, usage and goals, and coral for failures and destructive actions. Effort hues follow the selected variant. Companion tabs use their accent on selection; labels, glyphs and state text carry the meaning independently of color. An estimate's categorical color never implies permission, verification or execution status.

## Typography

Use self-hosted Geist for prose and headings and self-hosted JetBrains Mono for code, paths, metadata and compact counters. Normal and italic faces retain their licenses and owned fallbacks. R9 assigns these families to Web while preserving extension fonts and terminal host settings.

The fixed type pairs in the front matter remain the readable scale. Source-only 10px annotations and truncated sample identities are not a reason to shrink controls or hide real names. Context separates its measured mono total from the sans window capacity, model and seven-category estimate. Tabular count and percentage columns align at their end edges.

## Layout

The public source header is 56px high with a 1440px outer content cap and 32px gutters at the approved 1440px viewport. The same track owns public header, landing capabilities and footer; article reading measures and the 1280px documentation index keep their own caps. The landing has centered headline, support, two actions, install command and platform labels above four open capability columns. Footer destinations remain actual product links.

From 768px the remote shell has an 80px labeled activity bar, a 256px Session list column, a full-width 56px conversation header on the canvas, a centered conversation track capped at 64rem, and a 28px status bar across the bottom edge. Pending request cards are framed raised cards with a tonal head band by kind (amber for permissions and guardrails, sky for questions and forms, violet for reviews) and a divider above their actions; hard review keeps its coral outline and halo. Assistant prose fills the track and user bubbles align to its trailing edge. Decisions, changes and the composer share the same edges. Keep clearance for the prompt rail outside the track. Session names wrap in measured rows and share a minimum height and a common end edge.

Render each Project start or step-progress description as an ordinary transcript notice, without a member card or an Open action. Keep terminal outcomes, requests and escalations visible in transcript order. The prompt rail indexes user prompts, not Project notifications.

Activity docks below the conversation header at 380px; Context and Changes retain the 448px companion. Expanded Team keeps a flat master summary, direct children, reported blockers and a 320px selected-child inspector flush to the workspace end edge. Project coordination uses reported ownership, members and pending summaries without adopting the source's invented leases or event history.

### Settings

Align the title and the outer card edges on one centered track, capped at 64rem. Give each Settings category its own `--yc-plane-raised` plane, `--yc-line-subtle` boundary, and `--yc-radius-card` corners. Use `--yc-space-5` (20px) padding on wide layouts and `--yc-space-4` (16px) on phone layouts, measured inside the 1px border. The icon-led heading, prose, and controls share the card's content edge. Machine, Appearance, Notifications, Permissions and App remain directly visible in order; the category boundary groups the open Account and preference rows without framing each row or hiding it in a disclosure.

Use one vertical Machine list on every pointer. Its rows have 8px block and 12px inline padding; the current machine uses the existing selection tone and a semantic border. On wide layouts, place the 44px edit and connection controls next to the machine identity while keeping the row background full width. On phones, keep both controls and the identity inside each row. Place Keep machine awake after the chooser and its shared-name note inside the same card, using the category's 16px flow gap. Place the effective state and switch next to the label with a 12px gap; wrap the controls if needed. Use 4px gaps below the switch row and limit support, status and expanded safety prose to `--yc-measure` (68ch). Keep phone safety details reachable through the 44px disclosure without moving focus or toggling the switch.

Separate sections by 32px on wide layouts and 24px on phone layouts, with no extra gap for an absent section. Device records retain open backgrounds and receive 16px inline padding alongside the aligned table headings. At a Device table width through 767px, place the state in the existing stacked arrangement and use 12px card padding. In a device removal confirmation, separate the copy, any error, and the action row by 16px. Retain the shared modal's 16px body inset on desktop and phone, with the phone safe area outside it. Preserve the Notifications matrix, owned switches, permission disclosure, Account actions, and the single Settings scroll owner. Keep explanations at their existing readable measure rather than making a second page column.

### Provider connection

Connect provider is the same shared Modal from both an attached Session and a selected new-chat Location. Keep title and fields on a common start edge: 20px in the desktop dialog and 16px in the phone sheet. Each existing profile is a borderless tonal card with 16px padding in the dialog and 12px in the sheet. Group the kind and reported connection state with a middle dot. From 768px, put that group beside the name and provider-default label when they fit; wrap it below when they don't. Align actions at the end of the card. At narrower widths, put the metadata below the name and keep the actions below both. Keep the full identity and status readable, the action hit areas intact, and overflow vertical. Keep one Close, visible focus and focus return with the Modal and picker owners. A provider default on the connected machine does not change a Session's selected profile.

### Project coordination and Team

Keep the Project conversation identity and context overview as separate disclosures (W112). The overview's existing sidebar/sheet has its own 16px block and 12px inline padding; member rows use 12px inside that panel. Do not add a Project frame around the transcript. Align the expanded coordination header, Master card, Member sessions and Pending requests with a 24px wide-layout start inset, plus 24px above the first card and below the last section. Master and pending cards keep 20px and 16px internal padding respectively; selectable member rows keep 12px inside the boundary. The 300px selected-member inspector stays at the end edge from 1024px with 20px padding. On phones the shared body and header use 16px insets, and Back replaces inspector content with the retained list rather than stacking the two views.

Keep expanded Team's master summary at 16px and blockers at 16px inside their own surfaces. Direct-child cards use 16px padding on wide layouts and 12px on phones; place their four accounting slots after an 8px gap, clear of the inspection button's focus outline. Use two rows of slots within a `team-panel` of 480px or less, keeping the inclusive labels, order, and selected child. The 320px Team inspector has 20px padding and its own scroll region on wide layouts. On phones the selected child uses the shared 16px body inset; only the overlay body scrolls the full inspector, keeping the header pinned and the Back focus outline inside its scrollport. Align the phone companion's header and tab bands to its 16px body inset without widening that scrollport. Keep Activity's compact task cards distinct from the expanded Team roster. Do not turn Project start or progress into a card or an Open action.

The documentation index uses open topic groups in three desktop columns, with a wider Configuration group and two link columns. Documentation and changelog search share the sole site-header trigger; article navigation and release filtering stay in content and mobile sheets. Articles retain their navigation and contents rails. Documentation search uses a 600px desktop surface and a scrolling results list capped at 380px; total height follows real results within the visual viewport.

### Office

Keep the real Phaser floor, world bounds, actor identity, selection and the Conversation/Office switch. Allocate height after visible notices. Preserve pan, zoom, keyboard movement, reader position, loading and unavailable states. Decorative idle activity follows reported backend state, never creates work, and stops under reduced motion. The source's drawn floor is composition evidence, not replacement art or a simulation contract.

## Responsive

Use the declared fixed composition steps (W80); the Desktop 1180px boundary does not apply to Web. The activity bar and status bar appear from 768px outside the phone layout. The companion docks from 1280px and overlays through 1279px. Composer picker caps use the same 1280px wide step, with their intermediate cap from 768px through 1279px. Visual-viewport keyboard ownership applies below 1280px. The Team component's named inline-size container adapts accounting slots to the actual Activity panel or inspector rather than the viewport.

Below the phone-layout boundary, use the full-height Session navigation drawer and component-owned content-sized sheets, safe-area insets and visual-viewport handling. The approved phone scenes are 390×844; native verification captures use DPR 1 and record that separately from physical device profiles. Preserve 44px coarse-pointer targets, full accessible names, focus return, draft ownership and containment when the keyboard opens. Do not render the source's simulated phone status bars.

The phone bottom bar keeps five single-line destinations in its 56px interactive area; safe-area padding extends its background below that area. Touch and short landscape layouts keep the same route, draft and selection owners. Navigation drawer dismissal preserves its search and list position. Project and workspace inspection use their existing data and shared Modal; member inspection replaces the phone list view until Back restores it. Public article contents and release filters use their route-owned sheets. Inputs use the existing 16px type token on coarse pointers. Header actions that cannot fit remain in their existing navigation, companion and command owners.

## Elevation & Depth

Use the canvas for primary work and headers, the chrome plane for the activity bar, Session list column, companion, status bar and phone bars, and the raised plane for cards, fields and overlays. Tooltips use the inverse plane with inverse ink. Notification toasts stay on the raised plane because they carry hue washes and actions. Align the rail's 56px header with the conversation header. `--yc-elevation-float` belongs only to popovers, dialogs, sheets, toasts and tooltips; every other surface is a flat tonal plane. Header, navigation, scrim, overlay and toast use their declared stack levels so floating content stays above the frame without hiding focus. R12 owns the source-defined code, diff, request, search and selected-detail boundaries. It does not permit arbitrary nested cards or full-width separators between every message.

## Shapes

Reuse the 4px detail, 6px control, 8px card, 12px composer and 999px pill radii. Preserve the existing composer capsule's 26px anatomy and its measured scroll reserve. Controls retain 44px standard and coarse-pointer targets; fine-pointer dense controls are 36px. Do not copy smaller specimen targets at the expense of keyboard or touch access.

## Motion

Durations, easing and semantic motion mappings come from the front matter; the trace loop runs at 1760ms and the Working spin at 660ms. The running trace is the signature moment (W116). Shared Collapsible owns height and opacity transitions, lazy mounting, inert closed content and focus-ring clearance. Reduced motion makes spatial travel instant, stops every loop, keeps effect crossfades at 150ms or less and makes exits immediate. Sending, queued input and actual execution remain distinct reported states.

## Icons

Use the existing 24-unit SVG registry and semantic currentColor roles. Material Symbols in exported HTML identify intent; they do not add a remote font dependency. Every icon-only action has an accessible name. Running, waiting and failed states pair a mark with readable status; reduced motion retains the mark without a spinner.

## Components

### Interaction control

Keep a named Interaction control row above the run's scroll region only when status is `pending`, `active`, `paused`, or `stopped`; render nothing (no element or layout row) when status is absent, checking, unsupported, errored, or `unavailable`. Use the canvas plane, small text, semantic status ink, and dense pill buttons with the standard coarse-pointer target and visible focus. Show the platform and reported target label when active or paused. Keep Stop beside pending, active, and paused status, separate from stopping prompt generation, and show Resume beside Stop when paused with the plain-word pause reason. Pending Chrome control says that local approval is required without naming an approval surface. Web offers no approval or grant request. Report stopped cleanup separately from unavailability.

Reveal the labeled preview only on request, in companion Activity from 1280px and inline below the status at narrower widths. Keep focus on the invoking button. Bound the preview to the available width and a 12rem by 25vh height cap, letterbox it on the raised plane, and state when it is withheld. Render at most one frame, without motion or download affordances. Closing the preview, changing views or connection, changing grant generation, or stopping clears the frame. `verify/interaction-control.integration.test.ts` exercises the rendered status, reveal and Stop.

| Source family | Existing owner | Preserved behavior |
| --- | --- | --- |
| Landing, site header and footer | `src/ui/site.tsx`, `src/styles/site.css`, `src/content/site.ts` | Real destinations, install copy, offline notice and mobile navigation |
| Documentation index, article and search | `src/ui/docs.tsx`, `src/styles/docs.css`, `src/content/docs/registry.ts` | Registry-backed pages and results, keyboard selection, trapped focus and return |
| Changelog and not found | `src/ui/changelog.tsx`, `src/ui/site.tsx`, `src/styles/site.css` | Actual release content, filters and recovery links |
| Conversation, rail and companion | `src/remote/ui/shell.tsx`, `src/remote/ui/shared-workspace.tsx`, `src/styles/remote.css` | Attached Session, reader anchor, drafts, Goal and autonomy controls |
| Activity bar, status bar and trace | `SharedActivityBar`, `SharedStatusBar` and `SharedTrace` in `src/remote/ui/shared-workspace.tsx`, `src/styles/workspace-shell.css`; destinations and readouts from `src/remote/ui/shell-model.ts` | Labeled destinations with `aria-current`, spoken badges, reported-only readouts, polite running count, reduced-motion trace poses |
| Requests and recorded answers | `src/remote/ui/form-request.tsx`, `src/remote/ui/shared-workspace.tsx` | Owned options, real pending requests and typed actions; displaying a recommendation settles nothing |
| Expanded Team and child inspector | `src/remote/ui/team-view.tsx`, `src/remote/ui/team-view.css`, `src/remote/ui/team-conversation.tsx`, `src/remote/queries.ts` | Bounded latest 40-message snapshot, Session/watermark validation and explicit refresh without leaving the master |
| Projects and coordination | `src/remote/ui/projects.tsx`, `src/remote/ui/projects.css` | Actual membership, ownership, counts, pending summaries and owner-Session navigation |
| Captured Changes | `src/remote/ui/file-change-card.tsx`, `src/remote/ui/file-change-card.css` | Recorded paths, counts and bounded unified diffs; no unsupported Git revert action |
| Usage and incidents | `src/remote/ui/usage.tsx`, `src/remote/ui/usage-model.ts` | Real reports, independent quota states, units and forecast provenance |
| Pickers, command palette and Dots | `src/ui/custom-select.tsx`, `src/remote/ui/command-palette.tsx` | Advertised model/profile choices, explicit decisions, focus and draft preservation |
| Settings, notifications, sign-in and invitation | `src/remote/ui/settings.tsx`, `src/remote/ui/settings.css`, `src/styles/remote.css`, `src/remote/ui/notifications.tsx`, `src/remote/ui/shell.tsx`, `src/remote/ui/invite.tsx` | Account/machine distinction, Settings spacing by role, actual mutation outcomes and supported enrollment |
| Provider connection and profiles | `src/remote/ui/provider-connect.tsx`, `src/remote/ui/provider-connect.css`, `src/ui/modal.tsx` | Scoped profile actions, reported metadata, bounded dialog/sheet and focus ownership |

Reuse shared Modal, Collapsible, buttons, fields, progress parts, notices, code blocks and scrollbars. Keep their leaf stylesheet ownership; moving component styles requires removing superseded global rules. Activity's four accounting slots retain inclusive labels and separate loading, unreported, value and unsupported-cost states. Empty/error inventories never appear alongside populated task rows.

Render user and assistant text, reasoning, substantive system and coordination notices, and narrative tool results as selectable Markdown. Keep terminal logs literal. Fenced code renders as a card on `--yc-plane-raised` with a `--yc-line-subtle` border, `--yc-radius-card` corners and a `--yc-plane-hover` header bar. The header starts with the `code` icon and the language label (Markdown, TypeScript, JavaScript, Rust, Python, JSON, Bash, or Code for an empty or unknown language) and ends with a Wrap lines toggle (`aria-pressed`) and a Copy code button that shows Copied with a check for 1.6 seconds. Copy writes the raw code text to the browser clipboard. The body uses JetBrains Mono, preserves whitespace and scrolls horizontally inside the `<pre>` unless Wrap lines is on, while the header stays still. Syntax spans use the `--yc-code-*` roles (keyword, string, number and literal, comment, function, type, property, meta; plain text uses `--yc-code-ink`); each reaches 4.5:1 on the raised and hover planes in the light and dark themes. Unknown languages render as plain text. The card classes are `transcript-md__code`, `transcript-md__code-head`, `transcript-md__code-lang`, `transcript-md__code-actions` and `transcript-md__code-button`; spans are `code-token code-token--<kind>`. The pending tray sits at the top of the composer body: a `--yc-plane-raised` card with a `--yc-line-subtle` border and a stacked edge while collapsed, a `--yc-weight-semibold` count, the first message as a one-line preview, and 32px icon actions (44px on coarse pointers). Use tone and spacing for open reasoning, tool and captured-file disclosures rather than framing each body.

Cursor roles belong to the shared foundation: surface, action, text, disabled, busy, pan, panning, zoom-in, horizontal adjustment and vertical resize. Components consume those declared roles rather than cursor keywords or document-wide pointer handlers. Background reads do not disable usable controls; Office restores its pan role after release or cancellation.

## Content

Product copy comes from the route's content owner and runtime, not the specimen's source-file captions, synthetic accounts, example versions or sample statistics. Keep every genuine reported message, tool, cost, quota and error even when the source stages less content. A source alternate state is not simultaneous content. The plain YCoding wordmark retains product identity without importing specimen monograms into every header.

New chat pairs the compact, neutral repository selector and refresh action directly above the composer's start edge so the composer card and submit control stay visually primary, keeps the real repository requirement accessible (`aria-required`, `aria-describedby`, the compact `Required` badge and the helper line) without a hue fill or border, and draws the green `:focus-visible` ring. Unsupported operations remain unavailable instead of gaining drawn controls. Preserve pending-request provenance, explicit denies, confirmation boundaries and uncertain outcomes; no uncertain mutation is automatically replayed.

Ordinary Session collections and Project root candidates exclude child Sessions and compaction helpers identified by the `compaction` agent or reserved `ses_compaction_` identity, never by title. Counts use those same projected rows. Direct Session and snapshot reads retain child metadata, side chats and parent navigation; opening a helper does not add it to an ordinary collection.

R1 geometry has coordinator approval for the bounded W47, W48 and W86 changes. Final visual acceptance remains pending.

## Touchpoints

This document governs `apps/web`. `.stitch/DESIGN.md` maps its approved source screens and extends this surface. Root R7 binds token drift; R9 assigns surface-specific type families and R12 owns Web structural boundaries. Chrome extension assets, embedded fonts, TUI typography and terminal settings keep their existing owners.

## Accessibility

Preserve semantic headings and landmarks, visible focus, keyboard navigation, native text selection, named controls and content-sized dialogs/sheets. Normal text needs 4.5:1; meaningful boundaries and focus need 3:1. Focus uses the green `--yc-focus` ring at 3:1 or more on every plane. Phone Context access MUST remain visible beside Team and Notifications; its control, companion tabs and other coarse-pointer actions MUST retain at least 44px targets and focus return. W7 owns standard and WebKit scrollbars unconditionally, with readable forced-color system inks. Contrast tests do not certify every rendered background or state.

Office, long transcripts and expanded changes stay reachable without page overflow. Public header controls retain 44px targets inside the 56px header. Source cards, HTML metadata and passing screenshots confer no decision authority.

## Verification

### Mobile boundary cases

Use the existing synthetic remote fixture, published local routes and pinned Chrome for Testing. The named cases in `verify/mobile-native.integration.test.ts` own the following observable contracts; they do not authorize live-account writes or visual acceptance.

| Case | Starting state and action | Required observation and forbidden effects |
| --- | --- | --- |
| Five destinations | Connected synthetic Conversation; inspect 320, 390 and 430px tabs and select each destination. | Projects, Sessions, Workspaces, Usage, Settings each stay on one line with 56px interactive height and 44px minimum width; safe-area padding is additional, current-page state follows navigation and the page does not overflow. |
| Sessions dismissal | A populated synthetic Session inventory; search, scroll, swipe left, reopen, then tap the scrim. | The drawer is at most 320px and full-height, contains overscroll, returns focus and restores search/list scroll; dismissal neither selects nor creates a Session. |
| Editing and sheets | A synthetic Conversation with an unsent draft; collapse/expand the dock, open agent/model and command sheets, dismiss by touch, request reduced motion and rotate to coarse landscape. | Editable text is at least 16px, sheets stay bounded and content-sized, focus returns, the draft survives and no prompt/model/command mutation is submitted. Native viewport events, not replaced browser properties, prove viewport tracking. |
| Project inspection | The populated coordination fixture; inspect Release train, select a member, return to members and close. | A named detail surface and Back/Close remain visible, the inspector replaces phone columns and list scroll/focus return; Open project still opens its Master and review actions stay with the owner Session. |
| Team inspection | Open Team from a synthetic conversation, inspect a reported child, use End, return to children, and dismiss each layer with Escape. | The child has one vertical scroll owner, the header stays pinned, and the last content is reachable. Back retains its full focus outline and returns to the selected row. The first Escape restores focus in Activity without horizontal overflow; the next returns focus to Open Team. |
| Workspace inspection | Previously opened synthetic repositories; inspect a workspace, close, reopen and open its Sessions. | The sheet shows the reported directory, closing restores list scroll/focus, and Sessions uses the genuine workspace filter without creating a Session. |
| Usage and Settings | Large synthetic usage values at 320 and 390px; open/dismiss quota details, enter Settings and operate local notification preferences. | Figures and legend remain readable, details stay viewport-bounded, Machine rows stack with name and action fully visible, switches retain 44px targets and headers stay single-line. Missing values and authorization do not change. |
| Public phone navigation | Local landing, Docs, article, Changelog and 404 at representative 320/390px; open/dismiss navigation, follow article contents and change release filters. | A clean single-row top bar, content-sized named sheets, reachable contents and filters, contained page width and keyboard/focus return; canonical content and destinations remain intact. |

Boundary/state-transition checks cover touch, keyboard, cancellation and retained state. Existing selected tests cover unavailable reads, staged selection, uncertain mutations and streaming scroll-away. Authentication, persistence, retries and concurrency retain their existing contracts; no new backend behavior is specified. Browser emulation proves rendered responses, not an iOS keyboard, physical safe area or device certification.

Run `python3 ~/.agents/skills/ui-design/scripts/design_md.py lint <file> --strict` on each changed canonical file and its inherited chain. Use the repository `audit:css` profile and run the raw scanner on affected CSS with `src/styles/base.css` for shared scrollbar ownership, `src/styles/tokens.css` for tokens, and this file for the design contract. Raw warnings fail.

Run `bun test --cwd apps/web src/styles/design-md.test.ts src/styles/tokens.test.ts src/styles/contrast.test.ts src/styles/typography.test.ts src/styles/composition.test.ts` and explicitly selected affected source/browser cases. Browser cases use the executable provisioned by `script/chrome-for-testing.ts .cache/chrome-for-testing`; no installed-browser substitute is evidence. Only the scrollbar suite enables visible scrollbars.

For Settings, provider, and coordination/Team geometry, use the synthetic fixtures in `verify/remote-shell-layout.integration.test.ts`, `verify/provider-connect.integration.test.ts`, `verify/workspace-rail-team.integration.test.ts`, and `verify/mobile-native.integration.test.ts`. Compare the same state at 1440×900 and 390×844 in light and dark, using keyboard focus. Record content insets and aligned edges, section and status gaps, scroll extent, visible focus and its clearance from neighboring content. Verify the Project disclosures and the shared model search and focus-return behavior with their owning cases; fixture reads and UI actions establish no live-account state.

Capture every indexed source scene from the real deterministic Web fixture or public route, with source and implementation images kept distinct. Record direct comparisons, source/runtime differences, commands, revisions and console/network outcomes in TOON. Validate with Aphrodite, run Web typecheck, scoped oxlint, build and `git diff --check`, then verify the local review and all linked resources. Keep visual acceptance blocked until Volk reviews it; technical passes are not acceptance.

## Maintenance

Obtain approval before changing a binding rule; update its source mapping, executable tokens/component, drift tests and affected checks in the same change. Preserve approved functional boundaries and unrelated work. Reinspect changed sources and invalidate dependent evidence; do not promote old capture or approval receipts to new bytes. Keep one canonical token owner and no obsolete source exclusion. Strict lint and bidirectional drift checks gate every chain change.

## Do's and Don'ts

- Do use directly inspected source composition and record every necessary runtime or accessibility difference.
- Don't fabricate capabilities, replace native UI with an image, hide a parent defect or infer acceptance from technical checks.

## Exceptions

| Rule | Scope | Reason and consumer effect | Approval | Review date |
| --- | --- | --- | --- | --- |
| W105 | Runtime data and unavailable source actions | Native pending-request inventories, seven estimated context categories, documentation registry and child snapshots remain truthful; unsupported destructive Git actions and invented Project history remain absent. These are visible source/runtime differences, not pixel parity. | approved functional boundary; visual acceptance pending | 2026-11-16 |
| R2 | Generated Markdown controls | A complete rendered owned-style audit is not established by the selected checks. Preserve native behavior and accessibility; unresolved variants remain review work. | pending | 2026-11-16 |
| W74 | Machine hostname subtitle | The current row exposes the hostname in its tooltip and edit action rather than in a second visible line. The Settings geometry contract does not change alias or hostname handling. | pending | 2026-11-19 |
