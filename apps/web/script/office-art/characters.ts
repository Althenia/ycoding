import {
  characterAppearances,
  characterColumnCount,
  characterDirections,
  characterFrameHeight,
  characterFrameWidth,
} from "../../src/remote/office/sprites"

export type PixelSheet = { readonly width: number; readonly height: number; readonly pixels: Uint8Array }

type Canvas = PixelSheet & {
  pixel(x: number, y: number, color: string): void
  rect(x: number, y: number, width: number, height: number, color: string): void
  oval(cx: number, cy: number, rx: number, ry: number, color: string): void
}

type Look = {
  skin: string
  hair: string
  shirt: string
  pants: string
  shoes: string
  style: "crop" | "long" | "afro" | "part" | "bun" | "spikes" | "ponytail" | "buzz" | "waves" | "cap" | "beanie" | "hat"
  clothes: "hoodie" | "jacket" | "sweater" | "shirt" | "dress"
  accessory?: "glasses" | "headphones"
}

const looks: readonly Look[] = [
  { skin: "#dba67d", hair: "#292e3d", shirt: "#8996a0", pants: "#48526b", shoes: "#b89475", style: "cap", clothes: "hoodie" },
  { skin: "#e8b98d", hair: "#9b4f39", shirt: "#4a8065", pants: "#485b6e", shoes: "#7b493e", style: "long", clothes: "shirt" },
  { skin: "#9a5b45", hair: "#332932", shirt: "#d4a45f", pants: "#4c5961", shoes: "#ede0b8", style: "afro", clothes: "sweater" },
  { skin: "#bd8261", hair: "#593e32", shirt: "#b46058", pants: "#4c6475", shoes: "#5c3a3e", style: "bun", clothes: "dress" },
  { skin: "#f3d0a8", hair: "#6d5545", shirt: "#80b5c1", pants: "#354967", shoes: "#845e45", style: "spikes", clothes: "shirt", accessory: "glasses" },
  { skin: "#c88d6d", hair: "#282d42", shirt: "#785e9d", pants: "#465466", shoes: "#e5d6b5", style: "ponytail", clothes: "jacket", accessory: "headphones" },
  { skin: "#754b3d", hair: "#a28b68", shirt: "#619198", pants: "#3d4a52", shoes: "#b99e76", style: "buzz", clothes: "jacket" },
  { skin: "#e1aa80", hair: "#b78a57", shirt: "#ab7954", pants: "#667768", shoes: "#7b5543", style: "hat", clothes: "shirt" },
  { skin: "#ad7055", hair: "#3f353b", shirt: "#cc8078", pants: "#475269", shoes: "#e6cfaa", style: "waves", clothes: "dress", accessory: "glasses" },
  { skin: "#e9c2a0", hair: "#485669", shirt: "#7e9b70", pants: "#65586b", shoes: "#6f4d43", style: "beanie", clothes: "hoodie" },
  { skin: "#895a48", hair: "#614635", shirt: "#d4b878", pants: "#465d72", shoes: "#4c3b38", style: "part", clothes: "sweater", accessory: "glasses" },
  { skin: "#c38a66", hair: "#b6a0a0", shirt: "#557e87", pants: "#666370", shoes: "#d6bd91", style: "crop", clothes: "hoodie" },
]

function shade(hex: string, amount: number) {
  const channel = (offset: number) => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * (amount < 0 ? 1 + amount : 1 - amount) + (amount < 0 ? 0 : 255 * amount)).toString(16).padStart(2, "0")
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

function canvas(width: number, height: number): Canvas {
  const pixels = new Uint8Array(width * height * 4)
  const pixel = (x: number, y: number, color: string) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const at = (Math.floor(y) * width + Math.floor(x)) * 4
    for (let i = 0; i < 3; i++) pixels[at + i] = parseInt(color.slice(i * 2 + 1, i * 2 + 3), 16)
    pixels[at + 3] = 255
  }
  return {
    width, height, pixels, pixel,
    rect(x, y, w, h, color) {
      for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) pixel(col, row, color)
    },
    oval(cx, cy, rx, ry, color) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) pixel(x, y, color)
      }
    },
  }
}

