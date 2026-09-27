import type { OfficeFurniture } from "../../src/remote/office/map"
import { canvas, type PixelArt } from "./canvas"

type Painter = ReturnType<typeof canvas>

function piece(width: number, height: number, paint: (art: Painter) => void): PixelArt {
  const art = canvas(width, height)
  paint(art)
  return art
}

function base(art: Painter, x: number, y: number, width: number, height: number, dark: string, face: string, lit: string) {
  art.ellipse(x + 2, y + height - 5, width - 2, 11, "#26304755")
  art.roundRect(x, y + 3, width, height - 5, dark)
  art.roundRect(x + 2, y + 1, width - 4, height - 9, face)
  art.rect(x + 5, y + 3, width - 10, 2, lit)
  art.rect(x + 3, y + height - 11, width - 6, 2, dark)
}

function monitor(art: Painter, x: number, y: number, style: "code" | "chart" | "test" | "executive") {
  art.rect(x, y + 2, 30, 20, "#303a50")
  art.rect(x + 2, y + 3, 26, 15, style === "executive" ? "#315d76" : "#304d69")
  art.rect(x + 4, y + 5, 21, 2, "#88c8d1")
  if (style === "chart") {
    art.line(x + 5, y + 15, x + 10, y + 11, "#f0bc78")
    art.line(x + 10, y + 11, x + 15, y + 13, "#f0bc78")
    art.line(x + 15, y + 13, x + 23, y + 8, "#f0bc78")
    art.rect(x + 6, y + 12, 2, 3, "#9bd3aa")
  }
  if (style === "code") for (let line = 0; line < 3; line++) {
    art.rect(x + 5, y + 9 + line * 3, 7 + line * 4, 1, line === 1 ? "#dbb1dc" : "#8bd1b8")
    art.rect(x + 18, y + 9 + line * 3, 5, 1, "#77a6d1")
  }
  if (style === "test") {
    for (let row = 0; row < 3; row++) {
      art.rect(x + 5, y + 9 + row * 3, 3, 2, row === 2 ? "#e3a8a5" : "#9bd3aa")
      art.rect(x + 10, y + 9 + row * 3, 13, 1, "#a8c4d4")
    }
    art.line(x + 5, y + 10, x + 6, y + 11, "#245f55")
    art.line(x + 6, y + 11, x + 8, y + 8, "#245f55")
    art.line(x + 5, y + 16, x + 8, y + 18, "#a7505f")
    art.line(x + 8, y + 16, x + 5, y + 18, "#a7505f")
  }
  if (style === "executive") art.rect(x + 5, y + 10, 18, 4, "#b0d6c3")
  art.rect(x + 14, y + 22, 3, 4, "#465161")
  art.rect(x + 9, y + 26, 13, 2, "#566478")
  art.rect(x + 3, y, 24, 1, "#8395a5")
}

function chair(art: Painter, x: number, y: number, color = "#64788e") {
  art.ellipse(x + 2, y + 14, 23, 7, "#26304755")
  art.roundRect(x + 2, y, 23, 14, "#344355")
  art.roundRect(x + 4, y + 2, 19, 9, color)
  art.rect(x + 6, y + 2, 13, 1, "#adbac4")
  art.rect(x + 10, y + 13, 6, 6, "#38485b")
  art.rect(x + 4, y + 18, 18, 2, "#3b4b5c")
}

