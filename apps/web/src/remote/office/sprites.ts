export const characterFrameWidth = 32
export const characterFrameHeight = 48
export const characterFeet = { x: 16, y: 46 } as const
export const characterAppearances = 12
export const characterDirections = ["down", "left", "right", "up"] as const
export const characterColumnCount = 12
export const characterColumns = {
  stand: [0, 1],
  walk: [2, 3, 4, 5],
  talk: [6, 7],
  sit: [8],
  type: [9, 10],
  wave: [11],
} as const

export function characterFrame(appearance: number, direction: (typeof characterDirections)[number], column: number): number {
  return (appearance * characterDirections.length + characterDirections.indexOf(direction)) * characterColumnCount + column
}

export function appearanceFor(sessionID: string): number {
  return Array.from(sessionID).reduce((hash, character) => (hash * 31 + character.codePointAt(0)!) >>> 0, 7) % characterAppearances
}
