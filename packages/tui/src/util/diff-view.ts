export const MIN_SPLIT_WIDTH = 100

export function diffViewForWidth(preference: "auto" | "split" | "unified" | undefined, width: number) {
  if (width < MIN_SPLIT_WIDTH || preference === "unified") return "unified"
  return "split"
}