function workstation(style: "executive" | "code" | "chart" | "test"): PixelArt {
  const executive = style === "executive"
  return piece(executive ? 128 : 96, 76, (art) => {
    const width = art.width
    base(art, 1, 15, width - 2, 46, executive ? "#55445c" : "#6e778d", executive ? "#926d61" : "#f0edf1", executive ? "#c79677" : "#ffffff")
    art.rect(5, 56, 9, 10, executive ? "#72565a" : "#b4bbca")
    art.rect(width - 14, 56, 9, 10, executive ? "#72565a" : "#b4bbca")
    monitor(art, executive ? 47 : 15, 8, style)
    if (!executive) monitor(art, 50, 10, style)
    art.rect(width / 2 - 20, 43, 40, 5, "#455365")
    art.rect(width / 2 - 18, 44, 36, 3, "#aeb9c7")
    for (let key = 0; key < 32; key += 4) art.pixel(width / 2 - 16 + key, 45, "#53637a")
    art.ellipse(width - 22, 42, 6, 4, "#425264")
    art.rect(9, 22, 3, 18, "#596475")
    art.ellipse(3, 16, 16, 9, "#f6d8a2")
    art.rect(9, 40, 8, 2, "#3d4e5b")
    art.rect(width - 31, 25, 14, 9, executive ? "#f7e5c4" : "#d8e6ed")
    art.rect(width - 29, 27, 10, 1, style === "test" ? "#d58487" : "#97a9ba")
    art.rect(width - 29, 30, 7, 1, "#97a9ba")
    art.rect(width - 13, 32, 7, 8, "#58728a")
    art.rect(width - 12, 33, 5, 4, "#c5e6e4")
    art.rect(width - 12, 38, 5, 2, "#d6a5a2")
    art.rect(width - 44, 34, 7, 8, "#bc8b6e")
    for (const [pencil, color] of ["#e5ba72", "#88aeb8", "#bd8eaa"].entries()) art.rect(width - 43 + pencil * 2, 30 + pencil % 2, 1, 6, color)
    if (style === "test") {
      art.rect(23, 33, 7, 10, "#293b4e")
      art.rect(24, 34, 5, 7, "#a5d4d8")
      art.rect(34, 35, 11, 7, "#48566c")
      art.rect(35, 36, 9, 5, "#d9a7d1")
    }
    if (style === "chart") {
      for (const [book, color] of ["#8592b9", "#b17d9a", "#d3a670", "#769b8e"].entries()) art.rect(5 + book * 5, 42 - book % 2 * 3, 4, 8 + book % 2 * 3, color)
      art.ellipse(72, 37, 9, 9, "#dfc995")
      art.ellipse(74, 39, 5, 5, "#84bcae")
    }
    if (executive) {
      art.rect(18, 34, 19, 12, "#d5bc91")
      art.rect(19, 35, 17, 9, "#f5e2bc")
      art.rect(21, 38, 12, 1, "#b18f80")
      art.rect(94, 28, 16, 3, "#dcb993")
      art.rect(95, 32, 12, 2, "#f2e0bd")
    }
    chair(art, width / 2 - 13, 54, executive ? "#7a5260" : "#778ca8")
  })
}

function plant(species: "fern" | "monstera" | "bamboo" | "succulent" | "flowers"): PixelArt {
  return piece(32, 72, (art) => {
    art.ellipse(4, 61, 25, 8, "#26304755")
    art.rect(8, 54, 16, 14, species === "succulent" ? "#d9d6d2" : species === "bamboo" ? "#5d6672" : "#b57d68")
    art.rect(6, 52, 20, 4, species === "succulent" ? "#f0ebe5" : "#d49c80")
    art.rect(10, 59, 12, 1, "#eed1b8")
    if (species === "bamboo") {
      for (let stem = 0; stem < 4; stem++) {
        const x = 10 + stem * 4
        art.rect(x, 9 + stem % 2 * 7, 2, 44, "#678f70")
        for (let y = 18 + stem % 2 * 7; y < 48; y += 11) {
          art.line(x, y, x - 6, y - 6, "#4e8064")
          art.line(x + 1, y + 2, x + 7, y - 4, "#92b88d")
        }
      }
    }
    if (species === "fern") {
      for (let frond = -3; frond <= 3; frond++) {
        art.line(16, 54, 16 + frond * 4, 17 + Math.abs(frond) * 4, "#3e7662")
        for (let leaf = 0; leaf < 4; leaf++) {
          const y = 23 + leaf * 7 + Math.abs(frond) * 3
          const x = 16 + frond * (4 - leaf / 2)
          art.ellipse(x - 5, y, 7, 3, leaf % 2 ? "#5f9a78" : "#8cb990")
          art.ellipse(x + 1, y + 2, 7, 3, "#467f6e")
        }
      }
    }
    if (species === "monstera") {
      for (const [x, y, color] of [[4, 26, "#4e8769"], [15, 17, "#79a879"], [18, 32, "#3f755d"], [5, 40, "#6b9b70"]] as const) {
        art.ellipse(x, y, 15, 17, color)
        art.rect(x + 5, y + 3, 2, 4, "#234f48")
        art.rect(x + 9, y + 9, 3, 2, "#234f48")
        art.line(x + 7, y + 13, 16, 54, "#41755e")
      }
    }
    if (species === "succulent") {
      for (let leaf = 0; leaf < 7; leaf++) {
        const x = 6 + leaf * 3
        art.line(16, 53, x, 31 + Math.abs(leaf - 3) * 3, leaf % 2 ? "#6ba88e" : "#4f8a82")
        art.rect(x - 2, 33 + Math.abs(leaf - 3) * 3, 5, 3, "#a3c5a3")
      }
    }
    if (species === "flowers") {
      for (const [x, y] of [[6, 21], [15, 16], [22, 26], [10, 35], [21, 38]] as const) {
        art.line(16, 54, x + 2, y + 4, "#4a8466")
        art.ellipse(x - 2, y - 2, 7, 7, "#cb86a7")
        art.pixel(x + 1, y + 1, "#f1d59b")
        art.ellipse(x + 1, y + 8, 8, 4, "#78a67c")
      }
    }
  })
}

