import fs from "fs/promises"
import path from "path"

export interface Mutation {
  readonly operation: "mkdir" | "write" | "rename" | "remove"
  readonly path?: string
  readonly source?: string
  readonly destination?: string
}

export interface Filesystem extends Pick<typeof fs, "lstat" | "realpath" | "readdir" | "readFile"> {
  readonly beforeRead?: (path: string) => Promise<void>
  readonly beforeMutation?: (mutation: Mutation) => Promise<void>
  readonly afterMutation?: (mutation: Mutation) => Promise<void>
}

export type MutationRequest =
  | { readonly operation: "mkdir"; readonly root: string; readonly path: string }
  | {
      readonly operation: "write"
      readonly root: string
      readonly path: string
      readonly content: string
      readonly flag?: "wx"
    }
  | {
      readonly operation: "rename"
      readonly sourceRoot: string
      readonly destinationRoot: string
      readonly source: string
      readonly destination: string
      readonly replace?: boolean
    }
  | { readonly operation: "remove"; readonly root: string; readonly path: string; readonly recursive: boolean }

export class UnsafeMutationError extends Error {}

export const native: Filesystem = {
  lstat: fs.lstat,
  realpath: fs.realpath,
  readdir: fs.readdir,
  readFile: fs.readFile,
}

export async function executeMutation(filesystem: Filesystem, request: MutationRequest) {
  const bindings =
    request.operation === "rename"
      ? [
          { root: request.sourceRoot, target: request.source },
          { root: request.destinationRoot, target: request.destination },
        ]
      : [{ root: request.root, target: request.path }]
  const before = await Promise.all(bindings.map(bindingIdentity))
  if (request.operation === "rename" && !request.replace && (await pathExists(request.destination))) {
    throw new UnsafeMutationError("rename destination exists")
  }
  const mutation = mutationMetadata(request)
  await filesystem.beforeMutation?.(mutation)
  const after = await Promise.all(bindings.map(bindingIdentity))
  if (!sameBindings(before, after)) throw new UnsafeMutationError("filesystem identity changed before mutation")
  if (request.operation === "rename" && !request.replace && (await pathExists(request.destination))) {
    throw new UnsafeMutationError("rename destination appeared before mutation")
  }

  if (request.operation === "mkdir") await fs.mkdir(request.path)
  if (request.operation === "write") {
    await fs.writeFile(request.path, request.content, request.flag ? { flag: request.flag } : undefined)
  }
  if (request.operation === "rename") await fs.rename(request.source, request.destination)
  if (request.operation === "remove") await fs.rm(request.path, { recursive: request.recursive, force: true })
  await filesystem.afterMutation?.(mutation)
}

interface BindingIdentity {
  readonly root: string
  readonly target: string
  readonly components: readonly ComponentIdentity[]
}

interface ComponentIdentity {
  readonly path: string
  readonly exists: boolean
  readonly device?: number
  readonly inode?: number
  readonly mode?: number
}

async function bindingIdentity(binding: { readonly root: string; readonly target: string }): Promise<BindingIdentity> {
  const root = path.resolve(binding.root)
  const target = path.resolve(binding.target)
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new UnsafeMutationError("mutation escapes root")
  const canonicalRoot = await fs.realpath(root).catch(() => undefined)
  const rootInfo = await fs.lstat(root).catch(() => undefined)
  if (!canonicalRoot || !rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new UnsafeMutationError("unsafe mutation root")
  }
  const paths = [root, ...componentPaths(root, relative)]
  const components: ComponentIdentity[] = []
  for (const [index, current] of paths.entries()) {
    const info = await fs.lstat(current).catch(() => undefined)
    if (!info) {
      components.push({ path: current, exists: false })
      break
    }
    if (info.isSymbolicLink()) throw new UnsafeMutationError("symbolic link in mutation path")
    if (index < paths.length - 1 && !info.isDirectory())
      throw new UnsafeMutationError("non-directory mutation ancestor")
    const canonical = await fs.realpath(current).catch(() => undefined)
    if (!canonical || (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`))) {
      throw new UnsafeMutationError("canonical mutation escape")
    }
    components.push({ path: current, exists: true, device: info.dev, inode: info.ino, mode: info.mode })
  }
  return { root, target, components }
}

function sameBindings(left: readonly BindingIdentity[], right: readonly BindingIdentity[]) {
  return (
    left.length === right.length &&
    left.every((binding, index) => {
      const compared = right[index]
      return (
        !!compared &&
        binding.root === compared.root &&
        binding.target === compared.target &&
        binding.components.length === compared.components.length &&
        binding.components.every((component, componentIndex) => {
          const other = compared.components[componentIndex]
          return (
            !!other &&
            component.path === other.path &&
            component.exists === other.exists &&
            component.device === other.device &&
            component.inode === other.inode &&
            component.mode === other.mode
          )
        })
      )
    })
  )
}

function mutationMetadata(request: MutationRequest): Mutation {
  if (request.operation === "rename") {
    return { operation: request.operation, source: request.source, destination: request.destination }
  }
  return { operation: request.operation, path: request.path }
}

function componentPaths(root: string, relative: string) {
  if (!relative) return []
  return relative.split(path.sep).map((_, index, parts) => path.join(root, ...parts.slice(0, index + 1)))
}

async function pathExists(target: string) {
  return !!(await fs.lstat(target).catch(() => undefined))
}
