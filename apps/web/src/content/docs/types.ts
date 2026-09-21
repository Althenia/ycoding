export const DOC_GROUPS = ["Get started", "Use", "Configuration", "Help"] as const

export type DocGroup = (typeof DOC_GROUPS)[number]

export type DocBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "code"; readonly language: string; readonly label?: string; readonly code: string }
  | { readonly kind: "list"; readonly items: readonly string[]; readonly ordered?: boolean }
  | { readonly kind: "steps"; readonly items: readonly { readonly title: string; readonly text: string }[] }
  | { readonly kind: "callout"; readonly tone: "info" | "warning" | "tip"; readonly title: string; readonly text: string }
  | { readonly kind: "table"; readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "cards"; readonly items: readonly { readonly title: string; readonly text: string; readonly href: string }[] }
  | { readonly kind: "related"; readonly slugs: readonly string[] }

export type DocSection = {
  readonly heading: string
  readonly blocks: readonly DocBlock[]
}

export type DocPage = {
  readonly slug: string
  readonly title: string
  readonly group: DocGroup
  readonly description: string
  readonly sections: readonly DocSection[]
}