function shelf(device: boolean): PixelArt {
  return piece(64, 112, (art) => {
    art.ellipse(2, 104, 60, 7, "#26304755")
    base(art, 1, 6, 62, 104, device ? "#465267" : "#5d4c5b", device ? "#7a8ba0" : "#927c78", device ? "#b2bdc9" : "#c1a095")
    for (let row = 0; row < 3; row++) {
      const y = 19 + row * 27
      art.rect(6, y - 3, 52, 22, device ? "#344559" : "#674e5c")
      const colors = device ? ["#8dbfc7", "#6e8fae", "#b7a8bf", "#deb6a8"] : ["#af7f9b", "#8099bd", "#c89f71", "#89aa8d"]
      for (const [item, color] of [...colors, ...colors].entries()) {
        const x = 9 + item * 6
        art.rect(x, y + item % 3, device ? 4 : 5, 15 - item % 3, color)
        art.rect(x + 1, y + 4, 2, 1, "#e8ded7")
        if (device) art.rect(x + 1, y + 9, 2, 1, item % 3 ? "#5da583" : "#c47576")
      }
      art.rect(5, y + 19, 54, 3, device ? "#d4dce0" : "#c7a494")
    }
  })
}

function board(bugs: boolean): PixelArt {
  return piece(128, 64, (art) => {
    art.ellipse(8, 57, 112, 5, "#26304744")
    art.rect(2, 6, 124, 50, "#51586c")
    art.rect(5, 8, 118, 44, bugs ? "#8e97a9" : "#eef0ed")
    art.rect(5, 8, 118, 2, "#dce1de")
    if (bugs) {
      for (let column = 0; column < 3; column++) {
        art.rect(12 + column * 37, 13, 29, 4, "#52687d")
        for (const [row, color] of ["#ead7a7", "#d5c6e0", "#bcd7d2"].entries()) {
          const x = 13 + column * 37
          const y = 21 + row * 9
          art.rect(x, y, 23, 7, color)
          art.rect(x + 3, y + 2, 13, 1, "#8b8f9d")
        }
      }
    }
    if (!bugs) {
      art.line(16, 39, 32, 20, "#739da1")
      art.line(32, 20, 52, 33, "#739da1")
      art.line(52, 33, 72, 17, "#c394b3")
      art.rect(75, 16, 33, 3, "#8eaab3")
      art.rect(75, 23, 25, 2, "#b49fbf")
      art.rect(75, 30, 29, 2, "#94b2a2")
      art.ellipse(25, 35, 5, 5, "#dbaf78")
      art.ellipse(54, 29, 5, 5, "#dbaf78")
    }
    art.rect(42, 54, 44, 3, "#7b8791")
  })
}

