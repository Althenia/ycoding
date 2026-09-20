## Which surface the shell is showing.
##
## The shell has one window and several surfaces, and exactly one of them owns the
## content region at a time. `Office` is the default spatial work surface; the
## others are places the user goes deliberately.
##
## The route is PRESENTATION state. It never stops the service, cancels work,
## changes the prompt target, or decides what is live: those belong to the
## composition root and the transports, and they keep running whichever route is
## showing. A route changes what the user is looking at, nothing else.
class_name OfficeRoute
extends RefCounted

const OFFICE := "office"
const SESSIONS := "sessions"
const STATISTICS := "statistics"
const SETTINGS := "settings"

## Every route, in the order the rail offers them. One canonical list, so a route
## cannot exist in the navigation without also existing here.
const ALL := [OFFICE, SESSIONS, STATISTICS, SETTINGS]

## The route a launch starts on. Office is the default surface by contract.
const DEFAULT := OFFICE

## The label the rail shows for a route.
const LABELS := {
	OFFICE: "Office",
	SESSIONS: "Sessions",
	STATISTICS: "Statistics",
	SETTINGS: "Settings",
}

## The glyph the rail shows for a route, so the row is legible without colour.
const GLYPHS := {
	OFFICE: "▦",
	SESSIONS: "≡",
	STATISTICS: "◫",
	SETTINGS: "⚙",
}


## Whether a string names a route this shell can show.
##
## An unknown route is refused rather than adopted, because showing an unknown
## surface would leave the content region owned by nothing.
static func is_route(value: String) -> bool:
	return ALL.has(value)


## A route name, or the default when the value is not one. A corrupt stored
## preference still yields a usable shell.
static func clamp_route(value: String) -> String:
	return value if is_route(value) else DEFAULT


static func label(route: String) -> String:
	return str(LABELS.get(route, route))


static func glyph(route: String) -> String:
	return str(GLYPHS.get(route, "•"))


## Whether the OFFICE surface (the spatial world) is the one showing. The world's
## camera, presence and player controls only apply on this route; the runtime
## subscriptions continue regardless.
static func shows_world(route: String) -> bool:
	return clamp_route(route) == OFFICE