function drawHair(art: Canvas, look: Look, direction: number, bob: number) {
  const back = direction === 3
  const side = direction === 1 || direction === 2
  const dark = shade(look.hair, -0.28)
  const light = shade(look.hair, 0.22)
  const y = bob
  if (look.style === "long" || look.style === "waves" || look.style === "ponytail") {
    art.oval(16, back ? 17 + y : 11 + y, 10, back ? 12 : 7, dark)
    art.rect(7, 18 + y, 4, 12, dark)
    art.rect(22, 18 + y, 4, 12, look.hair)
    art.rect(8, 23 + y, 3, 8, light)
    if (back) {
      art.oval(16, 18 + y, 7, 9, look.hair)
      art.rect(12, 16 + y, 3, 10, light)
    }
    if (look.style === "waves") {
      art.oval(8, 28 + y, 3, 4, look.hair)
      art.oval(24, 29 + y, 3, 4, dark)
      art.pixel(9, 30 + y, light)
      art.pixel(23, 27 + y, light)
    }
    if (look.style === "ponytail") {
      art.rect(side ? 8 : 22, 17 + y, 4, 4, "#d6a772")
      art.oval(side ? 7 : 25, 23 + y, 3, 6, look.hair)
    }
  }
  if (look.style === "bun") {
    art.oval(16, 8 + y, 7, 6, dark)
    art.oval(18, 7 + y, 5, 4, look.hair)
    art.rect(19, 5 + y, 3, 2, light)
  }
  if (look.style === "afro") {
    art.oval(16, back ? 15 + y : 10 + y, 11, back ? 11 : 8, dark)
    for (const [x, yy, r] of [[9, 8, 4], [15, 6, 5], [22, 8, 4], [7, 16, 4], [25, 15, 4], [7, 21, 3], [25, 21, 3]] as const) art.oval(x, yy + y, r, r, look.hair)
    if (back) art.oval(16, 17 + y, 7, 8, look.hair)
    for (const [x, yy] of [[9, 8], [14, 5], [20, 7], [7, 14], [24, 13], [7, 19]] as const) art.rect(x, yy + y, 2, 2, light)
    return
  }
  if (look.style === "buzz") {
    art.oval(16, 11 + y, 8, 6, look.hair)
    art.rect(10, 9 + y, 5, 1, light)
    return
  }
  art.oval(16, 11 + y, 9, look.style === "hat" ? 5 : 7, dark)
  art.oval(15, 10 + y, 8, 5, look.hair)
  if (back) {
    art.oval(16, 16 + y, 8, 8, look.hair)
    art.rect(11, 14 + y, 3, 5, light)
    art.rect(16, 16 + y, 2, 5, light)
  } else if (look.style !== "hat" && look.style !== "cap" && look.style !== "beanie") {
    art.rect(8, 12 + y, side ? 10 : 7, 4, look.hair)
    art.rect(side ? 9 : 19, 13 + y, side ? 4 : 5, 3, look.hair)
    art.rect(10, 9 + y, 6, 2, light)
  }
  if (look.style === "spikes") {
    for (const [x, h] of [[9, 5], [14, 4], [20, 5]] as const) {
      art.rect(x, h + y, 3, 5, look.hair)
      art.pixel(x + 1, h - 1 + y, light)
    }
  }
  if (look.style === "part") {
    art.rect(12, 10 + y, 2, 5, light)
    art.rect(15, 12 + y, 7, 3, look.hair)
  }
  if (look.style === "crop") {
    art.rect(10, 8 + y, 6, 2, light)
    art.rect(8, 13 + y, 3, 5, dark)
  }
  if (look.style === "beanie") {
    art.oval(16, 11 + y, 9, 7, shade(look.shirt, -0.25))
    art.rect(8, 12 + y, 17, 4, look.shirt)
    art.rect(9, 13 + y, 14, 1, shade(look.shirt, 0.28))
    art.rect(14, 3 + y, 4, 2, shade(look.shirt, 0.28))
  }
  if (look.style === "cap") {
    art.oval(16, 10 + y, 9, 6, look.hair)
    art.rect(side ? 19 : 9, 14 + y, side ? 8 : 15, 2, dark)
    art.rect(11, 7 + y, 7, 1, light)
  }
  if (look.style === "hat") {
    const straw = "#d8b976"
    art.oval(16, 10 + y, 9, 6, straw)
    art.rect(5, 14 + y, 22, 2, "#b78e57")
    art.rect(7, 13 + y, 18, 2, straw)
    art.rect(10, 11 + y, 12, 2, "#795c4a")
    art.rect(12, 7 + y, 7, 1, "#f3dfa3")
  }
}

