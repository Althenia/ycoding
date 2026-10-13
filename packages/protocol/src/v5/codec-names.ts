import type { FileDescriptorSet, DescriptorProto } from "@bufbuild/protobuf/wkt"

const tsReserved = new Set(
  "break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield enum implements interface let package private protected public static Object bigint number boolean string object globalThis Uint8Array Partial".split(
    " ",
  ),
)

export function rustWords(name: string) {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .flatMap((word) => {
      const parts: string[] = []
      let start = 0
      let mode = 0
      for (let index = 0; index < word.length - 1; index++) {
        const char = word[index]!
        const next = word[index + 1]!
        const lower = /[a-z]/.test(char)
        const upper = /[A-Z]/.test(char)
        const nextMode = lower ? 1 : upper ? 2 : mode
        if (nextMode === 1 && /[A-Z]/.test(next)) {
          parts.push(word.slice(start, index + 1))
          start = index + 1
          mode = 0
          continue
        }
        if (mode === 2 && upper && /[a-z]/.test(next)) {
          parts.push(word.slice(start, index))
          start = index
          mode = 0
          continue
        }
        mode = nextMode
      }
      parts.push(word.slice(start))
      return parts.map((part) => part.toLowerCase())
    })
}

export function rustTypeName(name: string) {
  const value = rustWords(name)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("")
  return value === "Self" ? "Self_" : /^[0-9]/.test(value) ? `_${value}` : value
}

export function codecNameCollisions(set: FileDescriptorSet) {
  const rust = new Map<string, string>()
  const ts = new Map<string, string>()
  const collisions: string[] = []
  const register = (language: string, names: Map<string, string>, name: string, source: string) => {
    const previous = names.get(name)
    if (previous && previous !== source)
      collisions.push(`${language} codec name collision ${name}: ${previous} and ${source}`)
    if (!previous) names.set(name, source)
  }
  for (const file of set.file.filter((file) => file.name?.startsWith("ycoding/v5/"))) {
    const visit = (name: string, nesting: string[]) => {
      const source = `${file.name}:${file.package}.${[...nesting, name].join(".")}`
      const module = [...(file.package?.split(".") ?? []), ...nesting]
        .map((part) => rustWords(part).join("_"))
        .join("::")
      register("Rust", rust, `${module}::${rustTypeName(name)}`, source)
      const flat = [...nesting, name].join("_")
      const shape = tsReserved.has(flat) ? `${flat}$` : flat
      register("TypeScript", ts, shape, source)
      register("TypeScript", ts, `${flat}Schema`, source)
    }
    const message = (item: DescriptorProto, nesting: string[]) => {
      visit(item.name!, nesting)
      const itemName = item.name!
      item.enumType.forEach((item) => visit(item.name!, [...nesting, itemName]))
      item.nestedType.forEach((item) => message(item, [...nesting, itemName]))
    }
    file.enumType.forEach((item) => visit(item.name!, []))
    file.messageType.forEach((item) => message(item, []))
  }
  return collisions
}

export function validateCodecNames(set: FileDescriptorSet) {
  const collisions = codecNameCollisions(set)
  if (collisions.length) throw new Error(collisions.join("\n"))
}