function sofa(back: string, cushion: string, seat: string, trim: string): PixelArt {
  return piece(160, 72, (art) => {
    art.ellipse(3, 60, 154, 10, "#26304755")
    art.roundRect(2, 9, 156, 52, trim)
    art.roundRect(7, 11, 146, 43, back)
    art.roundRect(14, 15, 132, 18, cushion)
    for (let cushionIndex = 0; cushionIndex < 3; cushionIndex++) {
      art.roundRect(13 + cushionIndex * 46, 34, 43, 17, seat)
      art.rect(20 + cushionIndex * 46, 35, 27, 2, cushion)
      art.rect(55 + cushionIndex * 46, 37, 2, 12, trim)
    }
    art.rect(10, 61, 13, 7, trim)
    art.rect(138, 61, 13, 7, trim)
    art.roundRect(8, 30, 12, 26, back)
    art.roundRect(140, 30, 12, 26, back)
  })
}

function beanBag(back: string, cushion: string, light: string): PixelArt {
  return piece(64, 64, (art) => {
    art.ellipse(3, 49, 58, 10, "#26304755")
    art.ellipse(5, 18, 54, 39, back)
    art.ellipse(8, 16, 48, 37, cushion)
    art.ellipse(12, 20, 38, 27, light)
    art.line(14, 39, 30, 47, back)
    art.line(50, 38, 34, 47, back)
    art.rect(21, 20, 8, 2, "#ead7d9")
  })
}

