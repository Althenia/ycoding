import { createCanvas, loadImage } from "@napi-rs/canvas"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const brand = path.join(root, "assets", "brand")

const jobs = [
  { source: "ycoding-mark.svg", target: "ycoding-mark-256.png", size: 256 },
  { source: "ycoding-mark.svg", target: "ycoding-mark-512.png", size: 512 },
  { source: "ycoding-icon.svg", target: "ycoding-icon-256.png", size: 256 },
  { source: "ycoding-icon.svg", target: "ycoding-icon-512.png", size: 512 },
] as const

for (const job of jobs) {
  const source = path.join(brand, job.source)
  const target = path.join(brand, job.target)
  const image = await loadImage(Buffer.from(await Bun.file(source).arrayBuffer()))
  const canvas = createCanvas(job.size, job.size)
  const context = canvas.getContext("2d")
  context.clearRect(0, 0, job.size, job.size)
  context.drawImage(image, 0, 0, job.size, job.size)
  await Bun.write(target, canvas.toBuffer("image/png"))
  console.log(`${path.relative(root, target)} ${job.size}x${job.size}`)
}
