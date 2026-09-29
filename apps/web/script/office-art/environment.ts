import { canvas } from "./canvas"
import { environmentFurniture } from "./furniture"

export { environmentFurniture }

export function environmentTiles() {
  const sheet = canvas(288, 32)
  const bases = ["#eadcc6", "#b7bbc3", "#8595b7", "#e6e1ef", "#dce8e9", "#dcb48b", "#b0bfa3", "#d3cec4", "#efdcc6"]
  for (const [frame, base] of bases.entries()) {
    const x = frame * 32
    sheet.rect(x, 0, 32, 32, base)
    if (frame === 0) {
      for (let y = 0; y < 32; y += 8) {
        sheet.rect(x, y, 32, 1, "#c6b59e")
        sheet.rect(x, y + 1, 32, 1, "#f4e9d9")
        for (let joint = (y / 8) % 2 ? 8 : 0; joint < 32; joint += 16) sheet.rect(x + joint, y + 2, 1, 6, "#d4c3ac")
      }
      for (const [dx, dy] of [[5, 4], [22, 12], [11, 27]] as const) sheet.rect(x + dx, dy, 2, 1, "#f8eddf")
    }
    if (frame === 1) {
      for (let y = 0; y < 32; y += 8) for (let dx = 0; dx < 32; dx += 8) {
        if ((y / 8 + dx / 8) % 2 === 0) sheet.rect(x + dx, y, 8, 8, "#a5aab5")
        sheet.rect(x + dx, y, 8, 1, "#cbd0d6")
        sheet.rect(x + dx, y, 1, 8, "#8e95a0")
      }
    }
    if (frame === 2) {
      for (let dx = 0; dx < 32; dx += 6) {
        sheet.rect(x + dx, 0, 3, 32, dx % 12 ? "#9387ad" : "#738eae")
        sheet.rect(x + dx + 3, 0, 1, 32, "#a8a5c3")
      }
      for (let y = 3; y < 32; y += 11) sheet.rect(x, y, 32, 1, "#7d83a5")
    }
    if (frame === 3) {
      for (let y = 0; y < 32; y++) for (let dx = 0; dx < 32; dx++) {
        const edge = Math.abs(dx % 16 - 8) + Math.abs(y % 16 - 8)
        if (edge === 7) sheet.pixel(x + dx, y, "#c7bdd9")
        if (edge === 8) sheet.pixel(x + dx, y, "#f8f4fa")
      }
    }
    if (frame === 4) {
      for (let y = 0; y < 32; y += 8) for (let dx = 0; dx < 32; dx += 8) {
        sheet.rect(x + dx + 1, y + 1, 7, 7, (dx / 8 + y / 8) % 2 ? "#e4eef0" : "#d4e2e5")
        sheet.rect(x + dx, y, 8, 1, "#b7cbd2")
        sheet.rect(x + dx, y, 1, 8, "#b7cbd2")
        sheet.pixel(x + dx + 5, y + 5, "#f4f8f3")
      }
    }
    if (frame === 5) {
      for (let y = 0; y < 32; y += 8) {
        sheet.rect(x, y, 32, 1, "#aa795a")
        sheet.rect(x, y + 1, 32, 1, "#efd0a8")
        sheet.rect(x + (y % 16 ? 10 : 24), y + 2, 1, 6, "#b98b68")
        for (let dx = 2; dx < 32; dx += 9) sheet.rect(x + dx, y + 5, 5, 1, "#c99a72")
      }
    }
    if (frame === 6) {
      for (let y = 0; y < 32; y += 4) for (let dx = (y / 4) % 2 * 2; dx < 32; dx += 4) {
        sheet.rect(x + dx, y, 2, 2, "#9fb094")
        sheet.pixel(x + dx, y + 2, "#c2cfb5")
      }
    }
    if (frame === 7) {
      for (const edge of [0, 16]) {
        sheet.rect(x, edge, 32, 1, "#b9b3a8")
        sheet.rect(x, edge + 1, 32, 1, "#e6e2d9")
        sheet.rect(x + (edge ? 0 : 8), edge + 1, 1, 15, "#b9b3a8")
        sheet.rect(x + (edge ? 24 : 8) + (edge ? 0 : 16), edge + 1, 1, 15, "#b9b3a8")
      }
      for (const [dx, dy] of [[4, 6], [20, 4], [14, 22], [27, 26]] as const) sheet.rect(x + dx, dy, 3, 1, "#dfdad0")
    }
    if (frame === 8) {
      for (let y = 0; y < 32; y += 16) for (let dx = 0; dx < 32; dx += 16) {
        if ((y + dx) % 32 === 0) sheet.rect(x + dx, y, 16, 16, "#d9b596")
        sheet.rect(x + dx, y, 16, 1, "#c99f7f")
        sheet.rect(x + dx, y, 1, 16, "#c99f7f")
        sheet.rect(x + dx + 3, y + 3, 4, 1, "#f6e9d7")
      }
    }
  }
  return sheet
}

export function wallTiles() {
  const sheet = canvas(128, 32)
  for (let frame = 0; frame < 4; frame++) {
    const x = frame * 32
    sheet.rect(x, 0, 32, 32, "#445466")
    sheet.rect(x, 0, 32, 5, "#344354")
    sheet.rect(x, 5, 32, 2, "#aeb7c3")
    sheet.rect(x + 1, 7, 30, 19, "#778696")
    sheet.rect(x + 1, 26, 30, 2, "#506374")
    sheet.rect(x, 28, 32, 4, "#364a59")
    sheet.rect(x + 15, 8, 1, 17, "#667889")
    if (frame === 1) {
      sheet.rect(x + 3, 7, 26, 19, "#405b72")
      sheet.rect(x + 5, 9, 22, 15, "#98c7d8")
      sheet.rect(x + 6, 10, 20, 12, "#b0d9e8")
      sheet.rect(x + 7, 10, 4, 11, "#d8f2f5")
      sheet.rect(x + 16, 10, 2, 12, "#e7f7f6")
      sheet.rect(x + 4, 16, 24, 2, "#526d81")
      sheet.rect(x + 27, 8, 2, 18, "#2e485e")
    }
    if (frame === 2) {
      sheet.rect(x + 4, 8, 24, 24, "#e9d9c2")
      sheet.rect(x + 3, 4, 4, 28, "#87664f")
      sheet.rect(x + 25, 4, 4, 28, "#87664f")
      sheet.rect(x + 4, 4, 24, 4, "#bc926a")
      sheet.rect(x + 7, 8, 18, 2, "#f8e4c7")
      sheet.rect(x + 7, 29, 18, 3, "#b38c66")
    }
    if (frame === 3) {
      sheet.rect(x + 3, 4, 26, 28, "#52687b")
      sheet.rect(x + 6, 6, 20, 23, "#a7d4df")
      sheet.rect(x + 7, 7, 18, 20, "#9bc8d6")
      sheet.rect(x + 7, 7, 3, 19, "#def3ee")
      sheet.line(x + 10, 9, x + 21, 20, "#effbf2")
      sheet.rect(x + 14, 6, 3, 24, "#567184")
      sheet.rect(x + 3, 28, 26, 4, "#324c5d")
      sheet.rect(x + 21, 20, 2, 3, "#d4a567")
    }
  }
  return sheet
}