function drawPerson(look: Look, direction: number, column: number) {
  if (direction === 1 || direction === 2) return drawSidePerson(look, column, direction === 1)
  const art = canvas(characterFrameWidth, characterFrameHeight)
  const back = direction === 3
  const sitting = column >= 8 && column <= 10
  const walking = column >= 2 && column <= 5
  const step = walking ? column - 2 : 0
  const bob = column === 1 || column === 3 || column === 5 ? -1 : 0
  const headBob = bob + (sitting ? 2 : 0)
  const clothDark = shade(look.shirt, -0.25)
  const clothLight = shade(look.shirt, 0.26)
  const skinLight = shade(look.skin, 0.2)
  const skinDark = shade(look.skin, -0.22)
  const trouserDark = shade(look.pants, -0.24)
  const shoeLight = shade(look.shoes, 0.23)

  if (sitting) {
    art.rect(11, 34, 12, 5, look.pants)
    art.rect(10, 37, 6, 7, look.pants)
    art.rect(18, 37, 6, 7, trouserDark)
    art.rect(9, 44, 8, 2, look.shoes)
    art.rect(17, 44, 8, 2, look.shoes)
    art.rect(11, 45, 5, 1, shoeLight)
    art.rect(19, 45, 5, 1, shoeLight)
  } else {
    const leftLeg = walking ? (step === 0 ? 7 : step === 2 ? 19 : 10) : 10
    const rightLeg = walking ? (step === 0 ? 19 : step === 2 ? 7 : 19) : 19
    art.rect(leftLeg, 34, 5, step === 1 ? 8 : 10, look.pants)
    art.rect(rightLeg, 34, 5, step === 3 ? 8 : 10, trouserDark)
    art.rect(leftLeg - 1, step === 1 ? 42 : 43, 6, 3, look.shoes)
    art.rect(rightLeg - 1, step === 3 ? 42 : 43, 6, 3, look.shoes)
    art.rect(leftLeg, step === 1 ? 43 : 44, 5, 1, shoeLight)
    art.rect(rightLeg, step === 3 ? 43 : 44, 5, 1, shoeLight)
  }

  const torsoY = (sitting ? 27 : 25) + bob
  art.oval(16, torsoY + 5, 9, 7, clothDark)
  art.rect(9, torsoY + 3, 14, sitting ? 8 : 10, look.shirt)
  art.rect(10, torsoY + 3, 10, 2, clothLight)
  art.rect(21, torsoY + 5, 2, 7, clothDark)
  if (look.clothes === "dress") {
    art.rect(9, torsoY + 9, 14, 3, look.shirt)
    art.rect(7, torsoY + 11, 18, 3, clothDark)
    art.rect(9, torsoY + 10, 3, 3, clothLight)
  }
  if (look.clothes === "jacket") {
    art.rect(13, torsoY + 2, 7, 9, shade(look.shirt, 0.4))
    art.rect(10, torsoY + 3, 3, 9, clothDark)
    art.rect(20, torsoY + 3, 3, 9, clothDark)
    art.rect(16, torsoY + 4, 1, 7, "#ead8bb")
  }
  if (look.clothes === "hoodie") {
    art.rect(11, torsoY, 10, 3, clothDark)
    art.rect(13, torsoY + 2, 6, 2, clothLight)
    art.rect(15, torsoY + 4, 1, 5, "#d6c7a6")
    art.rect(19, torsoY + 4, 1, 4, "#d6c7a6")
    art.rect(12, torsoY + 9, 8, 1, clothDark)
  }
  if (look.clothes === "sweater") {
    art.rect(10, torsoY + 10, 13, 2, clothDark)
    art.rect(12, torsoY + 3, 8, 1, clothLight)
  }
  if (look.clothes === "shirt") {
    art.rect(14, torsoY + 2, 5, 2, shade(look.shirt, -0.34))
    art.rect(15, torsoY + 3, 2, 2, skinDark)
  }

  const leftArm = walking ? (step % 2 ? -2 : 1) : 0
  const rightArm = walking ? (step % 2 ? 1 : -2) : 0
  art.rect(6, torsoY + 3 + leftArm, 4, 9, clothDark)
  art.rect(22, torsoY + 3 + rightArm, 4, 9, look.shirt)
  art.rect(6, torsoY + 4 + leftArm, 1, 5, clothLight)
  art.rect(23, torsoY + 4 + rightArm, 1, 5, clothLight)
  art.rect(7, torsoY + 12 + leftArm, 3, 3, skinDark)
  art.rect(23, torsoY + 12 + rightArm, 3, 3, look.skin)

  if (column === 7 || column === 6) {
    art.rect(23, torsoY + (column === 7 ? -4 : -1), 4, 8, look.shirt)
    art.rect(23, torsoY + (column === 7 ? -7 : -4), 3, 4, skinLight)
  }
  if (column === 11) {
    art.rect(23, torsoY, 4, 7, look.shirt)
    art.rect(26, torsoY - 5, 4, 8, look.shirt)
    art.rect(27, torsoY - 14, 3, 10, look.shirt)
    art.rect(26, torsoY - 19, 4, 6, look.skin)
    art.rect(25, torsoY - 20, 5, 2, skinLight)
  }
  if (column === 9 || column === 10) {
    const shift = column === 10 ? 2 : 0
    art.rect(9, torsoY + 9 + shift, 5, 3, look.shirt)
    art.rect(19, torsoY + 11 - shift, 5, 3, clothDark)
    art.rect(11, torsoY + 12 + shift, 4, 2, skinLight)
    art.rect(20, torsoY + 14 - shift, 4, 2, look.skin)
  }
  if (column === 12 || column === 13) {
    const tilt = column === 13 ? 2 : 0
    art.rect(7, torsoY + 8, 6, 3, look.shirt)
    art.rect(11, torsoY + 10, 10, 6, "#795c4a")
    art.rect(12 + tilt, torsoY + 11, 7, 4, "#f3dfa3")
    art.rect(15 + tilt, torsoY + 11, 1, 4, "#b78e57")
    art.rect(20, torsoY + 10, 4, 4, look.skin)
  }
  if (column === 14) {
    art.rect(21, torsoY + 4, 4, 7, look.shirt)
    art.rect(23, torsoY + 10, 3, 4, look.skin)
  }
  if (column === 15 || column === 16) {
    const raised = column === 16 ? -2 : 0
    art.rect(22, torsoY + 2 + raised, 4, 8, look.shirt)
    art.rect(25, torsoY - 2 + raised, 4, 4, look.skin)
  }

  art.rect(14, 23 + headBob, 4, 4, skinDark)
  art.oval(16, 16 + headBob, 9, 10, skinDark)
  art.oval(15, 15 + headBob, 8, 9, look.skin)
  art.rect(9, 16 + headBob, 2, 5, skinLight)
  if (!back) {
    art.rect(11, 16 + headBob, 8, 4, skinLight)
    art.rect(21, 17 + headBob, 2, 4, look.skin)
  }
  drawHair(art, look, direction, headBob)
  if (!back) {
    const ink = shade(look.hair, -0.48)
    art.rect(11, 18 + headBob, 2, 3, ink)
    art.rect(19, 18 + headBob, 2, 3, ink)
    art.pixel(11, 18 + headBob, "#f8e9c9")
    art.pixel(19, 18 + headBob, "#f8e9c9")
    art.pixel(16, 21 + headBob, skinDark)
    art.rect(15, 23 + headBob, 3, column === 7 ? 2 : 1, column === 7 ? "#873f4a" : skinDark)
    if (look.accessory === "glasses") {
      art.rect(10, 17 + headBob, 5, 1, "#3c424c")
      art.rect(18, 17 + headBob, 5, 1, "#3c424c")
      art.rect(13, 20 + headBob, 2, 1, "#3c424c")
      art.rect(20, 20 + headBob, 2, 1, "#3c424c")
      art.rect(15, 18 + headBob, 3, 1, "#3c424c")
    }
  }
  if (look.accessory === "headphones") {
    art.rect(7, 13 + headBob, 2, 9, "#ceb88d")
    art.rect(23, 13 + headBob, 2, 9, "#ceb88d")
    art.rect(8, 7 + headBob, 16, 2, "#ceb88d")
    art.rect(6, 16 + headBob, 3, 6, "#52606f")
    art.rect(24, 16 + headBob, 3, 6, "#52606f")
  }

  return finishFrame(art, look, false)
}

