import { deflateSync } from "node:zlib"
import type { PixelArt } from "./canvas"

const crcTable = Uint32Array.from(Array.from({ length: 256 }, (_, n) => {
  let value = n
  for (let index = 0; index < 8; index++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
}))

function crc32(buffer: Uint8Array) {
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function chunk(name: string, data: Uint8Array) {
  const body = Buffer.concat([Buffer.from(name), data])
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([header, body, tail])
}

export function encodePNG(art: PixelArt) {
  if (art.pixels.length !== art.width * art.height * 4) throw new Error("Invalid office art pixel buffer")
  const raw = Buffer.alloc((art.width * 4 + 1) * art.height)
  for (let row = 0; row < art.height; row++) {
    raw.set(art.pixels.subarray(row * art.width * 4, (row + 1) * art.width * 4), row * (art.width * 4 + 1) + 1)
  }
  const dimensions = Buffer.alloc(13)
  dimensions.writeUInt32BE(art.width, 0)
  dimensions.writeUInt32BE(art.height, 4)
  dimensions[8] = 8
  dimensions[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", dimensions), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}
