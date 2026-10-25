import { Dots } from "@ycoding-ai/schema/dots"

export function dotsPeerLabel(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return
  const peer = Dots.peer({ dots: Reflect.get(metadata, "dots") })
  if (!peer) return
  return `Dot ${peer.dotID} · external peer · ${peer.threadID}`.replace(/[\u0000-\u001f\u007f]/g, "�")
}
