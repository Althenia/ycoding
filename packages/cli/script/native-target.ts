export function nativeBuildTarget(input: { os: string; arch: string; single?: boolean; baseline?: boolean; target?: string }) {
  const supported = (input.os === "darwin" && (input.arch === "arm64" || input.arch === "x64")) ||
    ((input.os === "linux" || input.os === "win32") && input.arch === "x64")
  if (!supported || input.target !== undefined && input.target !== `${input.os}-${input.arch}`)
    throw new Error("Native builds require a supported matching native host")
  if (input.baseline && input.arch !== "x64") throw new Error("Baseline builds require an x64 native host")
  return { os: input.os as "linux" | "darwin" | "win32", arch: input.arch as "arm64" | "x64", ...(input.baseline ? { avx2: false as const } : {}) }
}
