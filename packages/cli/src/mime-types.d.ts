declare module "mime-types" {
  export function lookup(filenameOrExt: string): string | false
}