export function environmentFurniture(): Record<OfficeFurniture, PixelArt> {
  return {
    executiveDesk: workstation("executive"),
    developerDesk: workstation("code"),
    researchDesk: workstation("chart"),
    qaDesk: workstation("test"),
    conferenceTable: piece(256, 112, (art) => {
      for (let seat = 0; seat < 4; seat++) {
        chair(art, 30 + seat * 52, 0, "#738e9a")
        chair(art, 30 + seat * 52, 91, "#738e9a")
      }
      base(art, 5, 24, 246, 69, "#694b3e", "#b7865e", "#e9b77e")
      art.rect(11, 31, 234, 3, "#e2ab78")
      art.rect(11, 77, 234, 3, "#70513f")
      for (let place = 0; place < 8; place++) {
        const x = 28 + place * 27
        art.rect(x, place % 2 ? 61 : 38, 17, 10, "#eadfda")
        art.rect(x + 2, place % 2 ? 63 : 40, 11, 1, "#799ba6")
        art.ellipse(x + 19, place % 2 ? 64 : 42, 6, 6, "#c2d7d3")
      }
      art.ellipse(119, 48, 19, 12, "#738b9c")
      art.ellipse(122, 50, 13, 7, "#b4d2d0")
    }),
    sofa: sofa("#8e7196", "#b296b1", "#a386a2", "#5d4d6d"),
    sofaPeach: sofa("#e4a38e", "#ffd2ae", "#f5b59a", "#985d63"),
    sofaOrange: sofa("#dc8b5f", "#f5bd82", "#e9a16d", "#925858"),
    coffeeTable: piece(96, 40, (art) => {
      base(art, 2, 4, 92, 30, "#6c5b65", "#b79b88", "#e3c4a6")
      art.rect(9, 34, 7, 4, "#5d5361")
      art.rect(80, 34, 7, 4, "#5d5361")
      art.ellipse(38, 12, 18, 12, "#e2d5b9")
      art.ellipse(42, 15, 10, 7, "#b3cfc7")
      art.rect(13, 10, 18, 10, "#e1d5c9")
      art.rect(15, 12, 12, 1, "#93a0ae")
    }),
    beanBag: beanBag("#6c607c", "#a887bb", "#c6a5d2"),
    beanBagBlue: beanBag("#496b94", "#719cc4", "#a5c7dd"),
    beanBagPink: beanBag("#935e77", "#c983a3", "#e8afc4"),
    pingPong: piece(128, 80, (art) => {
      base(art, 2, 13, 124, 60, "#4c5367", "#538788", "#86b6aa")
      art.rect(63, 16, 2, 50, "#e5e8de")
      art.rect(8, 39, 112, 2, "#e5e8de")
      art.rect(3, 37, 122, 2, "#324d5a")
      art.rect(3, 42, 122, 2, "#324d5a")
      art.rect(14, 73, 7, 6, "#454d5c")
      art.rect(108, 73, 7, 6, "#454d5c")
      art.ellipse(30, 24, 11, 7, "#cf8d88")
      art.ellipse(88, 51, 11, 7, "#e6c08e")
      art.ellipse(73, 29, 4, 4, "#f7f5ec")
    }),
    kitchenCounter: piece(160, 64, (art) => {
      base(art, 1, 18, 158, 42, "#586071", "#e0d7d9", "#faf5ec")
      for (let cabinet = 0; cabinet < 4; cabinet++) {
        art.rect(9 + cabinet * 37, 39, 32, 16, "#c9c3cf")
        art.rect(11 + cabinet * 37, 41, 28, 12, "#e9e5ea")
        art.rect(34 + cabinet * 37, 44, 2, 5, "#76899b")
      }
      art.rect(15, 5, 28, 20, "#475368")
      art.rect(18, 7, 22, 12, "#a6b8c5")
      art.rect(24, 20, 10, 3, "#332d3c")
      art.rect(21, 24, 4, 5, "#e7cfb2")
      art.rect(32, 24, 4, 5, "#e7cfb2")
      art.ellipse(76, 23, 30, 11, "#81959e")
      art.ellipse(80, 24, 22, 8, "#c1d5d4")
      art.rect(124, 15, 14, 17, "#e9ddd1")
      art.rect(126, 17, 10, 10, "#81aaa9")
    }),
    fridge: piece(32, 80, (art) => {
      art.ellipse(2, 72, 28, 7, "#26304755")
      art.roundRect(3, 4, 26, 70, "#586779")
      art.rect(5, 6, 22, 64, "#d8dbe0")
      art.rect(6, 7, 3, 62, "#f8f7f3")
      art.rect(5, 32, 22, 2, "#8b9aac")
      art.rect(22, 18, 2, 10, "#758a9b")
      art.rect(22, 42, 2, 11, "#758a9b")
      art.rect(11, 10, 8, 6, "#dab1cc")
      art.pixel(14, 12, "#f5d48b")
    }),
    serverRack: shelf(true),
    deviceRack: piece(64, 112, (art) => {
      art.ellipse(2, 104, 60, 7, "#26304755")
      base(art, 2, 7, 60, 103, "#4b5168", "#8e96ac", "#c6cbd6")
      for (let row = 0; row < 4; row++) {
        const y = 15 + row * 22
        art.rect(7, y, 50, 18, "#435168")
        for (const [device, color] of ["#93c8cf", "#bea9d4", "#e1bcaa"].entries()) {
          const x = 10 + device * 15
          const width = row % 2 === 0 && device < 2 ? 14 : 9
          art.rect(x, y + 2, width, 14, "#29394e")
          art.rect(x + 1, y + 3, width - 2, 10, color)
          art.pixel(x + Math.floor(width / 2), y + 14, "#d5d9d9")
        }
      }
    }),
    bookshelf: shelf(false),
    whiteboard: board(false),
    bugBoard: board(true),
    wallTv: piece(128, 64, (art) => {
      art.ellipse(10, 57, 108, 5, "#26304744")
      art.rect(2, 5, 124, 50, "#2f3c50")
      art.rect(5, 8, 118, 43, "#355778")
      art.rect(8, 10, 112, 38, "#699bad")
      art.rect(9, 11, 38, 18, "#91c4c8")
      art.rect(51, 13, 58, 3, "#cbd8d3")
      art.rect(51, 20, 47, 2, "#9dc5bd")
      art.rect(51, 26, 55, 2, "#e1baaa")
      art.rect(11, 34, 106, 10, "#344e65")
      art.rect(14, 37, 42, 2, "#a4cccf")
      art.rect(14, 41, 72, 1, "#789eae")
      art.rect(61, 55, 6, 5, "#546378")
    }),
    waterDispenser: piece(32, 72, (art) => {
      art.ellipse(3, 65, 26, 6, "#26304755")
      art.rect(8, 4, 16, 22, "#a7d5df")
      art.rect(10, 6, 12, 17, "#c5e9ec")
      art.rect(7, 25, 18, 40, "#556b7c")
      art.rect(9, 27, 14, 36, "#f0eeeb")
      art.rect(11, 34, 10, 12, "#b0c7cb")
      art.rect(13, 35, 2, 4, "#d98681")
      art.rect(18, 35, 2, 4, "#89aac6")
      art.rect(12, 49, 8, 2, "#688b9b")
    }),
    plantFern: plant("fern"),
    plantMonstera: plant("monstera"),
    plantBamboo: plant("bamboo"),
    plantSucculent: plant("succulent"),
    plantFlowers: plant("flowers"),
    aquarium: piece(96, 80, (art) => {
      art.ellipse(3, 69, 90, 8, "#26304755")
      base(art, 1, 13, 94, 60, "#425469", "#698a9c", "#a7bdc4")
      art.rect(5, 15, 86, 45, "#32667c")
      art.rect(7, 17, 82, 40, "#82c4cd")
      art.rect(8, 18, 7, 37, "#b7e5e3")
      art.rect(19, 19, 2, 28, "#d0f4ef")
      for (const [x, y, color] of [[26, 34, "#f4c583"], [63, 27, "#d695a8"], [52, 43, "#e8d69d"]] as const) {
        art.ellipse(x, y, 11, 6, color)
        art.line(x, y + 3, x - 4, y, color)
        art.line(x, y + 3, x - 4, y + 6, color)
        art.pixel(x + 7, y + 2, "#364a5a")
      }
      for (let stem = 0; stem < 5; stem++) {
        const x = 12 + stem * 16
        art.line(x, 56, x + stem % 2 * 4, 39, "#4c998b")
        art.ellipse(x - 3, 42, 7, 4, "#69b49d")
      }
      art.rect(5, 59, 86, 5, "#556f80")
    }),
    globe: piece(32, 64, (art) => {
      art.ellipse(4, 57, 24, 5, "#26304755")
      art.ellipse(4, 5, 24, 25, "#5f83a2")
      art.ellipse(6, 7, 20, 21, "#8dbbd0")
      art.ellipse(9, 9, 9, 7, "#88ad8c")
      art.ellipse(18, 17, 6, 8, "#7aa398")
      art.line(4, 28, 28, 7, "#d5c298")
      art.rect(14, 31, 4, 24, "#665e6b")
      art.ellipse(8, 53, 16, 5, "#b59c83")
    }),
    readingSeat: piece(96, 72, (art) => {
      art.ellipse(4, 59, 90, 9, "#26304755")
      art.roundRect(4, 8, 66, 51, "#48566d")
      art.roundRect(8, 12, 58, 39, "#9d89ad")
      art.roundRect(15, 30, 45, 19, "#b6a2be")
      art.rect(6, 58, 10, 8, "#6c5b70")
      art.rect(60, 58, 10, 8, "#6c5b70")
      art.rect(75, 15, 3, 44, "#4e5868")
      art.ellipse(68, 8, 22, 10, "#f1d6a7")
      art.rect(73, 58, 9, 3, "#4e5868")
      art.rect(21, 34, 22, 13, "#ece3d7")
      art.rect(23, 36, 15, 1, "#8da0a8")
    }),
    wallArt: piece(64, 48, (art) => {
      art.rect(2, 3, 60, 40, "#615769")
      art.rect(5, 6, 54, 34, "#e6d4be")
      art.rect(8, 9, 48, 28, "#9fc1bd")
      art.ellipse(34, 10, 15, 12, "#f3d3a0")
      art.line(9, 34, 27, 17, "#708e8f")
      art.line(27, 17, 37, 28, "#8c9f9b")
      art.line(37, 28, 55, 15, "#708e8f")
      art.rect(6, 40, 52, 2, "#b9987c")
    }),
    clock: piece(32, 32, (art) => {
      art.ellipse(3, 2, 26, 26, "#5b6370")
      art.ellipse(5, 4, 22, 22, "#efe9db")
      for (const [x, y] of [[15, 6], [25, 15], [15, 24], [6, 15]] as const) art.rect(x, y, 2, 2, "#947d75")
      art.line(16, 15, 16, 8, "#465362")
      art.line(16, 15, 22, 18, "#465362")
      art.pixel(16, 15, "#d49078")
    }),
    floorLamp: piece(32, 96, (art) => {
      art.ellipse(2, 87, 28, 6, "#26304755")
      art.ellipse(5, 4, 22, 9, "#f9dc9f")
      art.rect(4, 8, 24, 17, "#d9a775")
      art.rect(7, 9, 18, 12, "#ffe4ad")
      art.rect(15, 25, 2, 59, "#586a72")
      art.ellipse(8, 82, 16, 5, "#62747a")
      art.rect(8, 23, 16, 2, "#ad805e")
    }),
    sideTable: piece(32, 48, (art) => {
      art.ellipse(3, 39, 26, 6, "#26304755")
      art.ellipse(3, 8, 26, 12, "#bb8e68")
      art.ellipse(5, 6, 22, 10, "#e5b882")
      art.rect(15, 18, 3, 25, "#755a55")
      art.ellipse(8, 41, 17, 3, "#725753")
      art.rect(8, 7, 9, 7, "#f7eedc")
      art.rect(9, 9, 6, 1, "#9ba6aa")
      art.ellipse(19, 7, 6, 5, "#82aaa4")
    }),
    filingCabinet: piece(64, 80, (art) => {
      art.ellipse(3, 70, 58, 7, "#26304755")
      base(art, 3, 4, 58, 69, "#516172", "#a9b5bb", "#dae0df")
      for (let drawer = 0; drawer < 3; drawer++) {
        art.rect(9, 13 + drawer * 17, 46, 15, "#d1d9d9")
        art.rect(13, 15 + drawer * 17, 38, 1, "#f1f0e8")
        art.rect(27, 21 + drawer * 17, 10, 3, "#8192a0")
        art.rect(18, 26 + drawer * 17, 28, 1, "#98a8ae")
      }
      art.rect(11, 3, 13, 4, "#d5b88e")
      art.rect(26, 1, 18, 6, "#a9b6a8")
    }),
    printer: piece(32, 48, (art) => {
      art.ellipse(3, 41, 27, 5, "#26304755")
      art.roundRect(2, 12, 28, 27, "#4d5e70")
      art.rect(4, 13, 24, 19, "#bac9ce")
      art.rect(7, 3, 18, 11, "#f3ede3")
      art.rect(9, 7, 13, 1, "#91a2a7")
      art.rect(9, 10, 10, 1, "#91a2a7")
      art.rect(8, 30, 16, 7, "#ecede8")
      art.rect(23, 18, 2, 2, "#77c1ad")
    }),
    receptionDesk: piece(64, 48, (art) => {
      base(art, 1, 9, 62, 38, "#556074", "#c8ada4", "#f0d9c0")
      art.rect(7, 27, 50, 14, "#a7898d")
      art.rect(19, 30, 26, 4, "#eff0e8")
      art.rect(25, 20, 15, 5, "#f1e5d0")
      art.rect(27, 21, 11, 1, "#8499a4")
      art.ellipse(48, 16, 8, 7, "#a8c9bd")
    }),
    rug: piece(128, 96, (art) => {
      art.roundRect(0, 0, 128, 96, "#6c6286")
      art.roundRect(3, 3, 122, 90, "#9c88a7")
      art.roundRect(7, 7, 114, 82, "#b19cb5")
      for (let y = 10; y < 86; y += 7) for (let x = 10; x < 119; x += 7) {
        art.pixel(x + (y % 14 ? 2 : 0), y, "#c6b3c5")
        art.pixel(x + 3, y + 3, "#806f97")
      }
      art.ellipse(43, 25, 43, 46, "#9c89a7")
      art.ellipse(49, 31, 31, 34, "#cfbbca")
      art.ellipse(55, 36, 19, 24, "#a489ae")
      art.ellipse(60, 41, 9, 14, "#dcc8d4")
      for (const [x, y] of [[15, 15], [105, 15], [15, 72], [105, 72]] as const) art.ellipse(x, y, 10, 9, "#d5c1d3")
    }),
    blueRug: piece(128, 96, (art) => {
      art.roundRect(0, 0, 128, 96, "#3d6575")
      art.roundRect(4, 4, 120, 88, "#91b3b7")
      art.roundRect(9, 9, 110, 78, "#d9e5d9")
      for (let y = 13; y < 84; y += 13) {
        art.rect(11, y, 106, 4, y % 2 ? "#6d98a5" : "#8db0b7")
        art.rect(11, y + 4, 106, 2, "#c1d6d1")
      }
      for (let x = 0; x < 128; x += 6) {
        art.rect(x, 0, 2, 4, "#e3ddd0")
        art.rect(x + 2, 92, 2, 4, "#e3ddd0")
      }
    }),
  }
}
