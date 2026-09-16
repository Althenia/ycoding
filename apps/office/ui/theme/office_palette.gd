## The visual palette, switchable at runtime.
##
## Colours are read through functions rather than baked into nodes, so the whole
## interface can change mode without rebuilding anything: every surface asks the
## palette when it paints.
##
## Both modes are authored, not derived. A mechanically inverted dark theme
## produces unreadable contrast on warm panel tones, so each light tone is chosen
## for its contrast against the surface it sits on.
##
## Changing mode changes CONTRAST, never presence: every label keeps its colour
## role, so a state that is legible in one mode is legible in the other and no
## runtime state is hidden by switching.
class_name OfficePalette
extends RefCounted

const MODE_DARK := "dark"
const MODE_LIGHT := "light"

## The reviewed dark interface.
const DARK := {
	"bg_window": "22252e",
	"bg_panel": "2b2f3a",
	"bg_panel_alt": "333846",
	"bg_input": "1d2029",
	"bg_elevated": "2a2e39",
	"border": "4a5163",
	"border_soft": "3a4050",
	"text": "e8eaf0",
	"text_dim": "a8aec0",
	"text_muted": "7b8296",
	"accent": "6fb2e8",
	"accent_warm": "f0c060",
	"danger": "e07a7a",
	"ok": "86c98a",
}

## Light mode, authored per tone.
const LIGHT := {
	"bg_window": "f4f2ee",
	"bg_panel": "ffffff",
	"bg_panel_alt": "f0eee9",
	"bg_input": "faf9f6",
	"bg_elevated": "ffffff",
	"border": "c8c4bb",
	"border_soft": "dedad2",
	"text": "22252e",
	"text_dim": "4e5464",
	"text_muted": "6f7482",
	"accent": "2f6ea8",
	"accent_warm": "9a6b12",
	"danger": "a83a3a",
	"ok": "2f7a3e",
}


## Every role a mode must define. A partial mode would leave a role undefined, so
## the modes are checked against this rather than trusted.
static func roles() -> Array[String]:
	var out: Array[String] = []
	for role in DARK:
		out.append(str(role))
	return out


static func modes() -> Array[String]:
	return [MODE_DARK, MODE_LIGHT]


## The table for a mode. An unknown mode falls back to dark rather than to
## nothing, so a typo renders a usable interface instead of an invisible one.
static func table(mode: String) -> Dictionary:
	return LIGHT if mode == MODE_LIGHT else DARK


## The colour for a role. An unknown role falls back to the mode's own text tone,
## so it renders legibly rather than as transparent.
static func color_of(role: String, mode: String) -> Color:
	var source := table(mode)
	return Color(str(source.get(role, source.get("text", "000000"))))


## Whether a mode is one this palette defines.
static func is_mode(mode: String) -> bool:
	return modes().has(mode)


## The mode that follows another, so a toggle cycles rather than picks.
static func next_mode(mode: String) -> String:
	return MODE_LIGHT if mode == MODE_DARK else MODE_DARK
