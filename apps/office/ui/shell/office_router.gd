## The route owner.
##
## It holds which surface is showing and tells interested panels when that changes.
## It deliberately knows nothing about transports, sessions or permissions: a route
## change is a view change, and the acceptance depends on it staying that way
## ("Navigating to these pages does not stop the service, cancel work or change the
## prompt target").
##
## Keeping the owner this small is what makes that property checkable: there is no
## transport reference here for a route change to reach.
class_name OfficeRouter
extends RefCounted

signal route_changed(route: String)

var _route: String = OfficeRoute.DEFAULT


## The route currently showing.
func route() -> String:
	return _route


## Whether the spatial world is the surface showing.
func shows_world() -> bool:
	return OfficeRoute.shows_world(_route)


## Show a route. An unknown or unchanged route is a no-op rather than an error,
## so a caller cannot leave the shell with no surface by mistake.
##
## Returns whether the route actually changed, so a caller can skip redundant work
## and a test can tell a real navigation from a repeated one.
func go(route: String) -> bool:
	# An invalid route is IGNORED, not clamped to the default. Clamping would jump
	# the user to a surface they never asked for, which is a worse outcome than
	# doing nothing: a caller with a corrupt or stale route name must not move the
	# shell at all.
	if not OfficeRoute.is_route(route):
		return false
	if route == _route:
		return false
	_route = route
	route_changed.emit(_route)
	return true
