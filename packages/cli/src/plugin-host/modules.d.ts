declare module "npm-package-arg" {
  export default function npa(specification: string): { readonly name?: string | null }
}

declare module "@npmcli/arborist" {
  type Tree = {
    edgesOut: Map<string, { to?: { name: string; path: string } | null }>
  }

  export class Arborist {
    constructor(options: Record<string, unknown>)
    readonly options: Record<string, unknown>
    reify(options: Record<string, unknown>): Promise<Tree & { target: Tree }>
  }
}
