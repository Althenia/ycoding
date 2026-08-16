import type { ThemeDefinition } from "./types"
import yc2ThemeJson from "./themes/yc-2.json"
import amoledThemeJson from "./themes/amoled.json"
import auraThemeJson from "./themes/aura.json"
import ayuThemeJson from "./themes/ayu.json"
import carbonfoxThemeJson from "./themes/carbonfox.json"
import catppuccinThemeJson from "./themes/catppuccin.json"
import catppuccinFrappeThemeJson from "./themes/catppuccin-frappe.json"
import catppuccinMacchiatoThemeJson from "./themes/catppuccin-macchiato.json"
import cobalt2ThemeJson from "./themes/cobalt2.json"
import cursorThemeJson from "./themes/cursor.json"
import draculaThemeJson from "./themes/dracula.json"
import everforestThemeJson from "./themes/everforest.json"
import flexokiThemeJson from "./themes/flexoki.json"
import githubThemeJson from "./themes/github.json"
import gruvboxThemeJson from "./themes/gruvbox.json"
import kanagawaThemeJson from "./themes/kanagawa.json"
import lucentOrngThemeJson from "./themes/lucent-orng.json"
import materialThemeJson from "./themes/material.json"
import matrixThemeJson from "./themes/matrix.json"
import mercuryThemeJson from "./themes/mercury.json"
import monokaiThemeJson from "./themes/monokai.json"
import nightowlThemeJson from "./themes/nightowl.json"
import nordThemeJson from "./themes/nord.json"
import oneDarkThemeJson from "./themes/one-dark.json"
import oneDarkProThemeJson from "./themes/onedarkpro.json"
import ycodingThemeJson from "./themes/ycoding.json"
import orngThemeJson from "./themes/orng.json"
import osakaJadeThemeJson from "./themes/osaka-jade.json"
import palenightThemeJson from "./themes/palenight.json"
import rosepineThemeJson from "./themes/rosepine.json"
import shadesOfPurpleThemeJson from "./themes/shadesofpurple.json"
import solarizedThemeJson from "./themes/solarized.json"
import synthwave84ThemeJson from "./themes/synthwave84.json"
import tokyonightThemeJson from "./themes/tokyonight.json"
import vercelThemeJson from "./themes/vercel.json"
import vesperThemeJson from "./themes/vesper.json"
import zenburnThemeJson from "./themes/zenburn.json"

export const yc2Theme = yc2ThemeJson as ThemeDefinition
export const amoledTheme = amoledThemeJson as ThemeDefinition
export const auraTheme = auraThemeJson as ThemeDefinition
export const ayuTheme = ayuThemeJson as ThemeDefinition
export const carbonfoxTheme = carbonfoxThemeJson as ThemeDefinition
export const catppuccinTheme = catppuccinThemeJson as ThemeDefinition
export const catppuccinFrappeTheme = catppuccinFrappeThemeJson as ThemeDefinition
export const catppuccinMacchiatoTheme = catppuccinMacchiatoThemeJson as ThemeDefinition
export const cobalt2Theme = cobalt2ThemeJson as ThemeDefinition
export const cursorTheme = cursorThemeJson as ThemeDefinition
export const draculaTheme = draculaThemeJson as ThemeDefinition
export const everforestTheme = everforestThemeJson as ThemeDefinition
export const flexokiTheme = flexokiThemeJson as ThemeDefinition
export const githubTheme = githubThemeJson as ThemeDefinition
export const gruvboxTheme = gruvboxThemeJson as ThemeDefinition
export const kanagawaTheme = kanagawaThemeJson as ThemeDefinition
export const lucentOrngTheme = lucentOrngThemeJson as ThemeDefinition
export const materialTheme = materialThemeJson as ThemeDefinition
export const matrixTheme = matrixThemeJson as ThemeDefinition
export const mercuryTheme = mercuryThemeJson as ThemeDefinition
export const monokaiTheme = monokaiThemeJson as ThemeDefinition
export const nightowlTheme = nightowlThemeJson as ThemeDefinition
export const nordTheme = nordThemeJson as ThemeDefinition
export const oneDarkTheme = oneDarkThemeJson as ThemeDefinition
export const oneDarkProTheme = oneDarkProThemeJson as ThemeDefinition
export const ycodingTheme = ycodingThemeJson as ThemeDefinition
export const orngTheme = orngThemeJson as ThemeDefinition
export const osakaJadeTheme = osakaJadeThemeJson as ThemeDefinition
export const palenightTheme = palenightThemeJson as ThemeDefinition
export const rosepineTheme = rosepineThemeJson as ThemeDefinition
export const shadesOfPurpleTheme = shadesOfPurpleThemeJson as ThemeDefinition
export const solarizedTheme = solarizedThemeJson as ThemeDefinition
export const synthwave84Theme = synthwave84ThemeJson as ThemeDefinition
export const tokyonightTheme = tokyonightThemeJson as ThemeDefinition
export const vercelTheme = vercelThemeJson as ThemeDefinition
export const vesperTheme = vesperThemeJson as ThemeDefinition
export const zenburnTheme = zenburnThemeJson as ThemeDefinition

export const DEFAULT_THEMES: Record<string, ThemeDefinition> = {
  "yc-2": yc2Theme,
  amoled: amoledTheme,
  aura: auraTheme,
  ayu: ayuTheme,
  carbonfox: carbonfoxTheme,
  catppuccin: catppuccinTheme,
  "catppuccin-frappe": catppuccinFrappeTheme,
  "catppuccin-macchiato": catppuccinMacchiatoTheme,
  cobalt2: cobalt2Theme,
  cursor: cursorTheme,
  dracula: draculaTheme,
  everforest: everforestTheme,
  flexoki: flexokiTheme,
  github: githubTheme,
  gruvbox: gruvboxTheme,
  kanagawa: kanagawaTheme,
  "lucent-orng": lucentOrngTheme,
  material: materialTheme,
  matrix: matrixTheme,
  mercury: mercuryTheme,
  monokai: monokaiTheme,
  nightowl: nightowlTheme,
  nord: nordTheme,
  "one-dark": oneDarkTheme,
  onedarkpro: oneDarkProTheme,
  ycoding: ycodingTheme,
  orng: orngTheme,
  "osaka-jade": osakaJadeTheme,
  palenight: palenightTheme,
  rosepine: rosepineTheme,
  shadesofpurple: shadesOfPurpleTheme,
  solarized: solarizedTheme,
  synthwave84: synthwave84Theme,
  tokyonight: tokyonightTheme,
  vercel: vercelTheme,
  vesper: vesperTheme,
  zenburn: zenburnTheme,
}