function finishFrame(art: Canvas, look: Look, flip: boolean) {
  const outline = shade(look.hair, -0.48)
  const result = canvas(characterFrameWidth, characterFrameHeight)
  for (let y = 0; y < art.height; y++) for (let x = 0; x < art.width; x++) {
    if (!art.pixels[(y * art.width + x) * 4 + 3]) continue
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx >= 0 && ny >= 0 && nx < art.width && ny < art.height && !art.pixels[(ny * art.width + nx) * 4 + 3]) result.pixel(nx, ny, outline)
    }
  }
  for (let y = 0; y < art.height; y++) for (let x = 0; x < art.width; x++) {
    const at = (y * art.width + x) * 4
    if (!art.pixels[at + 3]) continue
    result.pixels.set(art.pixels.subarray(at, at + 4), at)
  }
  if (flip) {
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width / 2; x++) {
      const a = (y * result.width + x) * 4
      const b = (y * result.width + result.width - 1 - x) * 4
      const left = result.pixels.slice(a, a + 4)
      result.pixels.set(result.pixels.subarray(b, b + 4), a)
      result.pixels.set(left, b)
    }
  }
  return result
}

function drawSidePerson(look: Look, column: number, flip: boolean) {
  const art = canvas(characterFrameWidth, characterFrameHeight)
  const sitting = column >= 8 && column <= 10
  const walking = column >= 2 && column <= 5
  const step = column - 2
  const bob = column === 1 || column === 3 || column === 5 ? -1 : 0
  const headY = bob + (sitting ? 2 : 0)
  const torsoY = 25 + headY
  const clothDark = shade(look.shirt, -0.27)
  const clothLight = shade(look.shirt, 0.26)
  const skinLight = shade(look.skin, 0.2)
  const skinDark = shade(look.skin, -0.23)
  const trouserDark = shade(look.pants, -0.25)
  const hairDark = shade(look.hair, -0.28)
  const hairLight = shade(look.hair, 0.22)

  if (sitting) {
    art.rect(12, 35, 9, 5, trouserDark)
    art.rect(18, 36, 9, 4, look.pants)
    art.rect(23, 39, 4, 6, trouserDark)
    art.rect(12, 39, 4, 6, look.pants)
    art.rect(22, 44, 7, 2, look.shoes)
    art.rect(11, 44, 7, 2, look.shoes)
    art.rect(23, 44, 5, 1, shade(look.shoes, 0.2))
  } else {
    const rear = walking ? (step === 0 ? 9 : step === 2 ? 19 : 13) : 13
    const near = walking ? (step === 0 ? 19 : step === 2 ? 9 : 16) : 15
    art.rect(rear, 34, 4, step === 1 ? 8 : 10, trouserDark)
    art.rect(rear - 1, step === 1 ? 42 : 44, 7, 2, shade(look.shoes, -0.18))
    art.rect(near, 34, 4, step === 3 ? 8 : 10, look.pants)
    art.rect(near - 1, step === 3 ? 42 : 44, 7, 2, look.shoes)
    art.rect(near, step === 3 ? 42 : 44, 5, 1, shade(look.shoes, 0.2))
  }

  art.rect(11, torsoY + 5, 3, 9, clothDark)
  art.rect(11, torsoY + 12, 3, 3, skinDark)
  art.oval(16, torsoY + 5, 6, 7, clothDark)
  art.rect(11, torsoY + 2, 11, sitting ? 10 : 11, look.shirt)
  art.rect(12, torsoY + 2, 8, 2, clothLight)
  art.rect(19, torsoY + 5, 3, 7, clothDark)
  if (look.clothes === "hoodie") {
    art.rect(12, torsoY, 8, 3, clothDark)
    art.rect(13, torsoY + 2, 4, 2, clothLight)
    art.rect(19, torsoY + 8, 3, 1, clothDark)
  }
  if (look.clothes === "jacket") {
    art.rect(18, torsoY + 3, 4, 9, shade(look.shirt, 0.4))
    art.rect(19, torsoY + 4, 1, 7, "#e7d9bd")
  }
  if (look.clothes === "dress") {
    art.rect(10, torsoY + 10, 13, 3, look.shirt)
    art.rect(9, torsoY + 12, 14, 2, clothDark)
  }
  if (look.clothes === "sweater") art.rect(11, torsoY + 11, 11, 2, clothDark)
  if (look.clothes === "shirt") art.rect(19, torsoY + 2, 2, 3, skinDark)

  const armX = walking ? (step % 2 ? 17 : 22) : 19
  const armY = walking ? (step % 2 ? torsoY + 3 : torsoY + 5) : torsoY + 4
  art.rect(armX, armY, 4, 8, look.shirt)
  art.rect(armX, armY, 1, 5, clothLight)
  art.rect(armX + 1, armY + 8, 3, 3, look.skin)
  if (column === 6 || column === 7) {
    art.rect(21, torsoY + (column === 7 ? -2 : 1), 5, 4, look.shirt)
    art.rect(25, torsoY + (column === 7 ? -5 : -2), 3, 4, skinLight)
  }
  if (column === 9 || column === 10) {
    art.rect(20, torsoY + 8 + (column - 9) * 2, 6, 3, look.shirt)
    art.rect(25, torsoY + 9 + (column - 9) * 2, 4, 2, skinLight)
  }
  if (column === 11) {
    art.rect(21, torsoY + 1, 4, 6, look.shirt)
    art.rect(24, torsoY - 5, 5, 8, look.shirt)
    art.rect(27, torsoY - 14, 3, 10, look.shirt)
    art.rect(26, torsoY - 19, 4, 6, look.skin)
    art.rect(25, torsoY - 20, 5, 2, skinLight)
  }
  if (column === 12 || column === 13) {
    const tilt = column === 13 ? 2 : 0
    art.rect(18, torsoY + 8, 5, 3, look.shirt)
    art.rect(19, torsoY + 10, 9, 6, "#795c4a")
    art.rect(20 + tilt, torsoY + 11, 6, 4, "#f3dfa3")
    art.rect(22 + tilt, torsoY + 11, 1, 4, "#b78e57")
  }
  if (column === 14) {
    art.rect(20, torsoY + 4, 5, 6, look.shirt)
    art.rect(24, torsoY + 9, 4, 4, skinLight)
  }
  if (column === 15 || column === 16) {
    const raised = column === 16 ? -2 : 0
    art.rect(19, torsoY + 2 + raised, 5, 7, look.shirt)
    art.rect(23, torsoY - 2 + raised, 5, 4, skinLight)
  }

  art.rect(14, 23 + headY, 4, 4, skinDark)
  art.oval(16, 16 + headY, 7, 9, skinDark)
  art.oval(17, 15 + headY, 6, 8, look.skin)
  art.rect(22, 18 + headY, 3, 3, skinLight)
  art.rect(24, 20 + headY, 2, 2, skinDark)
  art.rect(23, 19 + headY, 2, 2, look.skin)
  art.rect(11, 18 + headY, 3, 4, skinDark)

  if (look.style === "afro") {
    art.oval(13, 11 + headY, 9, 9, hairDark)
    for (const [x, y, r] of [[8, 10, 4], [13, 6, 5], [19, 8, 4], [7, 17, 4], [10, 21, 3]] as const) art.oval(x, y + headY, r, r, look.hair)
    for (const [x, y] of [[8, 8], [13, 5], [19, 7], [6, 16]] as const) art.rect(x, y + headY, 2, 2, hairLight)
  } else if (look.style === "buzz") {
    art.oval(16, 10 + headY, 7, 5, look.hair)
    art.rect(13, 8 + headY, 4, 1, hairLight)
  } else {
    art.oval(14, 10 + headY, 8, 6, hairDark)
    art.oval(13, 9 + headY, 7, 5, look.hair)
    art.rect(9, 12 + headY, 5, 8, look.hair)
    art.rect(11, 7 + headY, 5, 2, hairLight)
    if (["long", "waves", "ponytail"].includes(look.style)) {
      art.rect(8, 18 + headY, 4, 12, hairDark)
      art.rect(9, 22 + headY, 2, 7, hairLight)
      if (look.style === "waves") art.oval(9, 29 + headY, 3, 3, look.hair)
      if (look.style === "ponytail") art.oval(7, 23 + headY, 3, 6, look.hair)
    }
    if (look.style === "bun") {
      art.oval(9, 8 + headY, 5, 4, look.hair)
      art.rect(8, 5 + headY, 3, 2, hairLight)
    }
    if (look.style === "spikes") for (const [x, y] of [[8, 5], [13, 4], [18, 6]] as const) art.rect(x, y + headY, 3, 5, look.hair)
    if (look.style === "part") art.rect(15, 10 + headY, 2, 4, hairLight)
    if (look.style === "beanie") {
      art.oval(15, 10 + headY, 8, 6, shade(look.shirt, -0.25))
      art.rect(8, 12 + headY, 15, 3, look.shirt)
      art.rect(10, 13 + headY, 8, 1, clothLight)
    }
    if (look.style === "cap") {
      art.oval(15, 10 + headY, 8, 6, look.hair)
      art.rect(17, 14 + headY, 10, 2, hairDark)
      art.rect(11, 7 + headY, 5, 1, hairLight)
    }
    if (look.style === "hat") {
      art.oval(15, 10 + headY, 8, 6, "#d8b976")
      art.rect(7, 13 + headY, 20, 2, "#b78e57")
      art.rect(9, 12 + headY, 17, 2, "#e0c588")
      art.rect(10, 10 + headY, 10, 2, "#795c4a")
    }
  }
  art.rect(20, 18 + headY, 2, 3, shade(look.hair, -0.48))
  art.pixel(20, 18 + headY, "#f8e9c9")
  art.pixel(24, 23 + headY, column === 7 ? "#873f4a" : skinDark)
  if (look.accessory === "glasses") {
    art.rect(18, 17 + headY, 6, 1, "#3c424c")
    art.rect(19, 21 + headY, 4, 1, "#3c424c")
  }
  if (look.accessory === "headphones") {
    art.rect(9, 8 + headY, 10, 2, "#ceb88d")
    art.rect(8, 10 + headY, 2, 10, "#ceb88d")
    art.rect(8, 16 + headY, 3, 6, "#52606f")
  }
  return finishFrame(art, look, flip)
}

export function characterSheet(): PixelSheet {
  const sheet = canvas(characterFrameWidth * characterColumnCount, characterFrameHeight * characterAppearances * characterDirections.length)
  for (let appearance = 0; appearance < characterAppearances; appearance++) {
    const look = looks[appearance]
    if (!look) throw new Error(`Missing Office appearance ${appearance}`)
    for (let direction = 0; direction < characterDirections.length; direction++) for (let column = 0; column < characterColumnCount; column++) {
      const frame = drawPerson(look, direction, column)
      for (let y = 0; y < frame.height; y++) sheet.pixels.set(frame.pixels.subarray(y * frame.width * 4, (y + 1) * frame.width * 4), ((appearance * characterDirections.length + direction) * characterFrameHeight * sheet.width + y * sheet.width + column * characterFrameWidth) * 4)
    }
  }
  return { width: sheet.width, height: sheet.height, pixels: sheet.pixels }
}
