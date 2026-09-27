export type PixelArt = { readonly width: number; readonly height: number; readonly pixels: Uint8Array }

export function canvas(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 4)
  const pixel = (x: number, y: number, color: string) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = (Math.floor(y) * width + Math.floor(x)) * 4
    pixels[offset] = Number.parseInt(color.slice(1, 3), 16)
    pixels[offset + 1] = Number.parseInt(color.slice(3, 5), 16)
    pixels[offset + 2] = Number.parseInt(color.slice(5, 7), 16)
    pixels[offset + 3] = color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) : 255
  }
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) pixel(col, row, color)
    }
  }
  const line = (x0: number, y0: number, x1: number, y1: number, color: string) => {
    let x = x0
    let y = y0
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let error = dx + dy
    while (true) {
      pixel(x, y, color)
      if (x === x1 && y === y1) return
      const twice = 2 * error
      if (twice >= dy) { error += dy; x += sx }
      if (twice <= dx) { error += dx; y += sy }
    }
  }
  const ellipse = (x: number, y: number, w: number, h: number, color: string) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const dx = (col + 0.5 - x - w / 2) / (w / 2)
      const dy = (row + 0.5 - y - h / 2) / (h / 2)
      if (dx * dx + dy * dy <= 1) pixel(col, row, color)
    }
  }
  const roundRect = (x: number, y: number, w: number, h: number, color: string) => {
    for (let row = 0; row < h; row++) {
      const inset = row === 0 || row === h - 1 ? 3 : row === 1 || row === h - 2 ? 1 : 0
      rect(x + inset, y + row, w - inset * 2, 1, color)
    }
  }
  const blit = (source: PixelArt, x: number, y: number) => {
    for (let row = 0; row < source.height; row++) for (let col = 0; col < source.width; col++) {
      const from = (row * source.width + col) * 4
      if (!source.pixels[from + 3] || x + col < 0 || y + row < 0 || x + col >= width || y + row >= height) continue
      pixels.set(source.pixels.subarray(from, from + 4), ((y + row) * width + x + col) * 4)
    }
  }
  return { width, height, pixels, pixel, rect, line, ellipse, roundRect, blit }
}
